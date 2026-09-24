"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  type GameFinishedEvent,
  type LeaderboardEntry,
  type PlayerAnswerAckEvent,
  type PlayerGameStateView,
  type PlayerQuestionResult,
  type QuestionPayload,
} from "@quiz/shared";
import { getSocket } from "../../lib/socket";

type View =
  | { kind: "connecting" }
  | { kind: "not-in-game" }
  | { kind: "error"; code: string; message: string }
  | { kind: "in-game"; state: PlayerGameStateView };

interface AnswerState {
  kind: "idle" | "submitting" | "done";
  accepted: boolean;
  reason?: string;
  optionId?: string;
}

export default function PlayPage() {
  const [view, setView] = useState<View>({ kind: "connecting" });
  const [question, setQuestion] = useState<QuestionPayload | null>(null);
  const [answer, setAnswer] = useState<AnswerState>({ kind: "idle", accepted: false });
  const [result, setResult] = useState<PlayerQuestionResult | null>(null);
  const [finished, setFinished] = useState<GameFinishedEvent | null>(null);
  const [banner, setBanner] = useState<string | null>(null);

  const sync = useCallback(() => getSocket().emit("player:sync", {}), []);

  useEffect(() => {
    const socket = getSocket();

    const onConnect = () => sync();
    const onState = (state: PlayerGameStateView) => {
      setView({ kind: "in-game", state });
      setFinished(null);
      setResult(state.questionResult);
      if (state.currentQuestion) {
        setQuestion({
          questionId: state.currentQuestion.questionId,
          questionNumber: state.currentQuestion.questionNumber,
          totalQuestions: state.currentQuestion.totalQuestions,
          text: state.currentQuestion.text,
          options: state.currentQuestion.options,
          timeLimit: state.currentQuestion.timeLimit,
          questionEndsAt: state.currentQuestion.questionEndsAt,
        });
        setAnswer(
          state.currentQuestion.alreadyAnswered
            ? { kind: "done", accepted: true, optionId: state.currentQuestion.selectedOptionId ?? undefined }
            : { kind: "idle", accepted: false },
        );
      } else {
        setAnswer({ kind: "idle", accepted: false });
      }
      setBanner(null);
    };
    const onQuestion = (payload: QuestionPayload) => {
      setQuestion(payload);
      setAnswer({ kind: "idle", accepted: false });
      setBanner(null);
      setView((prev) =>
        prev.kind === "in-game"
          ? { ...prev, state: { ...prev.state, phase: "QUESTION_ACTIVE" } }
          : prev,
      );
    };
    const onAck = (payload: PlayerAnswerAckEvent) => {
      setAnswer((prev) =>
        payload.accepted
          ? { kind: "done", accepted: true, optionId: prev.optionId }
          : { kind: "done", accepted: false, reason: payload.reason ?? "Answer rejected", optionId: prev.optionId },
      );
      void sync();
    };
    const onResult = (payload: PlayerQuestionResult) => {
      setResult(payload);
      setView((prev) =>
        prev.kind === "in-game"
          ? { ...prev, state: { ...prev.state, phase: "QUESTION_RESULTS", questionResult: payload } }
          : prev,
      );
    };
    const onFinished = (payload: GameFinishedEvent) => {
      setFinished(payload);
      setView((prev) =>
        prev.kind === "in-game"
          ? { ...prev, state: { ...prev.state, phase: "FINISHED", currentQuestion: null, leaderboard: payload.leaderboard } }
          : prev,
      );
    };
    const onError = (payload: { code: string; message: string }) => {
      if (payload.code === "NOT_IN_GAME") {
        setView({ kind: "not-in-game" });
      } else {
        setBanner(payload.message);
      }
    };

    socket.on("connect", onConnect);
    socket.on("player:state", onState);
    socket.on("game:question", onQuestion);
    socket.on("player:answer-ack", onAck);
    socket.on("player:question-result", onResult);
    socket.on("game:finished", onFinished);
    socket.on("error", onError);
    if (socket.connected) sync();

    const heartbeat = setInterval(() => {
      if (socket.connected) socket.emit("player:heartbeat", {});
    }, 15_000);

    return () => {
      clearInterval(heartbeat);
      socket.off("connect", onConnect);
      socket.off("player:state", onState);
      socket.off("game:question", onQuestion);
      socket.off("player:answer-ack", onAck);
      socket.off("player:question-result", onResult);
      socket.off("game:finished", onFinished);
      socket.off("error", onError);
    };
  }, [sync]);

  if (view.kind === "connecting") {
    return (
      <PlayShell>
        <p className="text-zinc-400">Connecting…</p>
      </PlayShell>
    );
  }

  if (view.kind === "not-in-game") {
    return (
      <PlayShell>
        <Cardish>
          <h2 className="text-xl font-bold text-zinc-100">You're not in a game</h2>
          <p className="mt-2 text-sm text-zinc-400">Join using the code your host shows on screen.</p>
          <Link href="/join" className="mt-4 inline-block rounded-xl bg-violet-600 px-5 py-2.5 text-sm font-semibold text-white">
            Grab the code
          </Link>
        </Cardish>
      </PlayShell>
    );
  }

  if (view.kind === "error") {
    return (
      <PlayShell>
        <Cardish>
          <p className="text-sm text-red-300">{view.message}</p>
          <Link href="/join" className="mt-4 inline-block text-sm text-violet-400 underline">
            Join again
          </Link>
        </Cardish>
      </PlayShell>
    );
  }

  const { state } = view;
  const phase = finished ? "FINISHED" : state.phase;
  const rank = (leaderboard: LeaderboardEntry[] | null) => {
    if (!leaderboard) return null;
    const i = leaderboard.findIndex((p) => p.playerId === state.player.playerId);
    return i === -1 ? null : i + 1;
  };
  const myCount = (board: LeaderboardEntry[] | null) => board?.find((p) => p.playerId === state.player.playerId)?.score ?? state.player.totalPoints;

  return (
    <PlayShell>
      <div className="mb-4 text-center text-sm text-zinc-500">
        <span className="font-semibold text-zinc-300">{state.quizTitle}</span>
        {" · "}
        <span className="font-mono tracking-widest">{state.joinCode}</span>
      </div>

      {banner ? (
        <div className="mx-auto mb-4 max-w-md rounded-xl border border-amber-900/60 bg-amber-950/40 px-4 py-2.5 text-center text-sm text-amber-300">
          {banner}
        </div>
      ) : null}

      {phase === "LOBBY" && (
        <div className="flex flex-col items-center gap-3">
          <h2 className="text-2xl font-black text-zinc-100">{state.joinCode}</h2>
          <p className="text-sm text-zinc-400">You're in. Waiting for the host to start…</p>
          <p className="text-sm text-zinc-500">
            {state.hostPresent ? "Host is connected" : "Waiting for the host"} · {state.player.nickname}
          </p>
          <div className="flex animate-pulse gap-1.5 pt-2">
            <Dot delay={0} />
            <Dot delay={150} />
            <Dot delay={300} />
          </div>
        </div>
      )}

      {phase === "QUESTION_ACTIVE" && question && (
        <QuestionGame
          question={question}
          answer={answer}
          onSelect={submitAnswer}
          banner={banner}
          setBanner={setBanner}
        />
      )}

      {phase === "QUESTION_RESULTS" && (
        <ResultGame result={result} state={state} />
      )}

      {phase === "FINISHED" && (
        <FinishedGame
          leaderboard={finished?.leaderboard ?? state.leaderboard ?? []}
          myId={state.player.playerId}
          myScore={myCount(finished?.leaderboard ?? state.leaderboard)}
          rank={rank(finished?.leaderboard ?? state.leaderboard)}
          quizTitle={state.quizTitle}
        />
      )}

      {phase === "QUESTION_ACTIVE" && !question ? (
        <p className="text-center text-zinc-400">Loading question…</p>
      ) : null}
    </PlayShell>
  );

  function submitAnswer(optionId: string) {
    if (!question || answer.kind !== "idle") return;
    setAnswer({ kind: "submitting", accepted: false, optionId });
    getSocket().emit("player:submit-answer", {
      gameId: state.gameId,
      questionId: question.questionId,
      optionId,
    });
  }
}

