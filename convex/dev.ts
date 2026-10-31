import { mutation } from "./_generated/server";

// Wipe all data before going live: npx convex run dev:reset
export const reset = mutation({
  args: {},
  handler: async (ctx) => {
    const tables = [
      "pings",
      "matches",
      "messages",
      "attendees",
      "events",
      "registrations",
      "introductions",
      "agentJobs",
      "photonConversations",
      "photonWorkers",
    ] as const;
    for (const table of tables) {
      const rows = await ctx.db.query(table).collect();
      for (const row of rows) await ctx.db.delete(row._id);
    }
    return "wiped";
  },
});
