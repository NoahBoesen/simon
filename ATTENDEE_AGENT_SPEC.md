# Simon — Attendee Agent, Complete Feature Spec (iMessage side)

## What Simon is

- An event concierge you text. Knows everyone in the room, suggests who to meet, makes intros. No app, no login — iMessage only.
- One phone number serves all events; the event slug routes you.

## 1. Onboarding

- Attendee's first message = an **event slug** (e.g. `nighthack`), from a QR code / poster at the event. Slug maps to an event created in the event-creation layer.
- If the phone number is already on the imported guest list → agent greets them by name, asks one question: "what do you want out of tonight?"
- If unknown number → agent asks name first, then the one-liner. They join as a guest on that event.
- The one-liner is the attendee's **intent** — everything downstream keys off it.

## 2. Hints (proactive, right after onboarding)

- ~15-30s after the one-liner is saved, agent texts back unprompted with 1-2 early hints: people worth meeting + one concrete reason each.
- Hints improve as background research fills in — agent may send another proactive hint later if a high-fit person joins.

## 3. Background intelligence (invisible to attendee)

- Agent researches each attendee: web search (Firecrawl) + Claude synthesis → max ~3 conservative facts. Errs toward silence on same-name ambiguity.
- Matching engine scores everyone against the attendee's intent, keeps top matches with reasons.

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

- All attendee knowledge stays central with the agent. Attendees never see the roster, anyone's research, scores, or other people's conversations.
- An intro shares only the minimum: name, one-liner-level context, why it fits. Never research facts verbatim, never quotes from other chats.
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
| `nighthack` (first message) | onboards: greets by name (or asks name), asks "what do you want tonight?" |
| answers the one-liner | saves intent → sends 1-2 proactive hints ~15-30s later |
| "who should I meet?" | 1-2 suggestions with concrete reasons |
| "ping Maya" / "intro me to Alex" | texts the target an intro (only if their number is on the list) |
| "when's pizza" / logistics | answers from the event context field |
| anything else | brief answer, steers back to the event |
