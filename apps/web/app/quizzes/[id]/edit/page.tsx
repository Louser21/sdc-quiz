"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import type { OptionViewDto, QuestionViewDto, QuizDetailDto } from "@quiz/shared";
import { api, ApiError } from "../../../../lib/api";
import { Button, Card, ErrorBanner, Field, Input } from "../../../../components/ui";
import { RequireAuth } from "../../../../components/auth";
import { HostChrome } from "../../../../components/chrome";

interface EditorQuestion extends QuestionViewDto {
  dirty: boolean;
}

function blankOption(): OptionViewDto {
  return { id: "", text: "", isCorrect: false };
}

export default function QuizEditorPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();

  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [status, setStatus] = useState("");
  const [questions, setQuestions] = useState<EditorQuestion[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api<{ quiz: QuizDetailDto }>(`/api/quizzes/${id}`);
      setTitle(res.quiz.title);
      setDescription(res.quiz.description ?? "");
      setStatus(res.quiz.status);
      setQuestions(
        res.quiz.questions.map((q) => ({ ...q, dirty: false })),
      );
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not load quiz");
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  function flash(msg: string) {
    setNotice(msg);
    window.setTimeout(() => setNotice(null), 2500);
  }

  async function saveMeta(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await api(`/api/quizzes/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ title, description: description || undefined }),
      });
      flash("Quiz details saved");
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not save quiz");
    }
  }

  async function togglePublish() {
    try {
      await api(`/api/quizzes/${id}/${status === "PUBLISHED" ? "unpublish" : "publish"}`, {
        method: "POST",
      });
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not change status");
    }
  }

  function patchQuestion(index: number, patch: Partial<EditorQuestion>) {
    setQuestions((qs) => qs.map((q, i) => (i === index ? { ...q, ...patch, dirty: true } : q)));
  }

  function patchOption(qIndex: number, oIndex: number, patch: Partial<OptionViewDto>) {
    setQuestions((qs) =>
      qs.map((q, i) =>
        i === qIndex
          ? { ...q, dirty: true, options: q.options.map((o, j) => (j === oIndex ? { ...o, ...patch } : o)) }
          : q,
      ),
    );
  }

  async function saveQuestion(index: number) {
    const q = questions[index];
    if (!q) return;
    if (q.options.length < 2) {
      setError("Each question needs at least 2 options");
      return;
    }
    const body = {
      text: q.text,
      timeLimit: q.timeLimit,
      options: q.options.map((o) => ({ text: o.text, isCorrect: o.isCorrect })),
    };
    setSaving(true);
    setError(null);
    try {
      if (q.id) {
        await api(`/api/questions/${q.id}`, { method: "PATCH", body: JSON.stringify(body) });
      } else {
        await api(`/api/quizzes/${id}/questions`, { method: "POST", body: JSON.stringify(body) });
      }
      flash("Question saved");
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not save question");
    } finally {
      setSaving(false);
    }
  }

  async function deleteQuestion(index: number) {
    const q = questions[index];
    if (!q || !q.id) {
      setQuestions((qs) => qs.filter((_, i) => i !== index));
      return;
    }
    if (!window.confirm("Delete this question?")) return;
    try {
      await api(`/api/questions/${q.id}`, { method: "DELETE" });
      flash("Question deleted");
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not delete question");
    }
  }

  async function moveQuestion(index: number, dir: -1 | 1) {
    const target = index + dir;
    if (target < 0 || target >= questions.length) return;
    const ids = questions.map((q) => q.id).filter(Boolean);
    const next = [...questions];
    [next[index], next[target]] = [next[target]!, next[index]!];
    if (!next[index]?.id || !next[target]?.id) {
      setQuestions(next);
      return;
    }
    const orderedIds = next.map((q) => q.id);
    try {
      await api(`/api/quizzes/${id}/questions/reorder`, {
        method: "POST",
        body: JSON.stringify({ questionIds: orderedIds }),
      });
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not reorder questions");
    }
  }

  function addQuestion() {
    setQuestions((qs) => [
      ...qs,
      { id: "", text: "", position: qs.length, timeLimit: 20, options: [blankOption(), blankOption()], dirty: false },
    ]);
  }

  if (loading) {
    return (
      <RequireAuth>
        <HostChrome>
          <p className="text-zinc-500">Loading…</p>
        </HostChrome>
      </RequireAuth>
    );
  }

  return (
    <RequireAuth>
      <HostChrome>
        <div className="flex items-center justify-between">
        <h1 className="text-3xl font-black text-violet-400">Edit quiz</h1>
        <Button variant="ghost" onClick={() => router.push("/dashboard")}>
          Back to dashboard
        </Button>
      </div>

      <div className="mt-6 flex flex-col gap-6">
        <ErrorBanner message={error} />
        {notice ? <div className="text-sm text-emerald-400">{notice}</div> : null}

        <Card>
          <form onSubmit={saveMeta} className="flex flex-col gap-4">
            <div className="flex items-center justify-between gap-4">
              <span className="rounded-full border border-zinc-700 px-2.5 py-0.5 text-xs font-semibold text-zinc-300">
                {status}
              </span>
              <Button variant="ghost" type="button" onClick={() => void togglePublish()}>
                {status === "PUBLISHED" ? "Unpublish" : "Publish"}
              </Button>
            </div>
            <Field label="Title">
              <Input value={title} maxLength={120} onChange={(e) => setTitle(e.target.value)} />
            </Field>
            <Field label="Description">
              <Input
                value={description}
                maxLength={280}
                onChange={(e) => setDescription(e.target.value)}
              />
            </Field>
            <div>
              <Button type="submit">Save details</Button>
            </div>
          </form>
        </Card>

        <div className="flex items-center justify-between">
          <h2 className="text-xl font-bold text-zinc-200">Questions</h2>
          <Button onClick={addQuestion}>Add question</Button>
        </div>

        {questions.map((q, i) => (
          <Card key={q.id || `new-${i}`}>
            <div className="flex flex-col gap-4">
              <div className="flex items-center justify-between gap-3">
                <span className="rounded-lg bg-violet-600/20 px-2.5 py-1 text-sm font-bold text-violet-300">
                  Q{i + 1}
                </span>
                <div className="flex gap-2">
                  <Button variant="ghost" onClick={() => void moveQuestion(i, -1)} disabled={i === 0}>
                    ↑
                  </Button>
                  <Button variant="ghost" onClick={() => void moveQuestion(i, 1)} disabled={i === questions.length - 1}>
                    ↓
                  </Button>
                  <Button variant="danger" onClick={() => void deleteQuestion(i)}>
                    Delete
                  </Button>
                </div>
              </div>

              <div className="grid gap-4 sm:grid-cols-[1fr_120px]">
                <Field label="Question text">
                  <Input
                    value={q.text}
                    maxLength={500}
                    onChange={(e: React.ChangeEvent<HTMLInputElement>) => patchQuestion(i, { text: e.target.value })}
                    placeholder="What is the capital of France?"
                  />
                </Field>
                <Field label="Time limit (s)">
                  <Input
                    type="number"
                    min={3}
                    max={600}
                    value={q.timeLimit}
                    onChange={(e: React.ChangeEvent<HTMLInputElement>) => patchQuestion(i, { timeLimit: Number(e.target.value) || 3 })}
                  />
                </Field>
              </div>

              <div className="flex flex-col gap-2">
                {q.options.map((o, j) => (
                  <div key={o.id || `o-${j}`} className="flex items-center gap-2">
                    <input
                      type="radio"
                      name={`correct-${q.id || i}`}
                      checked={o.isCorrect}
                      onChange={() =>
                        patchQuestion(i, {
                          options: q.options.map((opt, k) => ({ ...opt, isCorrect: k === j })),
                        })
                      }
                      className="h-4 w-4 accent-violet-500"
                      title="Mark correct"
                    />
                    <Input
                      value={o.text}
                      maxLength={200}
                      onChange={(e: React.ChangeEvent<HTMLInputElement>) => patchOption(i, j, { text: e.target.value })}
                      placeholder={`Option ${j + 1}`}
                    />
                    {q.options.length > 2 ? (
                      <button
                        type="button"
                        onClick={() =>
                          setQuestions((qs) =>
                            qs.map((qq, qi) =>
                              qi === i
                                ? { ...qq, dirty: true, options: qq.options.filter((_, k) => k !== j) }
                                : qq,
                            ),
                          )
                        }
                        className="shrink-0 text-sm text-zinc-500 hover:text-red-400"
                        aria-label="Remove option"
                      >
                        ✕
                      </button>
                    ) : null}
                  </div>
                ))}
                {q.options.length < 6 ? (
                  <button
                    type="button"
                    onClick={() => patchQuestion(i, { options: [...q.options, blankOption()] })}
                    className="text-sm text-violet-400 hover:underline w-fit"
                  >
                    + Add option
                  </button>
                ) : null}
                <p className="text-xs text-zinc-600">Select the radio of the correct option. 2–6 options.</p>
              </div>

              <div>
                <Button onClick={() => void saveQuestion(i)} disabled={saving || !q.dirty}>
                  {saving ? "Saving…" : q.id ? "Save question" : "Create question"}
                </Button>
              </div>
            </div>
          </Card>
        ))}

        {questions.length === 0 ? (
          <p className="text-center text-zinc-500">
            No questions yet. <Link href="#" onClick={(e) => { e.preventDefault(); addQuestion(); }} className="text-violet-400 hover:underline">Add your first question</Link>.
          </p>
        ) : null}
      </div>
      </HostChrome>
    </RequireAuth>
  );
}