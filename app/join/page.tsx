"use client";

import { useRef, useState, type FormEvent } from "react";
import Link from "next/link";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { startMessage, messagesLink } from "../lib/startMessage";

type Joined = {
  phone: string;
  simulation: boolean;
  agentHandle?: string;
  code: string;
  welcomeQueued: boolean;
  activationError?: string;
  startMessage: string;
};
export default function Join() {
  const event = useQuery(api.onboarding.info);
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [profileUrl, setProfileUrl] = useState("");
  const [realMessages, setRealMessages] = useState(false);
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [joined, setJoined] = useState<Joined | null>(null);
  const messageRef = useRef<HTMLTextAreaElement>(null);
  const [copyStatus, setCopyStatus] = useState("");
  async function copyMessage() {
    if (!joined) return;
    try {
      await navigator.clipboard.writeText(joined.startMessage);
      setCopyStatus("Copied. Paste it into Messages.");
    } catch {
      messageRef.current?.select();
      setCopyStatus(
        "Message selected. Choose Copy, then paste it into Messages.",
      );
    }
  }
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/join", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          phone,
          profileUrl,
          consent,
          simulation: !!event?.demo && !realMessages,
        }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not register.");
      setJoined({
        ...data,
        startMessage: startMessage(name, profileUrl, data.code),
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Try again.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="max-w-md mx-auto px-6 py-12 space-y-6">
      <p className="text-sm text-zinc-500">Simon · attendee signup</p>
      <h1 className="text-2xl font-semibold">
        {event?.name || "Join the event"}
      </h1>
      {event === null ? (
        <p>No event is open for signup.</p>
      ) : joined ? (
        <div className="space-y-4">
          <p>Your details are saved.</p>
          {joined.simulation ? (
            <>
              <p>
                Your welcome message is ready in mock chat. No real texts are
                sent.
              </p>
              <Link
                className="block rounded-lg bg-blue-600 p-3 text-center"
                href={`/demo/chat?phone=${encodeURIComponent(joined.phone)}`}
              >
                Open mock conversation
              </Link>
            </>
          ) : joined.activationError ? (
            <p className="text-amber-300">{joined.activationError}</p>
          ) : joined.welcomeQueued ? (
            <p>Simon has queued your welcome message on iMessage.</p>
          ) : (
            <>
              <p>
                Open Messages, review your name and profile below, then tap Send
                from {joined.phone}. Simon will reply with your welcome.
              </p>
              <a
                className="block rounded-lg bg-blue-600 p-3 text-center"
                href={messagesLink(joined.agentHandle!, joined.startMessage)}
                onClick={(e) => {
                  if (/iPhone|iPad|iPod|Macintosh/.test(navigator.userAgent)) {
                    e.preventDefault();
                    window.location.href = messagesLink(
                      joined.agentHandle!,
                      joined.startMessage,
                      true,
                    );
                  }
                }}
              >
                Open in Messages
              </a>
              <textarea
                ref={messageRef}
                aria-label="Your first message"
                readOnly
                rows={6}
                value={joined.startMessage}
                className="w-full rounded-lg bg-zinc-900 p-3 text-sm"
              />
              <button className="text-sm underline" onClick={copyMessage}>
                Copy message
              </button>
              {copyStatus && (
                <p role="status" className="text-sm text-zinc-400">
                  {copyStatus}
                </p>
              )}
              <p className="text-sm text-zinc-400">
                If the text is not prefilled, paste it into a message to{" "}
                {joined.agentHandle}. Nothing is sent until you tap Send.
              </p>
            </>
          )}
          {joined.activationError && (
            <button className="underline" onClick={() => setJoined(null)}>
              Back to signup
            </button>
          )}
        </div>
      ) : (
        <form onSubmit={submit} className="space-y-4">
          <label className="block text-sm">
            Name
            <input
              required
              autoComplete="name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="mt-1 block w-full rounded-lg bg-zinc-900 border border-zinc-700 p-3"
            />
          </label>
          <label className="block text-sm">
            Phone number
            <input
              required
              type="tel"
              autoComplete="tel"
              placeholder="+1 415 555 0123"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              className="mt-1 block w-full rounded-lg bg-zinc-900 border border-zinc-700 p-3"
            />
          </label>
          <label className="block text-sm">
            LinkedIn, X, or another profile
            <input
              required
              placeholder="https://linkedin.com/in/your-name"
              value={profileUrl}
              onChange={(e) => setProfileUrl(e.target.value)}
              className="mt-1 block w-full rounded-lg bg-zinc-900 border border-zinc-700 p-3"
            />
          </label>
          {event?.demo && (
            <label className="flex gap-2 text-sm">
              <input
                type="checkbox"
                checked={realMessages}
                onChange={(e) => setRealMessages(e.target.checked)}
              />
              Use real iMessage instead of mock chat
            </label>
          )}
          <label className="flex gap-2 text-sm">
            <input
              required
              type="checkbox"
              checked={consent}
              onChange={(e) => setConsent(e.target.checked)}
            />
            I want Simon to contact me about this event and help arrange
            introductions.
          </label>
          {error && (
            <p role="alert" className="text-sm text-red-400">
              {error}
            </p>
          )}
          <button
            disabled={!event || busy}
            className="w-full rounded-lg bg-blue-600 p-3 font-medium disabled:opacity-40"
          >
            {busy ? "Joining…" : "Join and meet people"}
          </button>
          {event?.demo && (
            <p className="text-xs text-zinc-500">
              Mock chat is the default for this demo.
            </p>
          )}
        </form>
      )}
    </main>
  );
}
