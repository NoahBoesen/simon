import type { Doc } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { normalizeProfile } from "../onboarding";

export function identityKey(simulation?: boolean) {
  return simulation ? "simulatedIdentity" : "liveIdentity";
}

export function hasName(person: Doc<"attendees">) {
  return !!person.name.trim() && !/^(?:Demo )?Guest \d+$/i.test(person.name);
}

export function sameIdentity(a: Doc<"attendees">, b: Doc<"attendees">) {
  const urls = (p: Doc<"attendees">) => [p.linkedin, p.profileUrl]
    .filter((url): url is string => !!url)
    .map((url) => url.toLowerCase().replace(/^https?:\/\/(?:www\.)?/, "").replace(/\/$/, ""));
  return a._id === b._id || urls(a).some((url) => urls(b).includes(url));
}

export function identitySummary(person: Doc<"attendees">) {
  if (!hasName(person)) return "";
  const context = [...new Set([
    person.bio?.trim(), person.researchSummary?.trim(),
    ...(person.facts || []),
  ].filter(Boolean))].join(" ").slice(0, 800);
  if (!context) return "";
  const profile = person.profileUrl || person.linkedin;
  return `${person.name}: ${context}${profile ? `\nProfile: ${profile}` : ""}`;
}

export function identityQuestion(person: Doc<"attendees">) {
  if (!hasName(person)) return "What's your full name? I'll look up your profile before helping with introductions.";
  const summary = identitySummary(person);
  return summary
    ? `Here's the context I have for you:\n${summary}\n\nIs this you, and is that context accurate? I'll use the confirmed context for introductions.`
    : `I have your name as ${person.name}, but I don't have enough reliable background yet. Could you share ${person.profileUrl || person.linkedin ? "a sentence about what you do" : "your LinkedIn or a sentence about what you do"}?`;
}

export async function saveIdentityProfile(ctx: MutationCtx, person: Doc<"attendees">, update: {
  name?: string; profileUrl?: string; bio?: string;
}) {
  const name = update.name?.trim().slice(0, 120) || person.name;
  let profileUrl: string | undefined;
  if (update.profileUrl?.trim()) {
    try { profileUrl = normalizeProfile(update.profileUrl.trim()); } catch { /* Ask again; never save an unsafe URL. */ }
  }
  const nameChanged = name.toLowerCase() !== person.name.toLowerCase();
  const profileChanged = !!profileUrl && profileUrl.replace(/\/$/, "") !== (person.profileUrl || person.linkedin || "").replace(/\/$/, "");
  const bio = update.bio?.trim().slice(0, 1000);
  if (!nameChanged && !profileChanged && (!bio || bio === person.bio)) return person;
  const patch: Partial<Doc<"attendees">> = {
    name, liveIdentity: undefined, simulatedIdentity: undefined,
  };
  if (nameChanged || profileChanged) {
    Object.assign(patch, {
      profileUrl: undefined, linkedin: undefined, bio: undefined,
      researchSummary: undefined, facts: undefined, sources: undefined,
      researchStatus: "pending",
    });
    // Reuse a unique cached profile from this event, without linking someone
    // else's phone or copying private goals/conversations. Always confirm it.
    const roster = await ctx.db.query("attendees")
      .withIndex("by_event", (q) => q.eq("eventId", person.eventId)).collect();
    const matches = roster.filter((p) => p._id !== person._id && !p.isDemo &&
      (profileUrl
        ? [p.profileUrl, p.linkedin].some((url) => url?.replace(/\/$/, "") === profileUrl!.replace(/\/$/, ""))
        : p.name.trim().toLowerCase() === name.toLowerCase()));
    if (matches.length === 1) {
      const cached = matches[0];
      Object.assign(patch, {
        profileUrl: cached.profileUrl, linkedin: cached.linkedin,
        bio: cached.bio, researchSummary: cached.researchSummary,
        facts: cached.facts, sources: cached.sources,
        researchStatus: cached.researchSummary || cached.facts?.length ? "done" : "pending",
      });
    } else if (profileChanged && !nameChanged) {
      // A more precise profile link does not invalidate self-described context.
      patch.bio = person.bio;
    }
    if (profileUrl) {
      patch.profileUrl = profileUrl;
      if (new URL(profileUrl).hostname.replace(/^www\./, "") === "linkedin.com") patch.linkedin = profileUrl;
    }
  }
  if (bio) {
    patch.bio = bio;
    // Corrections take precedence over a prior web summary.
    patch.researchSummary = undefined;
    patch.facts = undefined;
    patch.researchStatus = "done";
  }
  await ctx.db.patch(person._id, patch);
  return (await ctx.db.get(person._id))!;
}

// A bare yes must answer the profile summary we actually sent, not an old
// summary, another question, or an invitation. Confirmation is per chat mode.
export async function canConfirmIdentity(ctx: MutationCtx, source: Doc<"messages">, person: Doc<"attendees">) {
  const identity = person[identityKey(source.simulation)];
  if (!identity?.summary || identity.confirmedAt !== undefined) return false;
  const last = await ctx.db.query("messages")
    .withIndex("by_phone", (q) => q.eq("phone", source.phone))
    .filter((q) => q.and(
      q.eq(q.field("eventId"), source.eventId),
      q.eq(q.field("direction"), "outbound"),
      q.lte(q.field("_creationTime"), source._creationTime),
      source.simulation ? q.eq(q.field("simulation"), true) : q.neq(q.field("simulation"), true),
      q.neq(q.field("deliveryStatus"), "failed"),
      q.neq(q.field("deliveryStatus"), "cancelled"),
    )).order("desc").first();
  return last?._id === identity.confirmationMessageId &&
    !["queued", "sending"].includes(last.deliveryStatus || "");
}
