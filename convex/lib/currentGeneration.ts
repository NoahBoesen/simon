import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { requireWorker } from "./photonAuth";

export async function currentGeneration(ctx: MutationCtx, args: {
  sourceMessageId: Id<"messages">;
  jobId?: Id<"agentJobs">;
  auth?: { token: string; projectId: string; workerId: string };
}) {
  const source = await ctx.db.get(args.sourceMessageId);
  if (!source?.eventId || !source.attendeeId) throw new Error("Missing source message.");
  if (source.processedAt !== undefined) return null;
  const event = await ctx.db.get(source.eventId);
  if (!event || event.status !== "live") return null;
  if (!source.simulation) {
    if (!args.auth || !args.jobId) throw new Error("Live replies require a worker job.");
    await requireWorker(ctx, args.auth);
    const job = await ctx.db.get(args.jobId);
    if (!job || job.status !== "processing" || job.workerId !== args.auth.workerId || job.sourceMessageId !== source._id) return null;
    const route = await ctx.db.query("photonConversations")
      .withIndex("by_phone", (q) => q.eq("projectId", args.auth!.projectId).eq("phone", source.phone)).unique();
    if (route?.optedOut || route?.lastInboundId !== source._id) {
      await ctx.db.patch(job._id, { status: "cancelled" });
      return null;
    }
  }
  return { source: { ...source, eventId: source.eventId, attendeeId: source.attendeeId }, event };
}
