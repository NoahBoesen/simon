import type { Doc } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { queueMessage } from "../photon";

export async function requestIntroduction(
  ctx: MutationCtx,
  source: Doc<"messages">,
  target: Doc<"attendees">,
  reason: string,
) {
  const sender = source.attendeeId ? await ctx.db.get(source.attendeeId) : null;
  if (
    !sender ||
    !source.eventId ||
    target.eventId !== source.eventId ||
    target._id === sender._id
  )
    return "Please choose another attendee from this event.";
  if (!target.phone || (!source.simulation && target.isDemo))
    return `${target.name} ${target.isDemo ? "is a demo profile" : "has no connected phone"}, so I couldn't send an introduction. You can test the introduction in mock chat.`;
  const existing = (
    await ctx.db
      .query("introductions")
      .withIndex("by_event", (q) => q.eq("eventId", source.eventId!))
      .collect()
  ).find(
    (i) =>
      i.simulation === !!source.simulation &&
      ((i.fromAttendeeId === sender._id && i.toAttendeeId === target._id) ||
        (i.fromAttendeeId === target._id && i.toAttendeeId === sender._id)) &&
      ["pending", "accepted", "declined"].includes(i.status),
  );
  if (existing)
    return existing.status === "accepted"
      ? `You and ${target.name} already have an introduction.`
      : existing.status === "pending"
        ? `There's already an introduction request between you and ${target.name}. I'm waiting for a reply.`
        : `${target.name} isn't available for this introduction. Let's find someone else.`;
  const id = await ctx.db.insert("introductions", {
    eventId: source.eventId,
    fromAttendeeId: sender._id,
    toAttendeeId: target._id,
    reason: reason.slice(0, 600),
    code: "",
    status: "pending",
    simulation: !!source.simulation,
    sourceMessageId: source._id,
  });
  const code = id.slice(-8).toUpperCase();
  const sent = await queueMessage(ctx, {
    eventId: source.eventId,
    attendeeId: target._id,
    phone: target.phone,
    body: `Hey ${target.name}! ${sender.name} would like to meet you. ${reason.slice(0, 600)} Would you like an introduction? Reply YES ${code} or NO ${code}.`,
    sourceMessageId: source._id,
    simulation: source.simulation,
    introductionId: id,
  });
  await ctx.db.patch(id, {
    code,
    requestMessageId: sent.messageId,
    status: ["mock", "queued"].includes(sent.status)
      ? "pending"
      : "unavailable",
  });
  return sent.status === "failed"
    ? `${target.name} needs to text Simon before I can request an introduction.`
    : `I'll ask ${target.name} if they'd like to meet. Once they say yes, I'll send you both an introduction and a meeting spot.${source.simulation ? " (Mock introduction; no real texts.)" : ""}`;
}

// Consent is an explicit, deterministic command, never an LLM-inferred approval.
export async function respondToIntroduction(
  ctx: MutationCtx,
  source: Doc<"messages">,
) {
  const answer = source.body.trim().match(/^(YES|NO)\s+([A-Z0-9]{8})[.!]?$/i);
  if (!answer || !source.eventId || !source.attendeeId) return null;
  const intro = (
    await ctx.db
      .query("introductions")
      .withIndex("by_event", (q) => q.eq("eventId", source.eventId!))
      .collect()
  ).find(
    (i) =>
      i.code === answer[2].toUpperCase() &&
      i.toAttendeeId === source.attendeeId &&
      i.simulation === !!source.simulation,
  );
  if (!intro)
    return "I couldn't find that introduction request for you. Use the code from Simon's invitation.";
  if (intro.status !== "pending")
    return "That introduction request has already been handled.";
  const from = await ctx.db.get(intro.fromAttendeeId);
  const to = await ctx.db.get(intro.toAttendeeId);
  const event = await ctx.db.get(intro.eventId);
  if (!from?.phone || !to || !event)
    return "This introduction is no longer available.";
  const approved = answer[1].toUpperCase() === "YES";
  await ctx.db.patch(intro._id, { status: approved ? "accepted" : "declined" });
  const point = event.meetingPoint || "the welcome desk";
  const sent = await queueMessage(ctx, {
    eventId: event._id,
    attendeeId: from._id,
    phone: from.phone,
    introductionId: intro._id,
    sourceMessageId: source._id,
    simulation: source.simulation,
    body: approved
      ? `${to.name} said yes to meeting you! ${intro.reason} Suggested meeting spot: ${point}. I've suggested the same spot to ${to.name}.`
      : `${to.name} isn't available to meet right now. Want me to find someone else?`,
  });
  if (sent.status === "failed") {
    await ctx.db.patch(intro._id, { status: "unavailable" });
    return `Thanks. I couldn't reach ${from.name} through Simon; ask the host to help connect you.`;
  }
  return approved
    ? `You and ${from.name} are both up for meeting! ${intro.reason} Suggested meeting spot: ${point}. I've queued the same details for ${from.name}.`
    : "No problem. I won't make that introduction.";
}
