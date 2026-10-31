/// <reference types="vite/client" />
import { beforeEach, afterEach, expect, test, vi } from "vitest";
import { convexTest } from "convex-test";
import schema from "../convex/schema";
import { confirmedGuest } from "./fixtures";
import { api, internal } from "../convex/_generated/api";

const modules = import.meta.glob("../convex/**/*.{ts,js}");
const auth = {
  token: "worker-secret",
  workerId: "worker-one",
  projectId: "pho_prj_test",
};
const phone = "+14155550101";
const agentHandle = "+14155550199";
const incoming = {
  ...auth,
  phone,
  externalId: "incoming-one",
  text: "I'm looking for event-tool builders.",
  spaceId: "pho_spc_noah",
  senderId: "pho_usr_agent",
  linePhone: agentHandle,
};
beforeEach(() => {
  vi.stubEnv("PHOTON_WORKER_SECRET", auth.token);
  vi.stubEnv("PHOTON_PROJECT_ID", auth.projectId);
  vi.stubEnv("ALLOW_DEMO_SEED", "1");
  vi.stubEnv("ANTHROPIC_API_KEY", "test-model-key");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
async function fixture() {
  const t = convexTest(schema, modules);
  const seeded = await t.mutation(api.demo.seed, { token: auth.token, phone });
  await t.mutation(api.photonBridge.register, { ...auth, agentHandle });
  await t.run(async (ctx) => {
    const person = await ctx.db.query("attendees").withIndex("by_phone", (q) => q.eq("phone", phone)).first();
    await confirmedGuest(ctx, person!._id, false);
    await confirmedGuest(ctx, person!._id, true);
  });
  return { t, eventId: seeded.eventId };
}

test("main agent uses Claude and existing profiles, then queues one real Photon reply", async () => {
  const { t, eventId } = await fixture();
  await t.run(async (ctx) => {
    const alex = (await ctx.db.query("attendees").collect()).find(
      (a) => a.name === "Alex (demo)",
    )!;
    await ctx.db.patch(alex._id, { bio: "Builds AI event tools." });
  });
  const fetchMock = vi.fn().mockResolvedValue(
    Response.json({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            reply: "You might enjoy meeting Alex (demo).",
            actions: [{ type: "save_profile", name: "Noah" }],
          }),
        },
      ],
      stop_reason: "end_turn",
    }),
  );
  vi.stubGlobal("fetch", fetchMock);
  expect(await t.mutation(api.photonBridge.receive, incoming)).toBe(true);
  expect(await t.mutation(api.photonBridge.receive, incoming)).toBe(false);
  expect(await t.action(api.agent.processNext, auth)).toBe(true);
  expect(await t.action(api.agent.processNext, auth)).toBe(false);
  const claimed = (await t.mutation(api.photonBridge.claimSend, auth))!;
  expect(claimed.phone).toBe(phone);
  expect(claimed.spaceId).toBe(incoming.spaceId);
  expect(claimed.parentMessageId).toBe(incoming.externalId);
  expect(fetchMock).toHaveBeenCalledOnce();
  const prompt = JSON.parse(fetchMock.mock.calls[0][1].body).messages[0]
    .content;
  expect(prompt).toContain("DEMO MODE");
  expect(prompt).toContain("Alex (demo)");
  expect(prompt).toContain("Builds AI event tools.");
  await t.mutation(api.photonBridge.finishSend, {
    ...auth,
    messageId: claimed._id,
    externalId: "outgoing-one",
    status: "dispatched",
  });
  await t.mutation(api.photonBridge.recordDelivery, {
    ...auth,
    externalId: "outgoing-one",
    status: "delivered",
  });
  await t.mutation(api.photonBridge.recordDelivery, {
    ...auth,
    externalId: "outgoing-one",
    status: "dispatched",
  });
  const messages = await t.query(api.messages.listByEvent, { eventId });
  expect(messages).toHaveLength(4);
  expect(messages.at(-1)?.deliveryStatus).toBe("delivered");
});

