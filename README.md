# Free Retro

A tiny, free retrospective board. Sign in with Google or GitHub to create a team,
share the link, drop sticky notes — and anyone with a board link can still read it
and add notes without an account.

**Live:** https://free-retro.haigr.workers.dev

- Classic 3-column retro: *What went well / What could improve / Action items*
- Merge: tap two or more notes and click **Merge**; the first note's text stays (sorted by creation) and the rest are removed; votes merge, too
- Multiplayer sync in real time: every open board connects to a per-board
  Durable Object room over WebSocket (hibernation API, so idle connections
  are free); any change pings the room and clients refetch. If the socket
  drops, the board degrades to slow lazy polling until it reconnects
- One vote per person per note (toggle), notes sorted by votes
- Note author names are hidden by default; the "Names" toggle in the board
  topbar shows them per viewer (stored in each browser)
- Permissions are enforced server-side on every endpoint (`src/access.js` is the
  single source of truth); the UI hides buttons it knows you cannot use, but never
  as the only check. `npm test` covers the denial cases, not just the happy path
- Silent-writing timer (5/8/10 min): while it runs, everyone's notes blur and
  composers stay open; the countdown is shared across all clients and the blur
  lifts when time is up
- Boards created with an empty title default to today's date, e.g. *Sep 5, 2026 retro board*
- **Accounts and roles**: sign in with Google or GitHub. A team has members and
  admins; the person who creates a team is its first admin. **Teams are private**
  — they are invisible to non-members and only admins can add people (there is no
  self-join, no public team list, and no global admin anywhere in the system)
- **Board visibility**: every board is `public` (anyone with the link can read and
  add notes) or `team` (members only). New boards default to `public`; the board
  owner or a team admin can flip it, and widening a board to public asks first
  because it exposes other people's notes
- **Who can do what**: members can add notes to any board in their team, and edit
  or delete their own; the **board owner** alone can merge notes (a team admin
  cannot) and manage that board, while a team admin can rename, delete and restore
  any board in the team. Export is admin-only
- **Visitors keep working**: anyone with a public board link can read it and add
  notes without an account. They get a signed anonymous session on their first
  write, so they can still edit what they wrote
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
├── schema.sql          # D1 tables (fresh databases)
├── migrations/         # one-off SQL for databases that predate a change
├── src/worker.js       # routing + handlers for /api/*
├── src/auth.js         # OAuth, sessions, anonymous sessions
├── src/access.js       # every permission decision lives here
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

For local development put this in `.dev.vars` (gitignored):

```
SESSION_SECRET=any-long-random-string
ALLOW_DEV_LOGIN=1
```

`ALLOW_DEV_LOGIN=1` adds a dev sign-in box to the sign-in sheet so you can work
without registering OAuth apps. The endpoint it calls (`POST /api/auth/dev-login`)
returns 404 unless that variable is set, so it does not exist in production.

If you already had a local database from before user management, apply the
migration once instead of recreating it:

```bash
npm run db:migrate:local
```

## Deploy

```bash
npx wrangler login                      # once
npx wrangler d1 create free-retro-db    # once; put the id into wrangler.jsonc
npm run db:schema:remote                # once, on a fresh database
npm run db:migrate:remote               # once, on a database that predates user management
npx wrangler secret put SESSION_SECRET  # signs OAuth state and websocket tickets
npx wrangler secret put GOOGLE_CLIENT_ID
npx wrangler secret put GOOGLE_CLIENT_SECRET
npx wrangler secret put GITHUB_CLIENT_ID
npx wrangler secret put GITHUB_CLIENT_SECRET
npm run deploy
```

**Order matters on an existing deployment.** The migration is additive and
NULL-tolerant, so apply it first and the old code keeps working; deploy the code
second. Until a user claims each pre-existing team (see the migration file) those
boards stay readable and writable but unmanageable, because no global admin exists
to adopt them.

`npm run deploy` stamps a build id (`<YYMMDD>.<short sha>`, `+dirty` when the
tree has uncommitted changes) into `public/app.js` for the duration of the
deploy, then restores the file. The home footer shows it, and a tab that has
been open across a deploy gets a "new version is live — reload" pill when you
return to it. Running `wrangler deploy` directly skips the stamp and the footer
reads `dev`.

### Deploying on push (Cloudflare Git integration)

The Worker is connected to this repository in the Cloudflare dashboard, so a
push to `main` builds and deploys automatically. Two configurations stamp the
build id — either is fine, pick one:

| | Build command | Deploy command |
|---|---|---|
| **A** (defaults mostly untouched) | `npm run stamp` | leave as `npx wrangler deploy` |
| **B** | leave empty | `npm run deploy` |

`npm run stamp` writes the id into `public/app.js` and leaves it there, so the
file Cloudflare uploads carries the stamp. `npm run deploy` does the same but
then deploys and restores the file itself, so it belongs in the deploy step.

Do **not** put `npm run deploy` in the *build* command. It restores
`public/app.js` when it finishes, so Cloudflare would then upload the restored —
and therefore unstamped — file: production reads `dev` while every build log
looks correct.

If the build image has no `git`, the stamp degrades to a date-only id
(`260910.local`) instead of failing — it still changes daily, but no longer
identifies the commit.

Worker secrets (`SESSION_SECRET`, the OAuth client IDs and secrets) are stored
in Cloudflare and are not touched by a deploy.

