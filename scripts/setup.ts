import { spawnSync } from "node:child_process";
import { ConvexHttpClient } from "convex/browser";
import { api } from "../convex/_generated/api";

function required(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`Set ${name} in .env.local.`);
  return value;
}
function setRemote(name: string, value: string) {
  const result = spawnSync("npx", ["convex", "env", "set", name], {
    input: value,
    encoding: "utf8",
  });
  if (result.status !== 0)
    throw new Error(
      `Could not configure ${name} in Convex. Check deployment access.`,
    );
}
async function main() {
  const url = required("NEXT_PUBLIC_CONVEX_URL");
  const token = required("PHOTON_WORKER_SECRET");
  const names = spawnSync("npx", ["convex", "env", "list", "--names-only"], {
    encoding: "utf8",
  });
  if (names.status !== 0)
    throw new Error("Cannot access this Convex deployment.");
  setRemote("PHOTON_WORKER_SECRET", token);
  setRemote("PHOTON_PROJECT_ID", required("PHOTON_PROJECT_ID"));
  for (const name of [
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_MODEL",
    "FIRECRAWL_API_KEY",
  ]) {
    if (process.env[name] && !names.stdout.includes(name))
      setRemote(name, process.env[name]!);
  }
  if (
    !names.stdout.includes("ANTHROPIC_API_KEY") &&
    !process.env.ANTHROPIC_API_KEY
  )
    throw new Error(
      "Add ANTHROPIC_API_KEY locally or in the Convex deployment.",
    );
  const local = ["127.0.0.1", "localhost"].includes(new URL(url).hostname);
  if (local) {
    setRemote("ALLOW_DEMO_SEED", "1");
    const client = new ConvexHttpClient(url);
    const seeded = await client.mutation(api.demo.seed, {
      token,
      phone: process.env.DEMO_ATTENDEE_PHONE,
    });
    console.log(
      seeded.created
        ? "Created demo event and sample attendee profiles."
        : "Existing local event and conversations preserved.",
    );
  }
  console.log(
    "Photon worker authentication and Convex model configuration are ready.",
  );
}
main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
