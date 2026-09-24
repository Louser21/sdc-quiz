"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import {
  type GameSessionSummaryDto,
  type HostGameStateView,
  type HostQuestionResult,
  type HostQuestionView,
  type PlayerLobbyEntry,
  type QuestionViewDto,
  type QuizDetailDto,
} from "@quiz/shared";
import { api, ApiError } from "../../../../lib/api";
import { Button, Card, ErrorBanner } from "../../../../components/ui";
import { RequireAuth } from "../../../../components/auth";
import { HostChrome } from "../../../../components/chrome";
import { getSocket } from "../../../../lib/socket";

type HostCommand =
  | { event: "host:start-question"; payload: { gameId: string; questionId: string; runId: string } }
  | { event: "host:end-question" | "host:next-question" | "host:end-game"; payload: { gameId: string; runId: string } };

export default function HostLivePage() {
  const params = useParams<{ id: string }>();
  const gameId = params.id;
  const router = useRouter();

  const [game, setGame] = useState<GameSessionSummaryDto | null>(null);
  const [quiz, setQuiz] = useState<QuizDetailDto | null>(null);
  const [state, setState] = useState<HostGameStateView | null>(null);
  const [lastQuestion, setLastQuestion] = useState<HostQuestionView | null>(null);
  const [result, setResult] = useState<HostQuestionResult | null>(null);
  const [count, setCount] = useState(0);
  const [banner, setBanner] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const joinedRef = useRef(false);

  const questions = useRef<QuestionViewDto[]>([]);

  const loadGame = useCallback(async () => {
    try {
      const g = await api<{ game: GameSessionSummaryDto }>(`/api/games/${gameId}`);
      setGame(g.game);
      const q = await api<{ quiz: QuizDetailDto }>(`/api/quizzes/${g.game.quizId}`);
      setQuiz(q.quiz);
      if (q.quiz.questions.length === 0) {
        setBanner("This quiz has no questions yet. Add questions before hosting.");
      } else {
        questions.current = q.quiz.questions;
      }
    } catch (err) {
      setBanner(err instanceof ApiError ? err.message : "Could not load game");
    }
  }, [gameId]);

  useEffect(() => {
    void loadGame();
  }, [loadGame]);

  const joinedRefSet = useCallback(() => {
    if (joinedRef.current) return;
    joinedRef.current = true;
    getSocket().emit("host:join-game", { gameId });
  }, [gameId]);

  useEffect(() => {
    const socket = getSocket();

    const onConnect = () => joinedRefSet();
    const onHostState = (payload: HostGameStateView) => {
      setState(payload);
      setResult(payload.questionResult);
      setCount(payload.currentQuestion?.answerCount ?? 0);
      if (payload.currentQuestion) setLastQuestion(payload.currentQuestion);
    };
    const onPlayerUpdated = (p: PlayerLobbyEntry) => {
      setState((prev) =>
        prev ? { ...prev, players: mergePlayers(prev.players, [p]) } : prev,
      );
    };
    const onQuestionStarted = (payload: HostQuestionView) => {
      setLastQuestion(payload);
      setCount(0);
      setState((prev) => (prev ? { ...prev, currentQuestion: payload, questionResult: null, phase: "QUESTION_ACTIVE" } : prev));
    };
    const onAnswerCount = (payload: { questionId: string; answerCount: number }) => setCount(payload.answerCount);
    const onQuestionResult = (payload: HostQuestionResult) => {
      setResult(payload);
      setState((prev) =>
        prev ? { ...prev, currentQuestion: null, questionResult: payload, phase: "QUESTION_RESULTS" } : prev,
      );
    };
    const onGameFinished = (payload: { leaderboard: HostGameStateView["leaderboard"] }) => {
      setState((prev) =>
        prev ? { ...prev, phase: "FINISHED", currentQuestion: null, questionResult: null, leaderboard: payload.leaderboard } : prev,
      );
    };
    const onError = (payload: { code: string; message: string }) => setBanner(payload.message);

    socket.on("connect", onConnect);
    socket.on("host:state", onHostState);
    socket.on("host:player-updated", onPlayerUpdated);
    socket.on("host:question-started", onQuestionStarted);
    socket.on("host:answer-count", onAnswerCount);
    socket.on("host:question-result", onQuestionResult);
    socket.on("host:game-finished", onGameFinished);
    socket.on("error", onError);
    if (socket.connected) joinedRefSet();

    return () => {
      socket.off("connect", onConnect);
      socket.off("host:state", onHostState);
      socket.off("host:player-updated", onPlayerUpdated);
      socket.off("host:question-started", onQuestionStarted);
      socket.off("host:answer-count", onAnswerCount);
      socket.off("host:question-result", onQuestionResult);
      socket.off("host:game-finished", onGameFinished);
      socket.off("error", onError);
    };
  }, [gameId, joinedRefSet]);

  const send = useCallback((cmd: HostCommand) => {
      setBusy(true);
      getSocket().emit(cmd.event, cmd.payload);
      setTimeout(() => setBusy(false), 600);
    }, []);

  if (!game || !quiz || !state) {
    return (
      <RequireAuth>
        <HostChrome>
          <ErrorBanner message={banner} />
          <p className="mt-6 text-zinc-400">Loading host console…</p>
        </HostChrome>
      </RequireAuth>
    );
  }

  const phase = state.phase;

  return (
    <RequireAuth>
      <HostChrome>
        <div className="flex items-center justify-between">
          <div>
            <Link href="/games" className="text-sm text-zinc-500 hover:text-zinc-300">
              ← All sessions
            </Link>
            <h1 className="mt-1 text-2xl font-black text-violet-400">{game.quizTitle}</h1>
          </div>
          <div className="text-center text-sm text-zinc-400">
            <p className="text-xs text-zinc-500">Join code</p>
            <p className="font-mono text-2xl font-black tracking-[0.35em] text-zinc-100">{game.joinCode}</p>
          </div>
        </div>

        <ErrorBanner message={banner} />

        <div className="mt-6">
          {phase === "LOBBY" && renderLobby()}
          {phase === "QUESTION_ACTIVE" && renderActive()}
          {phase === "QUESTION_RESULTS" && renderResults()}
          {phase === "FINISHED" && renderFinished()}
        </div>
      </HostChrome>
    </RequireAuth>
  );

  function renderLobby() {
    const first = questions.current[0];
    return (
      <div className="flex flex-col gap-6">
        <Card>
          <p className="text-sm text-zinc-400">
            {state!.players.length} player{state!.players.length === 1 ? "" : "s"} joined so far. Share the code above, then
            start when everyone's in.
          </p>
          {questions.current.length > 0 && (
            <Button
              onClick={() =>
                send({
                  event: "host:start-question",
                  payload: { gameId, questionId: first!.id, runId: crypto.randomUUID() },
                })
              }
              disabled={busy}
              className="mt-4 w-full py-3 text-base"
            >
              Start quiz ({questions.current.length} question{questions.current.length === 1 ? "" : "s"})
            </Button>
          )}
        </Card>
        <PlayerGrid players={state!.players} />
      </div>
    );
  }

  function renderActive() {
    const lq = lastQuestion;
    if (!lq) return <p className="text-zinc-400">Question starting…</p>;
    return (
      <div className="flex flex-col gap-6">
        <Card>
          <div className="flex items-baseline justify-between">
            <p className="text-sm font-semibold text-zinc-400">
              Question {lq.questionNumber} of {lq.totalQuestions}
            </p>
            <p className="font-mono text-lg text-zinc-200">{count} answer{count === 1 ? "" : "s"}</p>
          </div>
          <h2 className="mt-2 text-2xl font-black leading-snug text-zinc-50">{lq.text}</h2>
          <div className="mt-4">
            <Bar count={count} endsAt={lq.questionEndsAt} />
          </div>
          <Button onClick={() => send({ event: "host:end-question", payload: { gameId, runId: crypto.randomUUID() } })} disabled={busy} className="mt-5 w-full">
            End question now
          </Button>
        </Card>
        <PlayerGrid players={state!.players} />
      </div>
    );
  }

  function renderResults() {
    const res = result;
    if (!res) return <p className="text-zinc-400">Gathering results…</p>;
    const last = lastQuestion;
    const endedIndex = Math.max(0, (last?.questionNumber ?? 1) - 1);
    const ended = questions.current[endedIndex];
    const total = last?.totalQuestions ?? questions.current.length;
    return (
      <div className="flex flex-col gap-6">
        <Card>
          <p className="text-sm font-semibold text-zinc-400">
            Results · Question {last?.questionNumber ?? endedIndex + 1} of {total} · {res.answerCount} answer
            {res.answerCount === 1 ? "" : "s"}
          </p>
          {last && <h2 className="mt-1 text-xl font-black text-zinc-50">{last.text}</h2>}
          <div className="mt-4 grid grid-cols-1 gap-2 sm:grid-cols-2">
            {res.optionCounts.map((c) => (
              <OptionCountRow
                key={c.optionId}
                count={c.count}
                correct={c.optionId === res.correctOptionId}
                text={optionText(ended, c.optionId) ?? "Unknown"}
                total={Math.max(1, res.answerCount)}
              />
            ))}
          </div>
          <div className="mt-5 flex gap-3">
            <Button onClick={() => send({ event: "host:next-question", payload: { gameId, runId: crypto.randomUUID() } })} disabled={busy} className="flex-1">
              Next question
            </Button>
            <Button variant="ghost" onClick={() => send({ event: "host:end-game", payload: { gameId, runId: crypto.randomUUID() } })} disabled={busy}>
              End game
            </Button>
          </div>
        </Card>
        {state!.leaderboard.length > 0 && (
          <Card>
            <h3 className="mb-3 text-sm font-bold uppercase tracking-wide text-zinc-400">Leaderboard</h3>
            <Leaderboard rows={state!.leaderboard} highlightId="" />
          </Card>
        )}
      </div>
    );
  }

  function renderFinished() {
    return (
      <Card>
        <h2 className="text-center text-2xl font-black text-emerald-400">Game over!</h2>
        <p className="mt-1 text-center text-sm text-zinc-500">{state!.leaderboard.length} player{state!.leaderboard.length === 1 ? "" : "s"} · final scores</p>
        <div className="mt-5">
          <Leaderboard rows={state!.leaderboard} highlightId="" />
        </div>
        <div className="mt-6 text-center">
          <Button onClick={() => router.push("/games")}>Back to sessions</Button>
        </div>
      </Card>
    );
  }

  function optionText(q: QuestionViewDto | undefined, optionId: string): string | null {
    return q?.options.find((o) => o.id === optionId)?.text ?? null;
  }
}

