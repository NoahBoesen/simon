import { action, internalAction, internalMutation, internalQuery } from "./_generated/server";
import { api, internal } from "./_generated/api";
import { v } from "convex/values";
import { claude, claudeJson, parseJson } from "./lib/llm";
import { buildSystem, isDeferredSearchReply } from "./lib/attendeePrompt";
import { agentResultSchema, recommendationResultSchema } from "./lib/agentResultSchema";
import { workerArgs, authorize } from "./lib/photonAuth";
import { queueMessage } from "./photon";
import { currentGeneration } from "./lib/currentGeneration";
import { hasName, identityKey, identitySummary, identityQuestion, canConfirmIdentity, saveIdentityProfile, sameIdentity } from "./lib/identity";
import { welcomeText } from "./lib/welcome";
import {
  requestIntroduction,
  respondToIntroduction,
  answerIntroduction,
  relayMeetingMessage,
  introductionContext,
} from "./lib/introductions";
import type { Doc } from "./_generated/dataModel";

type AgentOut = {
  reply: string;
  actions: Array<
    | {
        type: "save_profile";
        name?: string;
        profileUrl?: string;
        bio?: string;
        oneLiner?: string;
        connectionGoals?: string;
      }
    | { type: "confirm_identity" }
    | { type: "reject_identity" }
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
        profileUrl: v.optional(v.string()),
        bio: v.optional(v.string()),
        oneLiner: v.optional(v.string()),
        connectionGoals: v.optional(v.string()),
      }),
      v.object({ type: v.literal("confirm_identity") }),
      v.object({ type: v.literal("reject_identity") }),
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
function rosterBlock(all: Doc<"attendees">[], self?: Doc<"attendees">) {
  return JSON.stringify(
    all
      .filter((a) => !self || !sameIdentity(a, self))
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
    const userPrompt = (person: Doc<"attendees">) => `EVENT: ${event.name}
${event.demo ? "DEMO MODE: The roster contains clearly labeled sample people. Say this is a demo; never present sample profiles as real attendees at tonight's event." : ""}

SENDER ON FILE:
name: ${person.name}
profile: ${person.profileUrl || person.linkedin || "not supplied"}
bio: ${person.bio || "unknown"}
cached research: ${person.researchSummary || "not available"}
facts: ${JSON.stringify(person.facts || [])}
identity status: ${person[identityKey(source.simulation)]?.confirmedAt !== undefined ? "confirmed" : "NOT CONFIRMED — collect identity and confirm context before recommendations"}
last profile summary offered: ${person[identityKey(source.simulation)]?.summary || "none"}
confirmed introduction context: ${person[identityKey(source.simulation)]?.confirmedAt !== undefined ? person[identityKey(source.simulation)]!.summary : "none — do not introduce yet"}
connection goals: ${person.connectionGoals || person.oneLiner || "(not stated; ask only AFTER identity confirmation)"}
event meeting point: ${event.meetingPoint || "the welcome desk"}

INTRODUCTIONS (only this sender's connections; canRespond means an invitation to them):
${JSON.stringify(introductions)}

ROSTER (${roster.length - 1} others):
${person[identityKey(source.simulation)]?.confirmedAt !== undefined ? rosterBlock(roster, person) : "Withheld until the sender confirms their identity."}

RECENT CONVERSATION (oldest first):
${history.filter((m) => m._creationTime <= source._creationTime).map((m) => `${m.direction === "inbound" ? "THEM" : "YOU"}: ${m.body}`).join("\n")}`;
    const wasConfirmed = attendee[identityKey(source.simulation)]?.confirmedAt !== undefined;
    let out = await claudeJson<AgentOut>(
      buildSystem(event), userPrompt(attendee), agentResultSchema,
    );
    // Save the supplied identity before researching it, then send one response
    // containing the resulting profile summary. Never research "Guest 8404".
    const prepared = await ctx.runMutation(internal.agent.prepareIdentity, { ...args, result: out });
    if (!prepared) return;
    attendee = prepared;
    const becameConfirmed = !wasConfirmed && attendee[identityKey(source.simulation)]?.confirmedAt !== undefined;
    const deferredSearch = attendee[identityKey(source.simulation)]?.confirmedAt !== undefined &&
      isDeferredSearchReply(out.reply) && out.actions.every((act) =>
        act.type === "save_profile" || act.type === "confirm_identity");
    if ((becameConfirmed || deferredSearch) && (attendee.connectionGoals || attendee.oneLiner)) {
      // The first model call cannot see the roster before confirmation. Once
      // the delivered summary is confirmed, finish the saved goal in this
      // same generation and queue only the resulting recommendations.
      const recommendations = await claudeJson<{ picks: Array<{ attendeeId: string; reason: string }> }>(
        `${buildSystem(event)}\nThe sender has now confirmed their identity and already supplied connection goals. Return up to three actual roster matches for those goals using the supplied picks schema. Give each a supported professional reason. If there is no supported match, return an empty picks array. Do not promise to search later.`,
        userPrompt(attendee), recommendationResultSchema,
      );
      out = { reply: "", actions: [
        ...out.actions.filter((act) => act.type === "save_profile" || act.type === "confirm_identity"),
        { type: "recommend", picks: recommendations.picks },
      ] };
    }
    if (!source.simulation && !attendee.isDemo && hasName(attendee) &&
      !attendee[identityKey(source.simulation)] && !identitySummary(attendee) &&
      ["pending", "skipped", "done"].includes(attendee.researchStatus)) {
      try {
        await ctx.runAction(internal.research.researchAttendee, { attendeeId: attendee._id });
      } catch {
        // A lookup failure should still get one useful onboarding reply.
        await ctx.runMutation(internal.attendees.saveResearch, {
          id: attendee._id, researchStatus: "skipped",
          expectedName: attendee.name, expectedProfile: attendee.profileUrl || attendee.linkedin || "",
          expectedBio: attendee.bio || "",
        });
      }
    }
    await ctx.runMutation(internal.agent.commitResult, {
      ...args,
      result: out,
    });
  },
});

