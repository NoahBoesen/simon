"use client";

import { QRCodeSVG } from "qrcode.react";
import { useEffect, useState } from "react";

export default function AllAttendeesQR() {
  const [joinUrl, setJoinUrl] = useState("");
  const [error, setError] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/join", { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error("Could not load signup link.");
        const data = await response.json();
        const url = new URL(data.joinUrl);
        if (!["http:", "https:"].includes(url.protocol))
          throw new Error("Invalid signup link.");
        setJoinUrl(url.toString());
      })
      .catch(() => {
        if (!controller.signal.aborted) setError(true);
      });
    return () => controller.abort();
  }, []);

  return (
    <main className="max-w-lg mx-auto px-6 py-12 space-y-6">
      <h1 className="text-2xl font-semibold">Meet people with Simon</h1>
      <p>Scan to sign up and get your number for chatting with Simon.</p>
      {joinUrl ? (
        <>
          <div className="bg-white p-5 rounded-lg w-fit">
            <QRCodeSVG
              value={joinUrl}
              size={260}
              level="M"
              title="Sign up to chat with Simon"
            />
          </div>
          <a href={joinUrl} className="block text-blue-400 underline break-all">
            {joinUrl}
          </a>
          <p className="text-xs text-zinc-500">
            Everyone can use this QR. After signup, open Messages and send your
            first message to your assigned Simon number.
          </p>
        </>
      ) : error ? (
        <p role="alert">
          Could not load the QR code.{" "}
          <button className="underline" onClick={() => window.location.reload()}>
            Try again
          </button>
        </p>
      ) : (
        <p role="status">Loading signup QR…</p>
      )}
    </main>
  );
}