test("a malformed reply can be recovered once without duplicating the inbound or sending stale replies", async () => {
  const { t, eventId } = await fixture();
  await t.mutation(api.photonBridge.receive, incoming);
  const job = (await t.mutation(internal.photonBridge.claimGeneration, auth))!;
  await t.mutation(internal.agent.commitResult, {
    auth, jobId: job._id, sourceMessageId: job.sourceMessageId,
    result: { reply: "I had trouble with that. Could you try again?", actions: [] },
  });
  const fallback = (await t.mutation(api.photonBridge.claimSend, auth))!;
  await t.mutation(api.photonBridge.finishSend, {
    ...auth, messageId: fallback._id, externalId: "fallback", status: "delivered",
  });
  const retry = () => t.mutation(internal.photonBridge.retryMalformedReply, {
    sourceMessageId: job.sourceMessageId,
  });
  expect(await retry()).toBe(true);
  expect(await retry()).toBe(false);
  const fetchMock = vi.fn().mockResolvedValue(Response.json({
    content: [{ type: "text", text: JSON.stringify({ reply: "Recovered reply.", actions: [] }) }],
    stop_reason: "end_turn",
  }));
  vi.stubGlobal("fetch", fetchMock);
  await t.action(api.agent.processNext, auth);
  const request = JSON.parse(fetchMock.mock.calls[0][1].body);
  expect(request.output_config.format.type).toBe("json_schema");
  expect(request.messages[0].content).not.toContain("I had trouble with that");
  expect((await t.mutation(api.photonBridge.claimSend, auth))?.body).toBe("Recovered reply.");
  await expect(retry()).rejects.toThrow("unrecovered");
  expect((await t.query(api.messages.listByEvent, { eventId }))
    .filter((m) => m.direction === "inbound")).toHaveLength(1);
  await t.mutation(api.photonBridge.receive, { ...incoming, externalId: "newer", text: "New goal" });
  await expect(retry()).rejects.toThrow("no longer current");
});

test("an unfinished search can be recovered once and a repeated promise is replaced with actual matches", async () => {
  const { t, eventId } = await fixture();
  const target = (await t.query(api.attendees.listByEvent, { eventId })).find((p) => p.name === "Alex (demo)")!;
  await t.mutation(api.photonBridge.receive, { ...incoming, text: "Can you find people for me?" });
  const job = (await t.mutation(internal.photonBridge.claimGeneration, auth))!;
  await t.mutation(internal.agent.commitResult, {
    auth, jobId: job._id, sourceMessageId: job.sourceMessageId,
    result: { reply: "Let me search the roster for people. One moment...", actions: [] },
  });
  const promise = (await t.mutation(api.photonBridge.claimSend, auth))!;
  await t.mutation(api.photonBridge.finishSend, {
    ...auth, messageId: promise._id, externalId: "promise", status: "delivered",
  });
  const retry = () => t.mutation(internal.photonBridge.retryUnfinishedSearch, { sourceMessageId: job.sourceMessageId });
  expect(await retry()).toBe(true);
  expect(await retry()).toBe(false);
  const response = (value: unknown) => Response.json({
    content: [{ type: "text", text: JSON.stringify(value) }], stop_reason: "end_turn",
  });
  const mock = vi.fn()
    .mockResolvedValueOnce(response({ reply: "Let me search the roster. One moment...", actions: [] }))
    .mockResolvedValueOnce(response({ picks: [{ attendeeId: target._id, reason: "Builds event tools." }] }));
  vi.stubGlobal("fetch", mock);
  await t.action(api.agent.processNext, auth);
  const result = (await t.mutation(api.photonBridge.claimSend, auth))!;
  expect(result.body).toContain("Alex (demo)");
  expect(result.body).not.toContain("One moment");
  expect(mock).toHaveBeenCalledTimes(2);
  expect((await t.query(api.messages.listByEvent, { eventId })).filter((m) => m.direction === "inbound")).toHaveLength(1);
  await expect(retry()).rejects.toThrow("unfinished search promise");
  await t.mutation(api.photonBridge.receive, { ...incoming, externalId: "newer-search", text: "Another request" });
  await expect(retry()).rejects.toThrow("no longer current");
});

