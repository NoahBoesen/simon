import { v } from "convex/values";
import type { MutationCtx, QueryCtx } from "../_generated/server";

export const workerArgs = {
  token: v.string(),
  workerId: v.string(),
  projectId: v.string(),
};
export type WorkerAuth = { token: string; workerId: string; projectId: string };
export function authorize(token: string, projectId?: string) {
  if (
    !process.env.PHOTON_WORKER_SECRET ||
    token !== process.env.PHOTON_WORKER_SECRET
  )
    throw new Error("Unauthorized Photon worker.");
  if (projectId && projectId !== process.env.PHOTON_PROJECT_ID)
    throw new Error("Wrong Photon project.");
}
export async function requireWorker(
  ctx: MutationCtx | QueryCtx,
  auth: WorkerAuth,
) {
  authorize(auth.token, auth.projectId);
  const worker = await ctx.db
    .query("photonWorkers")
    .withIndex("by_project", (q) => q.eq("projectId", auth.projectId))
    .unique();
  if (
    !worker ||
    worker.workerId !== auth.workerId ||
    worker.heartbeatAt < Date.now() - 45_000
  )
    throw new Error("Photon worker lease expired.");
  return worker;
}
export function isOptOut(text: string) {
  return /^(stop|unsubscribe|cancel|end|quit|stop messaging me|stop texting me|please stop)[.!\s]*$/i.test(
    text.trim(),
  );
}
