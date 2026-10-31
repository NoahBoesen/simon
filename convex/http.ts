import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";

const http = httpRouter();
// Photon 2.0 enters through authenticated worker mutations, with IDs and replay cursors.
http.route({
  path: "/photon/inbound",
  method: "POST",
  handler: httpAction(
    async () =>
      new Response("Use the authenticated Photon 2.0 worker.", { status: 410 }),
  ),
});
http.route({
  path: "/health",
  method: "GET",
  handler: httpAction(async () => Response.json({ ok: true, agent: "simon" })),
});
export default http;
