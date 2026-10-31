import { action, internalAction } from "./_generated/server";
import { api, internal } from "./_generated/api";
import { v } from "convex/values";
import { claude, parseJson } from "./lib/llm";
import type { Doc } from "./_generated/dataModel";

async function firecrawlSearch(query: string) {
  const key = process.env.FIRECRAWL_API_KEY;
  if (!key) return null;
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch("https://api.firecrawl.dev/v2/search", {
      method: "POST",
      headers: {
        authorization: `Bearer ${key}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ query, limit: 4 }),
    });
    if (res.status === 429) {
      const body = await res.text();
      let waitSec = 10;
      try {
        waitSec = JSON.parse(body)?.retry_after_seconds ?? 10;
      } catch {}
      console.log(`[firecrawl] 429, retrying in ${waitSec}s`);
      await new Promise((r) => setTimeout(r, (waitSec + 1) * 1000));
      continue;
    }
    if (!res.ok) {
      console.error(`[firecrawl] search ${res.status}: ${await res.text()}`);
      return null;
    }
    const data = await res.json();
    return data.data?.web ?? data.data ?? [];
  }
  return null;
}

export const researchAttendee = internalAction({
  args: { attendeeId: v.id("attendees") },
  handler: async (ctx, { attendeeId }): Promise<void> => {
    const attendee: Doc<"attendees"> | null = await ctx.runQuery(
      internal.attendees.get,
      { id: attendeeId }
    );
    if (!attendee || attendee.isDemo || attendee.researchStatus === "done") return;

    await ctx.runMutation(internal.attendees.saveResearch, {
      id: attendeeId,
      researchStatus: "running",
    });

    const emailDomain =
      attendee.email && !/gmail|yahoo|outlook|icloud|hotmail/.test(attendee.email)
        ? attendee.email.split("@")[1]
        : null;
    const profileUrl = attendee.profileUrl || attendee.linkedin;
    let parsedProfile: URL | undefined;
    try {
      if (profileUrl)
        parsedProfile = new URL(
          profileUrl.includes("://") ? profileUrl : `https://${profileUrl}`,
        );
    } catch {
      /* Imported rows can contain incomplete profile links. Search by name instead. */
    }
    const profileHandle = parsedProfile?.pathname
      .replace(/\/$/, "")
      .split("/")
      .pop();
    // A quoted unique handle surfaces the exact profile; name-based queries
    // return same-name strangers that the synthesizer rightly discards.
    const query = profileHandle
      ? `"${profileHandle}"`
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
      `You synthesize public web results about an event attendee into intel for a matchmaking agent.${
        profileHandle
          ? ` Ground truth: the attendee's profile is ${parsedProfile!.hostname}${parsedProfile!.pathname}. Any result whose URL contains "${profileHandle}" IS this person — trust it fully and extract everything useful. Results about same-name people at other URLs are different people — ignore them.`
          : ` Be conservative: results may be about a different person with the same name. If unsure, say less.`
      } Respond ONLY with JSON: {"summary":"one line, or empty string if nothing reliable","facts":["..."]} (max 3 facts).`,
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
// retryEmpty also re-runs skipped attendees and done-but-empty ones.
export const researchAll = action({
  args: { eventId: v.id("events"), retryEmpty: v.optional(v.boolean()) },
  handler: async (ctx, { eventId, retryEmpty }): Promise<{ queued: number }> => {
    const roster: Doc<"attendees">[] = await ctx.runQuery(
      api.attendees.listByEvent,
      { eventId }
    );
    const pending = roster.filter(
      (a) =>
        a.researchStatus === "pending" ||
        (retryEmpty &&
          (a.researchStatus === "skipped" ||
            (a.researchStatus === "done" &&
              !a.researchSummary &&
              !a.facts?.length)))
    );
    for (let i = 0; i < pending.length; i++) {
      if (pending[i].researchStatus !== "pending") {
        await ctx.runMutation(internal.attendees.saveResearch, {
          id: pending[i]._id,
          researchStatus: "pending",
        });
      }
      // 2.5s stagger keeps us under Firecrawl's 36 req/min limit.
      await ctx.scheduler.runAfter(i * 2500, internal.research.researchAttendee, {
        attendeeId: pending[i]._id,
      });
    }
    return { queued: pending.length };
  },
});
