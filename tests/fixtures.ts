import type { MutationCtx } from "../convex/_generated/server";
import type { Id } from "../convex/_generated/dataModel";

// Transport and meeting tests begin after onboarding. Identity onboarding has
// separate end-to-end coverage in identity-onboarding.test.ts.
export async function confirmedGuest(ctx: MutationCtx, id: Id<"attendees">, simulation = true) {
  const person = (await ctx.db.get(id))!;
  const summary = `${person.name}: Builds event tools.`;
  const confirmationMessageId = await ctx.db.insert("messages", {
    eventId: person.eventId, attendeeId: id, phone: person.phone!,
    direction: "outbound", body: summary, simulation,
    deliveryStatus: simulation ? "mock" : "delivered",
  });
  await ctx.db.patch(id, {
    [simulation ? "simulatedIdentity" : "liveIdentity"]: { summary, confirmationMessageId, confirmedAt: Date.now() },
    connectionGoals: "Event-tool builders",
  });
}
