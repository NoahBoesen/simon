"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useQuery, useMutation, useAction } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Doc } from "@/convex/_generated/dataModel";
import { useSessionToken } from "../../lib/useSession";

type Match = { name: string; why: string; linkedin?: string };
type ChatMsg =
  | { role: "user"; text: string }
  | { role: "agent"; text: string; matches: Match[] };
type SortMode = "relevance" | "recency" | "intros";

const FALLBACK_SUGGESTIONS = [
  "Find me a potential customer in this room",
  "Who should the founding team meet first?",
  "Any builders adjacent to our stack?",
];

function Dashboard({ event }: { event: Doc<"events"> }) {
  const router = useRouter();
  const { token, clear } = useSessionToken();
  const logout = useMutation(api.auth.logout);

  const attendees =
    useQuery(api.attendees.listByEvent, { eventId: event._id }) ?? [];
  const messages =
    useQuery(api.messages.listByEvent, { eventId: event._id }) ?? [];
  const pings = useQuery(api.pings.listByEvent, { eventId: event._id }) ?? [];
  const hostAsk = useAction(api.agent.hostAsk);

  const agentName = event.agentName?.trim() || "Simon";
  const joined = attendees.filter((a) => a.oneLiner).length;

  const [sortMode, setSortMode] = useState<SortMode>("relevance");
  const [chatInput, setChatInput] = useState("");
  const [chatMsgs, setChatMsgs] = useState<ChatMsg[]>([]);
  const [chatBusy, setChatBusy] = useState(false);
  const chatBottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    chatBottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [chatMsgs, chatBusy]);

  const introCount = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const p of pings) {
      counts[p.fromName] = (counts[p.fromName] ?? 0) + 1;
      counts[p.toName] = (counts[p.toName] ?? 0) + 1;
    }
    return counts;
  }, [pings]);

  const sortedFeed = useMemo(() => {
    const items = [...attendees];
    const rank = (a: (typeof items)[number]) =>
      (a.oneLiner ? 2 : 0) + (a.researchStatus === "done" ? 1 : 0);
    if (sortMode === "relevance") {
      items.sort(
        (a, b) => rank(b) - rank(a) || a.name.localeCompare(b.name)
      );
    } else if (sortMode === "intros") {
      items.sort(
        (a, b) =>
          (introCount[b.name] ?? 0) - (introCount[a.name] ?? 0) ||
          rank(b) - rank(a) ||
          a.name.localeCompare(b.name)
      );
    } else {
      items.sort((a, b) => {
        if (!!a.oneLiner !== !!b.oneLiner)
          return Number(!!b.oneLiner) - Number(!!a.oneLiner);
        return b._creationTime - a._creationTime;
      });
    }
    return items;
  }, [attendees, sortMode, introCount]);

  async function ask(q: string) {
    if (!q.trim() || chatBusy) return;
    setChatInput("");
    const history = chatMsgs.map((m) => ({ role: m.role, text: m.text }));
    setChatMsgs((m) => [...m, { role: "user", text: q }]);
    setChatBusy(true);
    try {
      const res = await hostAsk({ question: q, history });
      setChatMsgs((m) => [
        ...m,
        { role: "agent", text: res.reply, matches: res.matches },
      ]);
    } catch {
      setChatMsgs((m) => [
        ...m,
        { role: "agent", text: "Concierge hiccup. Try again.", matches: [] },
      ]);
    } finally {
      setChatBusy(false);
    }
  }

  return (
    <main className="h-screen flex flex-col">
      <header className="flex items-center justify-between px-6 py-4 border-b border-zinc-900/80">
        <div className="flex items-center gap-6">
          <div>
            <span className="font-semibold tracking-tight text-lg">simon</span>
            <p className="text-[10px] uppercase tracking-widest text-zinc-600 mt-0.5">
              {event.name}
            </p>
          </div>
          <div className="flex gap-5 text-[11px] uppercase tracking-widest text-zinc-500">
            <span>
              <span className="text-zinc-200 font-semibold">
                {attendees.length}
              </span>{" "}
              guests
            </span>
            <span>
              <span className="text-emerald-400 font-semibold">{joined}</span>{" "}
              joined
            </span>
            <span>
              <span className="text-zinc-200 font-semibold">{pings.length}</span>{" "}
              intros
            </span>
          </div>
        </div>
        <div className="flex items-center gap-4">
          <button
            onClick={async () => {
              if (token) await logout({ token });
              clear();
              router.replace("/");
            }}
            className="text-[11px] uppercase tracking-widest text-zinc-600 hover:text-zinc-400"
          >
            Log out
          </button>
          <Link
            href="/text"
            target="_blank"
            className="bg-zinc-100 text-zinc-950 font-semibold rounded-xl px-5 py-2 text-sm hover:bg-white"
          >
            Open attendee line
          </Link>
        </div>
      </header>

      <div className="flex-1 grid lg:grid-cols-[1fr_380px] overflow-hidden">
        {/* MAIN: chat with the agent */}
        <section className="flex flex-col overflow-hidden border-r border-zinc-900/80">
          <div className="flex-1 overflow-y-auto px-6 py-5">
            {chatMsgs.length === 0 && !chatBusy && (
              <div className="space-y-2 max-w-xl">
                <p className="text-sm text-zinc-500 mb-3">
                  Ask {agentName} about the room — or try one of these.
                </p>
                {FALLBACK_SUGGESTIONS.map((s) => (
                  <button
                    key={s}
                    onClick={() => ask(s)}
                    className="block w-full text-left bg-zinc-900/40 border border-zinc-800/60 rounded-xl px-4 py-3 text-sm text-zinc-300 hover:border-emerald-400/50"
                  >
                    {s}
                  </button>
                ))}
              </div>
            )}

            <div className="space-y-3 max-w-2xl">
              {chatMsgs.map((m, i) =>
                m.role === "user" ? (
                  <div key={i} className="flex justify-end">
                    <div className="bg-zinc-100 text-zinc-950 rounded-2xl rounded-br-md px-4 py-2.5 text-sm max-w-[85%]">
                      {m.text}
                    </div>
                  </div>
                ) : (
                  <div key={i} className="space-y-2">
                    {m.text && (
                      <div className="bg-zinc-900/60 border border-zinc-800/60 rounded-2xl rounded-bl-md px-4 py-2.5 text-sm max-w-[90%]">
                        {m.text}
                      </div>
                    )}
                    {m.matches.map((match, j) => (
                      <div
                        key={j}
                        className="bg-zinc-900/60 border border-zinc-800/60 rounded-xl p-4"
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="font-medium text-sm">
                            {match.name}
                          </span>
                          {match.linkedin && (
                            <a
                              href={match.linkedin}
                              target="_blank"
                              rel="noreferrer"
                              className="text-[11px] uppercase tracking-wider text-zinc-500 hover:text-emerald-400"
                            >
                              LinkedIn
                            </a>
                          )}
                        </div>
                        <p className="text-[13px] text-zinc-400 mt-1.5">
                          {match.why}
                        </p>
                      </div>
                    ))}
                  </div>
                )
              )}
              {chatBusy && (
                <div className="bg-zinc-900/60 border border-zinc-800/60 rounded-2xl rounded-bl-md px-4 py-2.5 text-sm text-zinc-500 w-fit animate-pulse">
                  Reading the room
                </div>
              )}
              <div ref={chatBottomRef} />
            </div>
          </div>

          <form
            onSubmit={(e) => {
              e.preventDefault();
              ask(chatInput);
            }}
            className="px-6 py-4 border-t border-zinc-900/80"
          >
            <div className="flex gap-2 max-w-2xl">
              <input
                value={chatInput}
                onChange={(e) => setChatInput(e.target.value)}
                placeholder="Find me a potential customer in this room"
                className="flex-1 bg-zinc-900/60 border border-zinc-800/60 rounded-xl px-4 py-3 text-sm outline-none focus:border-emerald-400/50 placeholder:text-zinc-600"
              />
              <button
                type="submit"
                disabled={chatBusy || !chatInput.trim()}
                className="bg-zinc-100 disabled:opacity-30 text-zinc-950 font-semibold rounded-xl px-5 text-sm hover:bg-white"
              >
                Ask
              </button>
            </div>
          </form>
        </section>

        {/* SIDE: live feed */}
        <aside className="flex flex-col overflow-hidden">
          <div className="px-5 py-4 border-b border-zinc-900/60">
            <div className="flex items-center justify-between">
              <h2 className="text-[11px] uppercase tracking-widest text-zinc-500">
                Live feed
              </h2>
              <span className="flex items-center gap-1.5 text-[10px] uppercase tracking-widest text-zinc-700">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                live
              </span>
            </div>
            <p className="text-xs text-zinc-600 mt-0.5 mb-3">
              The whole room · reordered as people text in
            </p>
            <div className="inline-flex bg-zinc-900/60 border border-zinc-800/60 rounded-full p-0.5 text-[10px] uppercase tracking-widest">
              {(["relevance", "recency", "intros"] as SortMode[]).map((m) => (
                <button
                  key={m}
                  onClick={() => setSortMode(m)}
                  className={`px-3 py-1 rounded-full ${
                    sortMode === m
                      ? "bg-zinc-100 text-zinc-950 font-semibold"
                      : "text-zinc-500 hover:text-zinc-300"
                  }`}
                >
                  {m}
                </button>
              ))}
            </div>
          </div>

          <div className="flex-1 overflow-y-auto px-5 py-4 space-y-2">
            {attendees.length === 0 && (
              <div className="text-sm text-zinc-600">
                <p className="mb-2">No guest list yet.</p>
                <p className="text-xs text-zinc-700">
                  Import guests from the host page.
                </p>
              </div>
            )}
            {sortedFeed.map((a) => {
              const live = !!a.oneLiner;
              const intros = introCount[a.name] ?? 0;
              return (
                <div
                  key={a._id}
                  className={`border rounded-xl px-3.5 py-3 transition-colors ${
                    live
                      ? "bg-zinc-900/60 border-zinc-800/60"
                      : "bg-zinc-900/20 border-zinc-900/60"
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2 min-w-0">
                      <span
                        className={`text-[10px] uppercase tracking-widest font-semibold w-7 text-center py-0.5 rounded ${
                          a.researchStatus === "done"
                            ? "text-zinc-950 bg-emerald-400"
                            : a.researchStatus === "running"
                              ? "text-zinc-600 border border-zinc-800 animate-pulse"
                              : "text-zinc-600 border border-zinc-800"
                        }`}
                      >
                        {a.researchStatus === "done" ? "✓" : "…"}
                      </span>
                      <span
                        className={`text-sm font-medium truncate ${
                          live ? "text-zinc-100" : "text-zinc-400"
                        }`}
                      >
                        {a.name}
                      </span>
                      {live && (
                        <span className="flex items-center gap-1 shrink-0">
                          <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
                          <span className="text-[9px] uppercase tracking-widest text-emerald-400">
                            live
                          </span>
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      {intros > 0 && (
                        <span className="text-[9px] uppercase tracking-widest text-emerald-400/80 border border-emerald-400/30 rounded-full px-2 py-0.5">
                          {intros} intro{intros === 1 ? "" : "s"}
                        </span>
                      )}
                      {a.linkedin && (
                        <a
                          href={a.linkedin}
                          target="_blank"
                          rel="noreferrer"
                          className="text-[10px] uppercase tracking-wider text-zinc-500 hover:text-emerald-400"
                        >
                          LinkedIn
                        </a>
                      )}
                    </div>
                  </div>
                  {a.researchSummary && (
                    <p
                      className={`text-[11px] mt-0.5 ml-9 truncate ${
                        live ? "text-zinc-500" : "text-zinc-600"
                      }`}
                    >
                      {a.researchSummary}
                    </p>
                  )}
                  {a.oneLiner && (
                    <p className="text-[12px] text-emerald-400/80 mt-2 ml-9 leading-snug">
                      → {a.oneLiner}
                    </p>
                  )}
                  {a.facts && a.facts.length > 0 && (
                    <div className="mt-1.5 ml-9 space-y-0.5">
                      {a.facts.map((f, i) => (
                        <p
                          key={i}
                          className="text-[11px] text-zinc-500 leading-snug"
                        >
                          {f}
                        </p>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}

            {messages.length > 0 && (
              <div className="pt-6">
                <h3 className="text-[10px] uppercase tracking-widest text-zinc-600 mb-2">
                  Live texts
                </h3>
                <div className="space-y-1">
                  {messages.slice(-14).map((m) => (
                    <div
                      key={m._id}
                      className={`rounded-lg px-3 py-2 text-xs max-w-[85%] ${
                        m.direction === "inbound"
                          ? "bg-zinc-900 border border-zinc-800/60"
                          : "bg-emerald-400/10 border border-emerald-400/20 ml-auto"
                      }`}
                    >
                      <span className="block text-[10px] opacity-50">
                        {m.phone}
                      </span>
                      {m.body}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </aside>
      </div>
    </main>
  );
}

export default function DashboardPage() {
  const router = useRouter();
  const { token, loaded } = useSessionToken();
  const me = useQuery(api.auth.me, loaded && token ? { token } : "skip");
  const event = useQuery(api.events.getActive);

  useEffect(() => {
    if (loaded && !token) router.replace("/login");
    if (loaded && token && me === null) router.replace("/login");
  }, [loaded, token, me, router]);

  useEffect(() => {
    if (event === null) router.replace("/host");
  }, [event, router]);

  if (
    !loaded ||
    !token ||
    me === undefined ||
    me === null ||
    event === undefined ||
    event === null
  )
    return (
      <main className="flex-1 flex items-center justify-center text-zinc-500">
        Loading...
      </main>
    );

  return <Dashboard event={event} />;
}
