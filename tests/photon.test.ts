import { expect, test } from "vitest";
import type { ReceivedImessageMessage } from "@photon-ai/api";
import { eventMessage, incomingMessage } from "../agent/photon";

const projectId = "pho_prj_test";
const agentHandle = "+14155550199";
const now = "2026-10-30T23:00:00.000Z";
const message: ReceivedImessageMessage = {
  id: "pho_msg_test",
  projectId,
  platform: "imessage",
  status: "received",
  createdAt: now,
  updatedAt: now,
  timestamps: { receivedAt: now },
  metadata: {},
  content: { type: "text", format: "plain", text: "I want to meet founders" },
  space: {
    id: "pho_spc_test",
    projectId,
    platform: "imessage",
    kind: "direct",
    participantIds: ["pho_usr_human", "pho_usr_agent"],
    metadata: {},
    details: {},
  },
  sentBy: {
    id: "pho_usr_human",
    projectId,
    platform: "imessage",
    kind: "human",
    handle: "+14155550101",
    metadata: {},
    details: {},
  },
  receivedBy: {
    id: "pho_usr_agent",
    projectId,
    platform: "imessage",
    kind: "agent",
    handle: agentHandle,
    metadata: {},
    details: {},
  },
};
const envelope = {
  source: "imessage.photon",
  type: "message.received",
  data: { projectId, object: message },
};

test("Beta replies reuse the receiving agent and direct-conversation IDs", () => {
  const decoded = eventMessage(envelope, projectId)!;
  expect(incomingMessage(decoded, projectId, agentHandle)).toEqual({
    phone: "+14155550101",
    externalId: "pho_msg_test",
    text: "I want to meet founders",
    spaceId: "pho_spc_test",
    senderId: "pho_usr_agent",
    linePhone: agentHandle,
  });
});

test("groups, other projects, other receiving lines and outbound echoes cannot trigger replies", () => {
  expect(eventMessage(envelope, "another-project")).toBeNull();
  const decoded = eventMessage(envelope, projectId)!;
  expect(incomingMessage(decoded, projectId, "+14155550200")).toBeNull();
  const group = eventMessage(
    {
      ...envelope,
      data: {
        projectId,
        object: { ...message, space: { ...message.space, kind: "group" } },
      },
    },
    projectId,
  )!;
  expect(incomingMessage(group, projectId, agentHandle)).toBeNull();
  const echo = eventMessage(
    {
      ...envelope,
      data: { projectId, object: { ...message, sentBy: message.receivedBy } },
    },
    projectId,
  )!;
  expect(incomingMessage(echo, projectId, agentHandle)).toBeNull();
});
