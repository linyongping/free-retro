# Free Retro

A tiny, free retrospective board. Create a team, share the link, drop sticky notes — no sign-up.

**Live:** https://free-retro.haigr.workers.dev

- Classic 3-column retro: *What went well / What could improve / Action items*
- Multiplayer sync in real time: every open board connects to a per-board
  Durable Object room over WebSocket (hibernation API, so idle connections
  are free); any change pings the room and clients refetch. If the socket
  drops, the board degrades to slow lazy polling until it reconnects
- One vote per person per note (toggle), notes sorted by votes
- Note author names are hidden by default; the "Names" toggle in the board
  topbar shows them per viewer (stored in each browser)
- Trusted-team model: notes, edits, deletes and drags are open to everyone
  with the link; `npm test` covers the core API flows
- Silent-writing timer (5/8/10 min): while it runs, everyone's notes blur and
  composers stay open; the countdown is shared across all clients and the blur
  lifts when time is up
- Boards created with an empty title default to today's date, e.g. *Sep 5, 2026 retro board*
- **Teams (link-as-credential)**: the home page lists teams; each team has its
  own shareable link (`/#/t/<teamId>`) with its boards, board creation, team
  rename, and a team-scoped manage page (`/#/t/<teamId>/admin`). Whoever has
  the team link is a member — same trusted-team model as the boards themselves
- Recycle bin: deleting a board soft-deletes it for 30 days (restore or
  purge from the team's admin Trash tab); a daily cron at 03:00 purges boards
  past the 30-day window
- Sticky-note paper UI, self-hosted handwriting fonts (Caveat + Patrick Hand)

## Stack

| Piece | Choice | Free tier fit |
|---|---|---|
| Hosting + API | Cloudflare Workers (static assets + Worker) | 100k req/day |
| Database | Cloudflare D1 (SQLite) | 5M row reads/day |
| Frontend | Vanilla JS SPA, zero dependencies, hash routing | — |

## Project layout

```
├── wrangler.jsonc      # Worker + D1 + assets config
├── schema.sql          # D1 tables: teams / boards / notes / votes
├── src/worker.js       # JSON API (/api/*)
└── public/             # SPA served as static assets
    ├── index.html
    ├── styles.css
    ├── app.js
    └── fonts/          # self-hosted woff2
```

## Local development

```bash
npm install
npm run db:schema:local   # init local D1 (sqlite under .wrangler)
npm run dev               # http://localhost:8787
```

## Deploy

```bash
npx wrangler login                # once
npx wrangler d1 create free-retro-db   # once; put the id into wrangler.jsonc
npm run db:schema:remote          # once
echo "your-passcode" | npx wrangler secret put SITE_PASSCODE   # site lock
npm run deploy
```

## Observability

Worker logs (errors + `console.*`) are shipped to Cloudflare Workers Logs
(`observability.enabled` in wrangler.jsonc): free tier keeps 200k events/day
for 3 days — view them under Workers & Pages → free-retro → Logs, or stream
live with `npx wrangler tail`. Request/error metrics and the trash-cleanup
cron history are in the same dashboard; D1 query/storage metrics live on the
D1 database page.

## Site passcode

When the `SITE_PASSCODE` secret is set, the whole site sits behind a shared
passcode: visitors see a lock screen, and every `/api/*` call requires the
signed session cookie it issues (30 days; changing the passcode voids all
sessions). Team links stay as the per-team credential underneath.

```bash
echo "new-passcode" | npx wrangler secret put SITE_PASSCODE   # change it (logs everyone out)
npx wrangler secret delete SITE_PASSCODE                      # remove the gate entirely
```

For local dev, put `SITE_PASSCODE=...` into `.dev.vars` (gitignored); without
it the app runs open.

## API

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/auth/check` | session probe (`{ok}`) |
| GET | `/api/boards/:id/ws` | websocket room (cookie session, or `?token=`) |
| POST | `/api/auth/login` | exchange passcode for session cookie |
| GET | `/api/teams` | list teams (with board counts) |
| POST | `/api/teams` | create team `{name}` |
| GET/PATCH | `/api/teams/:id` | get / rename team |
| DELETE | `/api/teams/:id` | delete team + all its boards, notes and votes |
| GET | `/api/teams/:id/boards` | team's boards (`?trash=1` for trash) |
| POST | `/api/boards` | create board `{title, team_id?}` |
| PATCH | `/api/boards/:id` | rename `{title}` |
| DELETE | `/api/boards/:id` | move board to trash (soft delete) |
| DELETE | `/api/boards/:id?permanent=1` | purge board + notes + votes |
| POST | `/api/boards/:id/restore` | restore from trash |
| POST | `/api/notes/:id/move` | move `{column_key, before_id}` (open to everyone) |
| POST | `/api/boards/:id/timer` | start silent-writing timer `{minutes}` |
| DELETE | `/api/boards/:id/timer` | stop the timer |
| GET | `/api/boards/:id?voter=` | full board state incl. notes + `voted` flag |
| POST | `/api/boards/:id/notes` | `{column_key, text, author, voter}` |
| PATCH | `/api/notes/:id` | edit `{text, voter}` (owner only) |
| DELETE | `/api/notes/:id?voter=` | delete note + its votes (owner only) |
| POST | `/api/notes/:id/vote` | toggle vote `{voter}` |

Notes: boards are editable by anyone with the link (trusted-team model); the
author name lives only in each visitor's browser (localStorage); the voter id is
a random localStorage uuid, so votes are per-browser.

## If `*.workers.dev` is unreachable from your network

Some networks DNS-pollute `workers.dev`. The app itself is fine — bind a custom
domain to the Worker in the Cloudflare dashboard (Workers → free-retro →
Settings → Domains & Routes) and it will resolve normally.
