import { Suspense } from "react";
import Chat from "./Chat";

export default function DemoChatPage() {
  return (
    <Suspense fallback={<p className="p-8">Opening mock conversation…</p>}>
      <Chat />
    </Suspense>
  );
}
