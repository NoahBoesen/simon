import type { Doc } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { queueMessage } from "../photon";

export const DEFAULT_WELCOME =
  "Hey {first_name}! I'm {agent_name}, your AI host for {event}. I help you find people to meet and coordinate introductions.";

export function welcomeText(event: Doc<"events">, name: string) {
  return (event.welcomeTemplate || DEFAULT_WELCOME)
    .replaceAll("{name}", name)
    .replaceAll("{first_name}", name.trim().split(/\s+/)[0] || name)
    .replaceAll("{event}", event.name)
    .replaceAll("{agent_name}", event.agentName?.trim() || "Simon");
}

export async function sendWelcome(
  ctx: MutationCtx,
  registration: Doc<"registrations">,
) {
  if (registration.welcomeMessageId) return registration.welcomeMessageId;
  const attendee = await ctx.db.get(registration.attendeeId);
  const event = await ctx.db.get(registration.eventId);
  if (!attendee || !event || event.status !== "live") return;
  const sent = await queueMessage(ctx, {
    eventId: event._id,
    attendeeId: attendee._id,
    phone: registration.phone,
    body: welcomeText(event, attendee.name),
    simulation: registration.simulation,
  });
  if (sent.status === "queued" || sent.status === "mock")
    await ctx.db.patch(registration._id, { welcomeMessageId: sent.messageId });
  return sent.messageId;
}
