import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { authorize } from "./lib/photonAuth";
import { normalizePhone } from "./attendees";
import { DEFAULT_WELCOME, sendWelcome } from "./lib/welcome";

export function normalizeProfile(raw: string) {
  if (!raw.trim()) throw new Error("Add a LinkedIn, X, or other profile URL.");
  let url: URL;
  try {
    url = new URL(raw.includes("://") ? raw : `https://${raw}`);
  } catch {
    throw new Error("Enter a valid profile URL.");
  }
  if (
    !["https:", "http:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    raw.length > 1000
  )
    throw new Error("Enter a public profile URL.");
  url.hash = "";
  return url.toString();
}

export const info = query({
  args: {},
  handler: async (ctx) => {
    const event = (await ctx.db.query("events").collect()).find(
      (e) => e.status === "live",
    );
    return event
      ? {
          eventId: event._id,
          name: event.name,
          demo: !!event.demo,
          welcomeTemplate: event.welcomeTemplate || DEFAULT_WELCOME,
          meetingPoint: event.meetingPoint || "the welcome desk",
        }
      : null;
  },
});

// Called through the server-side signup route. No provider secret reaches the browser.
export const register = mutation({
  args: {
    token: v.string(),
    name: v.string(),
    phone: v.string(),
    profileUrl: v.string(),
    simulation: v.boolean(),
    consent: v.boolean(),
    code: v.string(),
  },
  handler: async (ctx, args) => {
    authorize(args.token);
    const phone = normalizePhone(args.phone);
    if (!/^\+[1-9]\d{7,14}$/.test(phone))
      throw new Error("Use a phone number with country code.");
    if (!args.consent)
      throw new Error("Confirm that Simon can contact you for this event.");
    if (!args.name.trim() || args.name.length > 120)
      throw new Error("Enter your name.");
    const profileUrl = normalizeProfile(args.profileUrl);
    const event = (await ctx.db.query("events").collect()).find(
      (e) => e.status === "live",
    );
    if (!event) throw new Error("No active event.");
    if (args.simulation && !event.demo)
      throw new Error("Mock registration is only enabled for demo events.");
    const previous = await ctx.db
      .query("registrations")
      .withIndex("by_phone", (q) =>
        q
          .eq("eventId", event._id)
          .eq("phone", phone)
          .eq("simulation", args.simulation),
      )
      .unique();
    if (previous)
      return {
        registrationId: previous._id,
        phone,
        simulation: args.simulation,
        code: previous.code,
        agentHandle: previous.agentHandle,
        welcomeQueued: !!previous.welcomeMessageId,
      };
    let attendee = await ctx.db
      .query("attendees")
      .withIndex("by_phone", (q) => q.eq("phone", phone))
      .filter((q) => q.eq(q.field("eventId"), event._id))
      .first();
    // Imported profiles may already contain all the research; keep it when linking the phone.
    if (!attendee)
      attendee =
        (
          await ctx.db
            .query("attendees")
            .withIndex("by_event", (q) => q.eq("eventId", event._id))
            .collect()
        ).find(
          (a) =>
            !a.phone &&
            (a.profileUrl === profileUrl ||
              a.linkedin?.replace(/\/$/, "") === profileUrl.replace(/\/$/, "")),
        ) ?? null;
    if (attendee?.isDemo && !args.simulation)
      throw new Error("Use mock mode for fictional demo profiles.");
    const profile = {
      phone,
      profileUrl,
      registeredAt: Date.now(),
      ...(new URL(profileUrl).hostname.replace(/^www\./, "") === "linkedin.com"
        ? { linkedin: profileUrl }
        : {}),
    };
    const attendeeId =
      attendee?._id ??
      (await ctx.db.insert("attendees", {
        eventId: event._id,
        name: args.name.trim(),
        ...profile,
        researchStatus: event.demo ? "skipped" : "pending",
      }));
    if (attendee) await ctx.db.patch(attendee._id, profile);
    const projectId = process.env.PHOTON_PROJECT_ID;
    const route = projectId
      ? await ctx.db
          .query("photonConversations")
          .withIndex("by_phone", (q) =>
            q.eq("projectId", projectId).eq("phone", phone),
          )
          .unique()
      : null;
    if (!args.simulation && route?.optedOut)
      throw new Error(
        "This number opted out. Contact the host to re-enable it.",
      );
    const registrationId = await ctx.db.insert("registrations", {
      eventId: event._id,
      attendeeId,
      phone,
      simulation: args.simulation,
      code: args.code,
      agentHandle: args.simulation ? undefined : route?.agentHandle,
    });
    // Real onboarding starts in response to the attendee, so its welcome and
    // identity question are delivered as one text even for existing routes.
    if (args.simulation)
      await sendWelcome(ctx, (await ctx.db.get(registrationId))!);
    return {
      registrationId,
      phone,
      simulation: args.simulation,
      code: args.code,
      agentHandle: route?.agentHandle,
      welcomeQueued: args.simulation,
    };
  },
});

export const setLine = mutation({
  args: {
    token: v.string(),
    registrationId: v.id("registrations"),
    agentHandle: v.string(),
  },
  handler: async (ctx, args) => {
    authorize(args.token);
    if (!/^\+[1-9]\d{7,14}$/.test(args.agentHandle))
      throw new Error("Invalid assigned line.");
    await ctx.db.patch(args.registrationId, { agentHandle: args.agentHandle });
  },
});
