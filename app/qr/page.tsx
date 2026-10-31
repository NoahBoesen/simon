"use client";
import { useEffect, useState } from "react";
import { QRCodeSVG } from "qrcode.react";

export default function SignupQR() {
  const [url, setUrl] = useState("");
  useEffect(() => {
    fetch("/api/join")
      .then((r) => r.json())
      .then((data) => setUrl(data.joinUrl));
  }, []);
  return (
    <main className="max-w-lg mx-auto px-6 py-12 space-y-6">
      <h1 className="text-2xl font-semibold">Meet people at Night Hack</h1>
      <p>
        Scan to give Simon your name, phone and profile, then start your
        conversation.
      </p>
      {url && (
        <div className="bg-white p-5 rounded-lg w-fit">
          <QRCodeSVG
            value={url}
            size={260}
            level="M"
            title="Night Hack signup"
          />
        </div>
      )}
      <label className="block text-sm">
        Signup link
        <input
          aria-label="Signup link"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          className="mt-2 w-full rounded-lg bg-zinc-900 border border-zinc-700 p-3"
        />
      </label>
      <a href={url || "/join"} className="block text-blue-400 underline">
        Open signup
      </a>
      <p className="text-xs text-zinc-500">
        The QR opens the signup link shown above. Hosted links work from any phone.
        Local network links require the same Wi-Fi.
      </p>
    </main>
  );
}
