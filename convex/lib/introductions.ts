import type { Doc } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { queueMessage } from "../photon";

function linkedinLine(person: Doc<"attendees">) {
  return person.linkedin
    ? `\nLinkedIn${person.isDemo ? " (demo placeholder)" : ""}: ${person.linkedin}`
    : "";
}

export async function introductionContext(ctx: QueryCtx, source: Doc<"messages">) {
  if (!source.eventId || !source.attendeeId) return [];
  const introductions = await ctx.db.query("introductions")
    .withIndex("by_event", (q) => q.eq("eventId", source.eventId!)).collect();
  return await Promise.all(introductions.filter((intro) =>
    intro.simulation === !!source.simulation &&
    (intro.fromAttendeeId === source.attendeeId || intro.toAttendeeId === source.attendeeId),
  ).map(async (intro) => {
    const otherId = intro.fromAttendeeId === source.attendeeId
      ? intro.toAttendeeId : intro.fromAttendeeId;
    const other = await ctx.db.get(otherId);
    // Only messages already intentionally shared through this introduction,
    // never the other attendee's private conversation or research.
    const shared = await ctx.db.query("messages")
      .withIndex("by_event", (q) => q.eq("eventId", source.eventId!))
      .filter((q) => q.and(
        q.eq(q.field("introductionId"), intro._id),
        q.eq(q.field("direction"), "outbound"),
        q.lte(q.field("_creationTime"), source._creationTime),
      )).order("desc").take(6);
    return {
      introductionId: intro._id,
      otherAttendeeId: otherId,
      otherName: other?.name,
      status: intro.status,
      canRespond: intro.status === "pending" && intro.toAttendeeId === source.attendeeId,
      sharedMeetingUpdates: shared.reverse().map((m) => ({
        to: m.attendeeId === source.attendeeId ? "you" : other?.name,
        text: m.body,
        deliveryStatus: m.deliveryStatus,
      })),
    };
  }));
}

async function ownedIntroduction(
  ctx: MutationCtx, source: Doc<"messages">, introductionId: string,
) {
  const id = ctx.db.normalizeId("introductions", introductionId);
  const intro = id ? await ctx.db.get(id) : null;
  return intro && intro.eventId === source.eventId &&
    intro.simulation === !!source.simulation &&
    (intro.fromAttendeeId === source.attendeeId || intro.toAttendeeId === source.attendeeId)
    ? intro : null;
}

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
  const introductions = await ctx.db
    .query("introductions")
    .withIndex("by_event", (q) => q.eq("eventId", source.eventId!))
    .collect();
  const existing = introductions.find(
    (i) =>
      i.simulation === !!source.simulation &&
      ((i.fromAttendeeId === sender._id && i.toAttendeeId === target._id) ||
        (i.fromAttendeeId === target._id && i.toAttendeeId === sender._id)) &&
      ["pending", "accepted", "declined"].includes(i.status),
  );
  if (existing?.status === "pending" && existing.toAttendeeId === sender._id)
    return await answerIntroduction(ctx, source, existing._id, "accept");
  if (existing)
    return existing.status === "accepted"
      ? `You and ${target.name} already have an introduction. Tell me where you'd like to meet and I can pass that along.`
      : existing.status === "pending"
        ? `There's already an introduction request between you and ${target.name}. I'm waiting for a reply.`
        : `${target.name} isn't available for this introduction. Let's find someone else.`;
  // Codes are unique within the event, including older failed requests.
  // Convex replays Math.random deterministically when retrying mutations.
  const usedCodes = new Set(introductions.map((intro) => intro.code));
  let code: string;
  do {
    code = Math.floor(Math.random() * 0x100000000)
      .toString(16)
      .padStart(8, "0")
      .toUpperCase();
  } while (usedCodes.has(code));
  const id = await ctx.db.insert("introductions", {
    eventId: source.eventId,
    fromAttendeeId: sender._id,
    toAttendeeId: target._id,
    reason: reason.slice(0, 600),
    code,
    status: "pending",
    simulation: !!source.simulation,
    sourceMessageId: source._id,
  });
  const sent = await queueMessage(ctx, {
    eventId: source.eventId,
    attendeeId: target._id,
    phone: target.phone,
    body: `Hey ${target.name}! ${sender.name} would like to meet you. ${reason.slice(0, 600)}${linkedinLine(sender)}\nWould you like an introduction? You can say yes or tell me where you'd like to meet. If you have several invitations, reply YES ${code} or NO ${code}.`,
    sourceMessageId: source._id,
    simulation: source.simulation,
    introductionId: id,
  });
  await ctx.db.patch(id, {
    requestMessageId: sent.messageId,
    status: ["mock", "queued"].includes(sent.status)
      ? "pending"
      : "unavailable",
  });
  return sent.status === "failed"
    ? `${target.name} needs to text Simon before I can request an introduction.`
    : `I'll ask ${target.name} if they'd like to meet. Once they say yes, I'll send you both an introduction and a meeting spot.${source.simulation ? " (Mock introduction; no real texts.)" : ""}`;
}

