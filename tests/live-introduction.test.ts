/// <reference types="vite/client" />
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { convexTest } from "convex-test";
import schema from "../convex/schema";
import { confirmedGuest } from "./fixtures";
import { api, internal } from "../convex/_generated/api";

const modules = import.meta.glob("../convex/**/*.{ts,js}");
const token = "test-worker-secret";
const auth = { token, projectId: "test-project", workerId: "test-worker" };
const line = "+12025550101";
const tester = {
  token,
  name: "Test recipient",
  phone: "+91 99999 00001",
  profileUrl: "https://www.linkedin.com/in/simon-test-recipient/",
  code: "test-code",
};
beforeEach(() => {
  vi.stubEnv("PHOTON_WORKER_SECRET", token);
  vi.stubEnv("PHOTON_PROJECT_ID", auth.projectId);
  vi.stubEnv("ALLOW_DEMO_SEED", "1");
});
afterEach(() => vi.unstubAllEnvs());

test("preparing a real tester is idempotent, demo-only, and sends no messages", async () => {
  const t = convexTest(schema, modules);
  const { eventId } = await t.mutation(api.demo.seed, { token });
  await expect(
    t.mutation(api.demo.prepareTestContact, {
      ...tester,
      token: "wrong",
    }),
  ).rejects.toThrow();
  const first = await t.mutation(api.demo.prepareTestContact, tester);
  expect(
    await t.mutation(api.demo.prepareTestContact, {
      ...tester,
      code: "retry",
    }),
  ).toEqual(first);
  expect(first.phone).toBe("+919999900001");
  expect(await t.query(api.messages.listByEvent, { eventId })).toEqual([]);
  expect(
    await t.run((ctx) => ctx.db.query("photonConversations").collect()),
  ).toEqual([]);
  await expect(
    t.mutation(api.demo.prepareTestContact, {
      ...tester,
      phone: "+12025550121",
    }),
  ).rejects.toThrow("fictional");
  await t.run((ctx) => ctx.db.patch(eventId, { demo: false }));
  await expect(t.mutation(api.demo.prepareTestContact, tester)).rejects.toThrow(
    "demo event",
  );
});

test("an international tester activates their own line and receives a proactive consent request", async () => {
  const t = convexTest(schema, modules);
  await t.mutation(api.demo.seed, { token });
  await t.mutation(api.photonBridge.register, { ...auth, agentHandle: line });
  const recipient = await t.mutation(api.demo.prepareTestContact, tester);
  const senderProfile = "https://www.linkedin.com/in/simon-test-sender/";
  const sender = await t.mutation(api.demo.prepareTestContact, {
    ...tester,
    name: "Test sender",
    phone: "+12025550190",
    profileUrl: senderProfile,
  });
  const recipientLine = "+12025550102";
  await t.mutation(api.onboarding.setLine, {
    token,
    registrationId: recipient.registrationId,
    agentHandle: recipientLine,
  });
  const receive = (phone: string, text: string, id: string) =>
    t.mutation(api.photonBridge.receive, {
      ...auth,
      phone,
      text,
      externalId: id,
      spaceId: `space:${phone}`,
      senderId: `agent:${phone}`,
      linePhone: phone === recipient.phone ? recipientLine : line,
    });
  const deliver = async () => {
    const message = await t.mutation(api.photonBridge.claimSend, auth);
    expect(message).not.toBeNull();
    await t.mutation(api.photonBridge.finishSend, {
      ...auth,
      messageId: message!._id,
      externalId: `out:${message!._id}`,
      status: "delivered",
    });
    return message!;
  };
  const requestIntro = async (id: string) => {
    await receive(sender.phone, "Introduce me to Test recipient.", id);
    const job = (await t.mutation(
      internal.photonBridge.claimGeneration,
      auth,
    ))!;
    await t.mutation(internal.agent.commitResult, {
      auth,
      jobId: job._id,
      sourceMessageId: job.sourceMessageId,
      result: {
        reply: "",
        actions: [
          {
            type: "request_intro",
            attendeeId: recipient.attendeeId,
            reason: "You are both testing attendee networking.",
          },
        ],
      },
    });
  };
  expect(await t.mutation(api.photonBridge.claimSend, auth)).toBeNull();
  await receive(sender.phone, "Hi Simon", "sender-hi");
  const senderJob = (await t.mutation(internal.photonBridge.claimGeneration, auth))!;
  await t.mutation(internal.agent.commitResult, {
    auth, jobId: senderJob._id, sourceMessageId: senderJob.sourceMessageId,
    result: { reply: "", actions: [] },
  });
  await deliver();
  await t.run((ctx) => confirmedGuest(ctx, sender.attendeeId, false));
  await requestIntro("before-activation");
  expect((await deliver()).body).toContain("needs to text Simon");
  expect(await t.mutation(api.photonBridge.claimSend, auth)).toBeNull();

  await receive(recipient.phone, "Hi Simon", "recipient-hi");
  const greetingJob = (await t.mutation(internal.photonBridge.claimGeneration, auth))!;
  await t.mutation(internal.agent.commitResult, {
    auth, jobId: greetingJob._id, sourceMessageId: greetingJob.sourceMessageId,
    result: { reply: "", actions: [] },
  });
  expect((await deliver()).body).toContain("your AI host");
  await requestIntro("after-activation");
  const invitation = await deliver();
  expect(invitation).toMatchObject({
    phone: recipient.phone,
    spaceId: `space:${recipient.phone}`,
    senderId: `agent:${recipient.phone}`,
    parentMessageId: "recipient-hi",
  });
  expect(invitation.body).toContain(senderProfile);
  const intro = (
    await t.run((ctx) => ctx.db.query("introductions").collect())
  ).find((i) => i.status === "pending")!;
  expect(invitation.body).toContain("Just reply yes or no");
  await deliver(); // Requester's acknowledgement, separate from the invitation.
  await receive(recipient.phone, `YES ${intro.code}`, "recipient-yes");
  await t.action(api.agent.processNext, auth);
  expect((await t.run((ctx) => ctx.db.get(intro._id)))?.status).toBe(
    "accepted",
  );
  const toSender = await deliver();
  const toRecipient = await deliver();
  expect(toSender).toMatchObject({ phone: sender.phone });
  expect(toSender.body).not.toContain(tester.profileUrl);
  expect(toRecipient).toMatchObject({ phone: recipient.phone });
  expect(toRecipient.body).not.toContain(senderProfile);
  for (const message of [toSender, toRecipient]) {
    expect(message.body).toContain("the welcome desk");
    expect(message.body).not.toContain(recipient.phone);
    expect(message.body).not.toContain(sender.phone);
  }
  expect(await t.mutation(api.photonBridge.claimSend, auth)).toBeNull();
});