test("STOP and rapid follow-ups cancel stale model actions and queued sends", async () => {
  const { t, eventId } = await fixture();
  await t.mutation(api.photonBridge.receive, incoming);
  const first = (await t.mutation(
    internal.photonBridge.claimGeneration,
    auth,
  ))!;
  await t.mutation(api.photonBridge.receive, {
    ...incoming,
    externalId: "incoming-two",
    text: "Actually I want to meet designers.",
  });
  await t.mutation(internal.agent.commitResult, {
    auth,
    jobId: first._id,
    sourceMessageId: first.sourceMessageId,
    result: {
      reply: "Stale response",
      actions: [{ type: "save_profile", name: "Wrong name" }],
    },
  });
  expect(await t.mutation(api.photonBridge.claimSend, auth)).toBeNull();
  expect((await t.query(api.attendees.listByEvent, { eventId }))[0].name).toBe(
    "Noah",
  );
  const latest = (await t.mutation(
    internal.photonBridge.claimGeneration,
    auth,
  ))!;
  await t.mutation(internal.agent.commitResult, {
    auth,
    jobId: latest._id,
    sourceMessageId: latest.sourceMessageId,
    result: { reply: "Here's a designer", actions: [] },
  });
  await t.mutation(api.photonBridge.receive, {
    ...incoming,
    externalId: "stop",
    text: "STOP",
  });
  expect(await t.mutation(api.photonBridge.claimSend, auth)).toBeNull();
  expect(
    await t.mutation(api.photonBridge.receive, {
      ...incoming,
      externalId: "after-stop",
      text: "Hello",
    }),
  ).toBe(false);
});

test("disconnected demo targets cannot receive introductions and dashboard simulations never send", async () => {
  const { t, eventId } = await fixture();
  await t.mutation(api.photonBridge.receive, incoming);
  const job = (await t.mutation(internal.photonBridge.claimGeneration, auth))!;
  await t.mutation(internal.agent.commitResult, {
    auth,
    jobId: job._id,
    sourceMessageId: job.sourceMessageId,
    result: {
      reply: "I sent it!",
      actions: [
        {
          type: "ping",
          targetName: "Alex",
          message: "Noah would like an introduction.",
        },
      ],
    },
  });
  const reply = (await t.mutation(api.photonBridge.claimSend, auth))!;
  expect(reply.phone).toBe(phone);
  expect(reply.body).toContain("couldn't send");
  expect(
    await t.run((ctx) => ctx.db.query("introductions").collect()),
  ).toHaveLength(0);
  await t.mutation(api.photonBridge.finishSend, {
    ...auth,
    messageId: reply._id,
    status: "delivered",
    externalId: "out",
  });
  const simulation = await t.mutation(internal.messages.createSimulation, {
    phone,
    body: "Test",
  });
  await t.mutation(internal.agent.commitResult, {
    sourceMessageId: simulation,
    result: { reply: "Simulated reply", actions: [] },
  });
  expect(await t.mutation(api.photonBridge.claimSend, auth)).toBeNull();
  const messages = await t.query(api.messages.listByEvent, { eventId });
  expect(messages.at(-1)?.deliveryStatus).toBe("mock");
  const liveHistory = await t.query(internal.messages.recentByPhone, {
    phone,
    eventId,
    simulation: false,
  });
  expect(liveHistory.some((m) => m.simulation)).toBe(false);
  const mockHistory = await t.query(api.messages.listByPhone, { phone });
  expect(mockHistory.slice(1).map((m) => m.body)).toEqual(["Test", "Simulated reply"]);
  await t.run(async (ctx) => {
    await ctx.db.patch(eventId, { status: "ended" });
    await ctx.db.insert("events", {
      name: "Next event",
      hostName: "Host",
      status: "live",
    });
  });
  expect(await t.query(api.messages.listByPhone, { phone })).toEqual([]);
});

