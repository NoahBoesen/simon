# Submission copy — Simon (Night Hack, Tally form)

## One-liner

Simon turns any event guest list into a matchmaking agent you text. No app, no QR codes — attendees just iMessage one number, and Simon works the room for them.

## About the project

Every event has the same broken loop: a Luma page with 400 names, a room full of strangers, and everyone wandering around hoping to bump into the right person. LinkedIn tells you who someone *was*; nothing tells you who to meet *right now*. We wanted the guest list itself to become an agent — one that works the room on behalf of every attendee, and scouts it on behalf of the host.

**For attendees:** there is nothing to install and nothing to scan. You text Simon like you'd text a friend. It asks who you are and what you're looking for tonight, matches you against everyone in the room, explains exactly why each match fits — and when you say "ping them for me," it texts the other person an intro on your behalf. The entire product lives in your Messages app.

**For hosts:** import the Luma guest list, hit one button, and Simon researches every attendee (LinkedIn, bios, public web) before the doors open. A live dashboard shows the roster, research status, AI-scored matches, intro pings, and the full message stream. Ask the host concierge anything — "who here is building in healthcare?" — and it answers from everything it knows.

**The privacy line:** all attendee intelligence stays centralized with the agent. Attendees never see each other's research — Simon uses it to make better matches and only shares what you'd naturally share in an intro. It synthesizes intent; it never quotes anyone.

## How we built it

- **Convex** is the single brain: schema, live queries, actions, and the scheduler that drains research/matching queues — the dashboard updates in real time with zero polling code
- **Claude (Sonnet)** powers every decision: the attendee concierge (one call returns both the reply and structured actions like `save_profile` / `ping`), match scoring with concrete reasons, research synthesis, and the host concierge
- **Firecrawl** does the background research — LinkedIn-sharpened web search per attendee, with Claude instructed to refuse name-collision noise
- **Photon** delivers it over iMessage: inbound webhook → Convex HTTP action → agent → outbound send. A mock mode and a local `/text` client let us build the full loop before the endpoint was live
- **Luma ingestion:** scraped the real Night Hack guest list (401 attendees, 358 LinkedIns) into the roster

## What's next

Post-event follow-up (Simon texts you who you met and who you missed), organizer analytics, and multi-event memory — your profile travels with you from event to event.

## Links

- Code: https://github.com/NoahBoesen/simon
- iMessage number: [PHOTON NUMBER — get from Noah before submitting]
- Demo dashboard: [DEPLOY URL — fill in if we deploy before 9 PM]

## Built with

convex, claude, anthropic, firecrawl, photon, next.js, typescript, tailwindcss, luma
