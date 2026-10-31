import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { ApiError, Photon } from "@photon-ai/api";
import { ConvexHttpClient } from "convex/browser";
import { anyApi } from "convex/server";
import type { api as generatedApi } from "../convex/_generated/api";
import { connectEvents, eventMessage, incomingMessage } from "./photon";

// Keep generated API types without loading generated ESM across the Node module boundary.
const api = anyApi as unknown as typeof generatedApi;

function required(name: string) {
  const value = process.env[name]?.trim();
  if (!value)
    throw new Error(`Set ${name} in .env.local, then restart the worker.`);
  return value;
}
function describeError(error: unknown) {
  let message = error instanceof Error ? error.message : "Unexpected error";
  for (const name of [
    "PHOTON_API_KEY",
    "PHOTON_WORKER_SECRET",
    "ANTHROPIC_API_KEY",
  ]) {
    const value = process.env[name];
    if (value) message = message.replaceAll(value, "[redacted]");
  }
  return message.slice(0, 500);
}
async function main() {
  const client = new ConvexHttpClient(required("NEXT_PUBLIC_CONVEX_URL"));
  const auth = {
    token: required("PHOTON_WORKER_SECRET"),
    workerId: randomUUID(),
    projectId: required("PHOTON_PROJECT_ID"),
  };
  const apiKey = required("PHOTON_API_KEY");
  const agentHandle = required("PHOTON_AGENT_HANDLE");
  if (!auth.projectId.startsWith("pho_prj_") || !apiKey.startsWith("pho_sk_"))
    throw new Error("Use Photon 2.0 Beta credentials.");
  const photon = new Photon({ headers: { Authorization: `Bearer ${apiKey}` } });
  await Promise.all([
    photon.projects.listMessages({
      path: { id: auth.projectId },
      query: { pageSize: 1, platform: "imessage" },
    }),
    client.action(api.agent.checkModel, {
      token: auth.token,
      projectId: auth.projectId,
    }),
  ]);
  const cursor = await client.mutation(api.photonBridge.register, {
    ...auth,
    agentHandle,
    initialCursor: process.env.PHOTON_START_CURSOR
      ? Number(process.env.PHOTON_START_CURSOR)
      : undefined,
  });
  let stopping = false;
  let heartbeatBusy = false;
  let stream: ReturnType<typeof connectEvents> | undefined;
  const heartbeat = setInterval(async () => {
    if (heartbeatBusy || stopping) return;
    heartbeatBusy = true;
    try {
      await client.mutation(api.photonBridge.heartbeat, {
        ...auth,
        connected: stream?.connected() ?? false,
      });
    } catch (error) {
      console.error("Worker heartbeat:", describeError(error));
      stopping = true;
    } finally {
      heartbeatBusy = false;
    }
  }, 10_000);
  const stop = () => {
    stopping = true;
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    stream = connectEvents({
      projectId: auth.projectId,
      apiKey,
      cursor,
      onError: (error) =>
        console.error("Photon connection:", describeError(error)),
      checkpoint: async (seq) => {
        await client.mutation(api.photonBridge.checkpoint, { ...auth, seq });
      },
      handle: async (event) => {
        const message = eventMessage(event, auth.projectId);
        if (!message) return;
        // Convex validates the receiving line against this attendee's assignment.
        const incoming = incomingMessage(message, auth.projectId);
        if (incoming) {
          if (
            await client.mutation(api.photonBridge.receive, {
              ...auth,
              ...incoming,
            })
          )
            console.log("Incoming iMessage saved in main Simon.");
        } else if (
          message.platform === "imessage" &&
          message.status !== "received"
        ) {
          await client.mutation(api.photonBridge.recordDelivery, {
            ...auth,
            externalId: message.id,
            status: message.status,
          });
        }
      },
    });
    await stream.ready;
    await client.mutation(api.photonBridge.heartbeat, {
      ...auth,
      connected: true,
    });
    console.log(
      `Main Simon is listening on ${agentHandle}. Agent logic runs in Convex.`,
    );
    while (!stopping) {
      if (!stream.connected()) {
        await delay(1000);
        continue;
      }
      // Serialized, durable generation preserves the main app's agent behavior.
      await client.action(api.agent.processNext, auth);
      if (stopping) break;
      const message = await client.mutation(api.photonBridge.claimSend, auth);
      if (!message) {
        await delay(1000);
        continue;
      }
      try {
        if (!message.spaceId || !message.senderId || !message.parentMessageId)
          throw new Error("Missing Photon conversation route.");
        const sent = await photon.projects.sendMessage({
          path: { id: auth.projectId },
          headers: { "idempotency-key": `simon:${message._id}` },
          body: {
            spaceId: message.spaceId,
            senderId: message.senderId,
            parentMessageId: message.parentMessageId,
            content: { type: "text", format: "plain", text: message.body },
          },
        });
        if (typeof sent.id !== "string")
          throw new Error("Photon returned no message ID.");
        await client.mutation(api.photonBridge.finishSend, {
          ...auth,
          messageId: message._id,
          externalId: sent.id,
          status: sent.status,
          error:
            sent.status === "failed"
              ? "Photon rejected delivery. Check API Activities."
              : undefined,
        });
        console.log("Main Simon reply submitted to Photon.");
        // Reconcile status events that may have arrived before recording the external ID.
        try {
          const current = await photon.projects.getMessage({
            path: { id: auth.projectId, messageId: sent.id },
          });
          if (current && typeof current.status === "string")
            await client.mutation(api.photonBridge.recordDelivery, {
              ...auth,
              externalId: sent.id,
              status: current.status,
            });
        } catch (error) {
          console.error("Delivery status:", describeError(error));
        }
      } catch (error) {
        console.error("Delivery failed:", describeError(error));
        await client.mutation(api.photonBridge.finishSend, {
          ...auth,
          messageId: message._id,
          status: "failed",
          error:
            error instanceof ApiError
              ? `Photon rejected the request (HTTP ${error.status}).`
              : "Delivery is uncertain. Check Photon before retrying.",
        });
      }
    }
  } finally {
    stopping = true;
    clearInterval(heartbeat);
    await stream?.stop();
    await client
      .mutation(api.photonBridge.heartbeat, {
        ...auth,
        connected: false,
        stopping: true,
      })
      .catch(() => {});
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }
}
main().catch((error) => {
  console.error("Photon worker stopped:", describeError(error));
  process.exitCode = 1;
});