// ---------------------------------------------------------------------------

function PlayShell({ children }: { children: React.ReactNode }) {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-6 px-6">
      {children}
    </main>
  );
}

function Cardish({ children }: { children: React.ReactNode }) {
  return <div className="w-full max-w-md rounded-2xl border border-zinc-800 bg-zinc-900/50 p-6 text-center">{children}</div>;
}

function Dot({ delay }: { delay: number }) {
  return (
    <span
      style={{ animationDelay: `${delay}ms` }}
      className="h-2.5 w-2.5 animate-bounce rounded-full bg-violet-500"
    />
  );
}

function Countdown({ endsAt }: { endsAt: number }) {
  const [, force] = useState(0);
  useEffect(() => {
    const t = setInterval(() => force((n) => n + 1), 250);
    return () => clearInterval(t);
  }, []);
  const remaining = Math.max(0, Math.ceil((endsAt - Date.now()) / 1000));
  const pct = Math.min(100, (remaining / 10) * 100);
  return (
    <div>
      <div className="h-2 w-full overflow-hidden rounded-full bg-zinc-800">
        <div
          className="h-full rounded-full bg-violet-500 transition-all duration-250"
          style={{ width: `${pct}%` }}
        />
      </div>
      <p className="mt-1 text-right font-mono text-sm text-zinc-400">{remaining}s</p>
    </div>
  );
}

