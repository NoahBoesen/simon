"use client";

import { FormEvent, useEffect, useRef, useState } from "react";
import { useAction, useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";

function normalizePhone(raw: string): string {
  const digits = raw.replace(/[^\d+]/g, "");
  if (digits.startsWith("+")) return digits;
  if (digits.length === 10) return `+1${digits}`;
  return digits ? `+${digits}` : "";
}

function Thread({ phone }: { phone: string }) {
  const messages = useQuery(api.messages.listByPhone, { phone });
  const send = useAction(api.agent.simulateInbound);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  const waitingOnAgent =
    sending ||
    (!!messages?.length && messages[messages.length - 1].direction === "inbound");

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages?.length, waitingOnAgent]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const body = draft.trim();
    if (!body || sending) return;
    setDraft("");
    setSending(true);
    try {
      await send({ phone, body });
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="flex flex-col flex-1 min-h-0">
      <div className="flex-1 overflow-y-auto px-4 py-6 flex flex-col gap-2">
        {messages === undefined && (
          <p className="text-center text-sm text-zinc-500">loading…</p>
        )}
        {messages?.length === 0 && (
          <p className="text-center text-sm text-zinc-500">
            Say hi — Simon will introduce himself.
          </p>
        )}
        {messages?.map((m) => (
          <div
            key={m._id}
            className={`max-w-[75%] rounded-2xl px-4 py-2 text-[15px] leading-snug whitespace-pre-wrap ${
              m.direction === "inbound"
                ? "self-end bg-blue-600 text-white rounded-br-sm"
                : "self-start bg-zinc-800 text-zinc-100 rounded-bl-sm"
            }`}
          >
            {m.body}
          </div>
        ))}
        {waitingOnAgent && (
          <div className="self-start rounded-2xl rounded-bl-sm bg-zinc-800 px-4 py-2 text-zinc-400 text-sm animate-pulse">
            Simon is typing…
          </div>
        )}
        <div ref={bottomRef} />
      </div>
      <form onSubmit={submit} className="p-3 border-t border-zinc-800 flex gap-2">
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="iMessage"
          autoFocus
          className="flex-1 rounded-full bg-zinc-900 border border-zinc-700 px-4 py-2 text-[15px] outline-none focus:border-zinc-500"
        />
        <button
          type="submit"
          disabled={!draft.trim() || sending}
          className="rounded-full bg-blue-600 px-4 py-2 text-sm font-semibold disabled:opacity-40"
        >
          Send
        </button>
      </form>
    </div>
  );
}

export default function TextMock() {
  const [phoneInput, setPhoneInput] = useState("");
  const [phone, setPhone] = useState<string | null>(null);

  if (!phone) {
    return (
      <main className="min-h-screen flex items-center justify-center p-8">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const p = normalizePhone(phoneInput);
            if (p.length >= 8) setPhone(p);
          }}
          className="w-full max-w-sm flex flex-col gap-3 rounded-xl border border-zinc-800 bg-zinc-900/60 p-6"
        >
          <h1 className="text-lg font-semibold">Text Simon (mock)</h1>
          <p className="text-sm text-zinc-400">
            Local stand-in for iMessage. Enter the phone number you&apos;re
            texting from — each number is its own attendee thread.
          </p>
          <input
            value={phoneInput}
            onChange={(e) => setPhoneInput(e.target.value)}
            placeholder="+1 415 555 0123"
            autoFocus
            className="rounded-lg bg-zinc-900 border border-zinc-700 px-3 py-2 outline-none focus:border-zinc-500"
          />
          <button
            type="submit"
            className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold"
          >
            Start texting
          </button>
        </form>
      </main>
    );
  }

  return (
    <main className="h-screen max-w-xl mx-auto flex flex-col">
      <header className="px-4 py-3 border-b border-zinc-800 flex items-center justify-between">
        <div>
          <p className="text-sm font-semibold">Simon</p>
          <p className="text-xs text-zinc-500">{phone} · mock iMessage</p>
        </div>
        <button
          onClick={() => setPhone(null)}
          className="text-xs text-zinc-400 hover:text-zinc-200"
        >
          switch number
        </button>
      </header>
      <Thread phone={phone} />
    </main>
  );
}
