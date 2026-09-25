"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useAuth } from "./auth";
import { api } from "../lib/api";

/** Top bar with brand + optional session actions (logout when signed in). */
export function HostNav() {
  const { user, refresh, loading } = useAuth();
  const router = useRouter();

  async function logout() {
    await api<{ ok: boolean }>("/api/auth/logout", { method: "POST" });
    await refresh();
    router.replace("/");
  }

  return (
    <header className="flex items-center justify-between border-b border-zinc-800 px-6 py-4">
      <Link href="/" className="flex items-center gap-2.5 text-2xl font-black tracking-tight text-violet-400">
        <img src="/sdc.png" alt="" className="h-8 w-8 rounded-full" />
        Quiz Live
      </Link>
      <div className="flex items-center gap-3 text-sm text-zinc-300">
        {!loading && user ? (
          <>
            <Link href="/dashboard" className="rounded-lg border border-zinc-700 px-3 py-1.5 hover:border-violet-500 hover:text-white">
              Dashboard
            </Link>
            <Link href="/games" className="rounded-lg border border-zinc-700 px-3 py-1.5 hover:border-violet-500 hover:text-white">
              Sessions
            </Link>
            <span className="hidden sm:inline">Host: {user.name}</span>
            <button
              onClick={logout}
              className="rounded-lg border border-zinc-700 px-3 py-1.5 hover:border-red-700 hover:text-red-300"
            >
              Log out
            </button>
          </>
        ) : null}
      </div>
    </header>
  );
}

/** Minimal top bar for player-facing pages (join, play): brand + Home. */
export function GuestNav() {
  return (
    <header className="flex items-center justify-between border-b border-zinc-800 px-6 py-4">
      <Link href="/" className="flex items-center gap-2.5 text-2xl font-black tracking-tight text-violet-400">
        <img src="/sdc.png" alt="" className="h-8 w-8 rounded-full" />
        Quiz Live
      </Link>
      <Link
        href="/"
        className="rounded-lg border border-zinc-700 px-3 py-1.5 text-sm text-zinc-300 hover:border-violet-500 hover:text-white"
      >
        Home
      </Link>
    </header>
  );
}

/** Landing-page actions: logged-in hosts get a dashboard shortcut instead of going through join/host. */
export function HomeActions() {
  const { user, loading } = useAuth();
  return (
    <>
      <Link
        href="/join"
        className="rounded-2xl bg-violet-600 px-8 py-4 text-lg font-bold text-white shadow-lg shadow-violet-600/30 hover:bg-violet-500"
      >
        Join a game
      </Link>
      {!loading && user ? (
        <Link
          href="/dashboard"
          className="rounded-2xl border border-zinc-700 bg-zinc-900 px-8 py-4 text-lg font-bold text-zinc-200 hover:border-violet-500 hover:text-white"
        >
          Go to dashboard
        </Link>
      ) : (
        <Link
          href="/host/login"
          className="rounded-2xl border border-zinc-700 bg-zinc-900 px-8 py-4 text-lg font-bold text-zinc-200 hover:border-violet-500 hover:text-white"
        >
          Host a quiz
        </Link>
      )}
    </>
  );
}

/** Standard padded page container used by every horizontal page. */
export function PageShell({ children }: { children: ReactNode }) {
  return (
    <main className="mx-auto w-full max-w-5xl px-6 py-10">{children}</main>
  );
}

/** Navigation + padded container for authenticated/host pages. */
export function HostChrome({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen">
      <HostNav />
      <PageShell>{children}</PageShell>
    </div>
  );
}