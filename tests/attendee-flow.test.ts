/// <reference types="vite/client" />
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { convexTest } from "convex-test";
import schema from "../convex/schema";
import { api, internal } from "../convex/_generated/api";
import { messagesLink, startMessage } from "../app/lib/startMessage";

const modules = import.meta.glob("../convex/**/*.{ts,js}");
const token = "worker-secret";
const phone = "+12025550199";
const auth = { token, projectId: "pho_prj_test", workerId: "worker-one" };
const line = "+14155550199";
const signup = {
  token,
  name: "Taylor",
  phone,
  profileUrl: "https://example.test/taylor",
  simulation: true,
  consent: true,
  code: "signup-code",
};
beforeEach(() => {
  vi.stubEnv("PHOTON_WORKER_SECRET", token);
  vi.stubEnv("PHOTON_PROJECT_ID", auth.projectId);
  vi.stubEnv("ALLOW_DEMO_SEED", "1");
  vi.stubEnv("ANTHROPIC_API_KEY", "test-key");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
async function fixture() {
  const t = convexTest(schema, modules);
  const { eventId } = await t.mutation(api.demo.seed, { token });
  await t.mutation(api.photonBridge.register, { ...auth, agentHandle: line });
  return { t, eventId };
}

test("host wizard settings and the dashboard's structured replies survive the attendee integration", async () => {
  const { t, eventId } = await fixture();
  await t.run((ctx) =>
    ctx.db.patch(eventId, {
      agentName: "Nova",
      agenda: "Connect technical founders with design partners.",
      welcomeTemplate: "Hey {first_name}! Welcome to {event}.",
    }),
  );
  await t.mutation(api.onboarding.register, { ...signup, name: "Taylor Reed" });
  expect((await t.query(api.messages.listByPhone, { phone }))[0].body).toBe(
    "Hey Taylor! Welcome to Night Hack (demo).",
  );
  const fetchMock = vi.fn().mockResolvedValue(
    Response.json({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            reply: "Try Alex.",
            matches: [{ name: "Alex (demo)", why: "Builds AI tools." }],
          }),
        },
      ],
      stop_reason: "end_turn",
    }),
  );
  vi.stubGlobal("fetch", fetchMock);
  const result = await t.action(api.agent.hostAsk, {
    question: "Who builds AI tools?",
    history: [{ role: "user", text: "I need a technical founder." }],
  });
  expect(result.reply).toBe("Try Alex.");
  expect(result.matches[0]).toMatchObject({
    name: "Alex (demo)",
    why: "Builds AI tools.",
  });
  const hostRequest = JSON.parse(fetchMock.mock.calls[0][1].body);
  expect(hostRequest.messages[0].content).toContain(
    "I need a technical founder.",
  );
  fetchMock.mockResolvedValue(
    Response.json({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            reply: "Who would you like to meet?",
            actions: [],
          }),
        },
      ],
      stop_reason: "end_turn",
    }),
  );
  await t.action(api.agent.simulateInbound, { phone, body: "Hi" });
  const attendeeRequest = JSON.parse(fetchMock.mock.calls[1][1].body);
  expect(attendeeRequest.system).toContain("You are Nova");
  expect(attendeeRequest.system).toContain("HOST PRIVATE AGENDA");
});

test("QR signup validates identity, preserves cached profile and sends the controlled welcome once", async () => {
  const { t, eventId } = await fixture();
  await t.run((ctx) =>
    ctx.db.patch(eventId, {
      welcomeTemplate:
        "Hey {name}! Welcome to {event}. Who do you want to meet?",
    }),
  );
  await expect(
    t.mutation(api.onboarding.register, { ...signup, consent: false }),
  ).rejects.toThrow();
  await expect(
    t.mutation(api.onboarding.register, {
      ...signup,
      profileUrl: "javascript:alert(1)",
    }),
  ).rejects.toThrow();
  const first = await t.mutation(api.onboarding.register, signup);
  const second = await t.mutation(api.onboarding.register, {
    ...signup,
    code: "retry",
  });
  expect(second.registrationId).toBe(first.registrationId);
  expect(second.code).toBe(first.code);
  const thread = await t.query(api.messages.listByPhone, { phone });
  expect(thread).toHaveLength(1);
  expect(thread[0].body).toBe(
    "Hey Taylor! Welcome to Night Hack (demo). Who do you want to meet?",
  );
  expect(thread[0].deliveryStatus).toBe("mock");
  expect(await t.mutation(api.photonBridge.claimSend, auth)).toBeNull();
});

test("a new real signup waits for its assigned line, then welcomes exactly once", async () => {
  const { t, eventId } = await fixture();
  const registration = await t.mutation(api.onboarding.register, {
    ...signup,
    simulation: false,
  });
  expect(registration.welcomeQueued).toBe(false);
  expect(await t.query(api.messages.listByEvent, { eventId })).toHaveLength(0);
  const assigned = "+14155550200";
  await t.mutation(api.onboarding.setLine, {
    token,
    registrationId: registration.registrationId,
    agentHandle: assigned,
  });
  const incoming = {
    ...auth,
    phone,
    externalId: "first",
    text: startMessage("Taylor", signup.profileUrl, registration.code),
    spaceId: "space",
    senderId: "agent",
    linePhone: assigned,
  };
  expect(
    await t.mutation(api.photonBridge.receive, {
      ...incoming,
      linePhone: "+14155550999",
    }),
  ).toBe(false);
  expect(await t.mutation(api.photonBridge.receive, incoming)).toBe(true);
  expect(await t.mutation(api.photonBridge.receive, incoming)).toBe(false);
  const welcome = await t.mutation(api.photonBridge.claimSend, auth);
  expect(welcome?.body).toContain(
    "Hey Taylor! Welcome to Night Hack by Founders, Inc.",
  );
  expect(welcome?.senderId).toBe("agent");
  expect(
    await t.mutation(internal.photonBridge.claimGeneration, auth),
  ).toBeNull();
});

