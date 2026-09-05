# Free Retro

A tiny, free retrospective board. Create a board, share the link, drop sticky notes — no sign-up.

**Live:** https://free-retro.haigr.workers.dev

- Classic 3-column retro: *What went well / What could improve / Action items*
- Multiplayer sync (3s polling) — see teammates' notes and votes appear live
- One vote per person per note (toggle), notes sorted by votes
- Silent-writing timer (5/10 min): while it runs, everyone's notes blur and
  composers stay open; the countdown is shared across all clients and the blur
  lifts when time is up
- Multiple boards with a recent-boards home page
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
├── schema.sql          # D1 tables: boards / notes / votes
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
npm run deploy
```

## API

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/boards` | list boards (with note counts) |
| POST | `/api/boards` | create board `{title}` |
| PATCH | `/api/boards/:id` | rename `{title}` |
| POST | `/api/boards/:id/timer` | start silent-writing timer `{minutes}` |
| DELETE | `/api/boards/:id/timer` | stop the timer |
| GET | `/api/boards/:id?voter=` | full board state incl. notes + `voted` flag |
| POST | `/api/boards/:id/notes` | `{column_key, text, author}` |
| PATCH | `/api/notes/:id` | edit `{text}` |
| DELETE | `/api/notes/:id` | delete note + its votes |
| POST | `/api/notes/:id/vote` | toggle vote `{voter}` |

Notes: boards are editable by anyone with the link (trusted-team model); the
author name lives only in each visitor's browser (localStorage); the voter id is
a random localStorage uuid, so votes are per-browser.

## If `*.workers.dev` is unreachable from your network

Some networks DNS-pollute `workers.dev`. The app itself is fine — bind a custom
domain to the Worker in the Cloudflare dashboard (Workers → free-retro →
Settings → Domains & Routes) and it will resolve normally.
