"use client";

import { QRCodeSVG } from "qrcode.react";
import { messagesLink } from "../lib/startMessage";

const message = "Hey! I'm at the Night Hack event now";
const messageUrl = messagesLink("+16283167976", message, true);

export default function EventQR() {
  return (
    <main className="max-w-lg mx-auto px-6 py-12 space-y-6">
      <h1 className="text-2xl font-semibold">Meet people at Night Hack</h1>
      <p>
        Scan to open iMessage, then tap Send.
      </p>
      <div className="bg-white p-5 rounded-lg w-fit">
        <QRCodeSVG
          value={messageUrl}
          size={260}
          level="M"
          title="Message Simon at Night Hack"
        />
      </div>
      <p>{message}</p>
      <a href={messageUrl} className="block text-blue-400 underline">
        Open in iMessage
      </a>
      <p className="text-xs text-zinc-500">
        Your message to +16283167976 is ready. Nothing is sent until you tap Send.
      </p>
    </main>
  );
}
