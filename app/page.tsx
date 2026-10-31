"use client";

import { useState, FormEvent, ChangeEvent } from "react";
import { useQuery, useMutation, useAction } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Doc } from "@/convex/_generated/dataModel";

function parseCsv(text: string): {
  name: string;
  email?: string;
  phone?: string;
  linkedin?: string;
  bio?: string;
}[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) return [];
  const split = (line: string) =>
    line
      .match(/("([^"]|"")*"|[^,]*)(,|$)/g)
      ?.map((c) => c.replace(/,$/, "").replace(/^"|"$/g, "").trim())
      .slice(0, -1) ?? line.split(",");
  const headers = split(lines[0]).map((h) => h.toLowerCase());
  const col = (names: string[]) =>
    headers.findIndex((h) => names.some((n) => h.includes(n)));
  const nameIdx = col(["name"]);
  const emailIdx = col(["email"]);
  const phoneIdx = col(["phone", "mobile"]);
  const linkedinIdx = col(["linkedin"]);
  const bioIdx = col(["bio", "about"]);
  if (nameIdx === -1) return [];
  return lines.slice(1).map((line) => {
    const cells = split(line);
    return {
      name: cells[nameIdx] ?? "",
      email: emailIdx >= 0 ? cells[emailIdx] || undefined : undefined,
      phone: phoneIdx >= 0 ? cells[phoneIdx] || undefined : undefined,
      linkedin: linkedinIdx >= 0 ? cells[linkedinIdx] || undefined : undefined,
      bio: bioIdx >= 0 ? cells[bioIdx] || undefined : undefined,
    };
  });
}

const dot: Record<string, string> = {
  pending: "bg-zinc-600",
  running: "bg-amber-400 animate-pulse",
  done: "bg-emerald-400",
  skipped: "bg-zinc-700",
};

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-4 flex flex-col gap-3 min-h-0">
      <h2 className="text-xs font-semibold uppercase tracking-widest text-zinc-400">
        {title}
      </h2>
      <div className="overflow-y-auto flex-1 flex flex-col gap-2">{children}</div>
    </section>
  );
}

function CreateEvent() {
  const create = useMutation(api.events.create);
  const [name, setName] = useState("");
  const [host, setHost] = useState("");
  const [luma, setLuma] = useState("");
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!name || !host) return;
    await create({ name, hostName: host, lumaUrl: luma || undefined });
  };
  return (
    <main className="min-h-screen flex flex-col">
      <header className="px-6 pt-8 max-w-5xl mx-auto w-full flex items-center justify-between">
        <span className="font-semibold tracking-tight text-xl">simon</span>
        <span className="text-[11px] uppercase tracking-widest text-zinc-600">
          for hosts
        </span>
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

        <form
          onSubmit={submit}
          className="w-full max-w-md flex flex-col gap-4 rounded-2xl border border-zinc-800 bg-zinc-900/60 p-6"
        >
          <p className="text-xs font-semibold uppercase tracking-widest text-zinc-400">
            Start your event
          </p>
          <input
          className="rounded-lg bg-zinc-900 border border-zinc-800 px-4 py-3 outline-none focus:border-zinc-600"
          placeholder="Event name"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <input
          className="rounded-lg bg-zinc-900 border border-zinc-800 px-4 py-3 outline-none focus:border-zinc-600"
          placeholder="Host name"
          value={host}
          onChange={(e) => setHost(e.target.value)}
        />
        <input
          className="rounded-lg bg-zinc-900 border border-zinc-800 px-4 py-3 outline-none focus:border-zinc-600"
          placeholder="Luma URL (optional)"
          value={luma}
          onChange={(e) => setLuma(e.target.value)}
        />
        <button className="rounded-lg bg-zinc-100 text-zinc-950 font-semibold py-3 hover:bg-white">
          Start event
        </button>
      </form>
      </section>
    </main>
  );
}

