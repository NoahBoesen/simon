/// <reference types="vite/client" />
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { convexTest } from "convex-test";
import schema from "../convex/schema";
import { confirmedGuest } from "./fixtures";
import { api, internal } from "../convex/_generated/api";

const modules = import.meta.glob("../convex/**/*.{ts,js}");
const liveModel = process.env.SIMON_LIVE_MODEL_CHECK === "1";
const providerKey = process.env.ANTHROPIC_API_KEY;
const noahPhone = "+12025550180";
const chintanPhone = "+12025550181";
const alexPhone = "+12025550182";
beforeEach(() => vi.stubEnv("ANTHROPIC_API_KEY", "test-key"));
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

async function fixture() {
  const t = convexTest(schema, modules);
  const people = await t.run(async (ctx) => {
    const eventId = await ctx.db.insert("events", {
      name: "Coordination test", hostName: "Host", status: "live", demo: true,
      meetingPoint: "the welcome desk",
    });
    const add = (name: string, phone: string) => ctx.db.insert("attendees", {
      eventId, name, phone, researchStatus: "skipped",
    });
    return { eventId, noah: await add("Noah", noahPhone),
      chintan: await add("Chintan", chintanPhone), alex: await add("Alex", alexPhone) };
  });
  await t.run(async (ctx) => {
    for (const id of [people.noah, people.chintan, people.alex]) await confirmedGuest(ctx, id);
  });
  const source = await t.mutation(internal.messages.createSimulation, {
    phone: noahPhone, body: "Can you connect me with Chintan?",
  });
  await t.mutation(internal.agent.commitResult, {
    sourceMessageId: source,
    result: { reply: "", actions: [{ type: "request_intro", attendeeId: people.chintan,
      reason: "You both build AI agents." }] },
  });
  const intro = (await t.run((ctx) => ctx.db.query("introductions").collect()))[0];
  return { t, ...people, intro };
}
function modelResult(actions: unknown[]) {
  const mock = vi.fn().mockResolvedValue(Response.json({
    content: [{ type: "text", text: JSON.stringify({ reply: "", actions }) }],
    stop_reason: "end_turn",
  }));
  vi.stubGlobal("fetch", mock);
  return mock;
}

test("natural meeting requests accept the invitation and relay replies in both directions once", async () => {
  const { t, intro, eventId } = await fixture();
  const mock = modelResult([{ type: "respond_intro", introductionId: intro._id,
    decision: "accept", message: "Chintan said yes and can meet at the entrance." }]);
  await t.action(api.agent.simulateInbound, {
    phone: chintanPhone, body: "can you text Noah to meet me at the entrance",
  });
  expect((await t.run((ctx) => ctx.db.get(intro._id)))?.status).toBe("accepted");
  const toNoah = (await t.query(api.messages.listByPhone, { phone: noahPhone })).at(-1)!;
  expect(toNoah.body).toContain("Chintan said yes");
  expect(toNoah.body).toContain("entrance");
  expect(toNoah.body).not.toContain("welcome desk");
  const request = JSON.parse(mock.mock.calls[0][1].body);
  expect(request.messages[0].content).toContain(intro._id);
  expect(request.messages[0].content).toContain('"canRespond":true');
  expect(request.system).toContain("You CAN send private iMessages");

  modelResult([{ type: "relay_intro", introductionId: intro._id,
    message: "Noah confirmed and will be at the entrance in five minutes." }]);
  await t.action(api.agent.simulateInbound, {
    phone: noahPhone, body: "Tell him that works, I'll be there in five minutes.",
  });
  const toChintan = (await t.query(api.messages.listByPhone, { phone: chintanPhone })).at(-1)!;
  expect(toChintan.body).toContain("Noah confirmed");
  expect(toChintan.body).not.toContain("Reply here");
  expect(toChintan.body).toContain("five minutes");
  expect(toChintan.body).not.toContain(noahPhone);
  const all = await t.query(api.messages.listByEvent, { eventId });
  const lastInbound = all.filter((m) => m.direction === "inbound").at(-1)!;
  await t.mutation(internal.agent.commitResult, {
    sourceMessageId: lastInbound._id,
    result: { reply: "", actions: [{ type: "relay_intro", introductionId: intro._id,
      message: "Noah confirmed and will be at the entrance in five minutes." }] },
  });
  expect(await t.query(api.messages.listByEvent, { eventId })).toHaveLength(all.length);
});

