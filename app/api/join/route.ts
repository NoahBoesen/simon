import { randomBytes } from "node:crypto";
import { NextRequest } from "next/server";
import { ConvexHttpClient } from "convex/browser";
import { Photon } from "@photon-ai/api";
import { api } from "@/convex/_generated/api";
import { signupUrl } from "../../lib/signupUrl";

export async function GET(request: NextRequest) {
  // Hosted QR codes follow the domain being visited, including preview deployments.
  // APP_PUBLIC_URL is only a local-device testing override.
  return Response.json({
    joinUrl: signupUrl(request.nextUrl.origin, {
      hostedOnVercel: process.env.VERCEL === "1",
      localPublicUrl: process.env.APP_PUBLIC_URL,
    }),
  });
}

export async function POST(request: NextRequest) {
  if (Number(request.headers.get("content-length") || 0) > 8000)
    return Response.json({ error: "Signup is too large." }, { status: 413 });
  const url = process.env.NEXT_PUBLIC_CONVEX_URL;
  const token = process.env.PHOTON_WORKER_SECRET;
  if (!url || !token)
    return Response.json(
      { error: "Signup is not configured yet." },
      { status: 503 },
    );
  let input;
  try {
    input = await request.json();
  } catch {
    return Response.json({ error: "Invalid form." }, { status: 400 });
  }
  if (
    !input ||
    typeof input !== "object" ||
    typeof input.name !== "string" ||
    typeof input.phone !== "string" ||
    typeof input.profileUrl !== "string" ||
    typeof input.simulation !== "boolean" ||
    input.consent !== true
  )
    return Response.json(
      { error: "Fill in your name, phone, profile and contact permission." },
      { status: 400 },
    );
  const convex = new ConvexHttpClient(url);
  try {
    const saved = await convex.mutation(api.onboarding.register, {
      token,
      name: input.name,
      phone: input.phone,
      profileUrl: input.profileUrl,
      simulation: input.simulation,
      consent: true,
      code: randomBytes(8).toString("hex"),
    });
    if (saved.simulation || saved.agentHandle) return Response.json(saved);
    const key = process.env.PHOTON_SETUP_API_KEY || process.env.PHOTON_API_KEY;
    const projectId = process.env.PHOTON_PROJECT_ID;
    if (!key || !projectId)
      return Response.json({
        ...saved,
        activationError: "The host needs to configure iMessage enrollment.",
      });
    try {
      const photon = new Photon({
        headers: { Authorization: `Bearer ${key}` },
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
      assignment ??=
        await photon.projects.platforms.imessage.assignments.create({
          path: { id: projectId },
          headers: { idempotencyKey: `simon-enroll:${saved.registrationId}` },
          body: { handle: saved.phone },
        });
      await convex.mutation(api.onboarding.setLine, {
        token,
        registrationId: saved.registrationId,
        agentHandle: assignment.assignedPhoneNumber,
      });
      return Response.json({
        ...saved,
        agentHandle: assignment.assignedPhoneNumber,
      });
    } catch {
      return Response.json({
        ...saved,
        activationError:
          "Your details are saved. The host needs to enable Photon shared-line enrollment (platforms:read and platforms:write, plus an available seat). Retry signup after that is configured.",
      });
    }
  } catch {
    return Response.json(
      {
        error:
          "Could not register. Check your name, international phone number and public profile URL; mock mode needs a demo event.",
      },
      { status: 400 },
    );
  }
}
