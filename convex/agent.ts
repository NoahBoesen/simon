import { action, internalAction, internalMutation, internalQuery } from "./_generated/server";
import { api, internal } from "./_generated/api";
import { v } from "convex/values";
import { claude, claudeJson, parseJson } from "./lib/llm";
import { buildSystem } from "./lib/attendeePrompt";
import { agentResultSchema } from "./lib/agentResultSchema";
import { workerArgs, requireWorker, authorize } from "./lib/photonAuth";
import { queueMessage } from "./photon";
import {
  requestIntroduction,
  respondToIntroduction,
  answerIntroduction,
  relayMeetingMessage,
  introductionContext,
} from "./lib/introductions";
import type { Doc, Id } from "./_generated/dataModel";

type AgentOut = {
  reply: string;
  actions: Array<
    | {
        type: "save_profile";
        name?: string;
        oneLiner?: string;
        connectionGoals?: string;
      }
    | {
        type: "recommend";
        picks: Array<{ attendeeId: string; reason: string }>;
      }
    | { type: "request_intro"; attendeeId: string; reason: string }
    | { type: "respond_intro"; introductionId: string; decision: "accept" | "decline"; message?: string }
    | { type: "relay_intro"; introductionId: string; message: string }
    | { type: "ping"; targetName: string; message: string }
  >;
};
const resultValidator = v.object({
  reply: v.string(),
  actions: v.array(
    v.union(
      v.object({
        type: v.literal("save_profile"),
        name: v.optional(v.string()),
        oneLiner: v.optional(v.string()),
        connectionGoals: v.optional(v.string()),
      }),
      v.object({
        type: v.literal("recommend"),
        picks: v.array(
          v.object({ attendeeId: v.string(), reason: v.string() }),
        ),
      }),
      v.object({
        type: v.literal("request_intro"),
        attendeeId: v.string(),
        reason: v.string(),
      }),
      v.object({
        type: v.literal("respond_intro"),
        introductionId: v.string(),
        decision: v.union(v.literal("accept"), v.literal("decline")),
        message: v.optional(v.string()),
      }),
      v.object({
        type: v.literal("relay_intro"),
        introductionId: v.string(),
        message: v.string(),
      }),
      v.object({
        type: v.literal("ping"),
        targetName: v.string(),
        message: v.string(),
      }),
    ),
  ),
});
function rosterBlock(all: Doc<"attendees">[], selfId?: Id<"attendees">) {
  return JSON.stringify(
    all
      .filter((a) => a._id !== selfId)
      .map((a) => ({
        attendeeId: a._id,
        name: a.name,
        bio: a.bio,
        summary: a.researchSummary,
        facts: a.facts,
        profile: a.profileUrl || a.linkedin,
        lookingFor: a.connectionGoals || a.oneLiner,
        demo: a.isDemo,
      })),
  );
}

export const introductionState = internalQuery({
  args: { sourceMessageId: v.id("messages") },
  handler: async (ctx, { sourceMessageId }) => {
    const source = await ctx.db.get(sourceMessageId);
    return source ? await introductionContext(ctx, source) : [];
  },
});

// The Node worker only triggers this queue; Claude and business logic stay in Convex.
export const checkModel = action({
  args: { token: v.string(), projectId: v.string() },
  handler: async (_ctx, args) => {
    authorize(args.token, args.projectId);
    await claude("Connection check. Reply with OK.", "Ready?", 16);
    return true;
  },
});

export const processNext = action({
  args: workerArgs,
  handler: async (ctx, auth): Promise<boolean> => {
    const job = await ctx.runMutation(
      internal.photonBridge.claimGeneration,
      auth,
    );
    if (!job) return false;
    try {
      await ctx.runAction(internal.agent.handleInbound, {
        sourceMessageId: job.sourceMessageId,
        jobId: job._id,
        auth,
      });
    } catch (error) {
      console.error(
        "[agent] generation failed:",
        error instanceof Error ? error.message : "Unknown error",
      );
      await ctx.runMutation(internal.photonBridge.failGeneration, {
        ...auth,
        jobId: job._id,
      });
    }
    return true;
  },
});