test.each(["yes", "no thanks"])("a plain %s answers the single current invitation", async (body) => {
  const { t, intro } = await fixture();
  const source = await t.mutation(internal.messages.createSimulation, { phone: chintanPhone, body });
  await t.mutation(internal.agent.commitResult, {
    sourceMessageId: source, result: { reply: "", actions: [] },
  });
  expect((await t.run((ctx) => ctx.db.get(intro._id)))?.status)
    .toBe(body === "yes" ? "accepted" : "declined");
  if (body === "yes") {
    for (const phone of [noahPhone, chintanPhone]) {
      const reply = (await t.query(api.messages.listByPhone, { phone })).at(-1)!.body;
      expect(reply).toContain("in 10 minutes");
      expect(reply).toContain("the welcome desk");
      expect(reply).not.toContain(intro.code);
      expect(reply).not.toContain(intro.reason);
      expect(reply).not.toContain("LinkedIn");
    }
  }
});

test("a supplied meeting time is passed as an update without repeating bios or asking its sender to confirm", async () => {
  const { t, intro } = await fixture();
  modelResult([{ type: "respond_intro", introductionId: intro._id, decision: "accept",
    message: "Chintan said yes and can meet in about 10 minutes." }]);
  await t.action(api.agent.simulateInbound, { phone: chintanPhone, body: "Yes in like 10 minutes" });
  const update = (await t.query(api.messages.listByPhone, { phone: noahPhone })).at(-1)!.body;
  expect(update).toBe("Chintan said yes and can meet in about 10 minutes.");
  const ack = (await t.query(api.messages.listByPhone, { phone: chintanPhone })).at(-1)!.body;
  expect(ack).toBe("I'll let Noah know.");
});

test("fresh demo conversations exclude old history and introductions but preserve the audit trail", async () => {
  const { t, noah, chintan, eventId, intro } = await fixture();
  vi.useFakeTimers();
  vi.setSystemTime(Date.now() + 1000);
  await t.mutation(internal.demo.restartConversations, { attendeeIds: [noah, chintan], meetingPoint: "the food section" });
  const source = await t.mutation(internal.messages.createSimulation, { phone: noahPhone, body: "New test" });
  expect(await t.query(internal.agent.introductionState, { sourceMessageId: source })).toEqual([]);
  const history = await t.query(internal.messages.recentByPhone, { phone: noahPhone, eventId, simulation: true });
  expect(history.map((m) => m.body)).toEqual(["New test"]);
  expect((await t.run((ctx) => ctx.db.get(intro._id)))?.status).toBe("cancelled");
  expect((await t.query(api.messages.listByEvent, { eventId })).length).toBeGreaterThan(1);
});

test("real-event resets require explicit selection and leave other guests unchanged", async () => {
  const { t, noah, chintan, alex, eventId } = await fixture();
  await t.run((ctx) => ctx.db.patch(eventId, { demo: false }));
  const untouched = await t.run((ctx) => ctx.db.get(alex));
  await expect(t.mutation(internal.demo.restartConversations, { attendeeIds: [noah, chintan] }))
    .rejects.toThrow("explicit operator selection");
  await t.mutation(internal.demo.restartConversations, { attendeeIds: [noah, chintan], allowRealEvent: true });
  expect(await t.run((ctx) => ctx.db.get(alex))).toEqual(untouched);
  expect((await t.run((ctx) => ctx.db.get(noah)))?.conversationStartedAt).toBeGreaterThan(0);
});

test("phone ownership corrections and conversation resets happen together without moving transport routes", async () => {
  const { t, noah, chintan, alex, eventId, intro } = await fixture();
  const correctedChintanPhone = "+919999900001";
  const records = await t.run(async (ctx) => {
    await ctx.db.patch(chintan, { alternatePhones: [correctedChintanPhone] });
    const registration = await ctx.db.insert("registrations", {
      eventId, attendeeId: chintan, phone: chintanPhone, simulation: false, code: "test",
    });
    const route = await ctx.db.insert("photonConversations", {
      projectId: "test", phone: chintanPhone, spaceId: "original-space", senderId: "agent",
      agentHandle: "+12025550199", lastExternalId: "last", optedOut: false,
    });
    return { registration, route: (await ctx.db.get(route))!, untouched: (await ctx.db.get(alex))! };
  });
  vi.useFakeTimers();
  vi.setSystemTime(Date.now() + 1000);
  await t.mutation(internal.demo.restartConversations, {
    attendeeIds: [noah, chintan],
    phoneCorrections: [
      { attendeeId: noah, expectedPhone: noahPhone, phone: chintanPhone },
      { attendeeId: chintan, expectedPhone: chintanPhone, phone: correctedChintanPhone },
    ],
  });
  const people = await t.run(async (ctx) => [await ctx.db.get(noah), await ctx.db.get(chintan)]);
  expect(people.map((p) => p!.phone)).toEqual([chintanPhone, correctedChintanPhone]);
  expect(people.every((p) => !p!.liveIdentity && !p!.simulatedIdentity && !p!.connectionGoals)).toBe(true);
  expect(people[1]!.alternatePhones).toEqual([]);
  expect(await t.run((ctx) => ctx.db.get(records.route._id))).toEqual(records.route);
  expect(await t.run((ctx) => ctx.db.get(alex))).toEqual(records.untouched);
  expect((await t.run((ctx) => ctx.db.get(records.registration)))?.attendeeId).toBe(noah);
  expect((await t.run((ctx) => ctx.db.get(intro._id)))?.status).toBe("cancelled");
  const source = await t.mutation(internal.messages.createSimulation, { phone: chintanPhone, body: "Hello again" });
  expect((await t.run((ctx) => ctx.db.get(source)))?.attendeeId).toBe(noah);
  expect((await t.query(internal.messages.recentByPhone, { phone: chintanPhone, eventId, simulation: true })).map((m) => m.body)).toEqual(["Hello again"]);
});

