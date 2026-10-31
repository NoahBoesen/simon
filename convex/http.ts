import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { internal } from "./_generated/api";

const http = httpRouter();

// Photon (teammate's iMessage layer) POSTs inbound attendee messages here.
// Accepts {phone, message} with a few alias keys for flexibility.
http.route({
  path: "/photon/inbound",
  method: "POST",
  handler: httpAction(async (ctx, req) => {
    const secret = process.env.PHOTON_SECRET;
    if (secret) {
      const auth = req.headers.get("authorization") ?? "";
      if (auth !== `Bearer ${secret}`) {
        return new Response("unauthorized", { status: 401 });
      }
    }
    let body: Record<string, unknown>;
    try {
      body = await req.json();
    } catch {
      return new Response("invalid json", { status: 400 });
    }
    const phone = (body.phone ?? body.from ?? body.sender) as string | undefined;
    const text = (body.message ?? body.text ?? body.body) as string | undefined;
    if (!phone || !text) {
      return new Response("missing phone/message", { status: 400 });
    }
    await ctx.scheduler.runAfter(0, internal.agent.handleInbound, {
      phone,
      body: text,
    });
    return Response.json({ ok: true });
  }),
});

http.route({
  path: "/health",
  method: "GET",
  handler: httpAction(async () => Response.json({ ok: true, agent: "simon" })),
});

export default http;
