import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  organizers: defineTable({
    name: v.string(),
    email: v.string(),
    passwordHash: v.string(),
  }).index("by_email", ["email"]),

  sessions: defineTable({
    organizerId: v.id("organizers"),
    token: v.string(),
  }).index("by_token", ["token"]),

  events: defineTable({
    name: v.string(),
    hostName: v.string(),
    organizerId: v.optional(v.id("organizers")),
    lumaUrl: v.optional(v.string()),
    agenda: v.optional(v.string()),
    agentName: v.optional(v.string()),
    welcomeTemplate: v.optional(v.string()),
    status: v.string(), // "live" | "ended"
  }),

  attendees: defineTable({
    eventId: v.id("events"),
    name: v.string(),
    phone: v.optional(v.string()),
    email: v.optional(v.string()),
    oneLiner: v.optional(v.string()),
    linkedin: v.optional(v.string()),
    bio: v.optional(v.string()),
    researchStatus: v.string(), // "pending" | "running" | "done" | "skipped"
    researchSummary: v.optional(v.string()),
    facts: v.optional(v.array(v.string())),
  })
    .index("by_event", ["eventId"])
    .index("by_phone", ["phone"]),

  matches: defineTable({
    eventId: v.id("events"),
    attendeeA: v.id("attendees"),
    attendeeB: v.id("attendees"),
    score: v.number(),
    reason: v.string(),
    status: v.string(), // "suggested" | "pinged" | "dismissed"
  })
    .index("by_event", ["eventId"])
    .index("by_attendeeA", ["attendeeA"]),

  messages: defineTable({
    eventId: v.optional(v.id("events")),
    attendeeId: v.optional(v.id("attendees")),
    phone: v.string(),
    direction: v.string(), // "inbound" | "outbound"
    body: v.string(),
  })
    .index("by_event", ["eventId"])
    .index("by_phone", ["phone"]),

  pings: defineTable({
    eventId: v.id("events"),
    fromAttendeeId: v.optional(v.id("attendees")),
    toAttendeeId: v.id("attendees"),
    message: v.string(),
    status: v.string(), // "queued" | "sent" | "failed"
  }).index("by_event", ["eventId"]),
});
