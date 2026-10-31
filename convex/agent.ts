import { action, internalAction } from "./_generated/server";
import { api, internal } from "./_generated/api";
import { v } from "convex/values";
import { claude, parseJson } from "./lib/llm";
import type { Doc, Id } from "./_generated/dataModel";

type AgentOut = {
  reply: string;
  actions: Array<
    | { type: "save_profile"; name?: string; oneLiner?: string }
    | { type: "ping"; targetName: string; message: string }
  >;
};

function rosterBlock(all: Doc<"attendees">[], selfId?: Id<"attendees">) {
  return all
    .filter((a) => a._id !== selfId)
    .map(
      (a) =>
        `- ${a.name}${a.oneLiner ? ` | wants: ${a.oneLiner}` : ""}${
          a.researchSummary ? ` | ${a.researchSummary}` : ""
        }`
    )
    .join("\n");
}

const SYSTEM = `You are Simon, a warm, sharp event concierge agent that attendees interact with over text message (iMessage/WhatsApp). You know everyone in the room. Your job: help attendees meet the right people tonight.

Rules:
- Keep replies SHORT, like a text from a friend. 1-3 sentences max. No emojis.
- If the attendee has no name or no one-liner on file yet, your first priority is onboarding: ask who they are and what they want out of tonight. When they answer, use save_profile.
- "who should I meet" / intro requests: pick 1-2 people from the roster with a concrete reason each.
- "ping X" / "intro me to X" / "tell X ...": use the ping action. The target gets your message directly, so write it TO the target, mentioning who is asking and why.
- Everything you know about attendees stays with you. Never dump the full roster or anyone's research to an attendee; share only the minimum needed for an intro.
- If asked something unrelated to the event, answer briefly and steer back.

Respond with ONLY valid JSON:
{"reply": "<text back to the sender>", "actions": [{"type":"save_profile","name":"...","oneLiner":"..."} | {"type":"ping","targetName":"...","message":"..."}]}
"actions" may be empty.`;

export const handleInbound = internalAction({
  args: { phone: v.string(), body: v.string() },
  handler: async (ctx, { phone, body }) => {
    const event = await ctx.runQuery(api.events.getActive, {});
    if (!event) {
      console.log("[agent] inbound with no active event, ignoring");
      return;
    }

    let attendee = await ctx.runQuery(internal.attendees.getByPhone, { phone });
    if (!attendee) {
      const id = await ctx.runMutation(internal.attendees.create, {
        eventId: event._id,
        name: `Guest ${phone.slice(-4)}`,
        phone,
      });
      attendee = await ctx.runQuery(internal.attendees.get, { id });
    }

    await ctx.runMutation(internal.messages.log, {
      eventId: event._id,
      attendeeId: attendee!._id,
      phone,
      direction: "inbound",
      body,
    });

    const roster = await ctx.runQuery(api.attendees.listByEvent, {
      eventId: event._id,
    });
    const history = await ctx.runQuery(internal.messages.recentByPhone, {
      phone,
      limit: 12,
    });

    const userPrompt = `EVENT: ${event.name}

SENDER ON FILE:
name: ${attendee!.name}
one-liner: ${attendee!.oneLiner ?? "(none yet - onboard them)"}

ROSTER (${roster.length - 1} others):
${rosterBlock(roster, attendee!._id)}

RECENT CONVERSATION (oldest first):
${history.map((m) => `${m.direction === "inbound" ? "THEM" : "YOU"}: ${m.body}`).join("\n")}

NEW MESSAGE FROM SENDER: ${body}`;

    const raw = await claude(SYSTEM, userPrompt);
    const out = parseJson<AgentOut>(raw, {
      reply: "Got it. Give me a second and text me again.",
      actions: [],
    });

    for (const act of out.actions ?? []) {
      if (act.type === "save_profile") {
        await ctx.runMutation(internal.attendees.updateProfile, {
          id: attendee!._id,
          name: act.name,
          oneLiner: act.oneLiner,
        });
        if (act.oneLiner) {
          await ctx.scheduler.runAfter(0, internal.matching.computeFor, {
            attendeeId: attendee!._id,
          });
          await ctx.scheduler.runAfter(0, internal.research.researchAttendee, {
            attendeeId: attendee!._id,
          });
        }
      } else if (act.type === "ping") {
        const target = roster.find(
          (r) =>
            r._id !== attendee!._id &&
            r.name.toLowerCase().includes(act.targetName.toLowerCase())
        );
        if (target) {
          await ctx.runMutation(internal.pings.create, {
            eventId: event._id,
            fromAttendeeId: attendee!._id,
            toAttendeeId: target._id,
            message: act.message,
            status: target.phone ? "queued" : "failed",
          });
          if (target.phone) {
            await ctx.scheduler.runAfter(0, internal.photon.send, {
              eventId: event._id,
              attendeeId: target._id,
              phone: target.phone,
              body: act.message,
            });
          }
        }
      }
    }

    if (out.reply) {
      await ctx.scheduler.runAfter(0, internal.photon.send, {
        eventId: event._id,
        attendeeId: attendee!._id,
        phone,
        body: out.reply,
      });
    }
  },
});

// Dashboard testing path (and demo fallback if Photon isn't live).
export const simulateInbound = action({
  args: { phone: v.string(), body: v.string() },
  handler: async (ctx, args): Promise<void> => {
    await ctx.runAction(internal.agent.handleInbound, args);
  },
});

// Host concierge: the host asks about the room from the dashboard.
export const hostAsk = action({
  args: { question: v.string() },
  handler: async (ctx, { question }): Promise<string> => {
    const event = await ctx.runQuery(api.events.getActive, {});
    if (!event) return "No active event yet.";
    const roster = await ctx.runQuery(api.attendees.listByEvent, {
      eventId: event._id,
    });
    const system = `You are Simon, the host's event concierge for "${event.name}". Answer the host's question about the room using the roster. Be concrete and brief. You may reference research facts freely with the host.`;
    const user = `ROSTER:\n${roster
      .map(
        (a) =>
          `- ${a.name}${a.oneLiner ? ` | wants: ${a.oneLiner}` : ""}${
            a.researchSummary ? ` | ${a.researchSummary}` : ""
          }${a.facts?.length ? ` | facts: ${a.facts.join("; ")}` : ""}`
      )
      .join("\n")}\n\nHOST QUESTION: ${question}`;
    return await claude(system, user);
  },
});
