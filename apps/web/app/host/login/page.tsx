"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { UserDto } from "@quiz/shared";
import { api, ApiError } from "../../../lib/api";
import { Button, Card, ErrorBanner, Field, Input } from "../../../components/ui";
import { useAuth } from "../../../components/auth";

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const router = useRouter();
  const { refresh } = useAuth();

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await api<{ user: UserDto }>("/api/auth/login", {
        method: "POST",
        body: JSON.stringify({ email, password }),
      });
      await refresh();
      router.replace("/dashboard");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Login failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-md">
      <h1 className="mb-1 text-3xl font-black text-violet-400">Host log in</h1>
      <p className="mb-8 text-sm text-zinc-500">Log in to manage and run your quizzes.</p>
      <Card>
        <form onSubmit={submit} className="flex flex-col gap-5">
          <ErrorBanner message={error} />
          <Field label="Email">
            <Input
              type="email"
              required
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
            />
          </Field>
          <Field label="Password">
            <Input
              type="password"
              required
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
            />
          </Field>
          <Button type="submit" disabled={busy}>
            {busy ? "Logging in…" : "Log in"}
          </Button>
        </form>
        <p className="mt-5 text-sm text-zinc-400">
          New here?{" "}
          <Link href="/host/register" className="text-violet-400 hover:underline">
            Create a host account
          </Link>
        </p>
      </Card>
    </div>
  );
}