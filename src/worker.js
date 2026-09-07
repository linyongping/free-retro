// Free Retro — Worker API over D1.
// Static assets in ./public are served first; everything under /api/* lands here.
import { BoardRoom } from "./room.js";
export { BoardRoom };

const ALPHABET = "23456789abcdefghjkmnpqrstuvwxyz"; // unambiguous lowercase
const COLUMNS = new Set(["went_well", "to_improve", "actions"]);
const AUTH_COOKIE = "retro_auth";
const AUTH_TTL = 30 * 86400; // 30 days

async function hmacHex(key, msg) {
  const enc = new TextEncoder();
  const k = await crypto.subtle.importKey("raw", enc.encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", k, enc.encode(msg));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function getCookie(request, name) {
  for (const part of (request.headers.get("Cookie") || "").split(/;\s*/)) {
    const eq = part.indexOf("=");
    if (eq > 0 && part.slice(0, eq) === name) return part.slice(eq + 1);
  }
  return null;
}

// token = "<expiry-ms>.<hmac(passcode, expiry)>"; rotating the passcode voids all sessions
async function makeToken(passcode) {
  const exp = String(Date.now() + AUTH_TTL * 1000);
  return `${exp}.${await hmacHex(passcode, exp)}`;
}

async function sessionValid(env, token) {
  const passcode = (env.SITE_PASSCODE || "").trim();
  if (!passcode) return true; // no passcode configured → open access
  const dot = token.indexOf(".");
  if (dot <= 0) return false;
  const [exp, sig] = [token.slice(0, dot), token.slice(dot + 1)];
  if (!/^\d+$/.test(exp) || Number(exp) < Date.now()) return false;
  return sig === (await hmacHex(passcode, exp));
}

async function authed(request, env, tokenOverride) {
  const passcode = (env.SITE_PASSCODE || "").trim();
  if (!passcode) return true; // no passcode configured → open access
  const token = tokenOverride ?? (getCookie(request, AUTH_COOKIE) || "");
  return sessionValid(env, token);
}

// wake the board's room so it pings every connected client to refetch state
function notifyBoardChange(env, boardId) {
  const stub = env.BOARD_ROOM.get(env.BOARD_ROOM.idFromName(boardId));
  return stub
    .fetch("https://board-room/notify", {
      method: "POST",
      body: JSON.stringify({ type: "changed", at: Date.now() }),
    })
    .catch(() => {});
}

function rid(len) {
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  let id = "";
  for (const b of bytes) id += ALPHABET[b % ALPHABET.length];
  return id;
}

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });

async function readBody(request) {
  try {
    return await request.json();
  } catch {
    return {};
  }
}