test("stale or conflicting phone corrections leave the conversation intact", async () => {
  const { t, noah, chintan, intro } = await fixture();
  const before = await t.run((ctx) => ctx.db.get(noah));
  for (const correction of [
    { attendeeId: noah, expectedPhone: "+12025550999", phone: "+12025550998" },
    { attendeeId: noah, expectedPhone: noahPhone, phone: alexPhone },
  ]) {
    await expect(t.mutation(internal.demo.restartConversations, {
      attendeeIds: [noah, chintan], phoneCorrections: [correction],
    })).rejects.toThrow();
  }
  expect(await t.run((ctx) => ctx.db.get(noah))).toEqual(before);
  expect((await t.run((ctx) => ctx.db.get(intro._id)))?.status).toBe("pending");
});

test("a bare yes cannot choose between two pending invitations", async () => {
  const { t, intro, chintan } = await fixture();
  const secondRequest = await t.mutation(internal.messages.createSimulation, {
    phone: alexPhone, body: "Introduce me to Chintan.",
  });
  await t.mutation(internal.agent.commitResult, {
    sourceMessageId: secondRequest,
    result: { reply: "", actions: [{ type: "request_intro", attendeeId: chintan, reason: "Shared interests." }] },
  });
  const yes = await t.mutation(internal.messages.createSimulation, { phone: chintanPhone, body: "Yes" });
  await t.mutation(internal.agent.commitResult, {
    sourceMessageId: yes,
    result: { reply: "", actions: [{ type: "respond_intro", introductionId: intro._id, decision: "accept" }] },
  });
  const introductions = await t.run((ctx) => ctx.db.query("introductions").collect());
  expect(introductions.every((i) => i.status === "pending")).toBe(true);
  expect((await t.query(api.messages.listByPhone, { phone: chintanPhone })).at(-1)?.body)
    .toContain("Which introduction");
});

test("yes to an unrelated question does not accept an old invitation", async () => {
  const { t, intro, eventId, chintan } = await fixture();
  await t.run((ctx) => ctx.db.insert("messages", {
    eventId, attendeeId: chintan, phone: chintanPhone, direction: "outbound",
    body: "Would you like to see the event schedule?", simulation: true, deliveryStatus: "mock",
  }));
  const yes = await t.mutation(internal.messages.createSimulation, { phone: chintanPhone, body: "Yes" });
  await t.mutation(internal.agent.commitResult, {
    sourceMessageId: yes, result: { reply: "Here is the schedule.", actions: [] },
  });
  expect((await t.run((ctx) => ctx.db.get(intro._id)))?.status).toBe("pending");
});

test.each(["unrelated attendee", "other event", "other mode", "declined", "cancelled"])(
  "meeting relay rejects %s without messaging the other person", async (condition) => {
    const { t, intro } = await fixture();
    await t.run(async (ctx) => {
      if (condition === "other event") {
        const eventId = await ctx.db.insert("events", { name: "Other", hostName: "Host", status: "live" });
        await ctx.db.patch(intro._id, { eventId });
      } else if (condition === "other mode") await ctx.db.patch(intro._id, { simulation: false });
      else if (["declined", "cancelled"].includes(condition)) await ctx.db.patch(intro._id, { status: condition });
    });
    const before = await t.query(api.messages.listByPhone, { phone: noahPhone });
    const source = await t.mutation(internal.messages.createSimulation, {
      phone: condition === "unrelated attendee" ? alexPhone : chintanPhone,
      body: "Tell Noah to meet me at the entrance.",
    });
    await t.mutation(internal.agent.commitResult, {
      sourceMessageId: source,
      result: { reply: "", actions: [{ type: "relay_intro", introductionId: intro._id, message: "Meet me at the entrance." }] },
    });
    expect(await t.query(api.messages.listByPhone, { phone: noahPhone })).toHaveLength(before.length);
    expect((await t.run((ctx) => ctx.db.get(intro._id)))?.status).not.toBe("accepted");
  },
);

