"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { QuizSummaryDto } from "@quiz/shared";
import { api, ApiError } from "../../lib/api";
import { Button, Card, ErrorBanner } from "../../components/ui";
import { RequireAuth } from "../../components/auth";
import { HostChrome } from "../../components/chrome";

function statusColor(status: string) {
  if (status === "PUBLISHED") return "bg-emerald-500/15 text-emerald-400 border-emerald-500/30";
  if (status === "ARCHIVED") return "bg-zinc-500/15 text-zinc-400 border-zinc-500/30";
  return "bg-amber-500/15 text-amber-400 border-amber-500/30";
}

export default function DashboardPage() {
  const router = useRouter();
  const [quizzes, setQuizzes] = useState<QuizSummaryDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api<{ quizzes: QuizSummaryDto[] }>("/api/quizzes");
      setQuizzes(res.quizzes);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not load quizzes");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function togglePublish(q: QuizSummaryDto) {
    try {
      await api(`/api/quizzes/${q.id}/${q.status === "PUBLISHED" ? "unpublish" : "publish"}`, {
        method: "POST",
      });
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Action failed");
    }
  }

  async function duplicate(q: QuizSummaryDto) {
    try {
      await api(`/api/quizzes/${q.id}/duplicate`, { method: "POST" });
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not duplicate");
    }
  }

  async function remove(q: QuizSummaryDto) {
    if (!window.confirm(`Delete "${q.title}"? This cannot be undone.`)) return;
    try {
      await api(`/api/quizzes/${q.id}`, { method: "DELETE" });
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not delete");
    }
  }

  async function hostQuiz(q: QuizSummaryDto) {
    if (q.status !== "PUBLISHED") return;
    try {
      const res = await api<{ game: { id: string } }>("/api/games", {
        method: "POST",
        body: JSON.stringify({ quizId: q.id }),
      });
      router.push(`/games/${res.game.id}/live`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not start a game");
    }
  }

  return (
    <RequireAuth>
      <HostChrome>
        <div className="flex items-end justify-between">
        <div className="text-center">
          <h1 className="text-3xl font-black text-violet-400">My quizzes</h1>
        </div>
        <Button
          onClick={() => router.push("/quizzes/new")}
          className="px-6 py-2.5 text-base"
        >
          New quiz
        </Button>
      </div>

      <div className="mt-8 flex flex-col gap-4">
        <ErrorBanner message={error} />
        {loading ? (
          <p className="text-zinc-500">Loading…</p>
        ) : quizzes.length === 0 ? (
          <Card className="text-center text-zinc-500 py-12">
            No quizzes yet.{" "}
            <Link href="/quizzes/new" className="text-violet-400 hover:underline">
              Create your first quiz
            </Link>
            .
          </Card>
        ) : (
          quizzes.map((q) => (
            <Card key={q.id} className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0">
                <div className="flex items-center gap-3">
                  <h2 className="truncate text-lg font-bold text-zinc-100">{q.title}</h2>
                  <span className={`rounded-full border px-2.5 py-0.5 text-xs font-semibold ${statusColor(q.status)}`}>
                    {q.status}
                  </span>
                </div>
                <p className="mt-1 text-sm text-zinc-500">
                  {q.questionCount} question{q.questionCount === 1 ? "" : "s"}
                  {q.description ? ` · ${q.description}` : ""}
                </p>
              </div>
              <div className="flex shrink-0 flex-wrap gap-2">
                {q.status === "PUBLISHED" && (
                  <Button onClick={() => void hostQuiz(q)} className="bg-emerald-600 hover:bg-emerald-500">
                    Host
                  </Button>
                )}
                <Button variant="ghost" onClick={() => router.push(`/quizzes/${q.id}/edit`)}>
                  Edit
                </Button>
                <Button variant="ghost" onClick={() => void togglePublish(q)}>
                  {q.status === "PUBLISHED" ? "Unpublish" : "Publish"}
                </Button>
                <Button variant="ghost" onClick={() => void duplicate(q)}>
                  Duplicate
                </Button>
                <Button variant="danger" onClick={() => void remove(q)}>
                  Delete
                </Button>
              </div>
            </Card>
          ))
        )}
      </div>
      </HostChrome>
    </RequireAuth>
  );
}