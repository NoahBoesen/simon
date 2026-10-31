# Simon — Attendee Agent, Complete Feature Spec (iMessage side)

## What Simon is

- An event concierge you text. Knows everyone in the room, suggests who to meet, makes intros. No app, no login — iMessage only.
- One phone number serves all events; the event slug routes you.

## 1. Onboarding

- One inbound message gets one reply. Include the welcome in the first onboarding reply, then wait for the attendee.
- Ask an unknown sender for their full name. Reuse names and profile links already supplied at signup.
- Look up their LinkedIn/public professional context and reuse a unique matching imported profile. Never merge phone identities just because names match.
- Show a concise summary and ask whether it is them and the context is accurate. A rejected or ambiguous match asks for a profile link or self-description. Corrections need fresh confirmation.
- Save the confirmed context for later introductions. Only then ask who they want to meet. Identity and connection goals remain separate.

## 2. Suggestions

- Wait for the attendee to state a connection goal or name a person before suggesting anyone.
- Recommend up to three relevant roster entries in the reply to that request. A greeting or saved bio alone does not trigger recommendations.
- Save early goals but do not act on them until identity is confirmed.

## 3. Background intelligence

- Research attendees with Firecrawl and Claude, using conservative public facts and supported profile links. Same-name ambiguity requires clarification.
- Attendees can see and correct their own profile context. Other people's full research remains private.
- Real attendees can be researched even in a demo event; fictional demo profiles and simulated conversations never trigger web research.

## 4. On-demand matchmaking

- "who should I meet?" → 1-2 concrete suggestions with the *why* ("she's hiring founding engineers — you said you're looking").
- "anyone here from fintech?" → filtered answer from the roster.
- "actually I want a designer now" → intent updates, matches re-rank.

## 5. Pings (intros) — the core action

- "ping Sarah" / "intro me to Alex" → agent resolves the target by name on the event's guest list.
- **Only works if the target's phone number is on the list.** Missing number → agent tells the requester it can't reach them.
- Target receives an intro text written *to them*: who wants to meet, why it's a fit, where the requester is standing (agent asks the requester for their location if unknown).
- Target can reply accept/decline; agent closes the loop back to the requester.
- **No direct chat between attendees** — the agent relays. Attendees never message each other through Simon.

## 6. Privacy rules (hard boundaries)

- All attendee knowledge stays central with the agent. Attendees can confirm their own context, but never see the roster, other people's full research, scores, or private conversations.
- An intro shares only a short confirmed professional summary, name, and why it fits. Never share unconfirmed research or quotes from private chats.
- The host dashboard (web) is the only surface with full visibility.

## 7. Event logistics

- Each event record (from the event-creation layer) has an **event context field** — the host fills it with everything: schedule, venue details, wifi, judging criteria, demo order, sponsors, whatever they want Simon to know.
- The Luma scrape is just one *input* that can pre-fill it; the event context field is the source of truth.
- Agent answers logistics questions from that field, scoped to the attendee's event (slug-routed).
- Off-topic messages → brief answer, steered back to the event.
- Agent sees the last ~12 messages of that person's thread, so follow-ups work ("tell me more about the second one").

## Plumbing

- **Inbound:** forward every message → `POST https://beloved-echidna-158.convex.site/photon/inbound` with `{ "phone": "+1...", "message": "..." }`
- **Outbound:** backend calls your send endpoint with `{ "phone": "+1...", "message": "..." }` — must support **agent-initiated** sends (hints and pings arrive with no inbound trigger).
- Shared secret both directions (`Authorization: Bearer <secret>`). E.164 numbers. `GET /health` to check backend is up.
- Until your send URL is set, backend runs in mock mode — outbound shows in the dashboard "Live texts" panel, both sides build independently.
- **What we need from you:** send-endpoint URL + shared secret, and confirm agent-initiated sends work.

## Message flow summary

| Attendee texts | Simon does |
|---|---|
| first message | asks for their name or confirms a known profile in one welcome reply |
| supplies name/profile | looks up context, summarizes it, and asks for confirmation |
| confirms their profile | asks who they want to meet |
| states connection goals | saves intent and recommends relevant people |
| "who should I meet?" | 1-2 suggestions with concrete reasons |
| "ping Maya" / "intro me to Alex" | texts the target an intro (only if their number is on the list) |
| "when's pizza" / logistics | answers from the event context field |
| anything else | brief answer, steers back to the event |