test("operator recovery only requeues the current blocked acceptance, once", async () => {
  const { t, intro, eventId, chintan } = await fixture();
  const ids = await t.run(async (ctx) => {
    await ctx.db.patch(intro._id, { simulation: false });
    const source = await ctx.db.insert("messages", {
      eventId, attendeeId: chintan, phone: chintanPhone, direction: "inbound",
      body: "Yes", projectId: "recovery-test", simulation: false, processedAt: Date.now(),
    });
    const route = await ctx.db.insert("photonConversations", {
      projectId: "recovery-test", phone: chintanPhone, spaceId: "space", senderId: "agent",
      agentHandle: "+12025550100", lastExternalId: "inbound-yes", lastInboundId: source, optedOut: false,
    });
    const job = await ctx.db.insert("agentJobs", {
      projectId: "recovery-test", phone: chintanPhone, sourceMessageId: source, status: "done",
    });
    await ctx.db.insert("messages", {
      eventId, attendeeId: chintan, phone: chintanPhone, direction: "outbound", sourceMessageId: source,
      body: "There's already an introduction request between you and Noah. I'm waiting for a reply.",
      simulation: false, deliveryStatus: "delivered",
    });
    return { source, route, job };
  });
  expect(await t.mutation(internal.photonBridge.retryBlockedIntroduction, { sourceMessageId: ids.source })).toBe(true);
  expect((await t.run((ctx) => ctx.db.get(ids.job)))?.status).toBe("queued");
  expect(await t.mutation(internal.photonBridge.retryBlockedIntroduction, { sourceMessageId: ids.source })).toBe(false);
  await t.run((ctx) => ctx.db.patch(ids.route, { optedOut: true }));
  await expect(t.mutation(internal.photonBridge.retryBlockedIntroduction, { sourceMessageId: ids.source }))
    .rejects.toThrow("no longer current");
});

// Opt-in provider check: real Claude, in-memory DB, and no Photon/network sends.
test.runIf(liveModel)("real Claude relays the reported time-only acceptance as an update without inventing a meeting point", async () => {
  vi.stubEnv("ANTHROPIC_API_KEY", providerKey!);
  const { t, intro } = await fixture();
  await t.action(api.agent.simulateInbound, { phone: chintanPhone, body: "Yes in like 10 minutes" });
  expect((await t.run((ctx) => ctx.db.get(intro._id)))?.status).toBe("accepted");
  const update = (await t.query(api.messages.listByPhone, { phone: noahPhone })).at(-1)!.body;
  expect(update).toContain("Chintan");
  expect(update).toMatch(/(?:10|ten) minutes/i);
  expect(update).not.toMatch(/welcome desk|LinkedIn|AI agents|\?/i);
  expect(update.split(/\s+/).length).toBeLessThan(30);
  const ack = (await t.query(api.messages.listByPhone, { phone: chintanPhone })).at(-1)!.body;
  expect(ack).toBe("I'll let Noah know.");
  await t.action(api.agent.simulateInbound, { phone: noahPhone, body: "Yes that works" });
  const confirmation = (await t.query(api.messages.listByPhone, { phone: chintanPhone })).at(-1)!.body;
  expect(confirmation).toContain("Noah");
  expect(confirmation).not.toMatch(/welcome desk|LinkedIn|AI agents|\?/i);
}, 60_000);

test.runIf(liveModel)("real Claude confirms identity on hello before suggesting anyone", async () => {
  vi.stubEnv("ANTHROPIC_API_KEY", providerKey!);
  const { t, noah, chintan, alex } = await fixture();
  await t.mutation(internal.demo.restartConversations, { attendeeIds: [noah, chintan] });
  await t.run(async (ctx) => {
    await ctx.db.patch(noah, { bio: "Engineer building AI agents for events and community networking." });
    await ctx.db.patch(chintan, { bio: "Building an AI event concierge that connects attendees." });
    await ctx.db.patch(alex, { bio: "AI engineer building agent evaluation tools." });
  });
  await t.action(api.agent.simulateInbound, { phone: noahPhone, body: "Hi Simon!" });
  const matches = await t.run((ctx) => ctx.db.query("matches").filter((q) => q.eq(q.field("status"), "suggested")).collect());
  expect(matches).toHaveLength(0);
  expect((await t.query(api.messages.listByPhone, { phone: noahPhone })).at(-1)?.body).toContain("Is this you");
  expect(await t.run((ctx) => ctx.db.query("introductions").filter((q) => q.eq(q.field("status"), "pending")).collect())).toHaveLength(0);
}, 60_000);

