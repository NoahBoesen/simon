/// <reference types="vite/client" />
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { convexTest } from "convex-test";
import schema from "../convex/schema";
import { api, internal } from "../convex/_generated/api";

const modules = import.meta.glob("../convex/**/*.{ts,js}");
const auth = { token: "secret", projectId: "test-project", workerId: "test-worker" };
const phone = "+12025550198";
const line = "+12025550199";
const profile = "https://www.linkedin.com/in/example-taylor-reed/";
const providerKey = process.env.ANTHROPIC_API_KEY;
const liveModel = process.env.SIMON_LIVE_MODEL_CHECK === "1";

beforeEach(() => {
  vi.stubEnv("PHOTON_WORKER_SECRET", auth.token);
  vi.stubEnv("PHOTON_PROJECT_ID", auth.projectId);
  vi.stubEnv("ANTHROPIC_API_KEY", "test-key");
  vi.stubEnv("FIRECRAWL_API_KEY", "test-key");
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

async function fixture() {
  const t = convexTest(schema, modules);
  const eventId = await t.run((ctx) => ctx.db.insert("events", {
    name: "Networking demo", hostName: "Host", status: "live", demo: true,
  }));
  const target = await t.run((ctx) => ctx.db.insert("attendees", {
    eventId, name: "Alex", phone: "+12025550197", bio: "Builds AI tools", researchStatus: "done",
  }));
  await t.mutation(api.photonBridge.register, { ...auth, agentHandle: line });
  let actions: unknown[] = [];
  const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
    if (url.includes("firecrawl.dev/v2/search")) return Response.json({ data: { web: [
      { url: profile, title: "Taylor Reed", description: "Builds developer tools." },
    ] } });
    if (url.includes("firecrawl.dev/v2/scrape")) return Response.json({ data: { markdown: "Taylor Reed builds developer tools." } });
    const request = JSON.parse(init.body as string);
    const data = request.output_config
      ? { reply: "", actions }
      : { summary: "Builds developer tools.", facts: ["Works on AI agents."], linkedin: profile };
    return Response.json({ content: [{ type: "text", text: JSON.stringify(data) }], stop_reason: "end_turn" });
  });
  vi.stubGlobal("fetch", fetchMock);
  let sequence = 0;
  const receive = (text: string) => t.mutation(api.photonBridge.receive, {
    ...auth, phone, text, externalId: `in:${++sequence}`, spaceId: "space", senderId: "agent", linePhone: line,
  });
  const send = async (text: string, nextActions: unknown[] = []) => {
    actions = nextActions;
    await receive(text);
    await t.action(api.agent.processNext, auth);
    const reply = (await t.mutation(api.photonBridge.claimSend, auth))!;
    expect(reply).not.toBeNull();
    await t.mutation(api.photonBridge.finishSend, {
      ...auth, messageId: reply._id, status: "delivered", externalId: `out:${sequence}`,
    });
    expect(await t.mutation(api.photonBridge.claimSend, auth)).toBeNull();
    return reply;
  };
  const self = () => t.query(internal.attendees.getByPhone, { phone });
  const suggest = { type: "recommend", picks: [{ attendeeId: target, reason: "Shared AI work" }] };
  return { t, eventId, target, fetchMock, receive, send, self, suggest };
}

test("a real number in a demo asks for identity, researches the supplied name, confirms, then waits for goals", async () => {
  const { t, send, self, fetchMock, suggest } = await fixture();
  const hello = await send("Hi", [suggest]);
  expect(hello.body).toContain("What's your full name?");
  expect(hello.body).not.toContain("Guest 0198");
  expect(fetchMock.mock.calls.some(([url]) => url.includes("firecrawl"))).toBe(false);
  const identity = await send("Taylor Reed", [{ type: "save_profile", name: "Taylor Reed" }, suggest]);
  expect(identity.body).toContain("Builds developer tools");
  expect(identity.body).toContain(profile);
  expect(identity.body).toContain("Is this you");
  const search = fetchMock.mock.calls.find(([url]) => url.includes("/search"))!;
  expect(JSON.parse(search[1].body as string).query).toContain('"Taylor Reed"');
  expect((await self())?.liveIdentity?.confirmedAt).toBeUndefined();
  expect(await t.run((ctx) => ctx.db.query("matches").collect())).toHaveLength(0);
  const confirmed = await send("Yes, that's me", [{ type: "confirm_identity" }, suggest]);
  expect(confirmed.body).toContain("Who would you like to meet");
  expect((await self())?.liveIdentity?.confirmedAt).toBeDefined();
  expect(await t.run((ctx) => ctx.db.query("matches").collect())).toHaveLength(0);
  const suggestions = await send("I want to meet AI engineers", [
    { type: "save_profile", connectionGoals: "AI engineers" }, suggest,
  ]);
  expect(suggestions.body).toContain("Alex");
  expect(await t.run((ctx) => ctx.db.query("matches").collect())).toHaveLength(1);
  expect(fetchMock.mock.calls.filter(([url]) => url.includes("/search"))).toHaveLength(1);
});

