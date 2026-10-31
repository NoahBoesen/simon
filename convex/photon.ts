import { internalMutation, type MutationCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { v } from "convex/values";

export const sendArgs = {
  eventId: v.optional(v.id("events")),
  attendeeId: v.optional(v.id("attendees")),
  phone: v.string(),
  body: v.string(),
  sourceMessageId: v.optional(v.id("messages")),
  pingId: v.optional(v.id("pings")),
  simulation: v.optional(v.boolean()),
  introductionId: v.optional(v.id("introductions")),
};
type Send = {
  eventId?: Id<"events">;
  attendeeId?: Id<"attendees">;
  phone: string;
  body: string;
  sourceMessageId?: Id<"messages">;
  pingId?: Id<"pings">;
  simulation?: boolean;
  introductionId?: Id<"introductions">;
};

/** Queue an immutable Photon payload; the persistent worker performs delivery. */
export async function queueMessage(ctx: MutationCtx, args: Send) {
  const projectId = process.env.PHOTON_PROJECT_ID;
  const attendee = args.attendeeId ? await ctx.db.get(args.attendeeId) : null;
  const route = projectId
    ? await ctx.db
        .query("photonConversations")
        .withIndex("by_phone", (q) =>
          q.eq("projectId", projectId).eq("phone", args.phone),
        )
        .unique()
    : null;
  const error =
    !args.body.trim() || args.body.length > 8000
      ? "Invalid outbound text."
      : attendee?.isDemo && !args.simulation
        ? "Fictional demo attendees can only receive simulated messages."
        : !route
          ? "This attendee must text their assigned Photon line before receiving a message."
          : route.optedOut
            ? "This attendee opted out."
            : undefined;
  const status = args.simulation ? "mock" : error ? "failed" : "queued";
  const messageId = await ctx.db.insert("messages", {
    ...args,
    direction: "outbound",
    projectId,
    deliveryStatus: status,
    error: args.simulation ? undefined : error,
    spaceId: route?.spaceId,
    senderId: route?.senderId,
    parentMessageId: route?.lastExternalId,
  });
  if (args.pingId) await ctx.db.patch(args.pingId, { status });
  return { messageId, status };
}

export const send = internalMutation({ args: sendArgs, handler: queueMessage });