// Codes remain deterministic. A plain yes/no only resolves a single invitation
// when the last message to this attendee was that invitation, not another question.
export async function respondToIntroduction(
  ctx: MutationCtx,
  source: Doc<"messages">,
) {
  const answer = source.body.trim().match(/^(YES|NO)\s+([A-Z0-9]{8})[.!]?$/i);
  const plain = source.body.trim().match(/^(yes|yeah|yep|sure|ok|okay|no|no thanks|not now)[.!\s]*$/i);
  if ((!answer && !plain) || !source.eventId || !source.attendeeId) return null;
  const invitations = (
    await ctx.db
      .query("introductions")
      .withIndex("by_event", (q) => q.eq("eventId", source.eventId!))
      .collect()
  ).filter(
    (i) =>
      i.toAttendeeId === source.attendeeId &&
      i.simulation === !!source.simulation,
  );
  let intro;
  if (answer) intro = invitations.find((i) => i.code === answer[2].toUpperCase());
  else {
    const pending = invitations.filter((i) => i.status === "pending");
    const lastOutbound = await ctx.db.query("messages")
      .withIndex("by_phone", (q) => q.eq("phone", source.phone))
      .filter((q) => q.and(
        q.eq(q.field("eventId"), source.eventId),
        q.eq(q.field("direction"), "outbound"),
        q.lte(q.field("_creationTime"), source._creationTime),
      )).order("desc").collect();
    const last = lastOutbound.find((m) => !!m.simulation === !!source.simulation);
    if (!last?.introductionId || !pending.some((i) => i._id === last.introductionId))
      return null;
    if (pending.length > 1)
      return "Which introduction do you mean? Tell me the person's name or use YES / NO with the invitation code.";
    intro = pending[0];
  }
  if (!intro)
    return "I couldn't find that introduction request for you. Use the code from Simon's invitation.";
  const approved = answer ? answer[1].toUpperCase() === "YES"
    : !/^(no|not)/i.test(plain![1]);
  return await answerIntroduction(ctx, source, intro._id, approved ? "accept" : "decline");
}

export async function answerIntroduction(
  ctx: MutationCtx,
  source: Doc<"messages">,
  introductionId: string,
  decision: "accept" | "decline",
  meetingMessage?: string,
) {
  const intro = await ownedIntroduction(ctx, source, introductionId);
  if (!intro || intro.toAttendeeId !== source.attendeeId)
    return "I couldn't find an invitation for you to answer. Tell me who you want to meet.";
  if (intro.status !== "pending")
    return "That introduction request has already been handled.";
  const from = await ctx.db.get(intro.fromAttendeeId);
  const to = await ctx.db.get(intro.toAttendeeId);
  const event = await ctx.db.get(intro.eventId);
  if (!from?.phone || !to || !event || event.status !== "live" ||
    from.eventId !== event._id || to.eventId !== event._id)
    return "This introduction is no longer available.";
  const approved = decision === "accept";
  const note = meetingMessage?.trim().slice(0, 600);
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
      ? `${to.name} said yes to meeting you! ${intro.reason}${linkedinLine(to)}\n${note ? `${to.name} asks: ${note}` : `Suggested meeting spot: ${point}. I've suggested the same spot to ${to.name}.`}\nReply here if you'd like me to pass along a meeting update.`
      : `${to.name} isn't available to meet right now. Want me to find someone else?`,
  });
  if (sent.status === "failed") {
    await ctx.db.patch(intro._id, { status: "unavailable" });
    return `Thanks. I couldn't reach ${from.name} through Simon; ask the host to help connect you.`;
  }
  return approved
    ? `You and ${from.name} are both up for meeting! ${intro.reason}${linkedinLine(from)}\n${note ? `I've queued your message to ${from.name}: ${note}` : `Suggested meeting spot: ${point}. I've queued the same details for ${from.name}.`}\nYou can keep coordinating through me.`
    : "No problem. I won't make that introduction.";
}

export async function relayMeetingMessage(
  ctx: MutationCtx,
  source: Doc<"messages">,
  introductionId: string,
  message: string,
) {
  const intro = await ownedIntroduction(ctx, source, introductionId);
  const note = message.trim().slice(0, 600);
  if (!intro || !note)
    return "Which introduction should I pass that meeting update to?";
  if (intro.status === "pending" && intro.toAttendeeId === source.attendeeId)
    return await answerIntroduction(ctx, source, intro._id, "accept", note);
  if (!["pending", "accepted"].includes(intro.status))
    return "That introduction is no longer open, so I haven't passed along a message.";
  const from = await ctx.db.get(source.attendeeId!);
  const otherId = intro.fromAttendeeId === source.attendeeId
    ? intro.toAttendeeId : intro.fromAttendeeId;
  const other = await ctx.db.get(otherId);
  const event = await ctx.db.get(intro.eventId);
  if (!from || !other?.phone || !event || event.status !== "live" ||
    from.eventId !== event._id || other.eventId !== event._id)
    return "I can't reach the other attendee for this introduction.";
  const sent = await queueMessage(ctx, {
    eventId: intro.eventId,
    attendeeId: other._id,
    phone: other.phone,
    body: `${from.name} asks: ${note}\n${intro.status === "pending"
      ? `Would you like to meet? Reply YES ${intro.code} or NO ${intro.code}.`
      : "Reply here and I can pass a meeting update back."}`,
    sourceMessageId: source._id,
    simulation: source.simulation,
    introductionId: intro._id,
  });
  return sent.status === "failed"
    ? `I couldn't reach ${other.name}, so I haven't passed along your update.`
    : `I've queued your message to ${other.name}: ${note}`;
}
