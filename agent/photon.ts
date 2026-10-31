import { GetMessageOutputSchema } from "@photon-ai/api";
import { io } from "socket.io-client";

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Validate the public event envelope and the SDK's message contract. */
export function eventMessage(event: unknown, projectId: string) {
  if (
    !record(event) ||
    event.source !== "imessage.photon" ||
    typeof event.type !== "string" ||
    !event.type.startsWith("message.") ||
    !record(event.data) ||
    event.data.projectId !== projectId
  )
    return null;
  return GetMessageOutputSchema.parse(event.data.object);
}

export type PhotonMessage = NonNullable<ReturnType<typeof eventMessage>>;

export function incomingMessage(
  message: PhotonMessage,
  projectId: string,
  agentHandle?: string,
) {
  if (
    message.projectId !== projectId ||
    message.platform !== "imessage" ||
    message.status !== "received" ||
    message.space.platform !== "imessage" ||
    message.space.kind !== "direct" ||
    message.sentBy.platform !== "imessage" ||
    message.sentBy.kind !== "human" ||
    message.receivedBy?.platform !== "imessage" ||
    message.receivedBy.kind !== "agent" ||
    message.receivedBy.id === message.sentBy.id ||
    (agentHandle !== undefined && message.receivedBy.handle !== agentHandle) ||
    message.content.type !== "text" ||
    message.content.format !== "plain"
  )
    return null;
  return {
    phone: message.sentBy.handle,
    externalId: message.id,
    text: message.content.text,
    spaceId: message.space.id,
    senderId: message.receivedBy.id,
    linePhone: message.receivedBy.handle,
  };
}

export function connectEvents(options: {
  projectId: string;
  apiKey: string;
  cursor: number;
  handle: (event: unknown) => Promise<void>;
  checkpoint: (seq: number) => Promise<void>;
  onError: (error: unknown) => void;
}) {
  let cursor = options.cursor;
  let epoch = 0;
  let pending = 0;
  let subscribed = false;
  let queue = Promise.resolve();
  let resolveReady: () => void;
  let rejectReady: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const socket = io("https://api.photon.codes", {
    path: `/v1/projects/${options.projectId}/events/ws`,
    addTrailingSlash: false,
    transports: ["websocket"],
    extraHeaders: { Authorization: `Bearer ${options.apiKey}` },
    autoConnect: false,
  });
  const timer = setTimeout(() => {
    socket.disconnect();
    rejectReady(
      new Error(
        "Photon subscription timed out. Check the API key and project.",
      ),
    );
  }, 30_000);
  socket.on("connect", () => {
    socket
      .timeout(10_000)
      .emit(
        "subscribe",
        { startSeq: cursor, apiVersion: "2026-07-01" },
        (
          error: Error | null,
          result: { ok: boolean; error?: { code: string } },
        ) => {
          if (error) {
            socket.io.engine.close();
            return;
          }
          if (!result?.ok) {
            const problem = new Error(
              `Photon subscription rejected: ${result?.error?.code ?? "unknown"}`,
            );
            options.onError(problem);
            rejectReady(problem);
            socket.disconnect();
            return;
          }
          subscribed = true;
          clearTimeout(timer);
          resolveReady();
        },
      );
  });
  socket.on("disconnect", () => {
    subscribed = false;
    epoch++;
  });
  socket.on("connect_error", options.onError);
  socket.on("delivery_error", (error: { code: string; fatal: boolean }) => {
    options.onError(new Error(`Photon event delivery: ${error.code}`));
    if (error.fatal) socket.io.engine.close();
  });
  socket.on("delivery", (event: unknown, metadata: { seq: number }) => {
    const generation = epoch;
    if (!Number.isSafeInteger(metadata?.seq) || metadata.seq < 0) {
      options.onError(new Error("Photon returned an invalid replay cursor."));
      socket.io.engine.close();
      return;
    }
    if (++pending > 128) {
      pending--;
      epoch++;
      socket.io.engine.close();
      return;
    }
    queue = queue
      .then(async () => {
        if (generation !== epoch || metadata.seq <= cursor) return;
        await options.handle(event);
        await options.checkpoint(metadata.seq);
        cursor = Math.max(cursor, metadata.seq);
      })
      .catch((error) => {
        options.onError(error);
        if (generation === epoch) {
          epoch++;
          socket.io.engine.close();
        }
      })
      .finally(() => {
        pending--;
      });
  });
  socket.connect();
  return {
    ready,
    connected: () => socket.connected && subscribed,
    stop: async () => {
      clearTimeout(timer);
      socket.disconnect();
      await queue;
    },
  };
}
