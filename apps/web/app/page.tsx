import Link from "next/link";

export default function Home() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-10 px-6">
      <div className="text-center">
        <h1 className="text-5xl font-black tracking-tight text-violet-400 sm:text-6xl">Quiz Live</h1>
        <p className="mt-3 max-w-xl text-lg text-zinc-400">
          Live, real-time quizzes for events and classrooms. Server-authoritative scoring, instant
          results, and reliable reconnection when networks drop.
        </p>
      </div>

      <div className="flex flex-col gap-4 sm:flex-row">
        <Link
          href="/join"
          className="rounded-2xl bg-violet-600 px-8 py-4 text-lg font-bold text-white shadow-lg shadow-violet-600/30 hover:bg-violet-500"
        >
          Join a game
        </Link>
        <Link
          href="/host/login"
          className="rounded-2xl border border-zinc-700 bg-zinc-900 px-8 py-4 text-lg font-bold text-zinc-200 hover:border-violet-500 hover:text-white"
        >
          Host a quiz
        </Link>
      </div>

      <p className="text-xs text-zinc-600">Join with a code · answers are checked server-side · reconnect-proof</p>
    </main>
  );
}