test.runIf(liveModel)("real Claude follows the fresh networking test with plain yes and a shared plan", async () => {
  vi.stubEnv("ANTHROPIC_API_KEY", providerKey!);
  const { t, noah, chintan, eventId } = await fixture();
  await t.run(async (ctx) => {
    await ctx.db.patch(chintan, { bio: "Real test participant building and testing the Simon event-networking agent with Noah. Professional profile details have not been verified." });
    await ctx.db.insert("attendees", { eventId, name: "Morgan", phone: "+12025550183", bio: "Builds AI developer tools and retrieval systems.", researchStatus: "done", isDemo: true });
  });
  await t.mutation(internal.demo.restartConversations, { attendeeIds: [noah, chintan], meetingPoint: "the food section" });
  await t.run(async (ctx) => { await confirmedGuest(ctx, noah); await confirmedGuest(ctx, chintan); });
  await t.action(api.agent.simulateInbound, { phone: noahPhone, body: "I want to meet people building AI agents for event networking and attendee matchmaking." });
  const suggestions = (await t.query(api.messages.listByPhone, { phone: noahPhone })).at(-1)!.body;
  expect(suggestions).toContain("Chintan");
  await t.action(api.agent.simulateInbound, { phone: noahPhone, body: "I want to write to Chintan." });
  const invitation = (await t.query(api.messages.listByPhone, { phone: chintanPhone })).at(-1)!.body;
  expect(invitation).toContain("Noah would like to meet you");
  expect(invitation).not.toMatch(/YES [A-Z0-9]{8}/);
  await t.action(api.agent.simulateInbound, { phone: chintanPhone, body: "yes" });
  for (const phone of [noahPhone, chintanPhone]) {
    const proposal = (await t.query(api.messages.listByPhone, { phone })).at(-1)!.body;
    expect(proposal).toContain("in 10 minutes by the food section");
  }
  await t.action(api.agent.simulateInbound, { phone: chintanPhone, body: "yes" });
  const confirmation = (await t.query(api.messages.listByPhone, { phone: noahPhone })).at(-1)!.body;
  expect(confirmation).toContain("Chintan");
  expect(confirmation).not.toContain("Reply here");
}, 90_000);

test.runIf(liveModel)("real Claude coordinates the reported request and the other person's reply", async () => {
  expect(providerKey).toBeTruthy();
  vi.stubEnv("ANTHROPIC_API_KEY", providerKey!);
  const { t, intro } = await fixture();
  await t.action(api.agent.simulateInbound, {
    phone: chintanPhone, body: "can you text Noah to meet me at the entrance",
  });
  expect((await t.run((ctx) => ctx.db.get(intro._id)))?.status).toBe("accepted");
  expect((await t.query(api.messages.listByPhone, { phone: noahPhone })).at(-1)?.body).toMatch(/entrance/i);
  await t.action(api.agent.simulateInbound, {
    phone: noahPhone, body: "Yes, tell him I'll be at the entrance in five minutes.",
  });
  expect((await t.query(api.messages.listByPhone, { phone: chintanPhone })).at(-1)?.body).toMatch(/five|5/i);
}, 60_000);

test.runIf(liveModel)("real Claude recovers a yes after the old mistaken refusal", async () => {
  expect(providerKey).toBeTruthy();
  vi.stubEnv("ANTHROPIC_API_KEY", providerKey!);
  const { t, intro, eventId, chintan } = await fixture();
  await t.mutation(internal.messages.createSimulation, {
    phone: chintanPhone, body: "can you text Noah to meet me at the entrance",
  });
  await t.run((ctx) => ctx.db.insert("messages", {
    eventId, attendeeId: chintan, phone: chintanPhone, direction: "outbound",
    body: "I'm not able to send text messages or share phone numbers — I can only facilitate introductions through this chat. If you'd like, I can send Noah a formal intro request so you two can coordinate from there. Want me to do that?",
    simulation: true, deliveryStatus: "mock",
  }));
  await t.action(api.agent.simulateInbound, { phone: chintanPhone, body: "Yes" });
  expect((await t.run((ctx) => ctx.db.get(intro._id)))?.status).toBe("accepted");
  expect((await t.query(api.messages.listByPhone, { phone: noahPhone })).at(-1)?.body).toMatch(/entrance/i);
}, 60_000);
