"use client";

import Link from "next/link";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { useSessionToken } from "./lib/useSession";

export default function Home() {
  const { token, loaded, clear } = useSessionToken();
  const me = useQuery(api.auth.me, loaded && token ? { token } : "skip");
  const authed = !!token && !!me;

  return (
    <main className="min-h-screen flex flex-col">
      <header className="px-6 pt-8 max-w-5xl mx-auto w-full flex items-center justify-between">
        <span className="font-semibold tracking-tight text-xl">simon</span>
        {authed ? (
          <button
            onClick={clear}
            className="text-[11px] uppercase tracking-widest text-zinc-600 hover:text-zinc-300"
          >
            log out
          </button>
        ) : (
          <span className="text-[11px] uppercase tracking-widest text-zinc-600">
            for hosts
          </span>
        )}
      </header>

      <section className="flex-1 flex flex-col lg:flex-row items-center justify-center gap-14 px-6 pb-16 pt-10 max-w-5xl mx-auto w-full">
        <div className="flex-1 max-w-xl">
          <h1 className="text-4xl md:text-5xl font-semibold tracking-tight leading-[1.05]">
            Your guest list is an asset.
            <br />
            <span className="text-zinc-500">Put an agent on it.</span>
          </h1>
          <p className="text-zinc-400 mt-5 text-sm md:text-base max-w-md">
            Simon researches every guest before the doors open, then works the
            room over iMessage. No app, no QR codes, no badge scans — attendees
            just text.
          </p>
          <ul className="mt-8 flex flex-col gap-3 text-sm text-zinc-500">
            <li>
              <span className="text-zinc-200 font-medium">Knows the room.</span>{" "}
              Import the Luma list; Simon researches everyone on it.
            </li>
            <li>
              <span className="text-zinc-200 font-medium">Works the room.</span>{" "}
              Attendees text one number and get matched to the right people —
              with intros delivered to both sides.
            </li>
            <li>
              <span className="text-zinc-200 font-medium">Reads the room.</span>{" "}
              Ask the host concierge anything; it synthesizes intent, never
              quotes anyone.
            </li>
          </ul>
        </div>

        <div className="w-full max-w-md flex flex-col gap-3 rounded-2xl border border-zinc-800 bg-zinc-900/60 p-6">
          <p className="text-xs font-semibold uppercase tracking-widest text-zinc-400">
            Hosting tonight?
          </p>
          {authed ? (
            <Link
              href="/host"
              className="rounded-lg bg-zinc-100 text-zinc-950 font-semibold py-3 text-center text-sm hover:bg-white"
            >
              Set up your event
            </Link>
          ) : (
            <>
              <Link
                href="/signup"
                className="rounded-lg bg-zinc-100 text-zinc-950 font-semibold py-3 text-center text-sm hover:bg-white"
              >
                Create your event
              </Link>
              <Link
                href="/login"
                className="rounded-lg border border-zinc-800 bg-zinc-900 py-3 text-center text-sm font-medium text-zinc-200 hover:border-zinc-600"
              >
                Log in
              </Link>
            </>
          )}
        </div>
      </section>
    </main>
  );
}
