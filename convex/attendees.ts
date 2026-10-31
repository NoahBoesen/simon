import {
  internalMutation,
  internalQuery,
  mutation,
  query,
} from "./_generated/server";
import { v } from "convex/values";

export const listByEvent = query({
  args: { eventId: v.id("events") },
  handler: async (ctx, { eventId }) => {
    const attendees = await ctx.db
      .query("attendees")
      .withIndex("by_event", (q) => q.eq("eventId", eventId))
      .collect();
    // Also support goals saved before the agent started mirroring oneLiner.
    return attendees.map((attendee) => ({
      ...attendee,
      oneLiner: attendee.connectionGoals || attendee.oneLiner,
    }));
  },
});

export const getByPhone = internalQuery({
  args: { phone: v.string() },
  handler: async (ctx, { phone }) => {
    return await ctx.db
      .query("attendees")
      .withIndex("by_phone", (q) => q.eq("phone", phone))
      .first();
  },
});

export const get = internalQuery({
  args: { id: v.id("attendees") },
  handler: async (ctx, { id }) => ctx.db.get(id),
});

// Operator-only linking of a verified messaging identity to an imported guest.
export const setMessagingPhone = internalMutation({
  args: { id: v.id("attendees"), phone: v.string(), expectedPhone: v.string() },
  handler: async (ctx, { id, phone, expectedPhone }) => {
    if (!/^\+[1-9]\d{7,14}$/.test(phone)) throw new Error("Use an E.164 number.");
    const attendee = await ctx.db.get(id);
    if (!attendee || attendee.phone !== expectedPhone) throw new Error("Guest contact changed; inspect it before relinking.");
    const duplicate = await ctx.db.query("attendees")
      .withIndex("by_phone", (q) => q.eq("phone", phone))
      .filter((q) => q.eq(q.field("eventId"), attendee.eventId)).first();
    if (duplicate && duplicate._id !== id) throw new Error("Number already belongs to another guest.");
    await ctx.db.patch(id, {
      phone,
      alternatePhones: [...new Set([...(attendee.alternatePhones || []), expectedPhone])].filter((p) => p !== phone),
    });
    return { linked: true };
  },
});

export const create = internalMutation({
  args: {
    eventId: v.id("events"),
    name: v.string(),
    phone: v.optional(v.string()),
    email: v.optional(v.string()),
    oneLiner: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("attendees", {
      ...args,
      researchStatus: "pending",
    });
  },
});

export const updateProfile = internalMutation({
  args: {
    id: v.id("attendees"),
    name: v.optional(v.string()),
    oneLiner: v.optional(v.string()),
  },
  handler: async (ctx, { id, name, oneLiner }) => {
    const patch: Record<string, string> = {};
    if (name) patch.name = name;
    if (oneLiner) patch.oneLiner = oneLiner;
    if (Object.keys(patch).length) await ctx.db.patch(id, patch);
  },
});

export const saveResearch = internalMutation({
  args: {
    id: v.id("attendees"),
    researchStatus: v.string(),
    researchSummary: v.optional(v.string()),
    facts: v.optional(v.array(v.string())),
    sources: v.optional(v.array(v.string())),
    linkedin: v.optional(v.string()),
    expectedName: v.optional(v.string()),
    expectedProfile: v.optional(v.string()),
    expectedBio: v.optional(v.string()),
  },
  handler: async (ctx, { id, expectedName, expectedProfile, expectedBio, ...rest }) => {
    const person = await ctx.db.get(id);
    if (!person || (expectedName !== undefined &&
      (person.name !== expectedName || (person.profileUrl || person.linkedin || "") !== expectedProfile)) ||
      (expectedBio !== undefined && (person.bio || "") !== expectedBio)) return;
    await ctx.db.patch(id, rest);
  },
});

export const bulkImport = mutation({
  args: {
    eventId: v.id("events"),
    rows: v.array(
      v.object({
        name: v.string(),
        email: v.optional(v.string()),
        phone: v.optional(v.string()),
        linkedin: v.optional(v.string()),
        bio: v.optional(v.string()),
      })
    ),
  },
  handler: async (ctx, { eventId, rows }) => {
    const existing = await ctx.db
      .query("attendees")
      .withIndex("by_event", (q) => q.eq("eventId", eventId))
      .collect();
    const seen = new Set(existing.map((a) => a.name.toLowerCase().trim()));
    let added = 0;
    for (const row of rows) {
      const key = row.name.toLowerCase().trim();
      if (!row.name.trim() || seen.has(key)) continue;
      seen.add(key);
      await ctx.db.insert("attendees", {
        eventId,
        name: row.name.trim(),
        email: row.email || undefined,
        phone: row.phone ? normalizePhone(row.phone) : undefined,
        linkedin: row.linkedin || undefined,
        bio: row.bio || undefined,
        researchStatus: "pending",
      });
      added++;
    }
    return { added };
  },
});

export function normalizePhone(raw: string): string {
  const digits = raw.replace(/[^\d+]/g, "");
  if (digits.startsWith("+")) return digits;
  if (digits.length === 10) return `+1${digits}`;
  return `+${digits}`;
}
