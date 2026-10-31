# Simon

The event concierge you text. Simon knows everyone in the room and gets the right people talking — over iMessage/WhatsApp. No app, no login, nothing to install.

Built at Founders Inc NightHack. Rebuilt from the Envoy engine on a new stack: **Next.js + Convex + Claude + Firecrawl + Photon**.

## How it works

- Host imports the Luma guest list (CSV upload or Firecrawl scrape)
- Simon researches attendees in the background (Firecrawl search + Claude synthesis)
- Attendees text Simon: it onboards them ("what do you want out of tonight?"), suggests who to meet, and pings people for intros
- Everything Simon knows stays with Simon — attendees only get the minimum context needed for an intro
- Host gets a live dashboard: roster, scored matches, live message feed, and a concierge to ask about the room

## How the agent works

Every inbound text runs through one pipeline (`convex/agent.ts`):

1. **Identify the sender** by phone number. Unknown number → a new attendee record is created on the active event.
2. **Build context**: the event, the sender's profile and current connection goals, the roster's cached bios/research, and the last 12 messages of this conversation. Reuse imported research; missing research for real attendees can use Firecrawl.
3. **One Claude call** with that context returns strict JSON: a `reply` plus zero or more `actions`:
   - `save_profile` — saves the latest connection goals and mirrors the existing host dashboard's intent field; profile/research data stays separate.
   - `recommend` — selects up to three attendee IDs with reasons. The server validates those IDs against the event, stores the suggestions, and formats the numbered reply.
   - `request_intro` — asks a specific attendee if they want to meet. `YES <code>` / `NO <code>` still work, and a plain yes/no can answer a single current invitation.
   - `respond_intro` — understands a recipient's natural acceptance or refusal. The server validates the invitation, recipient, event and conversation mode before applying the decision.
   - `relay_intro` — carries meeting proposals and replies between the two private iMessage conversations. “Tell Noah to meet me at the entrance” accepts an incoming invitation and passes that request along. After acceptance, either person can send updates through Simon. Only the requested meeting details are shared, and a proposed time/place is not treated as agreed until both people confirm.
4. **Reply is queued** through `convex/photon.ts`. A persistent Node worker sends it with the Photon 2.0 API and records delivery status. Dashboard simulations are explicitly marked and never send real messages.

### Privacy model

All attendee knowledge stays centralized with the agent. Attendees never see the roster, anyone's research, or scores — only the minimum context needed for a specific intro ("Alex is building X and wants to meet a designer"). The **host** concierge is the exception: it answers with full research access, dashboard-side only.

### Intents the agent handles over text

| You text | Simon does |
|---|---|
| first message after signup | sends the host-controlled welcome using your name on file |
| "who should I meet?" | Three relevant roster suggestions with reasons |
| "ping Maya" / "intro me to Alex" | asks the target for consent, then introduces both people |
| "tell Noah to meet me at the entrance" | accepts Noah's incoming invitation, if pending, and sends him the meeting request |
| "tell him I'll be there in five minutes" | relays the update through the existing introduction |
| anything else | brief answer, steers back to the event |

## Attendee flow (mock data first)

1. Open `/qr` for the signup QR, or `/join` for the form. Collect name, phone, LinkedIn/X/other profile, and permission to contact them. Mock mode is the default in the demo event.
2. Signup links the phone to an attendee and preserves imported research. A controlled welcome is sent once per registration. The host wizard's `welcomeTemplate` supports `{first_name}`, `{name}`, and `{event}`; the default copy is in `convex/lib/welcome.ts`. `events.meetingPoint` controls the suggested meeting spot.
3. The attendee says who they want to meet. Claude uses their profile and the cached roster research to recommend three actual roster entries with reasons. Changing the goal creates a fresh set of suggestions; old suggestions are marked superseded.
4. “Introduce me to Alex” sends Alex an invitation. Alex can simply say yes or no; no codes are shown or required. On acceptance, Simon suggests meeting in 10 minutes at the event's meeting point to both people, unless the attendee already proposed specific details. Subsequent yeses, locations, timing changes, and confirmations are relayed between their private chats. Ambiguous replies ask for a person's name. Phone numbers are not shared; unrelated or closed introductions cannot receive relayed messages. Duplicate processing does not resend messages.
5. In `/demo/chat`, use “switch number” and a sample attendee button to act as the recipient and test consent. Every mock message stays out of real Photon delivery. Fictional profiles can never receive real outbound texts.

