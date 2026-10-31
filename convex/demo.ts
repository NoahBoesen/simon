import { mutation, query, internalMutation } from "./_generated/server";
import { v } from "convex/values";
import { authorize } from "./lib/photonAuth";
import { DEFAULT_WELCOME } from "./lib/welcome";
import { normalizePhone } from "./attendees";
import { normalizeProfile } from "./onboarding";

const people = [
  {
    name: "Alex (demo)",
    linkedin: "https://www.linkedin.com/in/simon-demo-alex/",
    phone: "+12025550121",
    bio: "AI engineer building agent infrastructure and production LLM evaluation tools.",
    facts: [
      "Built agent evaluation pipelines",
      "Works on reliable tool use and LLM observability",
    ],
  },
  {
    name: "Jamie (demo)",
    linkedin: "https://www.linkedin.com/in/simon-demo-jamie/",
    phone: "+12025550122",
    bio: "Product designer focused on onboarding, community experiences and consumer apps.",
    facts: [
      "Designs onboarding flows",
      "Has built community and event products",
    ],
  },
  {
    name: "Morgan (demo)",
    linkedin: "https://www.linkedin.com/in/simon-demo-morgan/",
    phone: "+12025550123",
    bio: "Technical founder building AI developer tools and retrieval systems.",
    facts: [
      "Built semantic search and RAG systems",
      "Looking for early developer-tool design partners",
    ],
  },
  {
    name: "Priya (demo)",
    linkedin: "https://www.linkedin.com/in/simon-demo-priya/",
    phone: "+12025550124",
    bio: "ML engineer working on speech agents, realtime inference and voice interfaces.",
    facts: [
      "Ships realtime voice agents",
      "Experienced with inference latency and conversational AI",
    ],
  },
  {
    name: "Casey (demo)",
    linkedin: "https://www.linkedin.com/in/simon-demo-casey/",
    phone: "+12025550125",
    bio: "Design founder helping early-stage teams with product strategy and user research.",
    facts: ["Runs discovery interviews", "Designs early-stage B2B products"],
  },
  {
    name: "Sam (demo)",
    linkedin: "https://www.linkedin.com/in/simon-demo-sam/",
    phone: "+12025550126",
    bio: "Creative technologist and interaction designer building playful web experiences.",
    facts: [
      "Prototypes interfaces in React",
      "Combines motion design with rapid user testing",
    ],
  },
];

export const seed = mutation({
  args: { token: v.string(), phone: v.optional(v.string()) },
  handler: async (ctx, { token, phone }) => {
    authorize(token);
    if (process.env.ALLOW_DEMO_SEED !== "1")
      throw new Error("Demo seeding is not enabled on this deployment.");
    if (phone && !/^\+[1-9]\d{7,14}$/.test(phone))
      throw new Error("Use an E.164 test phone number.");
    const existing = (await ctx.db.query("events").collect()).find(
      (e) => e.status === "live",
    );
    if (existing && !existing.demo)
      return { eventId: existing._id, created: false };
    const eventId =
      existing?._id ??
      (await ctx.db.insert("events", {
        name: "Night Hack (demo)",
        hostName: "Noah",
        status: "live",
        demo: true,
        welcomeTemplate: DEFAULT_WELCOME,
        meetingPoint: "the welcome desk",
      }));
    if (existing)
      await ctx.db.patch(eventId, {
        ...(existing.name === "Simon local demo"
          ? { name: "Night Hack (demo)" }
          : {}),
        welcomeTemplate: existing.welcomeTemplate || DEFAULT_WELCOME,
        meetingPoint: existing.meetingPoint || "the welcome desk",
      });
    const roster = await ctx.db
      .query("attendees")
      .withIndex("by_event", (q) => q.eq("eventId", eventId))
      .collect();
    if (!existing)
      await ctx.db.insert("attendees", {
        eventId,
        name: "Noah",
        phone,
        researchStatus: "skipped",
      });
    for (const person of people) {
      const old = roster.find((a) => a.name === person.name);
      const fields = {
        ...person,
        // Fictional placeholders, not researched or verified LinkedIn profiles.
        profileUrl: person.linkedin,
        isDemo: true,
        researchStatus: "done",
        researchSummary: `Fictional cached research for testing: ${person.bio}`,
      };
      if (old)
        await ctx.db.patch(old._id, {
          ...fields,
          // Older demo seeds used this goal field for the fictional bio.
          ...(old.oneLiner === person.bio
            ? { oneLiner: old.connectionGoals }
            : {}),
        });
      else await ctx.db.insert("attendees", { eventId, ...fields });
    }
    return { eventId, created: !existing };
  },
});

export const peopleForSimulation = query({
  args: {},
  handler: async (ctx) => {
    const event = (await ctx.db.query("events").collect()).find(
      (e) => e.status === "live",
    );
    if (!event?.demo) return [];
    return (
      await ctx.db
        .query("attendees")
        .withIndex("by_event", (q) => q.eq("eventId", event._id))
        .collect()
    )
      .filter((a) => a.isDemo && a.phone)
      .map((a) => ({ name: a.name, phone: a.phone!, bio: a.bio }));
  },
});

