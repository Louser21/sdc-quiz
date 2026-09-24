"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  type GameFinishedEvent,
  type PlayerGameStateView,
  type PlayerScorecard,
  type PlayerSetAnswerAckEvent,
} from "@quiz/shared";
import { getSocket } from "../../lib/socket";

type View =
  | { kind: "connecting" }
  | { kind: "not-in-game" }
  | { kind: "error"; code: string; message: string }
  | { kind: "in-game"; state: PlayerGameStateView };

export default function PlayPage() {
  const [view, setView] = useState<View>({ kind: "connecting" });
  const [index, setIndex] = useState(0);
  const [banner, setBanner] = useState<string | null>(null);
  const [confirmSubmit, setConfirmSubmit] = useState(false);
  const [finished, setFinished] = useState<GameFinishedEvent | null>(null);

  const sync = useCallback(() => getSocket().emit("player:sync", {}), []);

  const applyLocalAnswer = useCallback((questionId: string, optionId: string) => {
    setView((prev) =>
      prev.kind === "in-game"
        ? {
            ...prev,
            state: {
              ...prev.state,
              selections: { ...prev.state.selections, [questionId]: optionId },
            },
          }
        : prev,
    );
  }, []);

  useEffect(() => {
    const socket = getSocket();

    let bannerTimer: ReturnType<typeof setTimeout> | undefined;

    const onConnect = () => sync();
    const onState = (state: PlayerGameStateView) => {
      setView({ kind: "in-game", state });
      setFinished(null);
      setIndex((i) => (state.questions.length > 0 && i < state.questions.length ? i : 0));
      setBanner(null);
    };
    const onAck = (payload: PlayerSetAnswerAckEvent) => {
      if (!payload.accepted) {
        setBanner(payload.reason ?? "That change wasn't accepted");
        if (bannerTimer) clearTimeout(bannerTimer);
        bannerTimer = setTimeout(() => setBanner(null), 4000);
      }
    };
    const onScorecard = (payload: PlayerScorecard) => {
      setView((prev) =>
        prev.kind === "in-game"
          ? {
              ...prev,
              state: {
                ...prev.state,
                player: { ...prev.state.player, submitted: true },
                scorecard: payload,
              },
            }
          : prev,
      );
      setConfirmSubmit(false);
      setBanner(null);
    };
    const onFinished = (payload: GameFinishedEvent) => {
      setFinished(payload);
      setView((prev) =>
        prev.kind === "in-game"
          ? {
              ...prev,
              state: {
                ...prev.state,
                phase: "FINISHED",
                player: { ...prev.state.player, submitted: prev.state.player.submitted || prev.state.scorecard !== null },
                scorecard: prev.state.scorecard,
                leaderboard: payload.leaderboard,
              },
            }
          : prev,
      );
      setConfirmSubmit(false);
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
    socket.on("player:set-answer-ack", onAck);
    socket.on("player:scorecard", onScorecard);
    socket.on("game:finished", onFinished);
    socket.on("error", onError);
    if (socket.connected) sync();

    const heartbeat = setInterval(() => {
      if (socket.connected) socket.emit("player:heartbeat", {});
    }, 15_000);

    return () => {
      clearInterval(heartbeat);
      if (bannerTimer) clearTimeout(bannerTimer);
      socket.off("connect", onConnect);
      socket.off("player:state", onState);
      socket.off("player:set-answer-ack", onAck);
      socket.off("player:scorecard", onScorecard);
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
          <h2 className="text-xl font-bold text-zinc-100">You're not in a paper</h2>
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
  const mySubmitted = state.player.submitted || state.scorecard !== null;

  return (
    <PlayShell>
      <header className="w-full max-w-3xl">
        <div className="flex items-center justify-between gap-4 border-b border-zinc-800 pb-3">
          <div>
            <p className="text-sm font-semibold text-zinc-300">{state.quizTitle}</p>
            <p className="font-mono text-xs tracking-widest text-zinc-500">{state.joinCode}</p>
          </div>
          {phase === "ACTIVE" && state.deadline && !mySubmitted ? (
            <Countdown deadline={state.deadline} durationSeconds={state.timeLimitSeconds} />
          ) : null}
          {phase === "ACTIVE" && mySubmitted ? (
            <span className="rounded-full border border-emerald-800/60 bg-emerald-950/40 px-3 py-1 text-xs font-bold text-emerald-300">
              Submitted
            </span>
          ) : null}
        </div>
      </header>

      {banner ? (
        <div className="mx-auto mt-4 max-w-3xl rounded-xl border border-amber-900/60 bg-amber-950/40 px-4 py-2.5 text-center text-sm text-amber-300">
          {banner}
        </div>
      ) : null}

      {phase === "LOBBY" && <Lobby state={state} />}
      {phase === "ACTIVE" && !mySubmitted && (
        <Paper
          state={state}
          index={index}
          setIndex={setIndex}
          confirmSubmit={confirmSubmit}
          setConfirmSubmit={setConfirmSubmit}
          onLocalAnswer={applyLocalAnswer}
        />
      )}
      {phase === "ACTIVE" && mySubmitted && (
        <ScorecardWait scorecard={state.scorecard} totalQuestions={state.questions.length} />
      )}
      {phase === "FINISHED" && (
        <Final
          state={state}
          finished={finished}
          mySubmitted={mySubmitted}
          myScorecard={state.scorecard}
        />
      )}
    </PlayShell>
  );
}

// ---------------------------------------------------------------------------

function PlayShell({ children }: { children: React.ReactNode }) {
  return (
    <main className="flex min-h-screen flex-col items-center gap-6 px-6 py-8">
      {children}
    </main>
  );
}

function Cardish({ children }: { children: React.ReactNode }) {
  return (
    <div className="w-full max-w-md rounded-2xl border border-zinc-800 bg-zinc-900/50 p-6 text-center">
      {children}
    </div>
  );
}

function Lobby({ state }: { state: PlayerGameStateView }) {
  return (
    <div className="flex flex-col items-center gap-3 pt-10">
      <h2 className="font-mono text-4xl font-black tracking-[0.3em] text-zinc-100">{state.joinCode}</h2>
      <p className="text-sm text-zinc-400">You're in. Waiting for the host to start the paper…</p>
      <p className="text-sm text-zinc-500">
        {state.hostPresent ? "Host is connected" : "Waiting for the host"} · {state.player.nickname} ·{" "}
        {state.questions.length} question{state.questions.length === 1 ? "" : "s"}
      </p>
      <div className="flex animate-pulse gap-1.5 pt-2">
        <Dot delay={0} />
        <Dot delay={150} />
        <Dot delay={300} />
      </div>
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
  const mm = String(Math.floor(remain / 60_000)).padStart(2, "0");
  const ss = String(Math.floor((remain % 60_000) / 1000)).padStart(2, "0");
  return (
    <div className="flex items-center gap-3">
      <div className="h-1.5 w-28 overflow-hidden rounded-full bg-zinc-800">
        <div
          className={`h-full rounded-full transition-all duration-250 ${remain < 60_000 ? "bg-red-500" : "bg-violet-500"}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <p className={`font-mono text-lg tabular-nums ${remain < 60_000 ? "text-red-300" : "text-zinc-200"}`}>
        {mm}:{ss}
      </p>
    </div>
  );
}

function Paper({
  state,
  index,
  setIndex,
  confirmSubmit,
  setConfirmSubmit,
  onLocalAnswer,
}: {
  state: PlayerGameStateView;
  index: number;
  setIndex: (i: number) => void;
  confirmSubmit: boolean;
  setConfirmSubmit: (b: boolean) => void;
  onLocalAnswer: (questionId: string, optionId: string) => void;
}) {
  const question = state.questions[index];
  const answeredCount = useMemo(
    () => state.questions.filter((q) => state.selections[q.questionId]).length,
    [state.selections],
  );
  const selected = question ? state.selections[question.questionId] : undefined;
  const marked = question ? state.marked[question.questionId] : false;

  if (!question) {
    return <p className="text-zinc-400">The paper is starting…</p>;
  }

  function choose(optionId: string) {
    if (selected === optionId) return;
    getSocket().emit("player:set-answer", {
      gameId: state.gameId,
      questionId: question.questionId,
      optionId,
    });
    onLocalAnswer(question.questionId, optionId);
  }

  return (
    <div className="w-full max-w-3xl">
      <Palette
        state={state}
        index={index}
        onNavigate={setIndex}
      />
      <div className="mt-4 flex items-center justify-between text-sm text-zinc-400">
        <span>
          Question {question.questionNumber} of {question.totalQuestions}
        </span>
        <span>{answeredCount} answered</span>
      </div>
      <div className="mt-2 rounded-2xl border border-zinc-800 bg-zinc-900/50 p-6">
        <h2 className="mb-5 text-xl font-black leading-snug text-zinc-50 sm:text-2xl">{question.text}</h2>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {question.options.map((opt, i) => {
            const isSelected = selected === opt.id;
            const letter = String.fromCharCode(65 + i);
            return (
              <button
                key={opt.id}
                onClick={() => choose(opt.id)}
                className={`flex min-h-24 items-center gap-3 rounded-2xl border px-4 py-3 text-left transition ${
                  isSelected
                    ? "border-violet-500 bg-violet-950/40 ring-2 ring-violet-500/40"
                    : "border-zinc-700/70 bg-zinc-800/40 hover:border-zinc-500"
                }`}
              >
                <span
                  className={`grid h-8 w-8 shrink-0 place-items-center rounded-lg text-sm font-black ${
                    isSelected ? "bg-violet-500 text-white" : "bg-zinc-700 text-zinc-300"
                  }`}
                >
                  {letter}
                </span>
                <span className={`text-base font-semibold ${isSelected ? "text-violet-100" : "text-zinc-200"}`}>
                  {opt.text}
                </span>
              </button>
            );
          })}
        </div>

        <div className="mt-6 flex flex-wrap items-center justify-between gap-3 pb-2">
          <button
            type="button"
            onClick={() => setConfirmSubmit(true)}
            className="rounded-xl bg-emerald-600 px-5 py-2.5 text-sm font-bold text-white transition hover:bg-emerald-500"
          >
            Submit paper
          </button>
          <button
            type="button"
            onClick={() =>
              getSocket().emit("player:mark-review", {
                gameId: state.gameId,
                questionId: question.questionId,
                marked: !marked,
              })
            }
            className={`rounded-xl border px-4 py-2.5 text-sm font-semibold transition ${
              marked
                ? "border-amber-500/70 bg-amber-950/40 text-amber-300"
                : "border-zinc-700 text-zinc-400 hover:border-zinc-500"
            }`}
          >
            {marked ? "★ Marked for review" : "☆ Mark for review"}
          </button>
        </div>
      </div>

      <div className="mt-4 flex items-center justify-between">
        <ButtonGhost disabled={index === 0} onClick={() => setIndex(index - 1)}>
          ← Previous
        </ButtonGhost>
        <ButtonGhost
          disabled={index >= state.questions.length - 1}
          onClick={() => setIndex(index + 1)}
        >
          Next →
        </ButtonGhost>
      </div>

      {confirmSubmit && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/70 px-6">
          <div className="w-full max-w-md rounded-2xl border border-zinc-700 bg-zinc-900 p-6">
            <h3 className="text-lg font-bold text-zinc-100">Submit your paper?</h3>
            <p className="mt-2 text-sm text-zinc-400">
              You've answered {answeredCount} of {state.questions.length} questions. After submitting you
              can't change anything.
            </p>
            <div className="mt-5 flex gap-3">
              <button
                onClick={() => setConfirmSubmit(false)}
                className="flex-1 rounded-xl border border-zinc-700 px-4 py-2.5 text-sm font-semibold text-zinc-300 hover:border-zinc-500"
              >
                Keep working
              </button>
              <button
                onClick={() => getSocket().emit("player:submit-paper", { gameId: state.gameId })}
                className="flex-1 rounded-xl bg-emerald-600 px-4 py-2.5 text-sm font-bold text-white hover:bg-emerald-500"
              >
                Submit
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Palette({
  state,
  index,
  onNavigate,
}: {
  state: PlayerGameStateView;
  index: number;
  onNavigate: (i: number) => void;
}) {
  return (
    <nav className="flex flex-wrap gap-1.5">
      {state.questions.map((q, i) => {
        const answered = Boolean(state.selections[q.questionId]);
        const marked = Boolean(state.marked[q.questionId]);
        const current = i === index;
        return (
          <button
            key={q.questionId}
            onClick={() => onNavigate(i)}
            className={`relative grid h-9 w-9 place-items-center rounded-lg text-sm font-bold transition ${
              current
                ? "bg-violet-500 text-white ring-2 ring-violet-300/60"
                : answered
                  ? "bg-emerald-900/70 text-emerald-200"
                  : "bg-zinc-800 text-zinc-300 hover:bg-zinc-700"
            }`}
          >
            {i + 1}
            {marked && !current ? (
              <span className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-amber-400" />
            ) : null}
          </button>
        );
      })}
    </nav>
  );
}

function ButtonGhost({
  children,
  disabled,
  onClick,
}: {
  children: React.ReactNode;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="rounded-xl border border-zinc-700 px-4 py-2 text-sm font-semibold text-zinc-300 transition hover:border-zinc-500 disabled:opacity-40"
    >
      {children}
    </button>
  );
}

function ScorecardWait({
  scorecard,
  totalQuestions,
}: {
  scorecard: PlayerScorecard | null;
  totalQuestions: number;
}) {
  return (
    <div className="flex w-full max-w-md flex-col items-center gap-4 pt-10 text-center">
      <ScorecardCard scorecard={scorecard} totalQuestions={totalQuestions} />
      <p className="text-sm text-zinc-400">You've submitted. Waiting for the paper to finish…</p>
      <div className="flex animate-pulse gap-1.5 pt-2">
        <Dot delay={0} />
        <Dot delay={150} />
        <Dot delay={300} />
      </div>
    </div>
  );
}

function Final({
  state,
  finished,
  mySubmitted,
  myScorecard,
}: {
  state: PlayerGameStateView;
  finished: GameFinishedEvent | null;
  mySubmitted: boolean;
  myScorecard: PlayerScorecard | null;
}) {
  const leaderboard = finished?.leaderboard ?? state.leaderboard ?? [];
  const myId = state.player.playerId;
  const myScore = myScorecard?.score ?? leaderboard.find((p) => p.playerId === myId)?.score ?? 0;
  const rank = leaderboard.findIndex((p) => p.playerId === myId) + 1;
  return (
    <div className="flex w-full max-w-lg flex-col items-center gap-4">
      <h2 className="text-center text-3xl font-black text-violet-400">{state.quizTitle} is over!</h2>
      {mySubmitted && <ScorecardCard scorecard={myScorecard} totalQuestions={state.questions.length} />}
      <p className="text-center text-lg text-zinc-300">
        {rank > 0 ? (
          <>
            You finished <span className="font-black text-white">#{rank}</span> with{" "}
            <span className="font-black text-white">{myScore}</span> points
          </>
        ) : (
          <>Paper finished · {leaderboard.length} participant{leaderboard.length === 1 ? "" : "s"}</>
        )}
      </p>
      <div className="w-full overflow-hidden rounded-2xl border border-zinc-800">
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
      <div className="mt-2 flex items-center gap-4">
        <Link href="/" className="text-sm text-zinc-500 underline hover:text-zinc-300">
          Home
        </Link>
        <Link href="/join" className="text-sm text-violet-400 underline">
          Play another round
        </Link>
      </div>
    </div>
  );
}

function ScorecardCard({
  scorecard,
  totalQuestions,
}: {
  scorecard: PlayerScorecard | null;
  totalQuestions: number;
}) {
  if (!scorecard) return null;
  const pct = totalQuestions > 0 ? Math.round((scorecard.correctCount / totalQuestions) * 100) : 0;
  return (
    <div className="flex w-full max-w-md items-center gap-5 rounded-2xl border border-emerald-900/60 bg-emerald-950/30 px-6 py-5">
      <div className="grid h-20 w-20 shrink-0 place-items-center rounded-full border-8 border-emerald-500/50 bg-emerald-900/40">
        <span className="text-2xl font-black text-white">{scorecard.score}</span>
      </div>
      <div className="text-left">
        <p className="text-sm font-bold uppercase tracking-wide text-emerald-300">Your score</p>
        <p className="mt-1 text-sm text-zinc-300">
          {scorecard.correctCount} of {totalQuestions} correct ({pct}%)
        </p>
      </div>
    </div>
  );
}

function Dot({ delay }: { delay: number }) {
  return (
    <span
      style={{ animationDelay: `${delay}ms` }}
      className="h-2.5 w-2.5 animate-bounce rounded-full bg-violet-500"
    />
  );
}