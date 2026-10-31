import { internalMutation, internalQuery, query } from "./_generated/server";
import { v } from "convex/values";

export const get = internalQuery({
  args: { id: v.id("messages") },
  handler: (ctx, { id }) => ctx.db.get(id),
});

export const createSimulation = internalMutation({
  args: { phone: v.string(), body: v.string() },
  handler: async (ctx, { phone, body }) => {
    if (!body.trim() || body.length > 16000)
      throw new Error("Invalid message.");
    const event = (await ctx.db.query("events").collect()).find(
      (e) => e.status === "live",
    );
    if (!event) throw new Error("Create an event first.");
    const person = await ctx.db
      .query("attendees")
      .withIndex("by_phone", (q) => q.eq("phone", phone))
      .filter((q) => q.eq(q.field("eventId"), event._id))
      .first();
    const attendeeId =
      person?._id ??
      (await ctx.db.insert("attendees", {
        eventId: event._id,
        name: `Demo Guest ${phone.slice(-4)}`,
        phone,
        researchStatus: "skipped",
      }));
    return ctx.db.insert("messages", {
      eventId: event._id,
      attendeeId,
      phone,
      body,
      direction: "inbound",
      simulation: true,
    });
  },
});

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
  args: {
    phone: v.string(),
    eventId: v.id("events"),
    simulation: v.boolean(),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, { phone, eventId, simulation, limit }) => {
    const attendee = await ctx.db.query("attendees")
      .withIndex("by_phone", (q) => q.eq("phone", phone))
      .filter((q) => q.eq(q.field("eventId"), eventId)).first();
    const msgs = await ctx.db
      .query("messages")
      .withIndex("by_phone", (q) => q.eq("phone", phone))
      .filter((q) =>
        q.and(
          q.eq(q.field("eventId"), eventId),
          q.gte(q.field("_creationTime"), attendee?.conversationStartedAt ?? 0),
          simulation
            ? q.eq(q.field("simulation"), true)
            : q.neq(q.field("simulation"), true),
          q.neq(q.field("deliveryStatus"), "failed"),
          q.neq(q.field("deliveryStatus"), "cancelled"),
          q.neq(q.field("deliveryStatus"), "queued"),
        ),
      )
      .order("desc")
      .take(limit ?? 10);
    return msgs.reverse();
  },
});

// The /text simulator only reads simulated messages from the active event.
export const listByPhone = query({
  args: { phone: v.string() },
  handler: async (ctx, { phone }) => {
    const event = (await ctx.db.query("events").collect()).find(
      (e) => e.status === "live",
    );
    if (!event) return [];
    const msgs = await ctx.db
      .query("messages")
      .withIndex("by_phone", (q) => q.eq("phone", phone))
      .filter((q) =>
        q.and(
          q.eq(q.field("eventId"), event._id),
          q.eq(q.field("simulation"), true),
        ),
      )
      .order("desc")
      .take(100);
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