The mock roster includes six fictional profiles: Alex, Morgan and Priya have AI/engineering backgrounds; Jamie, Casey and Sam have design backgrounds. Each has a placeholder LinkedIn URL, explicitly labeled as a demo placeholder in recommendations; these are not verified real profiles. Recommendations include the stored LinkedIn URL when available. Their cached bios/research use the same fields as imported real attendees. Existing research is reused; missing research for real attendees uses the existing Firecrawl integration when configured.

For real iMessage, the form saves the profile, finds or creates a Photon shared-line assignment, and shows **Open in Messages** with the name, profile link and activation text prefilled. The attendee reviews it and taps Send; that first inbound text establishes the route and triggers the welcome. An already-connected attendee can receive the welcome directly. If a device drops the prefilled body, the page shows the text and a Copy message fallback.

Automatic enrollment of new real numbers requires `platforms:read` and `platforms:write` on the server-side Photon key (`PHOTON_SETUP_API_KEY`, or `PHOTON_API_KEY`), plus shared-line capacity. Missing permissions produce a visible activation error; the app never claims the welcome was delivered. This permission is not needed for mock testing. See [Photon shared-line setup](https://photon.codes/docs/beta/get-started/imessage).

To test an introduction between two real people alongside the fictional roster, run `npm run demo:contact -- --name "Test Attendee" --phone "+COUNTRYCODE_NUMBER" --profile "https://www.linkedin.com/in/PROFILE/"` (optionally `--bio "Known professional context"`). This requires `ALLOW_DEMO_SEED=1` and an active demo event. It preserves existing research, prepares a real attendee, and reuses or assigns a Photon line without sending a message. Personal test contact details stay in the development database, outside the committed fixtures. Each tester must first iMessage the number printed for them from their registered identity; assigned numbers can differ between testers. After that, “Introduce me to Test Attendee” sends the recipient a private consent request. Their `YES <code>` sends both people the meeting details and the other person's saved LinkedIn link. International E.164 phone numbers are accepted by setup; actual delivery requires iMessage enabled on that identity and is verified by an inbound message.

On Vercel, the QR automatically uses the domain being visited. In local dev, `APP_PUBLIC_URL` overrides the destination with a phone-accessible LAN address; local testing requires the same Wi-Fi.

## Running it

Use Node.js 22+ (required by the Photon SDK), install dependencies, and select your development deployment in the shared Convex project. Keep credentials in ignored `.env.local`; [.env.example](.env.example) lists the required variables.

The existing frontend workflow is unchanged:

```sh
npm install
npx convex dev       # terminal 1: backend
npm run dev          # terminal 2: frontend
```

To run Convex, Next.js, and the Photon worker together:

```sh
npm run dev:full
```

`npm run setup` synchronizes the worker secret/project ID and adds model/research credentials only when absent from the selected Convex deployment. Only one worker should run for a Photon project at a time, including across different Convex deployments. Frontend work does not require starting that worker.

`npm run dev:local` is the optional local Convex fallback. It seeds demo data for a localhost backend. Cloud demo seeding is opt-in: set `ALLOW_DEMO_SEED=1` in a development deployment, then invoke `demo:seed` with the worker token. The seed is idempotent, preserves existing conversations, and does not modify an existing non-demo event. Mock profiles and real profiles use the same schema; production data is never populated automatically.

## Configuration

| Variable | Purpose |
|---|---|
| `CONVEX_DEPLOYMENT`, `NEXT_PUBLIC_CONVEX_URL`, `NEXT_PUBLIC_CONVEX_SITE_URL` | Convex-generated deployment selection and browser connection |
| `PHOTON_PROJECT_ID`, `PHOTON_API_KEY` | Photon 2.0 project and server-side API key |
| `PHOTON_AGENT_HANDLE` | Original shared iMessage destination |
| `PHOTON_WORKER_SECRET` | Authenticates server/worker Convex calls; generate with `openssl rand -hex 32` |
| `PHOTON_SETUP_API_KEY` | Optional separate server-side key for signup enrollment |
| `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL` | Claude credentials and optional model override; defaults to `claude-sonnet-4-6` |
| `FIRECRAWL_API_KEY` | Optional real attendee research and Luma scraping |
| `APP_PUBLIC_URL` | Phone-accessible origin used by the signup QR |
| `DEMO_ATTENDEE_PHONE` | Optional real test sender for demo seeding |
| `PHOTON_START_CURSOR` | Optional migration checkpoint; ignored when a saved worker cursor exists |

Provider keys never belong in `NEXT_PUBLIC_*` variables. `.env.local`, local databases, and `.local/` backups are ignored. For shared Convex access, accept a team invitation and use `npx convex login --force` if the CLI is signed into the wrong account. Select your team's existing development deployment before starting the backend.

## Vercel handoff

Vercel hosts the Next.js pages and `/api/join`. Configure `NEXT_PUBLIC_CONVEX_URL`, `PHOTON_WORKER_SECRET`, `PHOTON_PROJECT_ID`, and `PHOTON_API_KEY` (or `PHOTON_SETUP_API_KEY`) in its environment. The worker secret must match the selected Convex deployment. Do not copy a localhost Convex URL. `APP_PUBLIC_URL` is unnecessary on Vercel.

Deploy the Convex functions to the same deployment named by `NEXT_PUBLIC_CONVEX_URL`; pushing Next.js code alone does not update Convex. Claude credentials stay in Convex. For demo testing, point the website and the existing worker at the same mock-data deployment.

The persistent Photon listener is a separate Node process. `next build` does not start it on Vercel. Keep `npm run agent` running on the designated worker machine for real iMessage, or deploy that process to a persistent worker host. `/demo/chat` runs through Convex and works without this worker. Keep only one worker per Photon project running.

## Photon integration

```text
Phone ↔ Photon 2.0 ↔ Node worker ↔ Convex queue → Simon agent → Claude
                                      ↑                         ↓
                               delivery tracking ← outgoing queue
```

- `agent/`: Socket.IO transport, contract validation, ordered replay, checkpointing, REST sends, and worker lifecycle.
- `convex/photonBridge.ts` and `convex/photon.ts`: authenticated queues, persisted conversation IDs, deduplication, opt-outs, and delivery state.
- `convex/onboarding.ts`: phone/profile registration and the controlled welcome.
- `convex/agent.ts` and `convex/lib/introductions.ts`: profile-based recommendations, refinements, and recipient-approved introductions.
- `convex/demo.ts` and `tests/`: reusable mock profiles and isolated regression tests.
- `/join`, `/qr`, and `/demo/chat`: standalone signup and testing pages. The existing dashboard, host login, and `/text` frontend remain unchanged.

The worker needs `messages:read`, `project:read`, and `project:write`. Signup enrollment additionally needs `platforms:read` and `platforms:write`. No tunnel or inbound HTTP webhook is required. The old `/photon/inbound` adapter returns HTTP 410; `/health` remains available. `PHOTON_SEND_URL` and `PHOTON_SECRET` are no longer used.

Replies use the received Space ID, agent User ID, and parent Message ID. Incoming messages are saved before checkpointing and deduplicated on replay. A crashed generation can be retried; an interrupted send is marked for review rather than blindly resent. `STOP` cancels queued work and prevents further sends. Mock messages never enter real delivery.

When moving the worker to a different database, stop the previous worker and transfer its latest saved replay cursor to avoid replaying already handled messages. Existing cursors take precedence over `PHOTON_START_CURSOR`.

This is a development setup. Existing dashboard/data APIs still need authorization checks before public use; the Photon worker and signup mutations require a server secret.

## Checks

```sh
npm test
npm run typecheck
npm run lint
npm run build
```

Tests cover signup and the controlled welcome, first-message activation, prefilled Messages links, goal-based recommendations and refinements, recipient consent, simulation isolation, and the Convex/Claude/Photon queue including deduplication, opt-outs, stale generations, replay checkpoints, worker ownership, and interrupted-send recovery.
