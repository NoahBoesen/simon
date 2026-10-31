/// <reference types="vite/client" />
import { afterEach, expect, test, vi } from "vitest";
import { convexTest } from "convex-test";
import schema from "../convex/schema";
import { api } from "../convex/_generated/api";
const modules = import.meta.glob("../convex/**/*.{ts,js}");
afterEach(() => vi.unstubAllEnvs());
test("event reset preserves the running worker and replay checkpoint", async () => {
  vi.stubEnv("PHOTON_WORKER_SECRET", "secret");
  vi.stubEnv("PHOTON_PROJECT_ID", "project");
  const t = convexTest(schema, modules);
  const auth = { token: "secret", projectId: "project", workerId: "worker" };
  await t.mutation(api.photonBridge.register, { ...auth, agentHandle: "+12025550199", initialCursor: 123 });
  await t.run(ctx => ctx.db.insert("events", { name: "Test", hostName: "Host", status: "live" }));
  await t.mutation(api.dev.reset, {});
  await t.mutation(api.photonBridge.heartbeat, { ...auth, connected: true });
  expect(await t.run(ctx => ctx.db.query("events").collect())).toEqual([]);
  const workers = await t.run(ctx => ctx.db.query("photonWorkers").collect());
  expect(workers).toHaveLength(1);
  expect(workers[0].cursor).toBe(123);
});
