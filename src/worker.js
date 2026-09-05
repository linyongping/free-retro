// Free Retro — Worker API over D1.
// Static assets in ./public are served first; everything under /api/* lands here.

const ALPHABET = "23456789abcdefghjkmnpqrstuvwxyz"; // unambiguous lowercase
const COLUMNS = new Set(["went_well", "to_improve", "actions"]);

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
      "SELECT id FROM boards WHERE deleted_at IS NOT NULL AND deleted_at < ?"
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

  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;
    let m;

    try {
      // ---- boards collection (active, or ?trash=1 for the recycle bin) ----
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
        const id = rid(8);
        const created_at = Date.now();
        await env.DB.prepare("INSERT INTO boards (id, title, created_at) VALUES (?, ?, ?)")
          .bind(id, title, created_at)
          .run();
        return json({ board: { id, title, created_at } }, 201);
      }

      // ---- single board ----
      if ((m = path.match(/^\/api\/boards\/([a-z0-9]+)$/))) {
        const boardId = m[1];
        const board = await env.DB.prepare("SELECT id, title, created_at, timer_ends_at, deleted_at FROM boards WHERE id = ?")
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
            `SELECT n.id, n.column_key, n.text, n.author, n.created_at, n.updated_at,
               (SELECT COUNT(*) FROM votes v WHERE v.note_id = n.id) AS vote_count,
               (SELECT COUNT(*) FROM votes v WHERE v.note_id = n.id AND v.voter = ?) AS voted
             FROM notes n WHERE n.board_id = ? ORDER BY n.created_at ASC`
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
        return json({ board: { id: boardId, timer_ends_at }, now });
      }

      if ((m = path.match(/^\/api\/boards\/([a-z0-9]+)\/timer$/)) && method === "DELETE") {
        const boardId = m[1];
        await env.DB.prepare("UPDATE boards SET timer_ends_at = NULL WHERE id = ?").bind(boardId).run();
        return json({ board: { id: boardId, timer_ends_at: null }, now: Date.now() });
      }

      // ---- restore from trash ----
      if ((m = path.match(/^\/api\/boards\/([a-z0-9]+)\/restore$/)) && method === "POST") {
        await env.DB.prepare("UPDATE boards SET deleted_at = NULL WHERE id = ?").bind(m[1]).run();
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
          return json({ ok: true, purged: true });
        }
        await env.DB.prepare("UPDATE boards SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL")
          .bind(Date.now(), boardId)
          .run();
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
        if (!COLUMNS.has(column_key)) return json({ error: "invalid_column" }, 400);
        if (!text) return json({ error: "invalid_text" }, 400);

        const id = rid(10);
        const now = Date.now();
        await env.DB.prepare(
          "INSERT INTO notes (id, board_id, column_key, text, author, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
        )
          .bind(id, boardId, column_key, text, author, now, now)
          .run();
        return json(
          { note: { id, column_key, text, author, created_at: now, updated_at: now, vote_count: 0, voted: 0 } },
          201
        );
      }

      // ---- single note: edit / delete ----
      if ((m = path.match(/^\/api\/notes\/([a-z0-9]+)$/))) {
        const noteId = m[1];
        const note = await env.DB.prepare("SELECT id FROM notes WHERE id = ?").bind(noteId).first();
        if (!note) return json({ error: "note_not_found" }, 404);

        if (method === "PATCH") {
          const body = await readBody(request);
          const text = (body.text || "").toString().trim().slice(0, 500);
          if (!text) return json({ error: "invalid_text" }, 400);
          await env.DB.prepare("UPDATE notes SET text = ?, updated_at = ? WHERE id = ?")
            .bind(text, Date.now(), noteId)
            .run();
          return json({ ok: true });
        }

        if (method === "DELETE") {
          await env.DB.batch([
            env.DB.prepare("DELETE FROM votes WHERE note_id = ?").bind(noteId),
            env.DB.prepare("DELETE FROM notes WHERE id = ?").bind(noteId),
          ]);
          return json({ ok: true });
        }
      }

      // ---- toggle vote ----
      if ((m = path.match(/^\/api\/notes\/([a-z0-9]+)\/vote$/)) && method === "POST") {
        const noteId = m[1];
        const note = await env.DB.prepare("SELECT id FROM notes WHERE id = ?").bind(noteId).first();
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
        return json({ vote_count: row.c, voted: existing ? 0 : 1 });
      }

      return json({ error: "not_found" }, 404);
    } catch (err) {
      console.error("api error:", err);
      return json({ error: "internal_error" }, 500);
    }
  },
};
