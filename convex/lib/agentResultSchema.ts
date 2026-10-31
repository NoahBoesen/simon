// The provider enforces this shape; commitResult also validates it in Convex.
const text = { type: "string" };
function object(
  properties: Record<string, unknown>,
  required = Object.keys(properties),
) {
  return { type: "object", properties, required, additionalProperties: false };
}

export const agentResultSchema = object({
  reply: text,
  actions: {
    type: "array",
    items: {
      anyOf: [
        object(
          {
            type: { type: "string", const: "save_profile" },
            name: text,
            oneLiner: text,
            connectionGoals: text,
            profileUrl: text,
            bio: text,
          },
          ["type"],
        ),
        object({ type: { type: "string", const: "confirm_identity" } }),
        object({ type: { type: "string", const: "reject_identity" } }),
        object({
          type: { type: "string", const: "recommend" },
          picks: {
            type: "array",
            items: object({ attendeeId: text, reason: text }),
          },
        }),
        object({
          type: { type: "string", const: "request_intro" },
          attendeeId: text,
          reason: text,
        }),
        object({
          type: { type: "string", const: "respond_intro" },
          introductionId: text,
          decision: { type: "string", enum: ["accept", "decline"] },
          message: text,
        }, ["type", "introductionId", "decision"]),
        object({
          type: { type: "string", const: "relay_intro" },
          introductionId: text,
          message: text,
        }),
      ],
    },
  },
});
