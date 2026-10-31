import { internalMutation, internalQuery, query } from "./_generated/server";
import { v } from "convex/values";

export const log = internalMutation({
  args: {
    eventId: v.optional(v.id("events")),
    attendeeId: v.optional(v.id("attendees")),
    phone: v.string(),
    direction: v.string(),
    body: v.string(),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("messages", args);
  },
});

export const recentByPhone = internalQuery({
  args: { phone: v.string(), limit: v.optional(v.number()) },
  handler: async (ctx, { phone, limit }) => {
    const msgs = await ctx.db
      .query("messages")
      .withIndex("by_phone", (q) => q.eq("phone", phone))
      .order("desc")
      .take(limit ?? 10);
    return msgs.reverse();
  },
});

export const listByEvent = query({
  args: { eventId: v.id("events") },
  handler: async (ctx, { eventId }) => {
    const msgs = await ctx.db
      .query("messages")
      .withIndex("by_event", (q) => q.eq("eventId", eventId))
      .order("desc")
      .take(100);
    return msgs.reverse();
  },
});
