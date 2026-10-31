import { action, internalAction } from "./_generated/server";
import { api, internal } from "./_generated/api";
import { v } from "convex/values";
import { claude, parseJson } from "./lib/llm";
import type { Doc } from "./_generated/dataModel";

async function firecrawlSearch(query: string) {
  const key = process.env.FIRECRAWL_API_KEY;
  if (!key) return null;
  const res = await fetch("https://api.firecrawl.dev/v2/search", {
    method: "POST",
    headers: {
      authorization: `Bearer ${key}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ query, limit: 4 }),
  });
  if (!res.ok) {
    console.error(`[firecrawl] search ${res.status}: ${await res.text()}`);
    return null;
  }
  const data = await res.json();
  return data.data?.web ?? data.data ?? [];
}

export const researchAttendee = internalAction({
  args: { attendeeId: v.id("attendees") },
  handler: async (ctx, { attendeeId }): Promise<void> => {
    const attendee: Doc<"attendees"> | null = await ctx.runQuery(
      internal.attendees.get,
      { id: attendeeId }
    );
    if (!attendee || attendee.researchStatus === "done") return;

    await ctx.runMutation(internal.attendees.saveResearch, {
      id: attendeeId,
      researchStatus: "running",
    });

    const emailDomain =
      attendee.email && !/gmail|yahoo|outlook|icloud|hotmail/.test(attendee.email)
        ? attendee.email.split("@")[1]
        : null;
    const linkedinHandle = attendee.linkedin
      ? attendee.linkedin.replace(/\/$/, "").split("/").pop()
      : null;
    const query = linkedinHandle
      ? `${attendee.name} linkedin ${linkedinHandle}`
      : `${attendee.name}${emailDomain ? ` ${emailDomain}` : ""} founder OR engineer OR startup`;

    const results = await firecrawlSearch(query);
    if (!results || results.length === 0) {
      await ctx.runMutation(internal.attendees.saveResearch, {
        id: attendeeId,
        researchStatus: "skipped",
      });
      return;
    }

    const raw = await claude(
      `You synthesize public web results about an event attendee into intel for a matchmaking agent. Be conservative: results may be about a different person with the same name. If unsure, say less. Respond ONLY with JSON: {"summary":"one line, or empty string if nothing reliable","facts":["..."]} (max 3 facts).`,
      `ATTENDEE: ${attendee.name}${attendee.email ? ` (${attendee.email})` : ""}${attendee.linkedin ? `\nLINKEDIN: ${attendee.linkedin}` : ""}\nBIO: ${attendee.bio ?? "n/a"}\nSELF-DESCRIBED: ${attendee.oneLiner ?? "n/a"}\n\nWEB RESULTS:\n${JSON.stringify(results).slice(0, 6000)}`
    );
    const parsed = parseJson<{ summary: string; facts: string[] }>(raw, {
      summary: "",
      facts: [],
    });

    await ctx.runMutation(internal.attendees.saveResearch, {
      id: attendeeId,
      researchStatus: "done",
      researchSummary: parsed.summary || undefined,
      facts: parsed.facts?.slice(0, 3) ?? [],
    });
  },
});

// Host dashboard button: drain research across pending attendees.
export const researchAll = action({
  args: { eventId: v.id("events") },
  handler: async (ctx, { eventId }): Promise<{ queued: number }> => {
    const roster: Doc<"attendees">[] = await ctx.runQuery(
      api.attendees.listByEvent,
      { eventId }
    );
    const pending = roster.filter((a) => a.researchStatus === "pending");
    for (let i = 0; i < pending.length; i++) {
      await ctx.scheduler.runAfter(i * 2000, internal.research.researchAttendee, {
        attendeeId: pending[i]._id,
      });
    }
    return { queued: pending.length };
  },
});
