import { action, internalAction } from "./_generated/server";
import { api, internal } from "./_generated/api";
import { v } from "convex/values";
import { claude, parseJson } from "./lib/llm";
import type { Doc } from "./_generated/dataModel";

type SearchResult =
  | { ok: true; results: { url?: string; title?: string; description?: string }[] }
  | { ok: false; rateLimited: true; retryAfterSec: number }
  | { ok: false; rateLimited?: false };

async function firecrawlSearch(query: string): Promise<SearchResult> {
  const key = process.env.FIRECRAWL_API_KEY;
  if (!key) return { ok: false };
  const res = await fetch("https://api.firecrawl.dev/v2/search", {
    method: "POST",
    headers: {
      authorization: `Bearer ${key}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ query, limit: 4 }),
  });
  if (res.status === 429) {
    let retryAfterSec = 15;
    try {
      retryAfterSec = JSON.parse(await res.text())?.retry_after_seconds ?? 15;
    } catch {}
    return { ok: false, rateLimited: true, retryAfterSec };
  }
  if (!res.ok) {
    console.error(`[firecrawl] search ${res.status}: ${await res.text()}`);
    return { ok: false };
  }
  const data = await res.json();
  return { ok: true, results: data.data?.web ?? data.data ?? [] };
}

const MAX_RATE_LIMIT_RETRIES = 5;

export const researchAttendee = internalAction({
  args: { attendeeId: v.id("attendees"), attempt: v.optional(v.number()) },
  handler: async (ctx, { attendeeId, attempt = 0 }): Promise<void> => {
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

    const search = await firecrawlSearch(query);
    if (!search.ok) {
      if (search.rateLimited && attempt < MAX_RATE_LIMIT_RETRIES) {
        // Reschedule instead of sleeping in-action: exponential backoff plus
        // jitter so a burst of rate-limited jobs doesn't stampede back at once.
        const delayMs =
          (search.retryAfterSec + 2 ** attempt + Math.random() * 10) * 1000;
        console.log(
          `[research] 429 for ${attendee.name}, retry ${attempt + 1}/${MAX_RATE_LIMIT_RETRIES} in ${Math.round(delayMs / 1000)}s`
        );
        await ctx.runMutation(internal.attendees.saveResearch, {
          id: attendeeId,
          researchStatus: "pending",
        });
        await ctx.scheduler.runAfter(delayMs, internal.research.researchAttendee, {
          attendeeId,
          attempt: attempt + 1,
        });
        return;
      }
      await ctx.runMutation(internal.attendees.saveResearch, {
        id: attendeeId,
        researchStatus: "skipped",
      });
      return;
    }
    if (search.results.length === 0) {
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
      `ATTENDEE: ${attendee.name}${attendee.email ? ` (${attendee.email})` : ""}${attendee.linkedin ? `\nLINKEDIN: ${attendee.linkedin}` : ""}\nBIO: ${attendee.bio ?? "n/a"}\nSELF-DESCRIBED: ${attendee.oneLiner ?? "n/a"}\n\nWEB RESULTS:\n${JSON.stringify(search.results).slice(0, 6000)}`
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