test("a supplied name reuses unique saved context without exposing goals or recommending the same person", async () => {
  const { t, eventId, send, self, fetchMock, suggest } = await fixture();
  const imported = await t.run((ctx) => ctx.db.insert("attendees", {
    eventId, name: "Taylor Reed", phone: "+12025550196", linkedin: profile,
    bio: "Founder building developer tools.", researchSummary: "Works on AI agents.",
    researchStatus: "done", connectionGoals: "Private fundraising plans",
  }));
  const reply = await send("I'm Taylor Reed", [{ type: "save_profile", name: "Taylor Reed" }]);
  expect(reply.body).toContain("Founder building developer tools");
  expect(reply.body).not.toContain("Private fundraising");
  expect(fetchMock.mock.calls.some(([url]) => url.includes("firecrawl"))).toBe(false);
  expect((await self())?._id).not.toBe(imported);
  expect((await t.run((ctx) => ctx.db.get(imported)))?.phone).toBe("+12025550196");
  await send("yes", [{ type: "confirm_identity" }]);
  const suggestions = await send("I want to meet AI engineers", [
    { type: "save_profile", connectionGoals: "AI engineers" },
    { type: "recommend", picks: [{ attendeeId: imported, reason: "Duplicate profile" }, ...suggest.picks] },
  ]);
  expect(suggestions.body).toContain("Alex");
  expect(suggestions.body).not.toContain("Duplicate profile");
});

test("early goals are saved but cannot bypass identity; a correction requires fresh confirmation", async () => {
  const { t, send, self, target, suggest } = await fixture();
  await send("Taylor Reed, looking for AI engineers", [
    { type: "save_profile", name: "Taylor Reed", connectionGoals: "AI engineers" },
    { type: "confirm_identity" }, suggest,
    { type: "request_intro", attendeeId: target, reason: "Meet" },
  ]);
  expect((await self())?.liveIdentity?.confirmedAt).toBeUndefined();
  expect((await self())?.connectionGoals).toBe("AI engineers");
  expect(await t.run((ctx) => ctx.db.query("introductions").collect())).toHaveLength(0);
  const corrected = await send("No, I design developer tools", [
    { type: "save_profile", bio: "Designs developer tools." }, { type: "confirm_identity" }, suggest,
  ]);
  expect(corrected.body).toContain("Designs developer tools.");
  expect(corrected.body).not.toContain("Works on AI agents");
  expect((await self())?.liveIdentity?.confirmedAt).toBeUndefined();
  await send("Yes, that's accurate", [{ type: "confirm_identity" }]);
  expect((await self())?.liveIdentity?.summary).toContain("Designs developer tools.");
  expect((await self())?.liveIdentity?.confirmedAt).toBeDefined();
});

test("an unavailable lookup asks for context without inventing a profile or losing the reply", async () => {
  const { send, self, fetchMock } = await fixture();
  vi.stubEnv("FIRECRAWL_API_KEY", "");
  const reply = await send("Taylor Reed", [{ type: "save_profile", name: "Taylor Reed" }]);
  expect(reply.body).toContain("don't have enough reliable background");
  expect(reply.body).not.toContain(profile);
  expect((await self())?.researchStatus).toBe("skipped");
  expect(fetchMock).toHaveBeenCalledOnce();
  const bio = await send("I build community tools", [{ type: "save_profile", bio: "Builds community tools." }]);
  expect(bio.body).toContain("Is this you");
  await send("yes", [{ type: "confirm_identity" }]);
  expect((await self())?.liveIdentity?.confirmedAt).toBeDefined();
});

test("rejecting a same-name profile discards it and waits for new details", async () => {
  const { send, self, fetchMock } = await fixture();
  await send("Taylor Reed", [{ type: "save_profile", name: "Taylor Reed" }]);
  const rejected = await send("No, that's someone else", [{ type: "reject_identity" }]);
  expect(rejected.body).not.toContain(profile);
  expect((await self())?.linkedin).toBeUndefined();
  expect((await self())?.liveIdentity?.summary).toBe("");
  await send("yes", [{ type: "confirm_identity" }]);
  expect((await self())?.liveIdentity?.confirmedAt).toBeUndefined();
  expect(fetchMock.mock.calls.filter(([url]) => url.includes("/search"))).toHaveLength(1);
  const corrected = await send("I run a design studio", [{ type: "save_profile", bio: "Runs a design studio." }]);
  expect(corrected.body).toContain("Runs a design studio.");
  expect(corrected.body).toContain("Is this you");
});

