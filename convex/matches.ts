import { internalMutation, query } from "./_generated/server";
import { v } from "convex/values";

export const listByEvent = query({
  args: { eventId: v.id("events") },
  handler: async (ctx, { eventId }) => {
    const matches = await ctx.db
      .query("matches")
      .withIndex("by_event", (q) => q.eq("eventId", eventId))
      .collect();
    const result = [];
    for (const m of matches) {
      const a = await ctx.db.get(m.attendeeA);
      const b = await ctx.db.get(m.attendeeB);
      result.push({ ...m, nameA: a?.name ?? "?", nameB: b?.name ?? "?" });
    }
    return result.sort((x, y) => y.score - x.score);
  },
});

export const upsert = internalMutation({
  args: {
    eventId: v.id("events"),
    attendeeA: v.id("attendees"),
    attendeeB: v.id("attendees"),
    score: v.number(),
    reason: v.string(),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("matches")
      .withIndex("by_attendeeA", (q) => q.eq("attendeeA", args.attendeeA))
      .collect();
    const dup = existing.find((m) => m.attendeeB === args.attendeeB);
    if (dup) {
      await ctx.db.patch(dup._id, { score: args.score, reason: args.reason });
      return dup._id;
    }
    return await ctx.db.insert("matches", { ...args, status: "suggested" });
  },
});