export default {
  // daily cron: purge boards that have sat in the trash for 30 days
  async scheduled(event, env, ctx) {
    const cutoff = Date.now() - 30 * 864e5;
    const { results } = await env.DB.prepare(
      "SELECT id FROM boards WHERE deleted_at IS NOT NULL AND deleted_at < ? LIMIT 50"
    )
      .bind(cutoff)
      .all();
    if (!results.length) return;
    await env.DB.batch(
      results.flatMap((b) => [
        env.DB.prepare("DELETE FROM votes WHERE note_id IN (SELECT id FROM notes WHERE board_id = ?)").bind(b.id),
        env.DB.prepare("DELETE FROM notes WHERE board_id = ?").bind(b.id),
        env.DB.prepare("DELETE FROM boards WHERE id = ?").bind(b.id),
      ])
    );
    console.log(`purged ${results.length} board(s) past the 30-day trash window`);
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;
    let m;

    try {
      // ---- site passcode gate (all /api/* except auth endpoints) ----
      if (path === "/api/auth/check") {
        return json({ ok: await authed(request, env) });
      }
      if (path === "/api/auth/login" && method === "POST") {
        const body = await readBody(request);
        const passcode = (env.SITE_PASSCODE || "").trim();
        if (!passcode) return json({ ok: true, open: true }); // gate not configured
        if ((body.passcode || "").toString().trim() !== passcode) {
          return json({ error: "wrong_passcode" }, 401);
        }
        const secure = url.hostname === "localhost" || url.hostname === "127.0.0.1" ? "" : "; Secure";
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: {
            "content-type": "application/json; charset=utf-8",
            "set-cookie": `${AUTH_COOKIE}=${await makeToken(passcode)}; Max-Age=${AUTH_TTL}; Path=/; HttpOnly; SameSite=Lax${secure}`,
          },
        });
      }
      // /ws handles its own auth (handshakes can't rely on the cookie alone)
      if (path.startsWith("/api/") && !path.endsWith("/ws") && !(await authed(request, env))) {
        return json({ error: "unauthorized" }, 401);
      }

      // ---- live board updates (websocket room; auth via cookie or ?token=) ----
      if ((m = path.match(/^\/api\/boards\/([a-z0-9]+)\/ws$/)) && method === "GET") {
        if (!(await authed(request, env, url.searchParams.get("token") || undefined))) {
          return json({ error: "unauthorized" }, 401);
        }
        return env.BOARD_ROOM.get(env.BOARD_ROOM.idFromName(m[1])).fetch(request);
      }

      // ---- teams ----
      if (path === "/api/teams" && method === "GET") {
        const { results } = await env.DB.prepare(
          `SELECT t.id, t.name, t.created_at,
             (SELECT COUNT(*) FROM boards b WHERE b.team_id = t.id AND b.deleted_at IS NULL) AS board_count
           FROM teams t ORDER BY t.created_at ASC LIMIT 50`
        ).all();
        return json({ teams: results });
      }

      if (path === "/api/teams" && method === "POST") {
        const body = await readBody(request);
        const name = (body.name || "").toString().trim().slice(0, 60) || "New team";
        const id = rid(8);
        const created_at = Date.now();
        await env.DB.prepare("INSERT INTO teams (id, name, created_at) VALUES (?, ?, ?)")
          .bind(id, name, created_at)
          .run();
        return json({ team: { id, name, created_at, board_count: 0 } }, 201);
      }

      if ((m = path.match(/^\/api\/teams\/([a-z0-9]+)$/))) {
        const teamId = m[1];
        const team = await env.DB.prepare("SELECT id, name, created_at FROM teams WHERE id = ?")
          .bind(teamId)
          .first();
        if (!team) return json({ error: "team_not_found" }, 404);
        if (method === "GET") return json({ team });
        if (method === "PATCH") {
          const body = await readBody(request);
          const name = (body.name || "").toString().trim().slice(0, 60);
          if (!name) return json({ error: "invalid_name" }, 400);
          await env.DB.prepare("UPDATE teams SET name = ? WHERE id = ?").bind(name, teamId).run();
          return json({ team: { ...team, name } });
        }
        if (method === "DELETE") {
          // purge the team and every board it owns (active + trash), notes and votes included
          const { results: boards } = await env.DB.prepare("SELECT id FROM boards WHERE team_id = ?")
            .bind(teamId)
            .all();
          await env.DB.batch([
            ...boards.flatMap((b) => [
              env.DB.prepare("DELETE FROM votes WHERE note_id IN (SELECT id FROM notes WHERE board_id = ?)").bind(b.id),
              env.DB.prepare("DELETE FROM notes WHERE board_id = ?").bind(b.id),
              env.DB.prepare("DELETE FROM boards WHERE id = ?").bind(b.id),
            ]),
            env.DB.prepare("DELETE FROM teams WHERE id = ?").bind(teamId),
          ]);
          return json({ ok: true, removed_boards: boards.length });
        }
      }

      // ---- team-scoped boards list (active, or ?trash=1) ----
      if ((m = path.match(/^\/api\/teams\/([a-z0-9]+)\/boards$/)) && method === "GET") {
        const team = await env.DB.prepare("SELECT id FROM teams WHERE id = ?").bind(m[1]).first();
        if (!team) return json({ error: "team_not_found" }, 404);
        const trash = url.searchParams.get("trash") === "1";
        const { results } = await env.DB.prepare(
          `SELECT b.id, b.title, b.created_at, b.deleted_at,
             (SELECT COUNT(*) FROM notes n WHERE n.board_id = b.id) AS note_count,
             (SELECT MAX(n.updated_at) FROM notes n WHERE n.board_id = b.id) AS last_activity
           FROM boards b
           WHERE b.team_id = ?1 AND b.deleted_at IS ${trash ? "NOT NULL" : "NULL"}
           ORDER BY ${trash ? "b.deleted_at" : "COALESCE(last_activity, b.created_at)"} DESC
           LIMIT 200`
        )
          .bind(m[1])
          .all();
        return json({ boards: results });
      }

      // ---- boards collection (legacy, unused by the UI) ----
      if (path === "/api/boards" && method === "GET") {
        const trash = url.searchParams.get("trash") === "1";
        const { results } = await env.DB.prepare(
          `SELECT b.id, b.title, b.created_at, b.deleted_at,
             (SELECT COUNT(*) FROM notes n WHERE n.board_id = b.id) AS note_count,
             (SELECT MAX(n.updated_at) FROM notes n WHERE n.board_id = b.id) AS last_activity
           FROM boards b
           WHERE b.deleted_at IS ${trash ? "NOT NULL" : "NULL"}
           ORDER BY ${trash ? "b.deleted_at" : "COALESCE(last_activity, b.created_at)"} DESC
           LIMIT 200`
        ).all();
        return json({ boards: results });
      }

      if (path === "/api/boards" && method === "POST") {
        const body = await readBody(request);
        const title = (body.title || "").toString().trim().slice(0, 120) || "Untitled retro";
        // resolve the owning team: given team if valid, else the oldest team
        let teamId = (body.team_id || "").toString().slice(0, 20) || null;
        if (teamId) {
          const t = await env.DB.prepare("SELECT id FROM teams WHERE id = ?").bind(teamId).first();
          if (!t) teamId = null;
        }
        if (!teamId) {
          const t = await env.DB.prepare("SELECT id FROM teams ORDER BY created_at ASC LIMIT 1").first();
          teamId = t ? t.id : null;
        }
        const id = rid(8);
        const created_at = Date.now();
        await env.DB.prepare("INSERT INTO boards (id, title, created_at, team_id) VALUES (?, ?, ?, ?)")
          .bind(id, title, created_at, teamId)
          .run();
        return json({ board: { id, title, created_at, team_id: teamId } }, 201);
      }

      // ---- single board ----
      if ((m = path.match(/^\/api\/boards\/([a-z0-9]+)$/))) {
        const boardId = m[1];
        const board = await env.DB.prepare("SELECT id, title, created_at, team_id, timer_ends_at, deleted_at FROM boards WHERE id = ?")
          .bind(boardId)
          .first();
        if (!board) return json({ error: "board_not_found" }, 404);
        // trashed boards are invisible to the board page (GET) and renames (PATCH),
        // but must stay reachable for the permanent-delete route below
        if (board.deleted_at && (method === "GET" || method === "PATCH")) {
          return json({ error: "board_not_found" }, 404);
        }

        if (method === "GET") {
          // expire stale timers on read so clients never see a dead countdown
          if (board.timer_ends_at && board.timer_ends_at < Date.now()) board.timer_ends_at = null;
          const voter = (url.searchParams.get("voter") || "").slice(0, 64);
          const { results: notes } = await env.DB.prepare(
            `SELECT n.id, n.column_key, n.text, n.author, n.created_at, n.updated_at, n.sort_order,
               (SELECT COUNT(*) FROM votes v WHERE v.note_id = n.id) AS vote_count,
               (SELECT COUNT(*) FROM votes v WHERE v.note_id = n.id AND v.voter = ?1) AS voted,
               CASE WHEN n.owner_id IS NULL OR n.owner_id = ?1 THEN 1 ELSE 0 END AS mine
             FROM notes n WHERE n.board_id = ?2 ORDER BY n.sort_order ASC`
          )
            .bind(voter, boardId)
            .all();
          return json({ board, notes, now: Date.now() });
        }

        if (method === "PATCH") {
          const body = await readBody(request);
          const title = (body.title || "").toString().trim().slice(0, 120);
          if (!title) return json({ error: "invalid_title" }, 400);
          await env.DB.prepare("UPDATE boards SET title = ? WHERE id = ?").bind(title, boardId).run();
          ctx.waitUntil(notifyBoardChange(env, boardId));
          return json({ board: { ...board, title } });
        }
      }

      // ---- silent-writing timer ----
      if ((m = path.match(/^\/api\/boards\/([a-z0-9]+)\/timer$/)) && method === "POST") {
        const boardId = m[1];
        const board = await env.DB.prepare("SELECT id FROM boards WHERE id = ?").bind(boardId).first();
        if (!board) return json({ error: "board_not_found" }, 404);
        const body = await readBody(request);
        const minutes = Number(body.minutes);
        if (!Number.isFinite(minutes) || minutes < 1 || minutes > 60) return json({ error: "invalid_minutes" }, 400);
        const now = Date.now();
        const timer_ends_at = now + Math.round(minutes * 60_000);
        await env.DB.prepare("UPDATE boards SET timer_ends_at = ? WHERE id = ?").bind(timer_ends_at, boardId).run();
        ctx.waitUntil(notifyBoardChange(env, boardId));
        return json({ board: { id: boardId, timer_ends_at }, now });
      }

      if ((m = path.match(/^\/api\/boards\/([a-z0-9]+)\/timer$/)) && method === "DELETE") {
        const boardId = m[1];
        await env.DB.prepare("UPDATE boards SET timer_ends_at = NULL WHERE id = ?").bind(boardId).run();
        ctx.waitUntil(notifyBoardChange(env, boardId));
        return json({ board: { id: boardId, timer_ends_at: null }, now: Date.now() });
      }

      // ---- restore from trash ----
      if ((m = path.match(/^\/api\/boards\/([a-z0-9]+)\/restore$/)) && method === "POST") {
        await env.DB.prepare("UPDATE boards SET deleted_at = NULL WHERE id = ?").bind(m[1]).run();
        ctx.waitUntil(notifyBoardChange(env, m[1]));
        return json({ ok: true });
      }

      // ---- delete board: soft (recycle bin) by default, ?permanent=1 to purge ----
      if ((m = path.match(/^\/api\/boards\/([a-z0-9]+)$/)) && method === "DELETE") {
        const boardId = m[1];
        if (url.searchParams.get("permanent") === "1") {
          const notes = await env.DB.prepare("SELECT id FROM notes WHERE board_id = ?").bind(boardId).all();
          const stmts = notes.results.map((n) =>
            env.DB.prepare("DELETE FROM votes WHERE note_id = ?").bind(n.id),
          );
          stmts.push(env.DB.prepare("DELETE FROM notes WHERE board_id = ?").bind(boardId));
          stmts.push(env.DB.prepare("DELETE FROM boards WHERE id = ?").bind(boardId));
          await env.DB.batch(stmts);
          ctx.waitUntil(notifyBoardChange(env, boardId));
          return json({ ok: true, purged: true });
        }
        await env.DB.prepare("UPDATE boards SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL")
          .bind(Date.now(), boardId)
          .run();
        ctx.waitUntil(notifyBoardChange(env, boardId));
        return json({ ok: true });
      }

      // ---- create note ----
      if ((m = path.match(/^\/api\/boards\/([a-z0-9]+)\/notes$/)) && method === "POST") {
        const boardId = m[1];
        const board = await env.DB.prepare("SELECT id FROM boards WHERE id = ?").bind(boardId).first();
        if (!board) return json({ error: "board_not_found" }, 404);

        const body = await readBody(request);
        const column_key = (body.column_key || "").toString();
        const text = (body.text || "").toString().trim().slice(0, 500);
        const author = (body.author || "").toString().trim().slice(0, 40);
        const voter = (body.voter || "").toString().slice(0, 64) || null;
        if (!COLUMNS.has(column_key)) return json({ error: "invalid_column" }, 400);
        if (!text) return json({ error: "invalid_text" }, 400);

        const id = rid(10);
        const now = Date.now();
        const maxRow = await env.DB.prepare(
          "SELECT MAX(sort_order) AS m FROM notes WHERE board_id = ? AND column_key = ?"
        )
          .bind(boardId, column_key)
          .first();
        const sort_order = (maxRow?.m || 0) + 1000;
        await env.DB.prepare(
          "INSERT INTO notes (id, board_id, column_key, text, author, owner_id, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
        )
          .bind(id, boardId, column_key, text, author, voter, sort_order, now, now)
          .run();
        ctx.waitUntil(notifyBoardChange(env, boardId));
        return json(
          { note: { id, column_key, text, author, sort_order, created_at: now, updated_at: now, vote_count: 0, voted: 0, mine: voter ? 1 : 0 } },
          201
        );
      }

      // ---- single note: edit / delete (open to everyone; owner_id kept as metadata) ----
      if ((m = path.match(/^\/api\/notes\/([a-z0-9]+)$/))) {
        const noteId = m[1];
        const note = await env.DB.prepare("SELECT id, board_id FROM notes WHERE id = ?").bind(noteId).first();
        if (!note) return json({ error: "note_not_found" }, 404);

        if (method === "PATCH") {
          const body = await readBody(request);
          const text = (body.text || "").toString().trim().slice(0, 500);
          if (!text) return json({ error: "invalid_text" }, 400);
          await env.DB.prepare("UPDATE notes SET text = ?, updated_at = ? WHERE id = ?")
            .bind(text, Date.now(), noteId)
            .run();
          ctx.waitUntil(notifyBoardChange(env, note.board_id));
          return json({ ok: true });
        }

        if (method === "DELETE") {
          await env.DB.batch([
            env.DB.prepare("DELETE FROM votes WHERE note_id = ?").bind(noteId),
            env.DB.prepare("DELETE FROM notes WHERE id = ?").bind(noteId),
          ]);
          ctx.waitUntil(notifyBoardChange(env, note.board_id));
          return json({ ok: true });
        }
      }

      // ---- move a note (open to everyone): change column and/or position ----
      if ((m = path.match(/^\/api\/notes\/([a-z0-9]+)\/move$/)) && method === "POST") {
        const noteId = m[1];
        const note = await env.DB.prepare("SELECT id, board_id FROM notes WHERE id = ?").bind(noteId).first();
        if (!note) return json({ error: "note_not_found" }, 404);
        const body = await readBody(request);
        const column_key = (body.column_key || "").toString();
        if (!COLUMNS.has(column_key)) return json({ error: "invalid_column" }, 400);

        const beforeId = (body.before_id || "").toString() || null;
        let sort_order = null;
        if (beforeId) {
          const before = await env.DB.prepare(
            "SELECT sort_order FROM notes WHERE id = ? AND board_id = ? AND column_key = ?"
          )
            .bind(beforeId, note.board_id, column_key)
            .first();
          if (before) {
            const above = await env.DB.prepare(
              "SELECT sort_order FROM notes WHERE board_id = ? AND column_key = ? AND id != ? AND id != ? AND sort_order < ? ORDER BY sort_order DESC LIMIT 1"
            )
              .bind(note.board_id, column_key, noteId, beforeId, before.sort_order)
              .first();
            const upper = before.sort_order;
            const lower = above ? above.sort_order : upper - 2000;
            sort_order = (upper + lower) / 2;
          }
        }
        if (sort_order == null) {
          const maxRow = await env.DB.prepare(
            "SELECT MAX(sort_order) AS m FROM notes WHERE board_id = ? AND column_key = ?"
          )
            .bind(note.board_id, column_key)
            .first();
          sort_order = (maxRow?.m || 0) + 1000;
        }
        await env.DB.prepare("UPDATE notes SET column_key = ?, sort_order = ?, updated_at = ? WHERE id = ?")
          .bind(column_key, sort_order, Date.now(), noteId)
          .run();
        ctx.waitUntil(notifyBoardChange(env, note.board_id));
        return json({ ok: true, column_key, sort_order });
      }

      // ---- merge notes ----
      if ((m = path.match(/^\/api\/boards\/([a-z0-9]+)\/merge$/)) && method === "POST") {
        const boardId = m[1];
        const body = await readBody(request);
        const ids = Array.isArray(body.ids) ? body.ids.filter((x) => typeof x === "string" && x.length < 40) : [];
        if (ids.length < 2) return json({ error: "need_at_least_two" }, 400);
        const ph = ids.map(() => "?").join(",");
        const { results } = await env.DB.prepare(
          `SELECT id, board_id, column_key, text FROM notes WHERE id IN (${ph}) AND board_id = ?`
        )
          .bind(...ids, boardId)
          .all();
        if (results.length !== ids.length) return json({ error: "some_notes_not_found" }, 400);

        const survivorId = ids[0];
        const victimIds = ids.slice(1);
        const vph = victimIds.map(() => "?").join(",");
        const victimVotes = await env.DB.prepare(
          `SELECT voter FROM votes WHERE note_id IN (${vph})`
        )
          .bind(...victimIds)
          .all();
        const ordered = ids.map((id) => results.find((r) => r.id === id));
        const mergedText = ordered.map((r) => r.text).join("\n\n─────────────────────\n\n");
        await env.DB.batch([
          env.DB.prepare("UPDATE notes SET text = ?, updated_at = ? WHERE id = ?").bind(mergedText, Date.now(), survivorId),
          ...victimVotes.results.map((v) =>
            env.DB.prepare("INSERT OR IGNORE INTO votes (note_id, voter, created_at) VALUES (?, ?, ?)").bind(survivorId, v.voter, Date.now())
          ),
          ...victimIds.map((v) => env.DB.prepare("DELETE FROM votes WHERE note_id = ?").bind(v)),
          env.DB.prepare(`DELETE FROM notes WHERE id IN (${vph})`).bind(...victimIds),
        ]);
        ctx.waitUntil(notifyBoardChange(env, boardId));
        return json({ ok: true, survivor_id: survivorId, survivor_text: mergedText, deleted: victimIds.length });
      }

      // ---- toggle vote ----
      if ((m = path.match(/^\/api\/notes\/([a-z0-9]+)\/vote$/)) && method === "POST") {
        const noteId = m[1];
        const note = await env.DB.prepare("SELECT id, board_id FROM notes WHERE id = ?").bind(noteId).first();
        if (!note) return json({ error: "note_not_found" }, 404);

        const body = await readBody(request);
        const voter = (body.voter || "").toString().slice(0, 64);
        if (!voter) return json({ error: "invalid_voter" }, 400);

        const existing = await env.DB.prepare("SELECT 1 AS x FROM votes WHERE note_id = ? AND voter = ?")
          .bind(noteId, voter)
          .first();
        if (existing) {
          await env.DB.prepare("DELETE FROM votes WHERE note_id = ? AND voter = ?").bind(noteId, voter).run();
        } else {
          await env.DB.prepare("INSERT INTO votes (note_id, voter, created_at) VALUES (?, ?, ?)")
            .bind(noteId, voter, Date.now())
            .run();
        }
        const row = await env.DB.prepare("SELECT COUNT(*) AS c FROM votes WHERE note_id = ?")
          .bind(noteId)
          .first();
        ctx.waitUntil(notifyBoardChange(env, note.board_id));
        return json({ vote_count: row.c, voted: existing ? 0 : 1 });
      }

      return json({ error: "not_found" }, 404);
    } catch (err) {
      console.error("api error:", err);
      return json({ error: "internal_error" }, 500);
    }
  },
};
