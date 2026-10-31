import { internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";

// Outbound delivery. Until the Photon send endpoint is live, messages are
// logged with direction "outbound" and visible on the dashboard (mock mode).
export const send = internalAction({
  args: {
    eventId: v.optional(v.id("events")),
    attendeeId: v.optional(v.id("attendees")),
    phone: v.string(),
    body: v.string(),
  },
  handler: async (ctx, args) => {
    await ctx.runMutation(internal.messages.log, {
      eventId: args.eventId,
      attendeeId: args.attendeeId,
      phone: args.phone,
      direction: "outbound",
      body: args.body,
    });

    const url = process.env.PHOTON_SEND_URL;
    if (!url) {
      console.log(`[photon mock] -> ${args.phone}: ${args.body}`);
      return { delivered: false, mock: true };
    }
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(process.env.PHOTON_SECRET
          ? { authorization: `Bearer ${process.env.PHOTON_SECRET}` }
          : {}),
      },
      body: JSON.stringify({ phone: args.phone, message: args.body }),
    });
    if (!res.ok) {
      console.error(`[photon] send failed ${res.status}: ${await res.text()}`);
      return { delivered: false, mock: false };
    }
    return { delivered: true, mock: false };
  },
});
