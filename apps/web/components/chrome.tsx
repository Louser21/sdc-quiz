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
      <Link href="/" className="text-2xl font-black tracking-tight text-violet-400">
        Quiz Live
      </Link>
      <div className="flex items-center gap-3 text-sm text-zinc-300">
        {!loading && user ? (
          <>
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