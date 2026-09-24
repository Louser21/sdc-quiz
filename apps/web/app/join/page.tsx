"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import type { PlayerJoinResultDto } from "@quiz/shared";
import { api, ApiError } from "../../lib/api";
import { Button, Card, ErrorBanner, Field, Input } from "../../components/ui";
import { GuestNav } from "../../components/chrome";
import { dropSocket } from "../../lib/socket";

interface LiveSession {
  playerId: string;
  gameId: string;
  joinCode: string;
  quizTitle: string;
  phase: string;
  nickname: string;
}

export default function JoinPage() {
  const router = useRouter();
  const [gameCode, setGameCode] = useState("");
  const [nickname, setNickname] = useState("");
  const [joining, setJoining] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [me, setMe] = useState<LiveSession | null>(null);
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await api<{ me: LiveSession | null }>("/api/play/me");
        if (!cancelled) setMe(res.me);
      } catch {
        if (!cancelled) setMe(null);
      } finally {
        if (!cancelled) setChecking(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function join(ev: React.FormEvent) {
    ev.preventDefault();
    setJoining(true);
    setError(null);
    try {
      const res = await api<{ join: PlayerJoinResultDto }>("/api/play/join", {
        method: "POST",
        body: JSON.stringify({ gameCode: gameCode.trim().toUpperCase(), nickname }),
      });
      if (res.join) {
        dropSocket();
        sessionStorage.setItem("quiz.join", timestamped(JSON.stringify(res.join)));
        router.push("/play");
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not join that game");
    } finally {
      setJoining(false);
    }
  }

  return (
    <div className="min-h-screen">
      <GuestNav />
      <main className="flex min-h-[80vh] flex-col items-center justify-center gap-6 px-6">
      <div className="text-center">
        <h1 className="text-4xl font-black tracking-tight text-violet-400">Quiz Live</h1>
        <p className="mt-2 text-sm text-zinc-500">Enter the join code your host shares to play along.</p>
      </div>

      <Card className="w-full max-w-sm">
        {!checking && me ? (
          <div className="mb-4 rounded-xl border border-violet-800/60 bg-violet-950/40 p-4">
            <p className="text-sm font-semibold text-violet-200">
              Already playing as <span className="font-black">{me.nickname}</span>
            </p>
            <p className="mt-1 text-xs text-zinc-400">
              {me.quizTitle} · code <span className="font-mono text-zinc-300">{me.joinCode}</span>
              {me.phase === "ACTIVE" ? " · in progress" : " · waiting to start"}
            </p>
            <Button className="mt-3 w-full" onClick={() => router.push("/play")}>
              Continue your paper
            </Button>
          </div>
        ) : null}
        <form onSubmit={join} className="flex flex-col gap-4">
          <ErrorBanner message={error} />
          <Field label="Game code">
            <Input
              value={gameCode}
              onChange={(e) => setGameCode(e.target.value.toUpperCase())}
              placeholder="ABCDEF"
              maxLength={6}
              autoCapitalize="characters"
              autoComplete="off"
              className="text-center text-2xl font-black tracking-[0.5em] uppercase"
            />
          </Field>
          <Field label="Nickname">
            <Input
              value={nickname}
              onChange={(e) => setNickname(e.target.value)}
              placeholder="Ms. Petty"
              maxLength={24}
            />
          </Field>
          <Button type="submit" disabled={joining || gameCode.length !== 6 || nickname.trim().length === 0}>
            {joining ? "Joining…" : "Join game"}
          </Button>
        </form>
      </Card>
      </main>
    </div>
  );
}

function timestamped(json: string): string {
  return JSON.stringify({ at: Date.now(), value: JSON.parse(json) });
}