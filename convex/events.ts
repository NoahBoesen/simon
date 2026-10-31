import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

export const create = mutation({
  args: {
    token: v.string(),
    name: v.string(),
    lumaUrl: v.optional(v.string()),
    agenda: v.optional(v.string()),
    agentName: v.optional(v.string()),
    welcomeTemplate: v.optional(v.string()),
  },
  handler: async (ctx, { token, ...fields }) => {
    const session = await ctx.db
      .query("sessions")
      .withIndex("by_token", (q) => q.eq("token", token))
      .first();
    if (!session) throw new Error("Not logged in");
    const organizer = await ctx.db.get(session.organizerId);
    if (!organizer) throw new Error("Not logged in");
    return await ctx.db.insert("events", {
      ...fields,
      hostName: organizer.name,
      organizerId: organizer._id,
      status: "live",
    });
  },
});

export const getActive = query({
  args: {},
  handler: async (ctx) => {
    const events = await ctx.db.query("events").collect();
    return events.find((e) => e.status === "live") ?? null;
  },
});
