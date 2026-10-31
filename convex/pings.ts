import { internalMutation, query } from "./_generated/server";
import { v } from "convex/values";

export const create = internalMutation({
  args: {
    eventId: v.id("events"),
    fromAttendeeId: v.optional(v.id("attendees")),
    toAttendeeId: v.id("attendees"),
    message: v.string(),
    status: v.string(),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("pings", args);
  },
});

export const listByEvent = query({
  args: { eventId: v.id("events") },
  handler: async (ctx, { eventId }) => {
    const pings = await ctx.db
      .query("pings")
      .withIndex("by_event", (q) => q.eq("eventId", eventId))
      .order("desc")
      .take(50);
    // Keep the host dashboard's existing feed contract. A request only counts
    // as a new introduction once the recipient has accepted it.
    const introductions = await ctx.db
      .query("introductions")
      .withIndex("by_event", (q) => q.eq("eventId", eventId))
      .filter((q) => q.eq(q.field("status"), "accepted"))
      .order("desc")
      .take(50);
    const activity = [
      ...pings,
      ...introductions.map((intro) => ({
        _id: intro._id,
        _creationTime: intro._creationTime,
        eventId: intro.eventId,
        fromAttendeeId: intro.fromAttendeeId,
        toAttendeeId: intro.toAttendeeId,
        message: intro.reason,
        status: intro.status,
      })),
    ]
      .sort((a, b) => b._creationTime - a._creationTime)
      .slice(0, 50);
    const result = [];
    for (const p of activity) {
      const from = p.fromAttendeeId ? await ctx.db.get(p.fromAttendeeId) : null;
      const to = await ctx.db.get(p.toAttendeeId);
      result.push({
        ...p,
        fromName: from?.name ?? "Host",
        toName: to?.name ?? "?",
      });
    }
    return result;
  },
});