export const handleInbound = internalAction({
  args: {
    sourceMessageId: v.id("messages"),
    jobId: v.optional(v.id("agentJobs")),
    auth: v.optional(v.object(workerArgs)),
  },
  handler: async (ctx, args): Promise<void> => {
    const source = await ctx.runQuery(internal.messages.get, {
      id: args.sourceMessageId,
    });
    if (!source?.eventId || !source.attendeeId)
      throw new Error("Incoming message has no event or attendee.");
    const event = await ctx.runQuery(internal.events.get, {
      id: source.eventId,
    });
    let attendee = await ctx.runQuery(internal.attendees.get, {
      id: source.attendeeId,
    });
    if (!event || !attendee || event.status !== "live")
      throw new Error("Event is no longer active.");
    if (/^(YES|NO)\s+[A-Z0-9]{8}[.!]?$/i.test(source.body.trim())) {
      await ctx.runMutation(internal.agent.commitResult, {
        ...args,
        result: { reply: "", actions: [] },
      });
      return;
    }
    if (
      !event.demo &&
      !source.simulation &&
      attendee.researchStatus === "pending" &&
      !attendee.researchSummary
    ) {
      await ctx.runAction(internal.research.researchAttendee, {
        attendeeId: attendee._id,
      });
      attendee = (await ctx.runQuery(internal.attendees.get, {
        id: attendee._id,
      }))!;
    }
    const roster = await ctx.runQuery(api.attendees.listByEvent, {
      eventId: event._id,
    });
    const history = await ctx.runQuery(internal.messages.recentByPhone, {
      phone: source.phone,
      eventId: event._id,
      simulation: source.simulation ?? false,
      limit: 12,
    });
    const introductions = await ctx.runQuery(internal.agent.introductionState, {
      sourceMessageId: source._id,
    });
    const userPrompt = `EVENT: ${event.name}
${event.demo ? "DEMO MODE: The roster contains clearly labeled sample people. Say this is a demo; never present sample profiles as real attendees at tonight's event." : ""}

SENDER ON FILE:
name: ${attendee.name}
profile: ${attendee.profileUrl || attendee.linkedin || "not supplied"}
bio: ${attendee.bio || "unknown"}
cached research: ${attendee.researchSummary || "not available"}
facts: ${JSON.stringify(attendee.facts || [])}
connection goals: ${attendee.connectionGoals || attendee.oneLiner || "(not stated; start with relevant suggestions from the saved profile if possible)"}
event meeting point: ${event.meetingPoint || "the welcome desk"}

INTRODUCTIONS (only this sender's connections; canRespond means an invitation to them):
${JSON.stringify(introductions)}

ROSTER (${roster.length - 1} others):
${rosterBlock(roster, attendee._id)}

RECENT CONVERSATION (oldest first):
${history.filter((m) => m._creationTime <= source._creationTime).map((m) => `${m.direction === "inbound" ? "THEM" : "YOU"}: ${m.body}`).join("\n")}`;
    const out = await claudeJson<AgentOut>(
      buildSystem(event), userPrompt, agentResultSchema,
    );
    await ctx.runMutation(internal.agent.commitResult, {
      ...args,
      result: out,
    });
  },
});