test("an existing live route still waits for one inbound onboarding reply after signup", async () => {
  const { t, send, eventId } = await fixture();
  await send("Hi");
  const before = await t.query(api.messages.listByEvent, { eventId });
  const registration = await t.mutation(api.onboarding.register, {
    token: auth.token, name: "Taylor Reed", phone, profileUrl: profile,
    simulation: false, consent: true, code: "join-code",
  });
  expect(registration.welcomeQueued).toBe(false);
  expect(await t.query(api.messages.listByEvent, { eventId })).toHaveLength(before.length);
  await send("I'm Taylor Reed", [{ type: "save_profile", name: "Taylor Reed" }]);
});

test("stale name extraction and stale research cannot overwrite a newer identity or bio", async () => {
  const { t, receive, send, self } = await fixture();
  await receive("My name is Wrong Person");
  const job = (await t.mutation(internal.photonBridge.claimGeneration, auth))!;
  await receive("Actually I'm Taylor Reed");
  expect(await t.mutation(internal.agent.prepareIdentity, {
    auth, jobId: job._id, sourceMessageId: job.sourceMessageId,
    result: { reply: "", actions: [{ type: "save_profile", name: "Wrong Person" }] },
  })).toBeNull();
  expect((await self())?.name).not.toBe("Wrong Person");
  await send("Taylor Reed", [{ type: "save_profile", name: "Taylor Reed", bio: "Designs community tools." }]);
  const person = (await self())!;
  await t.mutation(internal.attendees.saveResearch, {
    id: person._id, expectedName: "Taylor Reed", expectedProfile: "", expectedBio: "",
    researchStatus: "done", researchSummary: "Old research about someone else",
  });
  expect((await self())?.researchSummary).toBeUndefined();
});

test("a simulated confirmation cannot unlock the real conversation or perform a web lookup", async () => {
  const { t, send, self, fetchMock } = await fixture();
  await send("Taylor Reed", [{ type: "save_profile", name: "Taylor Reed" }]);
  const before = fetchMock.mock.calls.length;
  await t.action(api.agent.simulateInbound, { phone, body: "Hi" });
  const yes = await t.mutation(internal.messages.createSimulation, { phone, body: "yes" });
  await t.mutation(internal.agent.commitResult, {
    sourceMessageId: yes, result: { reply: "", actions: [{ type: "confirm_identity" }] },
  });
  expect((await self())?.simulatedIdentity?.confirmedAt).toBeDefined();
  expect((await self())?.liveIdentity?.confirmedAt).toBeUndefined();
  expect(fetchMock.mock.calls.slice(before).some(([url]) => url.includes("firecrawl"))).toBe(false);
});

test("confirmed context is used in the invitation and duplicate processing does not resend it", async () => {
  const { t, eventId, target, send, self } = await fixture();
  await send("Taylor Reed", [{ type: "save_profile", name: "Taylor Reed", bio: "Builds community tools." }]);
  await send("yes", [{ type: "confirm_identity" }]);
  // Isolate invitation formatting with a simulated conversation in the same DB.
  const person = (await self())!;
  await t.run((ctx) => ctx.db.patch(person._id, { simulatedIdentity: person.liveIdentity }));
  const source = await t.mutation(internal.messages.createSimulation, { phone, body: "Introduce me to Alex" });
  const args = { sourceMessageId: source, result: { reply: "", actions: [
    { type: "request_intro" as const, attendeeId: target, reason: "Shared AI interests." },
  ] } };
  await t.mutation(internal.agent.commitResult, args);
  await t.mutation(internal.agent.commitResult, args);
  const invitations = (await t.query(api.messages.listByEvent, { eventId })).filter((m) => m.attendeeId === target);
  expect(invitations).toHaveLength(1);
  expect(invitations[0].body).toContain("Builds community tools.");
});

test.runIf(liveModel)("real Claude handles a bare name, identity confirmation, and then connection goals in separate turns", async () => {
  vi.stubEnv("ANTHROPIC_API_KEY", providerKey!);
  const t = convexTest(schema, modules);
  const eventId = await t.run((ctx) => ctx.db.insert("events", {
    name: "Test event", hostName: "Host", status: "live", demo: true,
  }));
  await t.run(async (ctx) => {
    await ctx.db.insert("attendees", { eventId, name: "Taylor Reed", bio: "Builds community tools.", researchStatus: "done", linkedin: profile });
    await ctx.db.insert("attendees", { eventId, name: "Alex", bio: "AI engineer building developer tools.", researchStatus: "done" });
  });
  const say = async (body: string) => {
    await t.action(api.agent.simulateInbound, { phone, body });
    return (await t.query(api.messages.listByPhone, { phone })).at(-1)!.body;
  };
  expect(await say("Hello!")).toContain("What's your full name");
  expect(await say("Taylor Reed")).toContain("Builds community tools");
  expect(await say("Yes, that's me")).toContain("Who would you like to meet");
  expect(await t.run((ctx) => ctx.db.query("matches").collect())).toHaveLength(0);
  expect(await say("I'd like to meet AI engineers")).toContain("Alex");
}, 90_000);
