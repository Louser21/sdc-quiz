import { HomeActions } from "../components/chrome";

export default function Home() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-10 px-6">
      <div className="text-center">
        <img
          src="/sdc.png"
          alt="SDC"
          className="mx-auto h-20 w-20 rounded-full"
        />
        <h1 className="mt-4 text-5xl font-black tracking-tight text-violet-400 sm:text-6xl">Quiz Live</h1>
      </div>

      <div className="flex flex-col gap-4 sm:flex-row">
        <HomeActions />
      </div>
    </main>
  );
}