function QuestionGame({
  question,
  answer,
  onSelect,
  banner,
  setBanner,
}: {
  question: QuestionPayload;
  answer: AnswerState;
  onSelect: (optionId: string) => void;
  banner: string | null;
  setBanner: (m: string | null) => void;
}) {
  useEffect(() => {
    if (answer.kind === "done" && !answer.accepted) {
      setBanner(answer.reason ?? "That answer wasn't accepted");
      const t = setTimeout(() => setBanner(null), 4000);
      return () => clearTimeout(t);
    }
  }, [answer, setBanner]);

  return (
    <div className="w-full max-w-2xl">
      <div className="mb-4 flex items-center justify-between text-sm text-zinc-400">
        <span>
          Question {question.questionNumber} of {question.totalQuestions}
        </span>
        <span className={banner ? "text-amber-300" : "text-zinc-500"}>
          {banner ?? (answer.kind === "done" && answer.accepted ? "Answer locked in" : "Pick an answer")}
        </span>
      </div>
      <h2 className="mb-4 text-center text-2xl font-black leading-snug text-zinc-50">{question.text}</h2>
      <Countdown endsAt={question.questionEndsAt} />
      <div className="mt-6 grid grid-cols-1 gap-3 sm:grid-cols-2">
        {question.options.map((opt, i) => {
          const selected = answer.kind === "done" && answer.optionId === opt.id;
          const colors = ["bg-violet-600", "bg-fuchsia-600", "bg-cyan-600", "bg-emerald-600"];
          return (
            <button
              key={opt.id}
              disabled={answer.kind !== "idle"}
              onClick={() => onSelect(opt.id)}
              className={`flex min-h-28 items-center gap-3 rounded-2xl px-5 py-4 text-left text-lg font-bold text-white transition ${
                selected ? `${colors[i % colors.length]} ring-4 ring-white/40` : `${colors[i % colors.length]} hover:opacity-90`
              } disabled:opacity-60`}
            >
              <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-black/25 text-sm">{String.fromCharCode(65 + i)}</span>
              <span>{opt.text}</span>
            </button>
          );
        })}
      </div>
      {answer.kind === "submitting" ? (
        <p className="mt-4 text-center text-sm text-zinc-400">Submitting…</p>
      ) : null}
    </div>
  );
}

function ResultGame({ result, state }: { result: PlayerQuestionResult | null; state: PlayerGameStateView }) {
  return (
    <div className="flex flex-col items-center gap-4 text-center">
      {result ? (
        <>
          <div
            className={`grid h-32 w-32 place-items-center rounded-full border-8 ${
              result.isCorrect ? "border-emerald-500/60 bg-emerald-950/40" : "border-red-900/50 bg-red-950/30"
            }`}
          >
            <div>
              <p className="text-3xl font-black text-white">+{result.points}</p>
              <p className="text-xs text-zinc-400">points</p>
            </div>
          </div>
          <div>
            <p className={`text-xl font-black ${result.isCorrect ? "text-emerald-400" : "text-red-400"}`}>
              {result.isCorrect ? "Correct!" : result.selectedOptionId ? "Not quite" : "No answer"}
            </p>
            <p className="mt-1 text-sm text-zinc-400">
              {result.totalPoints} total points · {state.quizTitle}
            </p>
          </div>
        </>
      ) : (
        <p className="text-zinc-400">Waiting for results…</p>
      )}
      <div className="flex animate-pulse gap-1.5 pt-4">
        <Dot delay={0} />
        <Dot delay={150} />
        <Dot delay={300} />
      </div>
    </div>
  );
}

function FinishedGame({
  leaderboard,
  myId,
  myScore,
  rank,
  quizTitle,
}: {
  leaderboard: { playerId: string; nickname: string; score: number }[];
  myId: string;
  myScore: number;
  rank: number | null;
  quizTitle: string;
}) {
  return (
    <div className="w-full max-w-lg">
      <h2 className="text-center text-3xl font-black text-violet-400">{quizTitle} is over!</h2>
      {rank ? (
        <p className="mt-2 text-center text-lg text-zinc-300">
          You finished <span className="font-black text-white">#{rank}</span> with{" "}
          <span className="font-black text-white">{myScore}</span> points
        </p>
      ) : null}
      <div className="mt-6 overflow-hidden rounded-2xl border border-zinc-800">
        {leaderboard.map((p, i) => (
          <div
            key={p.playerId}
            className={`flex items-center justify-between border-b border-zinc-800 px-5 py-3 text-sm ${
              p.playerId === myId ? "bg-violet-950/50" : i % 2 ? "bg-zinc-900/60" : ""
            }`}
          >
            <span className="flex items-center gap-3">
              <span className={`grid h-7 w-7 place-items-center rounded-full text-xs font-bold ${i < 3 ? "bg-amber-500/20 text-amber-300" : "bg-zinc-800 text-zinc-400"}`}>
                {i + 1}
              </span>
              <span className={`font-semibold ${p.playerId === myId ? "text-violet-300" : "text-zinc-200"}`}>
                {p.nickname}
                {p.playerId === myId ? " (you)" : ""}
              </span>
            </span>
            <span className="font-mono text-zinc-300">{p.score}</span>
          </div>
        ))}
      </div>
      <div className="mt-6 text-center">
        <Link href="/join" className="text-sm text-violet-400 underline">
          Play another round
        </Link>
      </div>
    </div>
  );
}