// Apply a generation once, atomically with its outgoing messages. Stale generations do nothing.
export const commitResult = internalMutation({
  args: {
    sourceMessageId: v.id("messages"),
    jobId: v.optional(v.id("agentJobs")),
    auth: v.optional(v.object(workerArgs)),
    result: resultValidator,
  },
  handler: async (ctx, args) => {
    const source = await ctx.db.get(args.sourceMessageId);
    if (!source?.eventId || !source.attendeeId)
      throw new Error("Missing source message.");
    if (source.processedAt !== undefined) return;
    const event = await ctx.db.get(source.eventId);
    if (!event) throw new Error("Missing event.");
    if (!source.simulation) {
      if (!args.auth || !args.jobId)
        throw new Error("Live replies require a worker job.");
      await requireWorker(ctx, args.auth);
      const job = await ctx.db.get(args.jobId);
      if (
        !job ||
        job.status !== "processing" ||
        job.workerId !== args.auth.workerId ||
        job.sourceMessageId !== source._id
      )
        return;
      const route = await ctx.db
        .query("photonConversations")
        .withIndex("by_phone", (q) =>
          q.eq("projectId", args.auth!.projectId).eq("phone", source.phone),
        )
        .unique();
      if (
        event.status !== "live" ||
        route?.optedOut ||
        route?.lastInboundId !== source._id
      ) {
        await ctx.db.patch(job._id, { status: "cancelled" });
        return;
      }
    }
    const roster = await ctx.db
      .query("attendees")
      .withIndex("by_event", (q) => q.eq("eventId", event._id))
      .collect();
    const consentReply = await respondToIntroduction(ctx, source);
    let reply = consentReply ?? args.result.reply;
    const coordinated = new Set<string>();
    for (const act of consentReply !== null
      ? []
      : args.result.actions.slice(0, 10)) {
      if (act.type === "save_profile") {
        // The existing host dashboard and matcher read goals from oneLiner.
        const goals = (act.connectionGoals?.trim() || act.oneLiner?.trim())?.slice(
          0,
          1000,
        );
        await ctx.db.patch(source.attendeeId, {
          ...(goals ? { connectionGoals: goals, oneLiner: goals } : {}),
          ...(act.name?.trim() ? { name: act.name.trim().slice(0, 120) } : {}),
        });
      } else if (act.type === "recommend") {
        const seen = new Set<string>();
        const picks = act.picks
          .flatMap((pick) => {
            const target = roster.find(
              (a) => a._id === pick.attendeeId && a._id !== source.attendeeId,
            );
            if (!target || seen.has(target._id) || !pick.reason.trim())
              return [];
            seen.add(target._id);
            return [{ target, reason: pick.reason.trim().slice(0, 600) }];
          })
          .slice(0, 3);
        const old = await ctx.db
          .query("matches")
          .withIndex("by_attendeeA", (q) =>
            q.eq("attendeeA", source.attendeeId!),
          )
          .collect();
        for (const match of old)
          if (
            !!match.simulation === !!source.simulation &&
            match.status === "suggested"
          )
            await ctx.db.patch(match._id, { status: "superseded" });
        for (const [index, pick] of picks.entries())
          await ctx.db.insert("matches", {
            eventId: event._id,
            attendeeA: source.attendeeId,
            attendeeB: pick.target._id,
            reason: pick.reason,
            score: 95 - index * 5,
            status: "suggested",
            sourceMessageId: source._id,
            simulation: !!source.simulation,
          });
        const self = await ctx.db.get(source.attendeeId);
        const recommendations = picks.map(({ target, reason }, i) => {
          const profile = target.linkedin
            ? `\nLinkedIn${target.isDemo ? " (demo placeholder)" : ""}: ${target.linkedin}`
            : "";
          return `${i + 1}. ${target.name} — ${reason}${profile}`;
        });
        reply = picks.length
          ? `Hi ${self?.name || "there"}! Here ${picks.length === 1 ? "is 1 person" : `are ${picks.length} people`} I think you should talk to${event.demo ? " in this demo" : " tonight"}:\n\n${recommendations.join("\n\n")}\n\nWant an introduction, or should I look for a different kind of person?`
          : "I couldn't find a supported match for that request in this roster. What other backgrounds would be useful?";
      } else if (act.type === "respond_intro" || act.type === "relay_intro") {
        if (coordinated.has(act.introductionId)) continue;
        coordinated.add(act.introductionId);
        reply = act.type === "respond_intro"
          ? await answerIntroduction(ctx, source, act.introductionId, act.decision, act.message)
          : await relayMeetingMessage(ctx, source, act.introductionId, act.message);
      } else {
        let target: Doc<"attendees"> | undefined;
        if (act.type === "request_intro")
          target = roster.find((a) => a._id === act.attendeeId);
        else {
          const name = act.targetName.trim().toLowerCase();
          const exact = roster.filter((a) => a.name.toLowerCase() === name);
          const candidates = exact.length
            ? exact
            : roster.filter((a) => name && a.name.toLowerCase().includes(name));
          if (candidates.length === 1) target = candidates[0];
        }
        reply = target
          ? await requestIntroduction(
              ctx,
              source,
              target,
              act.type === "request_intro" ? act.reason : act.message,
            )
          : "Which attendee do you mean? Please use their full name so I ask the right person.";
      }
    }
    if (reply.trim())
      await queueMessage(ctx, {
        eventId: event._id,
        attendeeId: source.attendeeId,
        phone: source.phone,
        body: reply,
        sourceMessageId: source._id,
        simulation: source.simulation,
      });
    if (args.jobId) await ctx.db.patch(args.jobId, { status: "done" });
    await ctx.db.patch(source._id, { processedAt: Date.now() });
  },
});