test("profile-based search returns three roster people and a changed goal replaces the suggestions", async () => {
  const { t, eventId } = await fixture();
  await t.mutation(api.onboarding.register, signup);
  const roster = await t.query(api.attendees.listByEvent, { eventId });
  const names = ["Alex (demo)", "Morgan (demo)", "Priya (demo)"];
  const picks = names.map((name) => ({
    attendeeId: roster.find((a) => a.name === name)!._id,
    reason: `Relevant AI experience from ${name}.`,
  }));
  const fetchMock = vi.fn().mockResolvedValue(
    Response.json({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            reply: "",
            actions: [
              { type: "save_profile", connectionGoals: "AI engineers" },
              { type: "recommend", picks },
            ],
          }),
        },
      ],
      stop_reason: "end_turn",
    }),
  );
  vi.stubGlobal("fetch", fetchMock);
  await t.action(api.agent.simulateInbound, {
    phone,
    body: "I want to meet AI engineers.",
  });
  const first = (await t.query(api.messages.listByPhone, { phone })).at(-1)!;
  for (const name of names) expect(first.body).toContain(name);
  expect(first.body).toContain("3 people");
  const prompt = JSON.parse(fetchMock.mock.calls[0][1].body).messages[0]
    .content;
  expect(prompt).toContain("evaluation pipelines");
  const source = await t.mutation(internal.messages.createSimulation, {
    phone,
    body: "Actually, designers instead.",
  });
  const designers = ["Jamie (demo)", "Casey (demo)", "Sam (demo)"];
  await t.mutation(internal.agent.commitResult, {
    sourceMessageId: source,
    result: {
      reply: "",
      actions: [
        { type: "save_profile", connectionGoals: "Designers" },
        {
          type: "recommend",
          picks: designers.map((name) => ({
            attendeeId: roster.find((a) => a.name === name)!._id,
            reason: "Relevant design work.",
          })),
        },
      ],
    },
  });
  const active = await t.run((ctx) =>
    ctx.db
      .query("matches")
      .filter((q) => q.eq(q.field("status"), "suggested"))
      .collect(),
  );
  expect(active).toHaveLength(3);
  expect(
    active.map((m) => roster.find((a) => a._id === m.attendeeB)!.name).sort(),
  ).toEqual(designers.sort());
  expect(
    (await t.query(api.attendees.listByEvent, { eventId })).find(
      (a) => a.phone === phone,
    )?.connectionGoals,
  ).toBe("Designers");
});

test("introductions wait for the correct recipient's yes and send both sides one meeting suggestion", async () => {
  const { t, eventId } = await fixture();
  await t.mutation(api.onboarding.register, signup);
  const alex = (await t.query(api.attendees.listByEvent, { eventId })).find(
    (a) => a.name === "Alex (demo)",
  )!;
  const source = await t.mutation(internal.messages.createSimulation, {
    phone,
    body: "Please introduce me to Alex.",
  });
  const result = {
    reply: "",
    actions: [
      {
        type: "request_intro" as const,
        attendeeId: alex._id,
        reason: "You both work on AI agents.",
      },
    ],
  };
  await t.mutation(internal.agent.commitResult, {
    sourceMessageId: source,
    result,
  });
  await t.mutation(internal.agent.commitResult, {
    sourceMessageId: source,
    result,
  });
  const intro = (
    await t.run((ctx) => ctx.db.query("introductions").collect())
  )[0];
  expect(intro.status).toBe("pending");
  const invite = await t.query(api.messages.listByPhone, {
    phone: alex.phone!,
  });
  expect(invite).toHaveLength(1);
  expect(invite[0].body).toContain(`YES ${intro.code}`);
  const wrong = await t.mutation(internal.messages.createSimulation, {
    phone,
    body: `YES ${intro.code}`,
  });
  await t.mutation(internal.agent.commitResult, {
    sourceMessageId: wrong,
    result: { reply: "", actions: [] },
  });
  expect((await t.run((ctx) => ctx.db.get(intro._id)))?.status).toBe("pending");
  await t.action(api.agent.simulateInbound, {
    phone: alex.phone!,
    body: `YES ${intro.code}`,
  });
  expect((await t.run((ctx) => ctx.db.get(intro._id)))?.status).toBe(
    "accepted",
  );
  expect(
    (await t.query(api.messages.listByPhone, { phone })).at(-1)?.body,
  ).toContain("the welcome desk");
  expect(
    (await t.query(api.messages.listByPhone, { phone: alex.phone! })).at(-1)
      ?.body,
  ).toContain("the welcome desk");
  expect(await t.mutation(api.photonBridge.claimSend, auth)).toBeNull();
  const all = await t.query(api.messages.listByEvent, { eventId });
  expect(
    all
      .filter((m) => m.direction === "outbound")
      .every((m) => m.deliveryStatus === "mock"),
  ).toBe(true);
});

test("prefilled Messages link safely carries the entered name, profile and activation code", () => {
  const body = startMessage(
    "Ana & Jo",
    "https://example.test/ana?x=1&y=2",
    "abc123",
  );
  const link = messagesLink("+14155550199", body);
  expect(link).toBe(`sms:+14155550199?body=${encodeURIComponent(body)}`);
  expect(decodeURIComponent(link.split("body=")[1])).toContain("Ana & Jo");
  expect(decodeURIComponent(link.split("body=")[1])).toContain("START abc123");
  expect(messagesLink("+14155550199", body, true)).toContain("&body=");
});
