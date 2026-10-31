# Simon

The event concierge you text. Simon knows everyone in the room and gets the right people talking — over iMessage/WhatsApp. No app, no login, nothing to install.

Built at Founders Inc NightHack. Rebuilt from the Envoy engine on a new stack: **Next.js + Convex + Claude + Firecrawl + Photon**.

## How it works

- Host imports the Luma guest list (CSV upload or Firecrawl scrape)
- Simon researches attendees in the background (Firecrawl search + Claude synthesis)
- Attendees text Simon: it onboards them ("what do you want out of tonight?"), suggests who to meet, and pings people for intros
- Everything Simon knows stays with Simon — attendees only get the minimum context needed for an intro
- Host gets a live dashboard: roster, scored matches, live message feed, and a concierge to ask about the room

## Running it

```bash
npm install
npx convex dev        # terminal 1 — backend
npm run dev           # terminal 2 — host dashboard on localhost:3000
```

Convex env vars (set with `npx convex env set KEY value`):

| Var | Purpose |
|---|---|
| `ANTHROPIC_API_KEY` | Agent brain, matching, research synthesis |
| `FIRECRAWL_API_KEY` | Attendee research + Luma scraping |
| `PHOTON_SEND_URL` | Outbound message delivery (see below) |
| `PHOTON_SECRET` | Shared secret for both directions (optional but recommended) |

Wipe test data before going live: `npx convex run dev:reset`

---

## Photon integration (for the iMessage side)

The backend is live at:

- **Convex deployment:** `https://beloved-echidna-158.convex.cloud`
- **HTTP endpoints:** `https://beloved-echidna-158.convex.site`

Two directions to wire up:

### 1. Inbound — attendee texts Simon

Forward every inbound message to:

```
POST https://beloved-echidna-158.convex.site/photon/inbound
Content-Type: application/json
Authorization: Bearer <PHOTON_SECRET>   # only if we set one

{ "phone": "+14155551234", "message": "who should I meet tonight?" }
```

- `phone` must be E.164 (`+1...`). Aliases `from`/`sender` and `text`/`body` are also accepted.
- Returns `{"ok": true}` immediately; Simon replies asynchronously via the outbound path.
- Health check: `GET https://beloved-echidna-158.convex.site/health`

### 2. Outbound — Simon texts an attendee

Expose one send endpoint and tell us the URL. Simon will call:

```
POST <your-send-url>
Content-Type: application/json
Authorization: Bearer <PHOTON_SECRET>   # if set

{ "phone": "+14155551234", "message": "Hey Maya, Alex is here tonight and ..." }
```

Then we run:

```bash
npx convex env set PHOTON_SEND_URL https://your-endpoint
npx convex env set PHOTON_SECRET some-shared-secret
```

**Until `PHOTON_SEND_URL` is set, Simon runs in mock mode:** outbound messages are logged and visible in the dashboard "Live texts" panel, so both sides can be built and tested independently. The dashboard also has a simulator that injects inbound texts without Photon — use it to see exactly what Simon will send.

### Message semantics Photon doesn't need to care about

All intelligence (onboarding, intent parsing, matchmaking, ping routing) lives server-side. Photon is a dumb pipe: deliver inbound to the webhook, deliver outbound to the phone. One attendee = one phone number.
