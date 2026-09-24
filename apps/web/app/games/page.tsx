"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { GameSessionSummaryDto } from "@quiz/shared";
import { api, ApiError } from "../../lib/api";
import { Button, Card, ErrorBanner } from "../../components/ui";
import { RequireAuth } from "../../components/auth";
import { HostChrome } from "../../components/chrome";

function statusBadge(status: GameSessionSummaryDto["status"]) {
  const map: Record<string, string> = {
    ACTIVE: "bg-emerald-500/15 text-emerald-400 border-emerald-500/30",
    CREATED: "bg-sky-500/15 text-sky-400 border-sky-500/30",
    FINISHED: "bg-zinc-500/15 text-zinc-400 border-zinc-500/30",
    ABANDONED: "bg-red-500/15 text-red-400 border-red-500/30",
  };
  return `rounded-full border px-2.5 py-0.5 text-xs font-semibold ${map[status] ?? map.CREATED}`;
}

export default function GamesPage() {
  const router = useRouter();
  const [games, setGames] = useState<GameSessionSummaryDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api<{ games: GameSessionSummaryDto[] }>("/api/games");
      setGames(res.games);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not load games");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <RequireAuth>
      <HostChrome>
        <div className="flex items-end justify-between">
          <div>
            <h1 className="text-3xl font-black text-violet-400">Quiz sessions</h1>
            <p className="mt-1 text-sm text-zinc-500">Games you've run, and live consoles for the ones in progress.</p>
          </div>
          <Button variant="ghost" onClick={() => void load()}>
            Refresh
          </Button>
        </div>

        <div className="mt-6 flex flex-col gap-4">
          <ErrorBanner message={error} />
          {loading ? (
            <p className="text-zinc-500">Loading…</p>
          ) : games.length === 0 ? (
            <Card className="text-center text-zinc-500 py-12">
              No sessions yet. Publish a quiz and hit{" "}
              <Link href="/" className="text-violet-400 hover:underline">
                Host
              </Link>{" "}
              from the dashboard.
            </Card>
          ) : (
            games.map((g) => (
              <Card key={g.id} className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0">
                  <div className="flex items-center gap-3">
                    <h2 className="truncate text-lg font-bold text-zinc-100">{g.quizTitle}</h2>
                    <span className={`rounded-full border px-2.5 py-0.5 text-xs font-semibold ${statusBadge(g.status)}`}>
                      {g.status}
                    </span>
                  </div>
                  <p className="mt-1 text-sm text-zinc-500">
                    <span className="font-mono tracking-widest text-zinc-300">{g.joinCode}</span> · {g.playerCount} player
                    {g.playerCount === 1 ? "" : "s"} · {new Date(g.createdAt).toLocaleString()}
                  </p>
                </div>
                {(g.status === "ACTIVE" || g.status === "CREATED") && (
                  <Button onClick={() => router.push(`/games/${g.id}/live`)}>
                    Open host console
                  </Button>
                )}
              </Card>
            ))
          )}
        </div>
      </HostChrome>
    </RequireAuth>
  );
}