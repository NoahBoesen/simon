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
    demo: v.optional(v.boolean()),
    meetingPoint: v.optional(v.string()),
  }),

  attendees: defineTable({
    eventId: v.id("events"),
    name: v.string(),
    phone: v.optional(v.string()),
    email: v.optional(v.string()),
    oneLiner: v.optional(v.string()),
    linkedin: v.optional(v.string()),
    bio: v.optional(v.string()),
    profileUrl: v.optional(v.string()),
    connectionGoals: v.optional(v.string()),
    isDemo: v.optional(v.boolean()),
    registeredAt: v.optional(v.number()),
    researchStatus: v.string(), // "pending" | "running" | "done" | "skipped"
    researchSummary: v.optional(v.string()),
    facts: v.optional(v.array(v.string())),
    sources: v.optional(v.array(v.string())),
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
    simulation: v.optional(v.boolean()),
    sourceMessageId: v.optional(v.id("messages")),
  })
    .index("by_event", ["eventId"])
    .index("by_attendeeA", ["attendeeA"]),

  messages: defineTable({
    eventId: v.optional(v.id("events")),
    attendeeId: v.optional(v.id("attendees")),
    phone: v.string(),
    direction: v.string(), // "inbound" | "outbound"
    body: v.string(),
    projectId: v.optional(v.string()),
    externalId: v.optional(v.string()),
    sourceMessageId: v.optional(v.id("messages")),
    spaceId: v.optional(v.string()),
    senderId: v.optional(v.string()),
    parentMessageId: v.optional(v.string()),
    deliveryStatus: v.optional(v.string()),
    error: v.optional(v.string()),
    workerId: v.optional(v.string()),
    pingId: v.optional(v.id("pings")),
    simulation: v.optional(v.boolean()),
    introductionId: v.optional(v.id("introductions")),
    processedAt: v.optional(v.number()),
  })
    .index("by_event", ["eventId"])
    .index("by_phone", ["phone"])
    .index("by_external_id", ["externalId"])
    .index("by_delivery_status", ["projectId", "deliveryStatus"]),

  photonConversations: defineTable({
    projectId: v.string(),
    phone: v.string(),
    spaceId: v.string(),
    senderId: v.string(),
    agentHandle: v.string(),
    lastExternalId: v.string(),
    lastInboundId: v.optional(v.id("messages")),
    optedOut: v.boolean(),
  }).index("by_phone", ["projectId", "phone"]),

  photonWorkers: defineTable({
    projectId: v.string(),
    workerId: v.string(),
    heartbeatAt: v.number(),
    connectedAt: v.number(),
    agentHandle: v.string(),
    cursor: v.number(),
  }).index("by_project", ["projectId"]),

  agentJobs: defineTable({
    projectId: v.string(),
    phone: v.string(),
    sourceMessageId: v.id("messages"),
    status: v.string(),
    workerId: v.optional(v.string()),
    error: v.optional(v.string()),
  })
    .index("by_status", ["projectId", "status"])
    .index("by_phone", ["projectId", "phone"]),

  pings: defineTable({
    eventId: v.id("events"),
    fromAttendeeId: v.optional(v.id("attendees")),
    toAttendeeId: v.id("attendees"),
    message: v.string(),
    status: v.string(), // "queued" | "sent" | "failed"
  }).index("by_event", ["eventId"]),

  registrations: defineTable({
    eventId: v.id("events"),
    attendeeId: v.id("attendees"),
    phone: v.string(),
    simulation: v.boolean(),
    code: v.string(),
    agentHandle: v.optional(v.string()),
    welcomeMessageId: v.optional(v.id("messages")),
  }).index("by_phone", ["eventId", "phone", "simulation"]),

  introductions: defineTable({
    eventId: v.id("events"),
    fromAttendeeId: v.id("attendees"),
    toAttendeeId: v.id("attendees"),
    reason: v.string(),
    code: v.string(),
    status: v.string(), // pending | accepted | declined | unavailable | cancelled
    simulation: v.boolean(),
    sourceMessageId: v.id("messages"),
    requestMessageId: v.optional(v.id("messages")),
  }).index("by_event", ["eventId"]),
});