// ---------------------------------------------------------------------------

function mergePlayers(existing: PlayerLobbyEntry[], updated: PlayerLobbyEntry[]) {
  const map = new Map(existing.map((p) => [p.playerId, p]));
  for (const p of updated) map.set(p.playerId, p);
  return Array.from(map.values());
}

function PlayerGrid({ players }: { players: PlayerLobbyEntry[] }) {
  return (
    <div>
      <h3 className="mb-3 text-sm font-bold uppercase tracking-wide text-zinc-400">
        Players ({players.length})
      </h3>
      {players.length === 0 ? (
        <p className="text-sm text-zinc-600">No one yet — waiting for the first join.</p>
      ) : (
        <div className="flex flex-wrap gap-2">
          {players.map((p) => (
            <span
              key={p.playerId}
              className={`flex items-center gap-2 rounded-full border px-4 py-1.5 text-sm font-semibold ${
                p.connected ? "border-emerald-800/60 bg-emerald-950/30 text-emerald-200" : "border-zinc-700 bg-zinc-900 text-zinc-500"
              }`}
            >
              <span className={`h-2 w-2 rounded-full ${p.connected ? "bg-emerald-400" : "bg-zinc-600"}`} />
              {p.nickname}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function Bar({ count, endsAt }: { count: number; endsAt: number }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, []);
  const total = Math.max(1, endsAt - (endsAt - 10_000));
  const remain = Math.max(0, endsAt - now);
  const pct = Math.min(100, (remain / total) * 100);
  return (
    <div>
      <div className="h-2 w-full overflow-hidden rounded-full bg-zinc-800">
        <div className="h-full rounded-full bg-violet-500 transition-all duration-250" style={{ width: `${pct}%` }} />
      </div>
      <p className="mt-1 text-right font-mono text-sm text-zinc-400">{Math.ceil(remain / 1000)}s</p>
      <p className="sr-only">{count} answers in</p>
    </div>
  );
}

function OptionCountRow({ count, text, correct, total }: { count: number; text: string; correct: boolean; total: number }) {
  const pct = Math.round((count / total) * 100);
  return (
    <div
      className={`flex items-center justify-between rounded-xl border px-4 py-2.5 ${
        correct ? "border-emerald-700/70 bg-emerald-950/40" : "border-zinc-800 bg-zinc-900/60"
      }`}
    >
      <span className={`text-sm font-semibold ${correct ? "text-emerald-300" : "text-zinc-200"}`}>
        {correct ? "✓ " : "· "}
        {text}
      </span>
      <span className={`font-mono text-sm ${correct ? "text-emerald-300" : "text-zinc-400"}`}>
        {count} ({pct}%)
      </span>
    </div>
  );
}

function Leaderboard({ rows, highlightId }: { rows: { playerId: string; nickname: string; score: number }[]; highlightId: string }) {
  const sorted = [...rows].sort((a, b) => b.score - a.score);
  return (
    <div className="overflow-hidden rounded-xl border border-zinc-800">
      {sorted.map((p, i) => (
        <div key={p.playerId} className={`flex items-center justify-between border-b border-zinc-800 px-4 py-2.5 text-sm ${p.playerId === highlightId ? "bg-violet-950/50" : i % 2 ? "bg-zinc-900/60" : ""}`}>
          <span className="flex items-center gap-3">
            <span className={`grid h-6 w-6 place-items-center rounded-full text-xs font-bold ${i < 3 ? "bg-amber-500/20 text-amber-300" : "bg-zinc-800 text-zinc-400"}`}>{i + 1}</span>
            <span className="font-semibold text-zinc-200">{p.nickname}</span>
          </span>
          <span className="font-mono text-zinc-300">{p.score}</span>
        </div>
      ))}
    </div>
  );
}