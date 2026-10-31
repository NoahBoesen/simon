import { randomBytes } from "node:crypto";
import { parseArgs } from "node:util";
import { Photon, ApiError } from "@photon-ai/api";
import { ConvexHttpClient } from "convex/browser";
import { anyApi } from "convex/server";
import type { api as generatedApi } from "../convex/_generated/api";

const api = anyApi as unknown as typeof generatedApi;
function required(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`Set ${name} in .env.local.`);
  return value;
}

async function main() {
  const { values } = parseArgs({
    options: {
      name: { type: "string" },
      phone: { type: "string" },
      profile: { type: "string" },
      bio: { type: "string" },
    },
  });
  if (!values.name || !values.phone || !values.profile)
    throw new Error("Pass --name, --phone (with country code), and --profile.");
  const token = required("PHOTON_WORKER_SECRET");
  const projectId = required("PHOTON_PROJECT_ID");
  const convex = new ConvexHttpClient(required("NEXT_PUBLIC_CONVEX_URL"));
  const photon = new Photon({
    headers: {
      Authorization: `Bearer ${process.env.PHOTON_SETUP_API_KEY || required("PHOTON_API_KEY")}`,
    },
  });
  const saved = await convex.mutation(api.demo.prepareTestContact, {
    token,
    name: values.name,
    phone: values.phone,
    profileUrl: values.profile,
    bio: values.bio,
    code: randomBytes(8).toString("hex"),
  });
  let assignment;
  let pageToken: string | undefined;
  do {
    const page = await photon.projects.platforms.imessage.assignments.list({
      path: { id: projectId },
      query: { pageSize: 100, pageToken },
    });
    assignment = page.assignments.find(
      (a) => a.handle === saved.phone && !a.releasedAt,
    );
    pageToken = page.nextPageToken;
  } while (!assignment && pageToken);
  assignment ??= await photon.projects.platforms.imessage.assignments.create({
    path: { id: projectId },
    headers: { idempotencyKey: `simon-enroll:${saved.registrationId}` },
    body: { handle: saved.phone },
  });
  await convex.mutation(api.onboarding.setLine, {
    token,
    registrationId: saved.registrationId,
    agentHandle: assignment.assignedPhoneNumber,
  });
  console.log(`${values.name} is prepared in the demo. No messages were sent.`);
  console.log(
    `From ${saved.phone}, send an iMessage to ${assignment.assignedPhoneNumber}:`,
  );
  console.log(`Hi Simon, it's ${values.name}. I'm here to test introductions.`);
}

main().catch((error) => {
  console.error(
    error instanceof ApiError
      ? `Photon enrollment failed (HTTP ${error.status}). Check the number, permissions and available seats.`
      : error instanceof Error
        ? error.message
        : "Test contact setup failed.",
  );
  process.exitCode = 1;
});