export const prepareIdentity = internalMutation({
  args: {
    sourceMessageId: v.id("messages"),
    jobId: v.optional(v.id("agentJobs")),
    auth: v.optional(v.object(workerArgs)),
    result: resultValidator,
  },
  handler: async (ctx, args) => {
    const current = await currentGeneration(ctx, args);
    if (!current) return null;
    let person = (await ctx.db.get(current.source.attendeeId))!;
    for (const action of args.result.actions.slice(0, 10)) {
      if (action.type !== "save_profile") continue;
      person = await saveIdentityProfile(ctx, person, action);
      const goals = (action.connectionGoals?.trim() || action.oneLiner?.trim())?.slice(0, 1000);
      if (goals) {
        await ctx.db.patch(person._id, { connectionGoals: goals, oneLiner: goals });
        person = (await ctx.db.get(person._id))!;
      }
    }
    if (args.result.actions.some((act) => act.type === "confirm_identity") &&
      await canConfirmIdentity(ctx, current.source, person)) {
      const key = identityKey(current.source.simulation);
      await ctx.db.patch(person._id, { [key]: { ...person[key]!, confirmedAt: Date.now() } });
      person = (await ctx.db.get(person._id))!;
    }
    return person;
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
    const current = await currentGeneration(ctx, args);
    if (!current) return;
    const { source, event } = current;
    const roster = await ctx.db
      .query("attendees")
      .withIndex("by_event", (q) => q.eq("eventId", event._id))
      .collect();
    let person = (await ctx.db.get(source.attendeeId))!;
    const key = identityKey(source.simulation);
    if (args.result.actions.some((act) => act.type === "reject_identity") &&
      !args.result.actions.some((act) => act.type === "save_profile" && (act.name || act.bio || act.profileUrl))) {
      await ctx.db.patch(person._id, {
        bio: undefined, profileUrl: undefined, linkedin: undefined,
        researchSummary: undefined, facts: undefined, sources: undefined,
        researchStatus: "skipped", liveIdentity: undefined, simulatedIdentity: undefined,
      });
      person = (await ctx.db.get(person._id))!;
    }
    for (const act of args.result.actions.slice(0, 10)) {
      if (act.type !== "save_profile") continue;
      person = await saveIdentityProfile(ctx, person, act);
      const goals = (act.connectionGoals?.trim() || act.oneLiner?.trim())?.slice(0, 1000);
      if (goals) {
        await ctx.db.patch(person._id, { connectionGoals: goals, oneLiner: goals });
        person = (await ctx.db.get(person._id))!;
      }
    }
    let justConfirmed = false;
    if (args.result.actions.some((act) => act.type === "confirm_identity") &&
      await canConfirmIdentity(ctx, source, person)) {
      await ctx.db.patch(person._id, { [key]: { ...person[key]!, confirmedAt: Date.now() } });
      person = (await ctx.db.get(person._id))!;
      justConfirmed = true;
    }
    const confirmed = person[key]?.confirmedAt !== undefined;
    const goals = person.connectionGoals || person.oneLiner;
    const consentReply = await respondToIntroduction(ctx, source);
    let reply = consentReply ?? (confirmed
      ? goals ? args.result.reply || (justConfirmed ? `Thanks for confirming! You mentioned wanting to meet ${goals}. Shall I find people who fit?` : "") : "Who would you like to meet, or what kind of connection would be useful?"
      : identityQuestion(person));
    let presentingIdentity = !confirmed && consentReply === null;
    const coordinated = new Set<string>();
    for (const act of consentReply !== null ? [] : args.result.actions.slice(0, 10)) {
      if (act.type === "save_profile" || act.type === "confirm_identity" || act.type === "reject_identity") continue;
      // Existing invitations/meeting updates remain usable during onboarding.
      if (!confirmed && act.type !== "respond_intro" && act.type !== "relay_intro") continue;
      if (act.type === "recommend") {
        if (!goals) continue;
        const seen = new Set<string>();
        const picks = act.picks
          .flatMap((pick) => {
            const target = roster.find(
              (a) => a._id === pick.attendeeId && !sameIdentity(a, person),
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
        presentingIdentity = false;
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
    if (reply.trim()) {
      const previousOutbound = await ctx.db.query("messages")
        .withIndex("by_phone", (q) => q.eq("phone", source.phone))
        .filter((q) => q.and(
          q.eq(q.field("eventId"), event._id), q.eq(q.field("direction"), "outbound"),
          q.gte(q.field("_creationTime"), person.conversationStartedAt ?? 0),
          source.simulation ? q.eq(q.field("simulation"), true) : q.neq(q.field("simulation"), true),
          q.neq(q.field("deliveryStatus"), "failed"), q.neq(q.field("deliveryStatus"), "cancelled"),
        )).first();
      if (!previousOutbound) reply = `${welcomeText(event, hasName(person) ? person.name : "there")}\n\n${reply}`;
      const sent = await queueMessage(ctx, {
        eventId: event._id, attendeeId: source.attendeeId, phone: source.phone,
        body: reply, sourceMessageId: source._id, simulation: source.simulation,
      });
      if (["mock", "queued"].includes(sent.status)) {
        const summary = identitySummary(person);
        if (presentingIdentity && hasName(person)) await ctx.db.patch(person._id, {
          [key]: { summary, confirmationMessageId: sent.messageId },
        });
        const registration = await ctx.db.query("registrations").withIndex("by_phone", (q) =>
          q.eq("eventId", event._id).eq("phone", source.phone).eq("simulation", !!source.simulation)).unique();
        if (registration && !registration.welcomeMessageId)
          await ctx.db.patch(registration._id, { welcomeMessageId: sent.messageId });
      }
    }
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
