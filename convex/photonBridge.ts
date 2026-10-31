import { v } from "convex/values";
import { mutation, query, internalMutation } from "./_generated/server";
import { sendWelcome } from "./lib/welcome";
import {
  authorize,
  requireWorker,
  workerArgs,
  isOptOut,
} from "./lib/photonAuth";

export const status = query({
  args: {},
  handler: async (ctx) => {
    const projectId = process.env.PHOTON_PROJECT_ID;
    if (!projectId) return null;
    const w = await ctx.db
      .query("photonWorkers")
      .withIndex("by_project", (q) => q.eq("projectId", projectId))
      .unique();
    return w
      ? {
          heartbeatAt: w.heartbeatAt,
          connectedAt: w.connectedAt,
          agentHandle: w.agentHandle,
        }
      : null;
  },
});

export const register = mutation({
  args: {
    ...workerArgs,
    agentHandle: v.string(),
    initialCursor: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    authorize(args.token, args.projectId);
    if (
      args.initialCursor !== undefined &&
      (!Number.isSafeInteger(args.initialCursor) || args.initialCursor < 0)
    )
      throw new Error("Invalid initial cursor.");
    const existing = await ctx.db
      .query("photonWorkers")
      .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
      .unique();
    if (existing && existing.heartbeatAt > Date.now() - 45_000)
      throw new Error("A Photon worker is already running.");
    // Generation can be repeated; an interrupted transport send is ambiguous.
    for (const job of await ctx.db
      .query("agentJobs")
      .withIndex("by_status", (q) =>
        q.eq("projectId", args.projectId).eq("status", "processing"),
      )
      .collect())
      await ctx.db.patch(job._id, { status: "queued", workerId: undefined });
    for (const message of await ctx.db
      .query("messages")
      .withIndex("by_delivery_status", (q) =>
        q.eq("projectId", args.projectId).eq("deliveryStatus", "sending"),
      )
      .collect()) {
      await ctx.db.patch(message._id, {
        deliveryStatus: "failed",
        error: "Send interrupted. Check Photon before retrying.",
      });
      if (message.pingId)
        await ctx.db.patch(message.pingId, { status: "failed" });
      if (message.introductionId) {
        const intro = await ctx.db.get(message.introductionId);
        if (
          intro?.status === "pending" &&
          intro.requestMessageId === message._id
        )
          await ctx.db.patch(intro._id, { status: "unavailable" });
      }
    }
    const record = {
      projectId: args.projectId,
      workerId: args.workerId,
      agentHandle: args.agentHandle,
      heartbeatAt: Date.now(),
      connectedAt: 0,
      cursor: existing?.cursor ?? args.initialCursor ?? 0,
    };
    if (existing) await ctx.db.replace(existing._id, record);
    else await ctx.db.insert("photonWorkers", record);
    return record.cursor;
  },
});

export const heartbeat = mutation({
  args: {
    ...workerArgs,
    connected: v.boolean(),
    stopping: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const worker = await requireWorker(ctx, args);
    await ctx.db.patch(worker._id, {
      heartbeatAt: args.stopping ? 0 : Date.now(),
      connectedAt: args.connected && !args.stopping ? Date.now() : 0,
    });
  },
});

export const checkpoint = mutation({
  args: { ...workerArgs, seq: v.number() },
  handler: async (ctx, args) => {
    const worker = await requireWorker(ctx, args);
    if (!Number.isSafeInteger(args.seq) || args.seq < 0)
      throw new Error("Invalid replay cursor.");
    if (args.seq > worker.cursor)
      await ctx.db.patch(worker._id, { cursor: args.seq });
  },
});

