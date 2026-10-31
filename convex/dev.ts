import { internalMutation, mutation } from "./_generated/server";
import { v } from "convex/values";

// Admin-only full reset for reloading a database, including accounts and jobs.
export const clearAllData = internalMutation({
  args: { confirmation: v.literal("CLEAR_ALL_DATA") },
  handler: async (ctx) => {
    let cancelledTasks = 0;
    for (const job of await ctx.db.system.query("_scheduled_functions").collect()) {
      if (job.state.kind === "pending") {
        await ctx.scheduler.cancel(job._id);
        cancelledTasks++;
      }
    }
    const tables = ["pings", "matches", "messages", "attendees", "events",
      "registrations", "introductions", "agentJobs", "photonConversations",
      "photonWorkers", "sessions", "organizers"] as const;
    const deleted: Record<string, number> = {};
    for (const table of tables) {
      const rows = await ctx.db.query(table).collect();
      for (const row of rows) await ctx.db.delete(row._id);
      deleted[table] = rows.length;
    }
    return { cancelledTasks, deleted };
  },
});

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