// Host-controlled setup for a real tester in a demo event. This only prepares
// their identity and assigned line; their first inbound text activates messaging.
export const prepareTestContact = mutation({
  args: {
    token: v.string(),
    name: v.string(),
    phone: v.string(),
    profileUrl: v.string(),
    code: v.string(),
    bio: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    authorize(args.token);
    if (process.env.ALLOW_DEMO_SEED !== "1")
      throw new Error("Demo setup is not enabled on this deployment.");
    const event = (await ctx.db.query("events").collect()).find(
      (e) => e.status === "live",
    );
    if (!event?.demo)
      throw new Error("Real test contacts require a demo event.");
    const phone = normalizePhone(args.phone);
    if (!/^\+[1-9]\d{7,14}$/.test(phone))
      throw new Error("Use a phone number with country code.");
    if (!args.name.trim() || args.name.length > 120)
      throw new Error("Enter the test attendee's name.");
    const profileUrl = normalizeProfile(args.profileUrl);
    const attendee = await ctx.db
      .query("attendees")
      .withIndex("by_phone", (q) => q.eq("phone", phone))
      .filter((q) => q.eq(q.field("eventId"), event._id))
      .first();
    if (attendee?.isDemo)
      throw new Error("Use a real test number, not a fictional demo identity.");
    const fields = {
      name: args.name.trim(),
      phone,
      profileUrl,
      ...(new URL(profileUrl).hostname.replace(/^www\./, "") === "linkedin.com"
        ? { linkedin: profileUrl }
        : {}),
      ...(args.bio?.trim() ? { bio: args.bio.trim().slice(0, 1000) } : {}),
    };
    const attendeeId =
      attendee?._id ??
      (await ctx.db.insert("attendees", {
        eventId: event._id,
        ...fields,
        researchStatus: "skipped",
      }));
    if (attendee) await ctx.db.patch(attendee._id, fields);
    const previous = await ctx.db
      .query("registrations")
      .withIndex("by_phone", (q) =>
        q.eq("eventId", event._id).eq("phone", phone).eq("simulation", false),
      )
      .unique();
    const registrationId =
      previous?._id ??
      (await ctx.db.insert("registrations", {
        eventId: event._id,
        attendeeId,
        phone,
        simulation: false,
        code: args.code,
      }));
    return {
      registrationId,
      attendeeId,
      phone,
      code: previous?.code ?? args.code,
    };
  },
});

// Start a fresh test without deleting the audit trail or Photon identities.
export const restartConversations = internalMutation({
  args: { attendeeIds: v.array(v.id("attendees")), meetingPoint: v.optional(v.string()) },
  handler: async (ctx, { attendeeIds, meetingPoint }) => {
    const people = await Promise.all(attendeeIds.map((id) => ctx.db.get(id)));
    if (!people.length || people.some((p) => !p || p.eventId !== people[0]?.eventId))
      throw new Error("Choose attendees from one demo event.");
    const eventId = people[0]!.eventId;
    const event = await ctx.db.get(eventId);
    if (!event?.demo) throw new Error("Conversation reset is only available for demo events.");
    const ids = new Set(attendeeIds);
    const phones = new Set(people.map((p) => p!.phone));
    const messages = await ctx.db.query("messages").withIndex("by_event", (q) => q.eq("eventId", eventId)).collect();
    const sources = new Set(messages.filter((m) => m.attendeeId && ids.has(m.attendeeId)).map((m) => m._id));
    const affected = messages.filter((m) => phones.has(m.phone) || (m.sourceMessageId && sources.has(m.sourceMessageId)));
    if (affected.some((m) => m.deliveryStatus === "sending"))
      throw new Error("Wait for the current message to finish sending before resetting.");
    for (const m of affected)
      if (m.deliveryStatus === "queued") await ctx.db.patch(m._id, { deliveryStatus: "cancelled" });
    for (const job of await ctx.db.query("agentJobs").collect())
      if (sources.has(job.sourceMessageId) && ["queued", "processing"].includes(job.status))
        await ctx.db.patch(job._id, { status: "cancelled" });
    for (const intro of await ctx.db.query("introductions").withIndex("by_event", (q) => q.eq("eventId", eventId)).collect())
      if (ids.has(intro.fromAttendeeId) || ids.has(intro.toAttendeeId))
        await ctx.db.patch(intro._id, { status: "cancelled" });
    for (const match of await ctx.db.query("matches").withIndex("by_event", (q) => q.eq("eventId", eventId)).collect())
      if (ids.has(match.attendeeA) || ids.has(match.attendeeB))
        await ctx.db.patch(match._id, { status: "superseded" });
    const startedAt = Date.now();
    for (const id of attendeeIds)
      await ctx.db.patch(id, { conversationStartedAt: startedAt, connectionGoals: undefined, oneLiner: undefined });
    if (meetingPoint?.trim()) await ctx.db.patch(eventId, { meetingPoint: meetingPoint.trim() });
    return { reset: people.map((p) => p!.name), startedAt };
  },
});