export const receive = mutation({
  args: {
    ...workerArgs,
    phone: v.string(),
    externalId: v.string(),
    text: v.string(),
    spaceId: v.string(),
    senderId: v.string(),
    linePhone: v.string(),
  },
  handler: async (ctx, args) => {
    const worker = await requireWorker(ctx, args);
    if (
      !/^\+[1-9]\d{7,14}$/.test(args.phone) ||
      !args.text.trim() ||
      args.text.length > 16000
    )
      return false;
    if (
      await ctx.db
        .query("messages")
        .withIndex("by_external_id", (q) => q.eq("externalId", args.externalId))
        .first()
    )
      return false;
    const route = await ctx.db
      .query("photonConversations")
      .withIndex("by_phone", (q) =>
        q.eq("projectId", args.projectId).eq("phone", args.phone),
      )
      .unique();
    if (route?.optedOut) return false;
    const event = (await ctx.db.query("events").collect()).find(
      (e) => e.status === "live",
    );
    if (!event)
      throw new Error("Create an active event before accepting iMessages.");
    const registration = await ctx.db
      .query("registrations")
      .withIndex("by_phone", (q) =>
        q
          .eq("eventId", event._id)
          .eq("phone", args.phone)
          .eq("simulation", false),
      )
      .unique();
    if (
      args.linePhone !== worker.agentHandle &&
      args.linePhone !== registration?.agentHandle
    )
      return false;
    let attendee = await ctx.db
      .query("attendees")
      .withIndex("by_phone", (q) => q.eq("phone", args.phone))
      .filter((q) => q.eq(q.field("eventId"), event._id))
      .first();
    if (!attendee) {
      const id = await ctx.db.insert("attendees", {
        eventId: event._id,
        name: `Guest ${args.phone.slice(-4)}`,
        phone: args.phone,
        researchStatus: "pending",
      });
      attendee = (await ctx.db.get(id))!;
    }
    const messageId = await ctx.db.insert("messages", {
      eventId: event._id,
      attendeeId: attendee._id,
      projectId: args.projectId,
      phone: args.phone,
      direction: "inbound",
      body: args.text,
      externalId: args.externalId,
      deliveryStatus: "received",
      simulation: false,
    });
    const optedOut = isOptOut(args.text);
    const routing = {
      projectId: args.projectId,
      phone: args.phone,
      spaceId: args.spaceId,
      senderId: args.senderId,
      agentHandle: args.linePhone,
      lastExternalId: args.externalId,
      lastInboundId: messageId,
      optedOut,
    };
    if (route) await ctx.db.replace(route._id, routing);
    else await ctx.db.insert("photonConversations", routing);
    const jobs = await ctx.db
      .query("agentJobs")
      .withIndex("by_phone", (q) =>
        q.eq("projectId", args.projectId).eq("phone", args.phone),
      )
      .collect();
    if (optedOut) {
      for (const intro of await ctx.db
        .query("introductions")
        .withIndex("by_event", (q) => q.eq("eventId", event._id))
        .collect())
        if (
          !intro.simulation &&
          intro.status === "pending" &&
          (intro.fromAttendeeId === attendee._id ||
            intro.toAttendeeId === attendee._id)
        )
          await ctx.db.patch(intro._id, { status: "cancelled" });
      for (const job of jobs)
        if (job.status === "queued")
          await ctx.db.patch(job._id, { status: "cancelled" });
      for (const message of await ctx.db
        .query("messages")
        .withIndex("by_delivery_status", (q) =>
          q.eq("projectId", args.projectId).eq("deliveryStatus", "queued"),
        )
        .collect()) {
        const source = message.sourceMessageId
          ? await ctx.db.get(message.sourceMessageId)
          : null;
        if (message.phone === args.phone || source?.phone === args.phone) {
          await ctx.db.patch(message._id, {
            deliveryStatus: "cancelled",
            error: "Attendee opted out.",
          });
          if (message.pingId)
            await ctx.db.patch(message.pingId, { status: "cancelled" });
        }
      }
    } else if (registration && !registration.welcomeMessageId) {
      await sendWelcome(ctx, registration);
    } else {
      const queued = jobs.find((j) => j.status === "queued");
      if (queued)
        await ctx.db.patch(queued._id, { sourceMessageId: messageId });
      else
        await ctx.db.insert("agentJobs", {
          projectId: args.projectId,
          phone: args.phone,
          sourceMessageId: messageId,
          status: "queued",
        });
    }
    return true;
  },
});

export const claimGeneration = internalMutation({
  args: workerArgs,
  handler: async (ctx, args) => {
    await requireWorker(ctx, args);
    if (
      await ctx.db
        .query("agentJobs")
        .withIndex("by_status", (q) =>
          q.eq("projectId", args.projectId).eq("status", "processing"),
        )
        .first()
    )
      return null;
    const job = await ctx.db
      .query("agentJobs")
      .withIndex("by_status", (q) =>
        q.eq("projectId", args.projectId).eq("status", "queued"),
      )
      .first();
    if (!job) return null;
    await ctx.db.patch(job._id, {
      status: "processing",
      workerId: args.workerId,
    });
    return job;
  },
});