// Dashboard simulations can exercise the agent without ever sending real iMessages.
export const simulateInbound = action({
  args: { phone: v.string(), body: v.string() },
  handler: async (ctx, args): Promise<void> => {
    const sourceMessageId = await ctx.runMutation(
      internal.messages.createSimulation,
      args,
    );
    await ctx.runAction(internal.agent.handleInbound, { sourceMessageId });
  },
});

// Host concierge: the host asks about the room from the dashboard.
export const hostAsk = action({
  args: {
    question: v.string(),
    history: v.optional(
      v.array(v.object({ role: v.string(), text: v.string() }))
    ),
  },
  handler: async (
    ctx,
    { question, history }
  ): Promise<{
    reply: string;
    matches: { name: string; why: string; linkedin?: string }[];
  }> => {
    const event = await ctx.runQuery(api.events.getActive, {});
    if (!event) return { reply: "No active event yet.", matches: [] };
    const roster = await ctx.runQuery(api.attendees.listByEvent, {
      eventId: event._id,
    });
    const system = `You are ${event.agentName?.trim() || "Simon"}, the host's event concierge for "${event.name}". Answer the host's question about the room using the roster. Be concrete and brief: 1-3 sentences of framing in "reply". When specific people are the answer, list them in "matches" (max 4) with a concrete one-line why each — use their exact roster name. You may reference research facts freely with the host.${event.agenda ? ` The host's agenda: ${event.agenda}` : ""}

Respond with ONLY valid JSON:
{"reply":"...","matches":[{"name":"<exact roster name>","why":"..."}]}
"matches" may be empty.`;
    const user = `ROSTER:\n${roster
      .map(
        (a) =>
          `- ${a.name}${a.oneLiner ? ` | wants: ${a.oneLiner}` : ""}${
            a.bio ? ` | ${a.bio}` : ""
          }${a.researchSummary ? ` | ${a.researchSummary}` : ""}${
            a.facts?.length ? ` | facts: ${a.facts.join("; ")}` : ""
          }`
      )
      .join("\n")}${
      history?.length
        ? `\n\nCONVERSATION SO FAR:\n${history
            .slice(-10)
            .map((m) => `${m.role === "user" ? "HOST" : "YOU"}: ${m.text}`)
            .join("\n")}`
        : ""
    }\n\nHOST QUESTION: ${question}`;
    const raw = await claude(system, user);
    const out = parseJson<{
      reply: string;
      matches: { name: string; why: string }[];
    }>(raw, { reply: raw, matches: [] });
    const matches = (out.matches ?? []).slice(0, 6).map((m) => {
      const a = roster.find(
        (r) => r.name.toLowerCase() === (m.name ?? "").toLowerCase()
      );
      return { name: m.name ?? "", why: m.why ?? "", linkedin: a?.linkedin };
    });
    return { reply: out.reply ?? "", matches };
  },
});
