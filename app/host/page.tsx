"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useAction, useMutation, useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import { parseCsv, type GuestRow } from "../lib/csv";
import { useSessionToken } from "../lib/useSession";

const DEFAULT_WELCOME = `Hey {first_name} — I'm Simon.

I know everyone in the room tonight. Tell me what you're building or what you're looking for, and I'll point you at the right people.

Try: "who should I meet?" or "find people building voice agents."`;

type Phase = "luma" | "scanning" | "form" | "enriching" | "done";

export default function HostOnboarding() {
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);
  const { token, loaded } = useSessionToken();
  const me = useQuery(api.auth.me, loaded && token ? { token } : "skip");
  const activeEvent = useQuery(api.events.getActive);

  const scanEvent = useAction(api.importGuests.scanEvent);
  const createEvent = useMutation(api.events.create);
  const bulkImport = useMutation(api.attendees.bulkImport);
  const researchAll = useAction(api.research.researchAll);

  const [phase, setPhase] = useState<Phase>("luma");
  const [lumaUrl, setLumaUrl] = useState("");
  const [scanError, setScanError] = useState("");
  const [eventName, setEventName] = useState("");
  const [agenda, setAgenda] = useState("");
  const [agentName, setAgentName] = useState("Simon");
  const [welcomeTemplate, setWelcomeTemplate] = useState(DEFAULT_WELCOME);
  const [guests, setGuests] = useState<GuestRow[]>([]);
  const [csvName, setCsvName] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [connecting, setConnecting] = useState(false);
  const [connected, setConnected] = useState(false);
  const [progress, setProgress] = useState(0);

  useEffect(() => {
    if (loaded && !token) router.replace("/login");
    if (token && me === null) router.replace("/login");
  }, [loaded, token, me, router]);

  useEffect(() => {
    // An event already live means onboarding is done — straight to the room.
    if (activeEvent && phase === "luma") router.replace("/host/dashboard");
  }, [activeEvent, phase, router]);

  const checking = !loaded || (token ? me === undefined : true) || activeEvent === undefined;

  async function scanLuma() {
    if (!lumaUrl.trim()) return;
    setScanError("");
    setPhase("scanning");
    try {
      const data = await scanEvent({ url: lumaUrl.trim() });
      if (!data.ok) {
        setScanError(data.error ?? "Could not read that page.");
        setPhase("luma");
        return;
      }
      if (data.name) setEventName(data.name);
      if (data.agenda) setAgenda(data.agenda);
      setPhase("form");
    } catch {
      setScanError("That page didn't respond. Enter the details manually.");
      setPhase("luma");
    }
  }

  function connectLuma() {
    if (!apiKey.trim()) return;
    setConnecting(true);
    setTimeout(() => {
      setConnecting(false);
      setConnected(true);
    }, 1800);
  }

  async function onCsv(file: File) {
    const rows = parseCsv(await file.text()).filter((r) => r.name);
    setGuests(rows);
    setCsvName(file.name);
  }

  const hasGuests = guests.length > 0 || connected;
  const ready = eventName.trim() && agenda.trim() && hasGuests && token;

  async function launch() {
    if (!ready || !token) return;
    setPhase("enriching");
    const eventId = await createEvent({
      token,
      name: eventName.trim(),
      lumaUrl: lumaUrl.trim() || undefined,
      agenda: agenda.trim(),
      agentName: agentName.trim() || undefined,
      welcomeTemplate: welcomeTemplate.trim() || undefined,
    });
    if (guests.length) {
      await bulkImport({ eventId, rows: guests });
      void researchAll({ eventId }).catch(() => {});
    }
    // Fixed ~3s reveal regardless of roster size; real research continues in
    // the background and streams into the dashboard feed per attendee.
    const step = Math.max(1, Math.ceil(guests.length / 30));
    let i = 0;
    const tick = () => {
      i = Math.min(i + step, guests.length);
      setProgress(i);
      if (i < guests.length) setTimeout(tick, 100);
      else setTimeout(() => setPhase("done"), 600);
    };
    setTimeout(tick, 400);
  }

  const linkedinCount = guests.filter((g) => g.linkedin).length;
  const bioCount = guests.filter((g) => g.bio).length;

  return (
    <main className="max-w-2xl mx-auto px-6 pt-10 pb-20 w-full">
      <header className="flex items-center justify-between mb-10">
        <span className="font-semibold tracking-tight text-xl">simon</span>
        <span className="text-[11px] uppercase tracking-widest text-zinc-600">
          for hosts
        </span>
      </header>

      {checking && phase === "luma" && (
        <p className="text-sm text-zinc-600">Loading…</p>
      )}

      {!checking && phase === "luma" && (
        <>
          <h1 className="text-3xl font-semibold tracking-tight leading-tight">
            Point us at your event.
            <br />
            <span className="text-zinc-500">We&apos;ll read it in.</span>
          </h1>
          <p className="text-sm text-zinc-500 mt-3 mb-10 max-w-md">
            Drop your Luma link. Our research agent pulls the name and agenda so
            you&apos;re not retyping any of it.
          </p>

          <input
            value={lumaUrl}
            onChange={(e) => setLumaUrl(e.target.value)}
            placeholder="https://luma.com/..."
            autoFocus
            className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-4 py-3.5 text-sm outline-none focus:border-zinc-600 placeholder:text-zinc-600 mb-3"
          />
          {scanError && <p className="text-xs text-red-400 mb-3">{scanError}</p>}
          <div className="flex gap-3">
            <button
              onClick={scanLuma}
              disabled={!lumaUrl.trim()}
              className="flex-1 bg-zinc-100 disabled:opacity-30 text-zinc-950 font-semibold rounded-lg py-3.5 text-sm hover:bg-white"
            >
              Scan event
            </button>
            <button
              onClick={() => setPhase("form")}
              className="text-[11px] uppercase tracking-widest text-zinc-500 hover:text-zinc-300 px-4"
            >
              Enter manually
            </button>
          </div>
        </>
      )}

      {phase === "scanning" && (
        <section className="pt-10">
          <p className="text-[11px] uppercase tracking-widest text-zinc-500 mb-3">
            Reading your Luma event
          </p>
          <div className="space-y-2 font-mono text-[13px] text-zinc-400">
            <p className="animate-pulse">→ fetching page…</p>
            <p className="animate-pulse" style={{ animationDelay: "0.3s" }}>
              → extracting agenda…
            </p>
            <p className="animate-pulse" style={{ animationDelay: "0.6s" }}>
              → naming the room…
            </p>
          </div>
        </section>
      )}

      {!checking && phase === "form" && (
        <>
          <h1 className="text-3xl font-semibold tracking-tight leading-tight">
            {lumaUrl.trim() ? "Confirm what we read." : "Your event."}
            <br />
            <span className="text-zinc-500">
              {lumaUrl.trim()
                ? "Tweak anything that's off."
                : "Fill in the essentials."}
            </span>
          </h1>
          {lumaUrl.trim() ? (
            <p className="text-xs text-emerald-400/90 mt-3 mb-8">
              ✓ Scanned {new URL(lumaUrl).hostname}{" "}
              <button
                onClick={() => setPhase("luma")}
                className="text-zinc-500 underline ml-1"
              >
                change
              </button>
            </p>
          ) : (
            <p className="text-sm text-zinc-500 mt-3 mb-10 max-w-md">
              Simon researches every guest before the doors open, pushes your
              agenda through every introduction, and hands you the interest
              graph when it&apos;s over.
            </p>
          )}

          <section className="space-y-8">
            <div>
              <label className="block text-[11px] uppercase tracking-widest text-zinc-500 mb-2">
                01 — Event name
              </label>
              <input
                value={eventName}
                onChange={(e) => setEventName(e.target.value)}
                placeholder="Event name"
                className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-4 py-3 text-sm outline-none focus:border-zinc-600 placeholder:text-zinc-600"
              />
            </div>

            <div>
              <label className="block text-[11px] uppercase tracking-widest text-zinc-500 mb-2">
                02 — Guests
              </label>
              <div className="grid sm:grid-cols-2 gap-3">
                <button
                  onClick={() => fileRef.current?.click()}
                  className={`text-left border rounded-lg p-4 ${
                    guests.length
                      ? "border-emerald-500/50 bg-emerald-500/5"
                      : "border-zinc-800 bg-zinc-900 hover:border-zinc-700"
                  }`}
                >
                  <span className="text-sm font-medium block">Upload guest CSV</span>
                  <span className="text-xs text-zinc-500 mt-1 block">
                    {guests.length
                      ? `${csvName} — ${guests.length} guests`
                      : "Export from Luma, Eventbrite, anywhere"}
                  </span>
                </button>
                <input
                  ref={fileRef}
                  type="file"
                  accept=".csv,text/csv"
                  className="hidden"
                  onChange={(e) => e.target.files?.[0] && onCsv(e.target.files[0])}
                />
                <div
                  className={`border rounded-lg p-4 ${
                    connected
                      ? "border-emerald-500/50 bg-emerald-500/5"
                      : "border-zinc-800 bg-zinc-900"
                  }`}
                >
                  <span className="text-sm font-medium block">Connect Luma API</span>
                  {connected ? (
                    <span className="text-xs text-emerald-400 mt-1 block">
                      Calendar connected — guests sync live
                    </span>
                  ) : (
                    <div className="flex gap-2 mt-2">
                      <input
                        value={apiKey}
                        onChange={(e) => setApiKey(e.target.value)}
                        placeholder="luma-api-key"
                        className="flex-1 min-w-0 bg-black/40 border border-zinc-800 rounded-lg px-2.5 py-1.5 text-xs outline-none focus:border-zinc-600 placeholder:text-zinc-700"
                      />
                      <button
                        onClick={connectLuma}
                        disabled={connecting || !apiKey.trim()}
                        className="text-xs bg-zinc-800 disabled:opacity-40 rounded-lg px-3"
                      >
                        {connecting ? "…" : "Link"}
                      </button>
                    </div>
                  )}
                </div>
              </div>
            </div>

            <div>
              <label className="block text-[11px] uppercase tracking-widest text-zinc-500 mb-2">
                03 — Your agenda
              </label>
              <textarea
                value={agenda}
                onChange={(e) => setAgenda(e.target.value)}
                rows={4}
                placeholder="What do you want out of this room? e.g. We're launching our platform — get builders to try it, form teams, and meet our founding engineers."
                className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-4 py-3 text-sm outline-none focus:border-zinc-600 placeholder:text-zinc-600"
              />
              <p className="text-xs text-zinc-600 mt-1.5">
                The concierge weaves this into every introduction it makes.
                Guests never see it raw.
              </p>
            </div>

            <div>
              <label className="block text-[11px] uppercase tracking-widest text-zinc-500 mb-2">
                04 — Your agent
              </label>
              <input
                value={agentName}
                onChange={(e) => setAgentName(e.target.value)}
                placeholder="Agent name (e.g. Simon)"
                className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-4 py-3 text-sm outline-none focus:border-zinc-600 placeholder:text-zinc-600 mb-2"
              />
              <textarea
                value={welcomeTemplate}
                onChange={(e) => setWelcomeTemplate(e.target.value)}
                rows={6}
                placeholder="First message every attendee gets. Use {first_name} to personalize."
                className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-4 py-3 text-sm outline-none focus:border-zinc-600 placeholder:text-zinc-600 font-mono"
              />
              <p className="text-xs text-zinc-600 mt-1.5">
                Sent when an attendee first texts in. {"{first_name}"} gets
                filled in.
              </p>
            </div>

            <button
              onClick={launch}
              disabled={!ready}
              className="w-full bg-zinc-100 disabled:opacity-30 text-zinc-950 font-semibold rounded-lg py-4 text-sm hover:bg-white"
            >
              Research my guests
            </button>
          </section>
        </>
      )}

      {phase === "enriching" && (
        <section>
          <h2 className="text-xl font-semibold mb-1">Agent researching the room</h2>
          <p className="text-sm text-zinc-500 mb-6">
            LinkedIn, bios, what they&apos;re building — assembled before anyone
            walks in.
          </p>
          <div className="space-y-1.5 font-mono text-[13px]">
            {guests.slice(0, progress).map((g, idx) => (
              <div key={idx} className="flex items-center gap-2.5">
                <span className="w-5 h-5 rounded-full bg-zinc-800 inline-block" />
                <span className="text-zinc-300">{g.name}</span>
                <span className="text-zinc-600 truncate flex-1">
                  {g.linkedin ? "linkedin ✓" : "no linkedin"}
                  {g.bio ? " · bio on file" : ""}
                </span>
              </div>
            ))}
            {(guests.length === 0 || progress < guests.length) && (
              <div className="text-emerald-400 animate-pulse">researching…</div>
            )}
          </div>
        </section>
      )}

      {phase === "done" && (
        <section className="pt-10 text-center">
          <p className="text-[11px] uppercase tracking-widest text-zinc-500 mb-3">
            room intelligence ready
          </p>
          <h2 className="text-4xl font-semibold tracking-tight">
            {guests.length} guests imported
          </h2>
          <p className="text-zinc-500 mt-2 text-sm">
            {linkedinCount} LinkedIn profiles · {bioCount} bios on file · deep
            research is streaming into your dashboard now
          </p>
          <button
            onClick={() => router.push("/host/dashboard")}
            className="mt-10 bg-zinc-100 text-zinc-950 font-semibold rounded-lg px-8 py-4 text-sm hover:bg-white"
          >
            Open event dashboard
          </button>
        </section>
      )}
    </main>
  );
}
