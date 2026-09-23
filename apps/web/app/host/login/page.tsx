import Link from "next/link";

export default function HostLoginPage() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-4 px-6">
      <h1 className="text-3xl font-black text-violet-400">Host log in</h1>
      <p className="text-zinc-500">Auth + quiz management ships in Phase 1.</p>
      <Link href="/" className="text-sm text-violet-400 hover:underline">
        Back home
      </Link>
    </main>
  );
}