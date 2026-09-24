"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { QuizSummaryDto } from "@quiz/shared";
import { api, ApiError } from "../../../lib/api";
import { Button, Card, ErrorBanner, Field, Input } from "../../../components/ui";
import { RequireAuth } from "../../../components/auth";
import { HostChrome } from "../../../components/chrome";

export default function NewQuizPage() {
  const router = useRouter();
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [timeLimitMinutes, setTimeLimitMinutes] = useState(10);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const res = await api<{ quiz: QuizSummaryDto }>("/api/quizzes", {
        method: "POST",
        body: JSON.stringify({
          title,
          description: description || undefined,
          timeLimitSeconds: timeLimitMinutes * 60,
        }),
      });
      router.replace(`/quizzes/${res.quiz.id}/edit`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not create quiz");
      setBusy(false);
    }
  }

  return (
    <RequireAuth>
      <HostChrome>
        <div className="mx-auto max-w-lg">
        <h1 className="mb-1 text-3xl font-black text-violet-400">New quiz</h1>
        <p className="mb-8 text-sm text-zinc-500">Give it a name, then add your first question.</p>
        <Card>
          <form onSubmit={submit} className="flex flex-col gap-5">
            <ErrorBanner message={error} />
            <Field label="Title">
              <Input
                required
                maxLength={120}
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="History of the Internet"
              />
            </Field>
            <Field label="Description (optional)">
              <Input
                value={description}
                maxLength={280}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="JEE-Mains-style MCQ paper"
              />
            </Field>
            <Field label="Total time for the paper (minutes)">
              <Input
                type="number"
                min={1}
                max={120}
                step={1}
                value={timeLimitMinutes}
                onChange={(e) => setTimeLimitMinutes(Number(e.target.value) || 10)}
              />
              <p className="text-xs text-zinc-600">You can change this later in the editor.</p>
            </Field>
            <div className="flex gap-3">
              <Button variant="ghost" type="button" onClick={() => router.push("/dashboard")}>
                Cancel
              </Button>
              <Button type="submit" disabled={busy || !title.trim()}>
                {busy ? "Creating…" : "Create & add questions"}
              </Button>
            </div>
          </form>
        </Card>
      </div>
      </HostChrome>
    </RequireAuth>
  );
}