function Dashboard({ event }: { event: Doc<"events"> }) {
  const attendees = useQuery(api.attendees.listByEvent, { eventId: event._id }) ?? [];
  const matches = useQuery(api.matches.listByEvent, { eventId: event._id }) ?? [];
  const messages = useQuery(api.messages.listByEvent, { eventId: event._id }) ?? [];
  const pings = useQuery(api.pings.listByEvent, { eventId: event._id }) ?? [];

  const bulkImport = useMutation(api.attendees.bulkImport);
  const fromLuma = useAction(api.importGuests.fromLuma);
  const researchAll = useAction(api.research.researchAll);
  const computeAll = useAction(api.matching.computeAll);
  const simulate = useAction(api.agent.simulateInbound);
  const hostAsk = useAction(api.agent.hostAsk);

  const [status, setStatus] = useState("");
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState("");
  const [asking, setAsking] = useState(false);
  const [simPhone, setSimPhone] = useState("+15550001111");
  const [simBody, setSimBody] = useState("");

  const onCsv = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const rows = parseCsv(await file.text()).filter((r) => r.name);
    const { added } = await bulkImport({ eventId: event._id, rows });
    setStatus(`Imported ${added} attendees from CSV`);
  };

  const onLuma = async () => {
    if (!event.lumaUrl) {
      setStatus("No Luma URL on this event");
      return;
    }
    setStatus("Scraping Luma...");
    const r = await fromLuma({ eventId: event._id, lumaUrl: event.lumaUrl });
    setStatus(`Luma: +${r.added} (${r.note})`);
  };

  const onAsk = async (e: FormEvent) => {
    e.preventDefault();
    if (!question.trim()) return;
    setAsking(true);
    setAnswer("");
    try {
      setAnswer(await hostAsk({ question }));
    } finally {
      setAsking(false);
    }
  };

  const onSim = async (e: FormEvent) => {
    e.preventDefault();
    if (!simBody.trim()) return;
    const body = simBody;
    setSimBody("");
    await simulate({ phone: simPhone, body });
  };

  return (
    <main className="flex-1 flex flex-col gap-4 p-6 h-screen">
      <header className="flex items-center justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold">
            Simon <span className="text-zinc-500 font-normal">/ {event.name}</span>
          </h1>
          <p className="text-xs text-zinc-500">
            {attendees.length} attendees · {matches.length} matches ·{" "}
            {messages.length} messages · host: {event.hostName}
          </p>
        </div>
        <div className="flex gap-2 flex-wrap items-center">
          <label className="cursor-pointer rounded-lg border border-zinc-700 px-3 py-2 text-sm hover:bg-zinc-900">
            Upload CSV
            <input type="file" accept=".csv" className="hidden" onChange={onCsv} />
          </label>
          <button
            onClick={onLuma}
            className="rounded-lg border border-zinc-700 px-3 py-2 text-sm hover:bg-zinc-900"
          >
            Scrape Luma
          </button>
          <button
            onClick={async () => {
              const r = await researchAll({ eventId: event._id });
              setStatus(`Research queued for ${r.queued}`);
            }}
            className="rounded-lg border border-zinc-700 px-3 py-2 text-sm hover:bg-zinc-900"
          >
            Research all
          </button>
          <button
            onClick={async () => {
              const r = await computeAll({ eventId: event._id });
              setStatus(`Matching queued for ${r.queued}`);
            }}
            className="rounded-lg bg-zinc-100 text-zinc-950 px-3 py-2 text-sm font-semibold hover:bg-white"
          >
            Compute matches
          </button>
        </div>
      </header>
      {status && <p className="text-xs text-amber-300">{status}</p>}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 flex-1 min-h-0">
        <Panel title={`Attendees (${attendees.length})`}>
          {attendees.map((a) => (
            <div key={a._id} className="rounded-lg bg-zinc-900 border border-zinc-800 p-3">
              <div className="flex items-center gap-2">
                <span
                  className={`h-2 w-2 rounded-full ${dot[a.researchStatus] ?? "bg-zinc-600"}`}
                />
                <span className="font-medium text-sm">{a.name}</span>
                {a.phone && <span className="text-xs text-zinc-500">{a.phone}</span>}
              </div>
              {a.oneLiner && (
                <p className="text-xs text-zinc-400 mt-1">wants: {a.oneLiner}</p>
              )}
              {a.researchSummary && (
                <p className="text-xs text-zinc-500 mt-1">{a.researchSummary}</p>
              )}
            </div>
          ))}
          {attendees.length === 0 && (
            <p className="text-sm text-zinc-600">
              Upload the Luma CSV or scrape the page.
            </p>
          )}
        </Panel>

        <Panel title={`Matches (${matches.length})`}>
          {matches.map((m) => (
            <div key={m._id} className="rounded-lg bg-zinc-900 border border-zinc-800 p-3">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium">
                  {m.nameA} <span className="text-zinc-500">×</span> {m.nameB}
                </span>
                <span className="text-xs font-mono text-emerald-400">{m.score}</span>
              </div>
              <p className="text-xs text-zinc-400 mt-1">{m.reason}</p>
            </div>
          ))}
          {pings.length > 0 && (
            <>
              <h3 className="text-xs font-semibold uppercase tracking-widest text-zinc-500 mt-2">
                Pings
              </h3>
              {pings.map((p) => (
                <div
                  key={p._id}
                  className="rounded-lg bg-zinc-900/60 border border-zinc-800 p-2 text-xs text-zinc-400"
                >
                  {p.fromName} → {p.toName}: {p.message}
                </div>
              ))}
            </>
          )}
          {matches.length === 0 && (
            <p className="text-sm text-zinc-600">
              Matches appear once attendees share what they want.
            </p>
          )}
        </Panel>

        <Panel title={`Live texts (${messages.length})`}>
          <div className="flex flex-col gap-1">
            {messages.map((m) => (
              <div
                key={m._id}
                className={`rounded-lg px-3 py-2 text-xs max-w-[85%] ${
                  m.direction === "inbound"
                    ? "bg-zinc-800 self-start"
                    : "bg-blue-600/80 self-end"
                }`}
              >
                <span className="block text-[10px] opacity-60">{m.phone}</span>
                {m.body}
              </div>
            ))}
          </div>
          <form
            onSubmit={onSim}
            className="mt-auto flex gap-2 pt-2 border-t border-zinc-800"
          >
            <input
              className="w-32 rounded-lg bg-zinc-900 border border-zinc-800 px-2 py-2 text-xs outline-none"
              value={simPhone}
              onChange={(e) => setSimPhone(e.target.value)}
            />
            <input
              className="flex-1 rounded-lg bg-zinc-900 border border-zinc-800 px-3 py-2 text-xs outline-none"
              placeholder="Simulate an inbound text..."
              value={simBody}
              onChange={(e) => setSimBody(e.target.value)}
            />
            <button className="rounded-lg bg-zinc-100 text-zinc-950 px-3 text-xs font-semibold">
              Send
            </button>
          </form>
        </Panel>
      </div>

      <section className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-4">
        <form onSubmit={onAsk} className="flex gap-2">
          <input
            className="flex-1 rounded-lg bg-zinc-900 border border-zinc-800 px-4 py-2 text-sm outline-none focus:border-zinc-600"
            placeholder={`Ask Simon about the room, ${event.hostName}...`}
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
          />
          <button
            disabled={asking}
            className="rounded-lg bg-zinc-100 text-zinc-950 px-4 py-2 text-sm font-semibold disabled:opacity-50"
          >
            {asking ? "Thinking..." : "Ask"}
          </button>
        </form>
        {answer && (
          <p className="text-sm text-zinc-300 mt-3 whitespace-pre-wrap">{answer}</p>
        )}
      </section>
    </main>
  );
}

export default function Home() {
  const event = useQuery(api.events.getActive);
  if (event === undefined)
    return (
      <main className="flex-1 flex items-center justify-center text-zinc-500">
        Loading...
      </main>
    );
  if (event === null) return <CreateEvent />;
  return <Dashboard event={event} />;
}
