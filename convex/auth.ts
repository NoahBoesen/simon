import {
  action,
  internalMutation,
  internalQuery,
  mutation,
  query,
} from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";

// Iterated SHA-256 via Web Crypto: no node deps, good enough for host accounts.
const ITERATIONS = 10_000;

function toHex(buf: ArrayBuffer | Uint8Array): string {
  return [...new Uint8Array(buf as ArrayBuffer)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function hashPassword(password: string, saltHex: string): Promise<string> {
  let data: ArrayBuffer = new TextEncoder().encode(`${saltHex}:${password}`)
    .buffer as ArrayBuffer;
  for (let i = 0; i < ITERATIONS; i++) {
    data = await crypto.subtle.digest("SHA-256", data);
  }
  return toHex(data);
}

function newToken(): string {
  return toHex(crypto.getRandomValues(new Uint8Array(32)));
}

type AuthResult = { ok: true; token: string } | { ok: false; error: string };

export const signup = action({
  args: { name: v.string(), email: v.string(), password: v.string() },
  handler: async (ctx, { name, email, password }): Promise<AuthResult> => {
    if (!name.trim() || !email.trim() || password.length < 8) {
      return {
        ok: false,
        error: "Name, email, and a password of 8+ characters required.",
      };
    }
    const cleanEmail = email.trim().toLowerCase();
    const existing: Doc<"organizers"> | null = await ctx.runQuery(
      internal.auth.byEmail,
      { email: cleanEmail }
    );
    if (existing) return { ok: false, error: "Account exists. Log in instead." };
    const salt = toHex(crypto.getRandomValues(new Uint8Array(16)));
    const passwordHash = `${salt}:${await hashPassword(password, salt)}`;
    const token: string = await ctx.runMutation(internal.auth.createOrganizer, {
      name: name.trim(),
      email: cleanEmail,
      passwordHash,
      token: newToken(),
    });
    return { ok: true, token };
  },
});

export const login = action({
  args: { email: v.string(), password: v.string() },
  handler: async (ctx, { email, password }): Promise<AuthResult> => {
    const organizer: Doc<"organizers"> | null = await ctx.runQuery(
      internal.auth.byEmail,
      { email: email.trim().toLowerCase() }
    );
    if (!organizer) return { ok: false, error: "No account with that email." };
    const [salt, stored] = organizer.passwordHash.split(":");
    if ((await hashPassword(password, salt)) !== stored) {
      return { ok: false, error: "Wrong password." };
    }
    const token: string = await ctx.runMutation(internal.auth.createSession, {
      organizerId: organizer._id,
      token: newToken(),
    });
    return { ok: true, token };
  },
});

export const me = query({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    if (!token) return null;
    const session = await ctx.db
      .query("sessions")
      .withIndex("by_token", (q) => q.eq("token", token))
      .first();
    if (!session) return null;
    const organizer = await ctx.db.get(session.organizerId);
    if (!organizer) return null;
    return { name: organizer.name, email: organizer.email };
  },
});

export const logout = mutation({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    const session = await ctx.db
      .query("sessions")
      .withIndex("by_token", (q) => q.eq("token", token))
      .first();
    if (session) await ctx.db.delete(session._id);
  },
});

export const byEmail = internalQuery({
  args: { email: v.string() },
  handler: async (ctx, { email }) => {
    return await ctx.db
      .query("organizers")
      .withIndex("by_email", (q) => q.eq("email", email))
      .first();
  },
});

export const createOrganizer = internalMutation({
  args: {
    name: v.string(),
    email: v.string(),
    passwordHash: v.string(),
    token: v.string(),
  },
  handler: async (ctx, { name, email, passwordHash, token }): Promise<string> => {
    const organizerId: Id<"organizers"> = await ctx.db.insert("organizers", {
      name,
      email,
      passwordHash,
    });
    await ctx.db.insert("sessions", { organizerId, token });
    return token;
  },
});

export const createSession = internalMutation({
  args: { organizerId: v.id("organizers"), token: v.string() },
  handler: async (ctx, { organizerId, token }): Promise<string> => {
    await ctx.db.insert("sessions", { organizerId, token });
    return token;
  },
});
