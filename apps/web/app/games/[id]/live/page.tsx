"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import {
  type GameSessionSummaryDto,
  type HostGameStateView,
  type PlayerLobbyEntry,
  type QuizDetailDto,
} from "@quiz/shared";
import { api, ApiError } from "../../../../lib/api";
import { Button, Card, ErrorBanner } from "../../../../components/ui";
import { RequireAuth } from "../../../../components/auth";
import { HostChrome } from "../../../../components/chrome";
import { getSocket } from "../../../../lib/socket";

type HostCommand =
  | { event: "host:start-paper"; payload: { gameId: string; runId: string } }
  | { event: "host:end-paper"; payload: { gameId: string; runId: string } };

export default function HostLivePage() {
  const params = useParams<{ id: string }>();
  const gameId = params.id;
  const router = useRouter();

  const [game, setGame] = useState<GameSessionSummaryDto | null>(null);
  const [quiz, setQuiz] = useState<QuizDetailDto | null>(null);
  const [state, setState] = useState<HostGameStateView | null>(null);
  const [banner, setBanner] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const joinedRef = useRef(false);

  const loadGame = useCallback(async () => {
    try {
      const g = await api<{ game: GameSessionSummaryDto }>(`/api/games/${gameId}`);
      setGame(g.game);
      const q = await api<{ quiz: QuizDetailDto }>(`/api/quizzes/${g.game.quizId}`);
      setQuiz(q.quiz);
      if (q.quiz.questions.length === 0) {
        setBanner("This quiz has no questions yet. Add questions before hosting a paper.");
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
    getSocket().emit("host:join-game", { gameId, runId: crypto.randomUUID() });
  }, [gameId]);

  useEffect(() => {
    const socket = getSocket();

    const onConnect = () => joinedRefSet();
    const onHostState = (payload: HostGameStateView) => {
      setState(payload);
      setBanner(null);
    };
    const onPaperStarted = (payload: { deadline: number }) => {
      setState((prev) =>
        prev
          ? { ...prev, phase: "ACTIVE", deadline: payload.deadline }
          : prev,
      );
      setBanner(null);
    };
    const onPlayerUpdated = (p: PlayerLobbyEntry) => {
      setState((prev) =>
        prev ? { ...prev, players: mergePlayers(prev.players, [p]) } : prev,
      );
    };
    const onPlayerSubmitted = (p: { playerId: string; submittedCount: number }) => {
      setState((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          submittedCount: p.submittedCount,
          players: prev.players.map((player) =>
            player.playerId === p.playerId ? { ...player, submitted: true } : player,
          ),
        };
      });
    };
    const onGameFinished = (payload: { leaderboard: HostGameStateView["leaderboard"] }) => {
      setState((prev) =>
        prev
          ? { ...prev, phase: "FINISHED", deadline: null, leaderboard: payload.leaderboard }
          : prev,
      );
      setBanner(null);
    };
    const onError = (payload: { code: string; message: string }) => setBanner(payload.message);

    socket.on("connect", onConnect);
    socket.on("host:state", onHostState);
    socket.on("host:paper-started", onPaperStarted);
    socket.on("host:player-updated", onPlayerUpdated);
    socket.on("host:player-submitted", onPlayerSubmitted);
    socket.on("host:game-finished", onGameFinished);
    socket.on("error", onError);
    if (socket.connected) joinedRefSet();

    return () => {
      socket.off("connect", onConnect);
      socket.off("host:state", onHostState);
      socket.off("host:paper-started", onPaperStarted);
      socket.off("host:player-updated", onPlayerUpdated);
      socket.off("host:player-submitted", onPlayerSubmitted);
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
  const minutes = Math.round(state.timeLimitSeconds / 60);

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
          {phase === "ACTIVE" && renderActive()}
          {phase === "FINISHED" && renderFinished()}
        </div>

        <div className="mt-8 rounded-2xl border border-zinc-800/70 bg-zinc-900/30 p-4 text-sm text-zinc-500">
          <p>
            CBT-style paper · {quiz!.questions.length} question{quiz!.questions.length === 1 ? "" : "s"} ·{" "}
            {minutes} minute{minutes === 1 ? "" : "s"} total. Participants work independently; when time runs
            out, every outstanding paper is submitted automatically.
          </p>
        </div>
      </HostChrome>
    </RequireAuth>
  );

  function renderLobby() {
    return (
      <div className="flex flex-col gap-6">
        <Card>
          <p className="text-sm text-zinc-400">
            {state!.players.length} player{state!.players.length === 1 ? "" : "s"} joined so far. Share the code,
            then start the paper when everyone's in.
          </p>
          <div className="mt-4 grid gap-2 sm:grid-cols-2">
            <Stat label="Questions" value={String(quiz!.questions.length)} />
            <Stat label="Time limit" value={`${minutes} min`} />
          </div>
          {quiz!.questions.length > 0 && (
            <Button
              onClick={() =>
                send({
                  event: "host:start-paper",
                  payload: { gameId, runId: crypto.randomUUID() },
                })
              }
              disabled={busy}
              className="mt-4 w-full py-3 text-base"
            >
              Start paper ({minutes} min for {quiz!.questions.length} question{quiz!.questions.length === 1 ? "" : "s"})
            </Button>
          )}
        </Card>
        <PlayerGrid players={state!.players} />
      </div>
    );
  }

  function renderActive() {
    const deadline = state!.deadline;
    const total = Math.max(1, state!.players.length);
    return (
      <div className="flex flex-col gap-6">
        <Card>
          <div className="flex items-baseline justify-between">
            <p className="text-sm font-semibold text-zinc-400">Paper in progress</p>
            <p className="font-mono text-lg text-zinc-200">
              {state!.submittedCount}/{total} submitted
            </p>
          </div>
          <div className="mt-4">
            {deadline ? (
              <Countdown deadline={deadline} durationSeconds={state!.timeLimitSeconds} />
            ) : (
              <p className="text-sm text-zinc-500">Starting…</p>
            )}
          </div>
          <Button
            onClick={() =>
              send({ event: "host:end-paper", payload: { gameId, runId: crypto.randomUUID() } })
            }
            disabled={busy}
            variant="ghost"
            className="mt-5 w-full"
          >
            End paper now (auto-submits everyone)
          </Button>
        </Card>
        {state!.leaderboard.length > 0 && (
          <Card>
            <h3 className="mb-3 text-sm font-bold uppercase tracking-wide text-zinc-400">
              Live results (submitted)
            </h3>
            <Leaderboard rows={state!.leaderboard} highlightId="" />
          </Card>
        )}
        <PlayerGrid players={state!.players} showSubmitted />
      </div>
    );
  }

  function renderFinished() {
    return (
      <Card>
        <h2 className="text-center text-2xl font-black text-emerald-400">Paper finished!</h2>
        <p className="mt-1 text-center text-sm text-zinc-500">
          {state!.players.length} player{state!.players.length === 1 ? "" : "s"} · final scores
        </p>
        <div className="mt-5">
          <Leaderboard rows={state!.leaderboard} highlightId="" />
        </div>
        <div className="mt-6 text-center">
          <Button onClick={() => router.push("/games")}>Back to sessions</Button>
        </div>
      </Card>
    );
  }
}

// ---------------------------------------------------------------------------

function mergePlayers(existing: PlayerLobbyEntry[], updated: PlayerLobbyEntry[]) {
  const map = new Map(existing.map((p) => [p.playerId, p]));
  for (const p of updated) map.set(p.playerId, p);
  return Array.from(map.values());
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900/60 px-4 py-3">
      <p className="text-xs uppercase tracking-wide text-zinc-500">{label}</p>
      <p className="mt-0.5 text-lg font-bold text-zinc-100">{value}</p>
    </div>
  );
}

function PlayerGrid({ players, showSubmitted = false }: { players: PlayerLobbyEntry[]; showSubmitted?: boolean }) {
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
                !p.connected
                  ? "border-zinc-700 bg-zinc-900 text-zinc-500"
                  : p.submitted
                    ? "border-emerald-800/60 bg-emerald-950/30 text-emerald-200"
                    : "border-violet-800/60 bg-violet-950/30 text-violet-200"
              }`}
            >
              <span
                className={`h-2 w-2 rounded-full ${p.connected ? "bg-current" : "bg-zinc-600"}`}
              />
              {p.nickname}
              {showSubmitted && p.submitted ? (
                <span className="ml-1 rounded-full bg-emerald-500/20 px-1.5 py-0.5 text-[10px] font-bold text-emerald-300">
                  done
                </span>
              ) : null}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function Countdown({ deadline, durationSeconds }: { deadline: number; durationSeconds: number }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, []);
  const remain = Math.max(0, deadline - now);
  const pct = Math.min(100, (remain / (durationSeconds * 1000)) * 100);
  const mm = Math.floor(remain / 60_000);
  const ss = Math.floor((remain % 60_000) / 1000);
  return (
    <div>
      <div className="h-2 w-full overflow-hidden rounded-full bg-zinc-800">
        <div
          className="h-full rounded-full bg-violet-500 transition-all duration-250"
          style={{ width: `${pct}%` }}
        />
      </div>
      <p className={`mt-1 text-right font-mono text-lg ${remain < 60_000 ? "text-red-300" : "text-zinc-300"}`}>
        {String(mm).padStart(2, "0")}:{String(ss).padStart(2, "0")}
      </p>
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