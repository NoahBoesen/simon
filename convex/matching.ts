import { action, internalAction } from "./_generated/server";
import { api, internal } from "./_generated/api";
import { v } from "convex/values";
import { claude, parseJson } from "./lib/llm";
import type { Doc } from "./_generated/dataModel";

type MatchOut = Array<{ name: string; score: number; reason: string }>;

export const computeFor = internalAction({
  args: { attendeeId: v.id("attendees") },
  handler: async (ctx, { attendeeId }): Promise<void> => {
    const attendee: Doc<"attendees"> | null = await ctx.runQuery(
      internal.attendees.get,
      { id: attendeeId }
    );
    if (!attendee) return;
    const roster: Doc<"attendees">[] = await ctx.runQuery(
      api.attendees.listByEvent,
      { eventId: attendee.eventId }
    );
    const others = roster.filter(
      (a) => a._id !== attendeeId && (a.oneLiner || a.bio || a.researchSummary)
    );
    if (others.length === 0) return;

    const raw = await claude(
      `You are a matchmaking engine for a live event. Given one attendee and the roster, pick the top matches (max 3) they should meet tonight. Score 0-100 for mutual value. Reasons must be concrete and specific, one sentence. Respond ONLY with JSON: [{"name":"<exact roster name>","score":85,"reason":"..."}]`,
      `ATTENDEE: ${attendee.name} | wants: ${attendee.oneLiner ?? "unknown"} | ${attendee.bio ?? ""} | ${attendee.researchSummary ?? ""}

ROSTER:
${others
  .map(
    (a) =>
      `- ${a.name}${a.oneLiner ? ` | wants: ${a.oneLiner}` : ""}${a.bio ? ` | ${a.bio}` : ""}${a.researchSummary ? ` | ${a.researchSummary}` : ""}`
  )
  .join("\n")}`
    );
    const matches = parseJson<MatchOut>(raw, []);

    for (const m of matches.slice(0, 3)) {
      const target = others.find(
        (a) => a.name.toLowerCase() === m.name.toLowerCase()
      );
      if (!target) continue;
      await ctx.runMutation(internal.matches.upsert, {
        eventId: attendee.eventId,
        attendeeA: attendeeId,
        attendeeB: target._id,
        score: Math.max(0, Math.min(100, m.score)),
        reason: m.reason,
      });
    }
  },
});

export const computeAll = action({
  args: { eventId: v.id("events") },
  handler: async (ctx, { eventId }): Promise<{ queued: number }> => {
    const roster: Doc<"attendees">[] = await ctx.runQuery(
      api.attendees.listByEvent,
      { eventId }
    );
    const eligible = roster.filter(
      (a) => a.oneLiner || a.bio || a.researchSummary
    );
    for (let i = 0; i < eligible.length; i++) {
      await ctx.scheduler.runAfter(i * 1500, internal.matching.computeFor, {
        attendeeId: eligible[i]._id,
      });
    }
    return { queued: eligible.length };
  },
});
