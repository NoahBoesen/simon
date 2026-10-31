import { action } from "./_generated/server";
import { api } from "./_generated/api";
import { v } from "convex/values";
import { claude, parseJson } from "./lib/llm";

// Onboarding step 1: read the event page so the host isn't retyping anything.
export const scanEvent = action({
  args: { url: v.string() },
  handler: async (
    ctx,
    { url }
  ): Promise<{ ok: boolean; name?: string; agenda?: string; error?: string }> => {
    const key = process.env.FIRECRAWL_API_KEY;
    if (!key) return { ok: false, error: "FIRECRAWL_API_KEY not set" };
    const res = await fetch("https://api.firecrawl.dev/v2/scrape", {
      method: "POST",
      headers: {
        authorization: `Bearer ${key}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ url, formats: ["markdown"] }),
    });
    if (!res.ok) return { ok: false, error: "Could not read that page." };
    const data = await res.json();
    const markdown: string = data.data?.markdown ?? "";
    if (!markdown) return { ok: false, error: "Empty page" };

    const raw = await claude(
      `You read an event page for an event-concierge product. Extract the event name and a short agenda: what the event is about and what the host plausibly wants out of it (2-3 sentences, written to the host as "you"). Respond ONLY with JSON: {"name":"...","agenda":"..."}`,
      markdown.slice(0, 12000)
    );
    const parsed = parseJson<{ name: string; agenda: string }>(raw, {
      name: "",
      agenda: "",
    });
    if (!parsed.name) return { ok: false, error: "Couldn't parse that page." };
    return { ok: true, name: parsed.name, agenda: parsed.agenda };
  },
});

// Scrape a public Luma page with Firecrawl and extract guest names.
// CSV upload (client-side parse -> attendees.bulkImport) is the reliable path;
// this covers "no CSV yet" and ticks the Firecrawl box.
export const fromLuma = action({
  args: { eventId: v.id("events"), lumaUrl: v.string() },
  handler: async (
    ctx,
    { eventId, lumaUrl }
  ): Promise<{ added: number; note: string }> => {
    const key = process.env.FIRECRAWL_API_KEY;
    if (!key) return { added: 0, note: "FIRECRAWL_API_KEY not set" };

    const res = await fetch("https://api.firecrawl.dev/v2/scrape", {
      method: "POST",
      headers: {
        authorization: `Bearer ${key}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ url: lumaUrl, formats: ["markdown"] }),
    });
    if (!res.ok) {
      return { added: 0, note: `Firecrawl scrape failed: ${res.status}` };
    }
    const data = await res.json();
    const markdown: string = data.data?.markdown ?? "";
    if (!markdown) return { added: 0, note: "Empty page" };

    const raw = await claude(
      `Extract attendee/guest names from this event page. Respond ONLY with JSON: {"names":["Full Name", ...]}. Only real human names visible as guests/attendees/hosts. Empty array if none listed.`,
      markdown.slice(0, 15000)
    );
    const parsed = parseJson<{ names: string[] }>(raw, { names: [] });
    if (!parsed.names.length) {
      return { added: 0, note: "No public guest names on page" };
    }

    const { added } = await ctx.runMutation(api.attendees.bulkImport, {
      eventId,
      rows: parsed.names.map((name) => ({ name })),
    });
    return { added, note: `Found ${parsed.names.length} names` };
  },
});