test("worker ownership, replay cursor and interrupted-send recovery survive a restart", async () => {
  const { t, eventId } = await fixture();
  await expect(
    t.mutation(api.photonBridge.receive, { ...incoming, token: "bad" }),
  ).rejects.toThrow();
  await expect(
    t.mutation(api.photonBridge.register, {
      ...auth,
      workerId: "duplicate",
      agentHandle,
    }),
  ).rejects.toThrow();
  await t.mutation(api.photonBridge.checkpoint, { ...auth, seq: 42 });
  await t.mutation(api.photonBridge.checkpoint, { ...auth, seq: 10 });
  await t.mutation(api.photonBridge.receive, incoming);
  const job = (await t.mutation(internal.photonBridge.claimGeneration, auth))!;
  await t.mutation(internal.agent.commitResult, {
    auth,
    jobId: job._id,
    sourceMessageId: job.sourceMessageId,
    result: { reply: "Ready", actions: [] },
  });
  const sending = (await t.mutation(api.photonBridge.claimSend, auth))!;
  await expect(
    t.mutation(api.photonBridge.finishSend, {
      ...auth,
      workerId: "wrong",
      messageId: sending._id,
      status: "delivered",
    }),
  ).rejects.toThrow();
  await t.mutation(api.photonBridge.heartbeat, {
    ...auth,
    connected: false,
    stopping: true,
  });
  const replacement = { ...auth, workerId: "worker-two" };
  expect(
    await t.mutation(api.photonBridge.register, {
      ...replacement,
      agentHandle,
    }),
  ).toBe(42);
  expect(await t.mutation(api.photonBridge.claimSend, replacement)).toBeNull();
  expect(
    (await t.query(api.messages.listByEvent, { eventId })).at(-1)
      ?.deliveryStatus,
  ).toBe("failed");
});

test("demo seed is idempotent and preserves existing conversations", async () => {
  const { t, eventId } = await fixture();
  await t.mutation(api.photonBridge.receive, incoming);
  expect(await t.mutation(api.demo.seed, { token: auth.token, phone })).toEqual(
    { eventId, created: false },
  );
  expect(await t.query(api.attendees.listByEvent, { eventId })).toHaveLength(7);
  expect(await t.query(api.messages.listByEvent, { eventId })).toHaveLength(3);
});

test.each(["delivery failure", "worker restart"])(
  "an introduction stops waiting when the invitation fails through %s",
  async (failure) => {
    const { t, eventId } = await fixture();
    const target = (await t.query(api.attendees.listByEvent, { eventId })).find(
      (person) => person.name === "Alex (demo)",
    )!;
    // Exercise the live queue entirely in the in-memory test database.
    await t.run(async (ctx) => {
      await ctx.db.patch(target._id, { isDemo: false });
      await confirmedGuest(ctx, target._id, false);
    });
    await t.mutation(api.photonBridge.receive, {
      ...incoming,
      phone: target.phone!,
      externalId: "target-first",
      spaceId: "target-space",
      text: "Hi Simon",
    });
    const targetJob = (await t.mutation(
      internal.photonBridge.claimGeneration,
      auth,
    ))!;
    await t.mutation(internal.agent.commitResult, {
      auth,
      jobId: targetJob._id,
      sourceMessageId: targetJob.sourceMessageId,
      result: { reply: "", actions: [] },
    });
    await t.mutation(api.photonBridge.receive, incoming);
    const sourceJob = (await t.mutation(
      internal.photonBridge.claimGeneration,
      auth,
    ))!;
    await t.mutation(internal.agent.commitResult, {
      auth,
      jobId: sourceJob._id,
      sourceMessageId: sourceJob.sourceMessageId,
      result: {
        reply: "",
        actions: [
          {
            type: "request_intro",
            attendeeId: target._id,
            reason: "Shared interest in AI.",
          },
        ],
      },
    });
    const invitation = (await t.mutation(api.photonBridge.claimSend, auth))!;
    expect(invitation.phone).toBe(target.phone);
    if (failure === "delivery failure") {
      await t.mutation(api.photonBridge.finishSend, {
        ...auth,
        messageId: invitation._id,
        externalId: "invite",
        status: "dispatched",
      });
      await t.mutation(api.photonBridge.recordDelivery, {
        ...auth,
        externalId: "invite",
        status: "failed",
      });
    } else {
      await t.mutation(api.photonBridge.heartbeat, {
        ...auth,
        connected: false,
        stopping: true,
      });
      await t.mutation(api.photonBridge.register, {
        ...auth,
        workerId: "replacement",
        agentHandle,
      });
    }
    const intro = await t.run((ctx) => ctx.db.get(invitation.introductionId!));
    expect(intro?.status).toBe("unavailable");
  },
);