export const failGeneration = internalMutation({
  args: { ...workerArgs, jobId: v.id("agentJobs") },
  handler: async (ctx, args) => {
    await requireWorker(ctx, args);
    const job = await ctx.db.get(args.jobId);
    if (job?.workerId === args.workerId && job.status === "processing") {
      await ctx.db.patch(job._id, {
        status: "failed",
        error:
          "Agent generation failed. Check Convex logs and Anthropic access.",
      });
      await ctx.db.patch(job.sourceMessageId, {
        error: "Simon could not generate a reply. Please try again.",
      });
    }
  },
});

export const claimSend = mutation({
  args: workerArgs,
  handler: async (ctx, args) => {
    await requireWorker(ctx, args);
    if (
      await ctx.db
        .query("messages")
        .withIndex("by_delivery_status", (q) =>
          q.eq("projectId", args.projectId).eq("deliveryStatus", "sending"),
        )
        .first()
    )
      return null;
    const message = await ctx.db
      .query("messages")
      .withIndex("by_delivery_status", (q) =>
        q.eq("projectId", args.projectId).eq("deliveryStatus", "queued"),
      )
      .first();
    if (!message) return null;
    const introduction = message.introductionId
      ? await ctx.db.get(message.introductionId)
      : null;
    const consentDecided =
      introduction && ["accepted", "declined"].includes(introduction.status);
    const target = await ctx.db
      .query("photonConversations")
      .withIndex("by_phone", (q) =>
        q.eq("projectId", args.projectId).eq("phone", message.phone),
      )
      .unique();
    const source = message.sourceMessageId
      ? await ctx.db.get(message.sourceMessageId)
      : null;
    const sender = source
      ? await ctx.db
          .query("photonConversations")
          .withIndex("by_phone", (q) =>
            q.eq("projectId", args.projectId).eq("phone", source.phone),
          )
          .unique()
      : null;
    if (
      !target ||
      target.optedOut ||
      (source &&
        (sender?.optedOut ||
          (!consentDecided && sender?.lastInboundId !== source._id)))
    ) {
      await ctx.db.patch(message._id, {
        deliveryStatus: "cancelled",
        error: "Attendee opted out or newer input superseded this reply.",
      });
      if (message.pingId)
        await ctx.db.patch(message.pingId, { status: "cancelled" });
      if (
        introduction?.status === "pending" &&
        introduction.requestMessageId === message._id
      )
        await ctx.db.patch(introduction._id, { status: "unavailable" });
      return null;
    }
    await ctx.db.patch(message._id, {
      deliveryStatus: "sending",
      workerId: args.workerId,
    });
    return message;
  },
});

export const finishSend = mutation({
  args: {
    ...workerArgs,
    messageId: v.id("messages"),
    externalId: v.optional(v.string()),
    status: v.string(),
    error: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireWorker(ctx, args);
    const message = await ctx.db.get(args.messageId);
    if (
      !message ||
      message.workerId !== args.workerId ||
      message.deliveryStatus !== "sending"
    )
      throw new Error("Message is no longer owned by this worker.");
    await ctx.db.patch(message._id, {
      externalId: args.externalId,
      deliveryStatus: args.status,
      error: args.error,
    });
    if (message.pingId)
      await ctx.db.patch(message.pingId, { status: args.status });
    if (message.introductionId && args.status === "failed") {
      const intro = await ctx.db.get(message.introductionId);
      if (intro?.status === "pending" && intro.requestMessageId === message._id)
        await ctx.db.patch(intro._id, { status: "unavailable" });
    }
  },
});

export const recordDelivery = mutation({
  args: { ...workerArgs, externalId: v.string(), status: v.string() },
  handler: async (ctx, args) => {
    await requireWorker(ctx, args);
    const message = await ctx.db
      .query("messages")
      .withIndex("by_external_id", (q) => q.eq("externalId", args.externalId))
      .first();
    if (
      !message ||
      message.projectId !== args.projectId ||
      message.direction !== "outbound"
    )
      return;
    if (["delivered", "failed"].includes(message.deliveryStatus ?? "")) return;
    await ctx.db.patch(message._id, {
      deliveryStatus: args.status,
      error:
        args.status === "failed"
          ? "Photon could not deliver this message. Check API Activities."
          : undefined,
    });
    if (message.pingId)
      await ctx.db.patch(message.pingId, { status: args.status });
    if (message.introductionId && args.status === "failed") {
      const intro = await ctx.db.get(message.introductionId);
      if (intro?.status === "pending" && intro.requestMessageId === message._id)
        await ctx.db.patch(intro._id, { status: "unavailable" });
    }
  },
});