`.github/workflows/ci.yml` runs the API tests on pull requests and pushes. It
does **not** deploy, and because Cloudflare deploys on push independently, a
failing test does not block a release — it just tells you `main` is broken.

## Observability

Worker logs (errors + `console.*`) are shipped to Cloudflare Workers Logs
(`observability.enabled` in wrangler.jsonc): free tier keeps 200k events/day
for 3 days — view them under Workers & Pages → free-retro → Logs, or stream
live with `npx wrangler tail`. Request/error metrics and the trash-cleanup
cron history are in the same dashboard; D1 query/storage metrics live on the
D1 database page.

## Sign-in

Sign-in is OAuth only — there is no password anywhere in the system.

| Provider | Register the app at | Callback URL |
|---|---|---|
| Google | Google Cloud Console → APIs & Services → Credentials (OAuth client, Web application) | `https://<your-host>/api/auth/callback/google` |
| GitHub | GitHub → Settings → Developer settings → OAuth Apps | `https://<your-host>/api/auth/callback/github` |

Register one callback URL per host you deploy to (`*.workers.dev` and any custom
domain), then set `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` and the GitHub pair
as Worker secrets. `SESSION_SECRET` is required too: it signs the OAuth `state`
and the short-lived websocket tickets. **When it is missing those two flows refuse
to run** rather than falling back to anything open.

Accounts are keyed by `(provider, provider_user_id)`. Email is stored but never
used to merge accounts: GitHub often exposes no usable address, and merging on an
unverified address would hand one person another's account.

Two cookies, both `HttpOnly` / `SameSite=Lax` / 30 days:

| Cookie | Meaning |
|---|---|
| `retro_session` | a signed-in account |
| `retro_anon` | an anonymous visitor, issued on the **first write**, never on a read |

The anonymous cookie is what lets a visitor with a board link own the notes they
write. Signing in afterwards hands that ownership over to the account, so notes
written before signing in stay editable. When an anonymous session expires, its
notes pass to the board's owner (the cleanup cron does that before deleting the
session row, since the ownership is keyed to it).

## API

Status codes carry meaning the client relies on: **401** not signed in,
**403** readable but not allowed, **404** missing *or* not readable (a denied
reader must not learn that a board exists).

| Method | Path | Who |
|---|---|---|
| GET | `/api/auth/providers` | public — which sign-in buttons to show |
| GET | `/api/auth/login/:provider` | public — starts OAuth (`?return=`) |
| GET | `/api/auth/callback/:provider` | public — finishes OAuth |
| POST | `/api/auth/logout` | any session |
| GET | `/api/me` | any — identity, teams and roles |
| PATCH | `/api/me` | signed in — display name |
| GET | `/api/teams` | own teams (a visitor gets `[]`) |
| POST | `/api/teams` | signed in — creator becomes its admin |
| GET/PATCH/DELETE | `/api/teams/:id` | member / admin / admin |
| GET | `/api/teams/:id/boards` | member (`?trash=1` is admin-only) |
| GET | `/api/teams/:id/export` | **admin only** |
| GET | `/api/teams/:id/members` | member — the roster |
| POST | `/api/teams/:id/members` | admin — add by `email` or `user_id`, with `role` |
| PATCH/DELETE | `/api/teams/:id/members/:userId` | admin — change role / remove |
| POST | `/api/teams/:id/leave` | self — refused for the last admin |
| POST | `/api/boards` | member of the named `team_id` (required) |
| GET | `/api/boards/:id` | readable (admins may also inspect a trashed one) |
| PATCH | `/api/boards/:id` | owner or admin — `title` and/or `visibility` |
| DELETE | `/api/boards/:id` | owner or admin — soft delete (`?permanent=1` is admin-only) |
| POST | `/api/boards/:id/restore` | **admin only** |
| POST/DELETE | `/api/boards/:id/timer` | owner or admin |
| POST | `/api/boards/:id/ws-ticket` | readable — 60s ticket for non-browser clients |
| GET | `/api/boards/:id/ws` | readable (session cookie, or `?ticket=`) |
| POST | `/api/boards/:id/notes` | readable — visitors included |
| PATCH/DELETE | `/api/notes/:id` | the note's author, or a team admin |
| POST | `/api/notes/:id/move` | readable (same tier as writing a note) |
| POST | `/api/boards/:id/merge` | **the board owner only** |
| POST | `/api/notes/:id/vote` | readable — one vote per identity |

Two rules explain most of the table:

- **Ownership does not grant access.** Every note write also requires being able to
  read the board, so removing someone from a team, or flipping a board to
  team-only, takes their edit rights with it.
- **Board management requires current membership.** `created_by` alone is not
  enough: a member removed from a team must not keep control of the board they
  created — including the power to flip it public.

Notes on the data model: a note's `owner_id` and a vote's `voter` are the
**signed identity** (user id, or anonymous session id) — never a value the client
sent. `notes.owner_id IS NULL` marks rows from before accounts existed and is
admin-only. The display name is still client-supplied (you may override your
nickname), which is cosmetic only: it grants nothing, because permissions read
`owner_id`.

## If `*.workers.dev` is unreachable from your network

Some networks DNS-pollute `workers.dev`. The app itself is fine — bind a custom
domain to the Worker in the Cloudflare dashboard (Workers → free-retro →
Settings → Domains & Routes) and it will resolve normally.
