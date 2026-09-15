// Free Retro — Worker API over D1.
// Static assets in ./public are served first; everything under /api/* lands here.
//
// Authorisation lives in ./access.js and identity in ./auth.js; this file is
// routing plus the handlers. Every mutating route calls a guard before it touches
// data, and identity is always derived from the session — never from the request
// body or a query parameter.
import { BoardRoom } from "./room.js";
import {
  assertNotLastAdmin,
  boardAccess,
  require,
  requireBoard,
  requireSignedIn,
  requireTeam,
  teamAccess,
} from "./access.js";
import {
  beginOAuth,
  createAuth,
  devLoginEnabled,
  devSignIn,
  enabledProviders,
  finishOAuth,
  meFromTicket,
  mintWsTicket,
  purgeExpiredSessions,
} from "./auth.js";
import { HttpError, json, readBody, rid, str, withCookies } from "./util.js";

export { BoardRoom };

const COLUMNS = new Set(["went_well", "to_improve", "actions"]);
const VISIBILITIES = new Set(["public", "team"]);

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

async function displayNameFor(env, me, fallback) {
  if (!me?.userId) return str(fallback, 40);
  const row = await env.DB.prepare("SELECT display_name, name, email FROM users WHERE id = ?").bind(me.userId).first();
  return str(row?.display_name || row?.name || row?.email?.split("@")[0], 40);
}

export default {
  // daily cron: purge boards that have sat in the trash for 30 days, and retire
  // expired sessions (handing their notes to the board owner first)
  async scheduled(event, env, ctx) {
    const cutoff = Date.now() - 30 * 864e5;
    const { results } = await env.DB.prepare(
      "SELECT id FROM boards WHERE deleted_at IS NOT NULL AND deleted_at < ? LIMIT 50"
    )
      .bind(cutoff)
      .all();
    if (results.length) {
      await env.DB.batch(
        results.flatMap((b) => [
          env.DB.prepare("DELETE FROM votes WHERE note_id IN (SELECT id FROM notes WHERE board_id = ?)").bind(b.id),
          env.DB.prepare("DELETE FROM notes WHERE board_id = ?").bind(b.id),
          env.DB.prepare("DELETE FROM boards WHERE id = ?").bind(b.id),
        ])
      );
      console.log(`purged ${results.length} board(s) past the 30-day trash window`);
    }

    const retired = await purgeExpiredSessions(env);
    if (retired) console.log(`retired ${retired} expired anonymous session(s)`);
  },

  async fetch(request, env, ctx) {
    const auth = createAuth(request, env);
    let res;
    try {
      res = await handle(request, env, ctx, auth);
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      if (status >= 500) console.error("api error:", err);
      const body = { error: err?.error || "internal_error" };
      if (err?.hint) body.hint = err.hint;
      res = json(body, status);
    }
    return withCookies(res, auth.cookies);
  },
};

async function handle(request, env, ctx, auth) {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;
  let m;

  // ---------------------------------------------------------------- auth

  // lightweight probe used at boot; always answerable, signed in or not
  if (path === "/api/auth/check") {
    const me = await auth.me();
    return json({ ok: true, kind: me.kind });
  }

  if (path === "/api/auth/providers") {
    return json({ providers: enabledProviders(env), dev_login: devLoginEnabled(env) });
  }

  if ((m = path.match(/^\/api\/auth\/login\/([a-z]+)$/)) && method === "GET") {
    const started = await beginOAuth(env, url, m[1], url.searchParams.get("return"));
    return new Response(null, {
      status: 302,
      headers: { location: started.location, "set-cookie": started.txCookie },
    });
  }

  if ((m = path.match(/^\/api\/auth\/callback\/([a-z]+)$/)) && method === "GET") {
    const { user, returnTo } = await finishOAuth(env, request, url, m[1]);
    await auth.signIn(user.id);
    return new Response(null, { status: 302, headers: { location: returnTo } });
  }

  if (path === "/api/auth/logout" && method === "POST") {
    await auth.signOut();
    return json({ ok: true });
  }

  // local development / test suite only — off unless explicitly enabled
  if (path === "/api/auth/dev-login" && method === "POST") {
    if (!devLoginEnabled(env)) return json({ error: "not_found" }, 404);
    const user = await devSignIn(env, await readBody(request));
    await auth.signIn(user.id);
    return json({ ok: true, user: { id: user.id, name: user.name, email: user.email } });
  }

  if (path === "/api/me" && method === "GET") {
    const me = await auth.me();
    if (!me.userId) {
      return json({ user: null, teams: [], providers: enabledProviders(env), dev_login: devLoginEnabled(env) });
    }
    const user = await env.DB.prepare("SELECT id, email, name, display_name, avatar_url FROM users WHERE id = ?")
      .bind(me.userId)
      .first();
    const { results: teams } = await env.DB.prepare(
      "SELECT t.id, t.name, tm.role FROM team_members tm JOIN teams t ON t.id = tm.team_id WHERE tm.user_id = ? ORDER BY tm.added_at"
    )
      .bind(me.userId)
      .all();
    return json({
      user: user ? { id: user.id, email: user.email, name: user.display_name || user.name, avatar: user.avatar_url } : null,
      teams,
      providers: enabledProviders(env),
      dev_login: devLoginEnabled(env),
    });
  }

  // display name override (rule 19). Identity stays untouched — this only changes
  // what other people see next to a note.
  if (path === "/api/me" && method === "PATCH") {
    const me = requireSignedIn(await auth.me());
    const body = await readBody(request);
    const name = str(body.display_name, 40);
    if (!name) return json({ error: "invalid_name" }, 400);
    await env.DB.prepare("UPDATE users SET display_name = ? WHERE id = ?").bind(name, me.userId).run();
    return json({ ok: true, display_name: name });
  }

  // ---------------------------------------------------------------- live room

  if ((m = path.match(/^\/api\/boards\/([a-z0-9]+)\/ws-ticket$/)) && method === "POST") {
    const access = requireBoard(await boardAccess(env, await auth.me(), m[1]));
    // a visitor with no session yet gets one here: the ticket has to name somebody
    const identity = await auth.ensureIdentity();
    const ticket = await mintWsTicket(env, identity.sessionId, access.board.id);
    return json({ ticket });
  }

  if ((m = path.match(/^\/api\/boards\/([a-z0-9]+)\/ws$/)) && method === "GET") {
    const me = await auth.me();
    const identity = me.identity ?? (await meFromTicket(env, url.searchParams.get("ticket"), m[1]));
    const access = await boardAccess(env, identity, m[1]);
    requireBoard(access);
    return env.BOARD_ROOM.get(env.BOARD_ROOM.idFromName(m[1])).fetch(request);
  }

  // ---------------------------------------------------------------- teams

  // "my teams" — a visitor has none, which is an empty list rather than an error,
  // because the home page asks for this on every load
  if (path === "/api/teams" && method === "GET") {
    const me = await auth.me();
    if (!me.userId) return json({ teams: [] });
    const { results } = await env.DB.prepare(
      `SELECT t.id, t.name, t.created_at, tm.role,
         (SELECT COUNT(*) FROM boards b WHERE b.team_id = t.id AND b.deleted_at IS NULL) AS board_count
       FROM team_members tm JOIN teams t ON t.id = tm.team_id
       WHERE tm.user_id = ?
       ORDER BY tm.added_at ASC LIMIT 50`
    )
      .bind(me.userId)
      .all();
    return json({ teams: results });
  }

  if (path === "/api/teams" && method === "POST") {
    const me = requireSignedIn(await auth.me());
    const body = await readBody(request);
    const name = str(body.name, 60) || "New team";
    const id = rid(8);
    const created_at = Date.now();
    await env.DB.batch([
      env.DB.prepare("INSERT INTO teams (id, name, created_at, created_by) VALUES (?, ?, ?, ?)").bind(
        id, name, created_at, me.userId
      ),
      // the creator is the team's first admin — rule 3
      env.DB.prepare("INSERT INTO team_members (team_id, user_id, role, added_by, added_at) VALUES (?, ?, 'admin', ?, ?)").bind(
        id, me.userId, me.userId, created_at
      ),
    ]);
    return json({ team: { id, name, created_at, role: "admin", board_count: 0 } }, 201);
  }

  if ((m = path.match(/^\/api\/teams\/([a-z0-9]+)$/))) {
    const teamId = m[1];
    const me = await auth.me();
    const access = await teamAccess(env, me, teamId);

    if (method === "GET") {
      requireTeam(access);
      return json({ team: access.team, role: access.member.role });
    }
    if (method === "PATCH") {
      requireTeam(access);
      require(access.canRename, "forbidden");
      const body = await readBody(request);
      const name = str(body.name, 60);
      if (!name) return json({ error: "invalid_name" }, 400);
      await env.DB.prepare("UPDATE teams SET name = ? WHERE id = ?").bind(name, teamId).run();
      return json({ team: { ...access.team, name } });
    }
    if (method === "DELETE") {
      requireTeam(access);
      require(access.canDelete, "forbidden");
      // purge the team and every board it owns (active + trash), notes and votes included
      const { results: boards } = await env.DB.prepare("SELECT id FROM boards WHERE team_id = ?").bind(teamId).all();
      await env.DB.batch([
        ...boards.flatMap((b) => [
          env.DB.prepare("DELETE FROM votes WHERE note_id IN (SELECT id FROM notes WHERE board_id = ?)").bind(b.id),
          env.DB.prepare("DELETE FROM notes WHERE board_id = ?").bind(b.id),
          env.DB.prepare("DELETE FROM boards WHERE id = ?").bind(b.id),
        ]),
        env.DB.prepare("DELETE FROM team_members WHERE team_id = ?").bind(teamId),
        env.DB.prepare("DELETE FROM teams WHERE id = ?").bind(teamId),
      ]);
      return json({ ok: true, removed_boards: boards.length });
    }
  }

  // ---- members ----
  if ((m = path.match(/^\/api\/teams\/([a-z0-9]+)\/members$/))) {
    const teamId = m[1];
    const me = await auth.me();
    const access = await teamAccess(env, me, teamId);
    requireTeam(access);

    if (method === "GET") {
      const { results } = await env.DB.prepare(
        `SELECT tm.user_id, tm.role, tm.added_at, u.name, u.display_name, u.email, u.avatar_url
         FROM team_members tm LEFT JOIN users u ON u.id = tm.user_id
         WHERE tm.team_id = ? ORDER BY tm.added_at`
      )
        .bind(teamId)
        .all();
      return json({ members: results });
    }

    if (method === "POST") {
      require(access.canAddMember, "forbidden");
      const body = await readBody(request);
      const email = str(body.email, 200).toLowerCase();
      const userId = str(body.user_id, 40);
      const role = body.role === "admin" ? "admin" : "member";
      const target = userId
        ? await env.DB.prepare("SELECT id FROM users WHERE id = ?").bind(userId).first()
        : await env.DB.prepare("SELECT id FROM users WHERE lower(email) = ?").bind(email).first();
      if (!target) return json({ error: "user_not_found" }, 404);
      await env.DB.prepare(
        "INSERT OR REPLACE INTO team_members (team_id, user_id, role, added_by, added_at) VALUES (?, ?, ?, ?, ?)"
      )
        .bind(teamId, target.id, role, me.userId, Date.now())
        .run();
      return json({ ok: true, user_id: target.id, role }, 201);
    }
  }

  if ((m = path.match(/^\/api\/teams\/([a-z0-9]+)\/members\/([a-z0-9]+)$/))) {
    const [, teamId, userId] = m;
    const me = await auth.me();
    const access = await teamAccess(env, me, teamId);
    requireTeam(access);

    const target = await env.DB.prepare("SELECT role FROM team_members WHERE team_id = ? AND user_id = ?")
      .bind(teamId, userId)
      .first();
    if (!target) return json({ error: "not_a_member" }, 404);

    if (method === "PATCH") {
      const role = (await readBody(request)).role === "admin" ? "admin" : "member";
      require(role === "admin" ? access.canGrantAdmin : access.canRevokeAdmin, "forbidden");
      if (target.role === "admin" && role !== "admin") await assertNotLastAdmin(env, teamId, userId);
      await env.DB.prepare("UPDATE team_members SET role = ? WHERE team_id = ? AND user_id = ?").bind(role, teamId, userId).run();
      return json({ ok: true, user_id: userId, role });
    }

    if (method === "DELETE") {
      require(access.canRemoveMember, "forbidden");
      if (target.role === "admin") await assertNotLastAdmin(env, teamId, userId);
      await env.DB.prepare("DELETE FROM team_members WHERE team_id = ? AND user_id = ?").bind(teamId, userId).run();
      return json({ ok: true });
    }
  }

  if ((m = path.match(/^\/api\/teams\/([a-z0-9]+)\/leave$/)) && method === "POST") {
    const teamId = m[1];
    const me = requireSignedIn(await auth.me());
    const access = await teamAccess(env, me, teamId);
    requireTeam(access);
    // leaving as the last admin would strand the team: there is no global admin
    // and no ownership transfer to recover it
    if (access.member.role === "admin") await assertNotLastAdmin(env, teamId, me.userId);
    await env.DB.prepare("DELETE FROM team_members WHERE team_id = ? AND user_id = ?").bind(teamId, me.userId).run();
    return json({ ok: true });
  }

  // ---- team-scoped boards list (active, or ?trash=1) ----
  if ((m = path.match(/^\/api\/teams\/([a-z0-9]+)\/boards$/)) && method === "GET") {
    const teamId = m[1];
    const access = await teamAccess(env, await auth.me(), teamId);
    requireTeam(access);
    const trash = url.searchParams.get("trash") === "1";
    if (trash) require(access.canListTrash, "forbidden");
    const { results } = await env.DB.prepare(
      `SELECT b.id, b.title, b.created_at, b.deleted_at, b.visibility, b.created_by,
         (SELECT COUNT(*) FROM notes n WHERE n.board_id = b.id) AS note_count,
         (SELECT MAX(n.updated_at) FROM notes n WHERE n.board_id = b.id) AS last_activity
       FROM boards b
       WHERE b.team_id = ?1 AND b.deleted_at IS ${trash ? "NOT NULL" : "NULL"}
       ORDER BY ${trash ? "b.deleted_at" : "COALESCE(last_activity, b.created_at)"} DESC
       LIMIT 200`
    )
      .bind(teamId)
      .all();
    return json({ boards: results });
  }

  // ---- team export: admins only (rule 15) ----
  if ((m = path.match(/^\/api\/teams\/([a-z0-9]+)\/export$/)) && method === "GET") {
    const teamId = m[1];
    const access = await teamAccess(env, await auth.me(), teamId);
    requireTeam(access);
    require(access.canExport, "forbidden");
    const team = access.team;

    const { results: boards } = await env.DB.prepare(
      `SELECT b.id, b.title, b.created_at
       FROM boards b
       WHERE b.team_id = ? AND b.deleted_at IS NULL
       ORDER BY b.created_at ASC`
    )
      .bind(teamId)
      .all();

    const boardsWithNotes = await Promise.all(
      boards.map(async (board) => {
        const { results: notes } = await env.DB.prepare(
          `SELECT n.id, n.column_key, n.text, n.author, n.created_at,
             (SELECT COUNT(*) FROM votes v WHERE v.note_id = n.id) AS vote_count
           FROM notes n
           WHERE n.board_id = ?
           ORDER BY n.column_key, n.sort_order ASC`
        )
          .bind(board.id)
          .all();
        return { ...board, notes };
      })
    );

    return json({ team, boards: boardsWithNotes });
  }

  // ---------------------------------------------------------------- boards

  if (path === "/api/boards" && method === "POST") {
    const me = requireSignedIn(await auth.me());
    const body = await readBody(request);
    const title = str(body.title, 120) || "Untitled retro";
    // A board belongs to a team, so the team must be named explicitly. The old
    // fallback ("attach to the oldest team") silently dropped a board into a
    // stranger's team.
    const teamId = str(body.team_id, 20);
    if (!teamId) return json({ error: "team_required" }, 400);
    const access = await teamAccess(env, me, teamId);
    requireTeam(access);
    const visibility = VISIBILITIES.has(body.visibility) ? body.visibility : "public";
    const id = rid(8);
    const created_at = Date.now();
    await env.DB.prepare(
      "INSERT INTO boards (id, title, created_at, team_id, created_by, visibility) VALUES (?, ?, ?, ?, ?, ?)"
    )
      .bind(id, title, created_at, teamId, me.userId, visibility)
      .run();
    return json({ board: { id, title, created_at, team_id: teamId, created_by: me.userId, visibility } }, 201);
  }

  // ---- single board ----
  if ((m = path.match(/^\/api\/boards\/([a-z0-9]+)$/))) {
    const boardId = m[1];
    const me = await auth.me();
    const access = await boardAccess(env, me, boardId);

    if (method === "GET") {
      // trashed boards stay visible to admins so a restore is an informed one
      if (!access || !access.canView) return json({ error: "board_not_found" }, 404);
      const board = access.board;
      if (board.deleted_at) return json({ board, notes: [], now: Date.now(), me: { ...access.boardFlags, trashed: 1 } });

      // expire stale timers on read so clients never see a dead countdown
      if (board.timer_ends_at && board.timer_ends_at < Date.now()) board.timer_ends_at = null;
      const identity = me.identity ?? "";
      const { results: notes } = await env.DB.prepare(
        `SELECT n.id, n.column_key, n.text, n.author, n.owner_id, n.created_at, n.updated_at, n.sort_order,
           (SELECT COUNT(*) FROM votes v WHERE v.note_id = n.id) AS vote_count,
           (SELECT COUNT(*) FROM votes v WHERE v.note_id = n.id AND v.voter = ?1) AS voted
         FROM notes n WHERE n.board_id = ?2 ORDER BY n.sort_order ASC`
      )
        .bind(identity, boardId)
        .all();
      return json({
        board,
        notes: notes.map((n) => ({ ...n, ...access.noteFlags(n) })),
        now: Date.now(),
        me: access.boardFlags,
      });
    }

    if (method === "PATCH") {
      requireBoard(access);
      const body = await readBody(request);
      const patch = {};
      if (body.title !== undefined) {
        const title = str(body.title, 120);
        if (!title) return json({ error: "invalid_title" }, 400);
        require(access.canRename, "forbidden");
        patch.title = title;
      }
      if (body.visibility !== undefined) {
        if (!VISIBILITIES.has(body.visibility)) return json({ error: "invalid_visibility" }, 400);
        require(access.canSetVisibility, "forbidden");
        patch.visibility = body.visibility;
      }
      if (!Object.keys(patch).length) return json({ error: "nothing_to_update" }, 400);

      const sets = Object.keys(patch).map((k) => `${k} = ?`);
      await env.DB.prepare(`UPDATE boards SET ${sets.join(", ")} WHERE id = ?`)
        .bind(...Object.values(patch), boardId)
        .run();
      ctx.waitUntil(notifyBoardChange(env, boardId));
      return json({ board: { ...access.board, ...patch } });
    }

    if (method === "DELETE") {
      requireBoard(access);
      if (url.searchParams.get("permanent") === "1") {
        require(access.canPurge, "forbidden");
        const notes = await env.DB.prepare("SELECT id FROM notes WHERE board_id = ?").bind(boardId).all();
        const stmts = notes.results.map((n) => env.DB.prepare("DELETE FROM votes WHERE note_id = ?").bind(n.id));
        stmts.push(env.DB.prepare("DELETE FROM notes WHERE board_id = ?").bind(boardId));
        stmts.push(env.DB.prepare("DELETE FROM boards WHERE id = ?").bind(boardId));
        await env.DB.batch(stmts);
        ctx.waitUntil(notifyBoardChange(env, boardId));
        return json({ ok: true, purged: true });
      }
      require(access.canDelete, "forbidden");
      await env.DB.prepare("UPDATE boards SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL")
        .bind(Date.now(), boardId)
        .run();
      ctx.waitUntil(notifyBoardChange(env, boardId));
      return json({ ok: true });
    }
  }

  // ---- silent-writing timer ----
  if ((m = path.match(/^\/api\/boards\/([a-z0-9]+)\/timer$/))) {
    const boardId = m[1];
    const access = requireBoard(await boardAccess(env, await auth.me(), boardId));
    require(access.canControlTimer, "forbidden");

    if (method === "POST") {
      const minutes = Number((await readBody(request)).minutes);
      if (!Number.isFinite(minutes) || minutes < 1 || minutes > 60) return json({ error: "invalid_minutes" }, 400);
      const now = Date.now();
      const timer_ends_at = now + Math.round(minutes * 60_000);
      await env.DB.prepare("UPDATE boards SET timer_ends_at = ? WHERE id = ?").bind(timer_ends_at, boardId).run();
      ctx.waitUntil(notifyBoardChange(env, boardId));
      return json({ board: { id: boardId, timer_ends_at }, now });
    }
    if (method === "DELETE") {
      await env.DB.prepare("UPDATE boards SET timer_ends_at = NULL WHERE id = ?").bind(boardId).run();
      ctx.waitUntil(notifyBoardChange(env, boardId));
      return json({ board: { id: boardId, timer_ends_at: null }, now: Date.now() });
    }
  }

  // ---- restore from trash (admins only, rule 10) ----
  if ((m = path.match(/^\/api\/boards\/([a-z0-9]+)\/restore$/)) && method === "POST") {
    const boardId = m[1];
    const access = await boardAccess(env, await auth.me(), boardId);
    if (!access) return json({ error: "board_not_found" }, 404);
    require(access.canRestore, "forbidden");
    await env.DB.prepare("UPDATE boards SET deleted_at = NULL WHERE id = ?").bind(boardId).run();
    ctx.waitUntil(notifyBoardChange(env, boardId));
    return json({ ok: true });
  }

  // ---- create note ----
  if ((m = path.match(/^\/api\/boards\/([a-z0-9]+)\/notes$/)) && method === "POST") {
    const boardId = m[1];
    const access = requireBoard(await boardAccess(env, await auth.me(), boardId));

    const body = await readBody(request);
    const column_key = str(body.column_key, 20);
    const text = str(body.text, 500);
    if (!COLUMNS.has(column_key)) return json({ error: "invalid_column" }, 400);
    if (!text) return json({ error: "invalid_text" }, 400);

    // only now mint an identity: a rejected or malformed request must not cost a
    // session row. ensureIdentity() returns the existing identity untouched.
    const me = await auth.ensureIdentity();
    const author = await displayNameFor(env, me, body.author);

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
      .bind(id, boardId, column_key, text, author, me.identity, sort_order, now, now)
      .run();
    ctx.waitUntil(notifyBoardChange(env, boardId));
    const note = { id, column_key, text, author, owner_id: me.identity, sort_order, created_at: now, updated_at: now };
    // the flags are computed against the freshly minted identity, not the identity
    // the guard ran with (a first-time visitor had none yet)
    return json({ note: { ...note, vote_count: 0, voted: 0, ...access.noteFlags(note, me.identity) } }, 201);
  }

  // ---- single note: edit / delete (owner or TADMIN only) ----
  if ((m = path.match(/^\/api\/notes\/([a-z0-9]+)$/))) {
    const noteId = m[1];
    const note = await env.DB.prepare("SELECT id, board_id, owner_id FROM notes WHERE id = ?").bind(noteId).first();
    if (!note) return json({ error: "note_not_found" }, 404);
    const access = requireBoard(await boardAccess(env, await auth.me(), note.board_id));

    if (method === "PATCH") {
      require(access.canEditNote(note), "forbidden");
      const text = str((await readBody(request)).text, 500);
      if (!text) return json({ error: "invalid_text" }, 400);
      await env.DB.prepare("UPDATE notes SET text = ?, updated_at = ? WHERE id = ?").bind(text, Date.now(), noteId).run();
      ctx.waitUntil(notifyBoardChange(env, note.board_id));
      return json({ ok: true });
    }

    if (method === "DELETE") {
      require(access.canDeleteNote(note), "forbidden");
      await env.DB.batch([
        env.DB.prepare("DELETE FROM votes WHERE note_id = ?").bind(noteId),
        env.DB.prepare("DELETE FROM notes WHERE id = ?").bind(noteId),
      ]);
      ctx.waitUntil(notifyBoardChange(env, note.board_id));
      return json({ ok: true });
    }
  }

  // ---- move a note: same tier as writing one (rule 16) ----
  if ((m = path.match(/^\/api\/notes\/([a-z0-9]+)\/move$/)) && method === "POST") {
    const noteId = m[1];
    const note = await env.DB.prepare("SELECT id, board_id FROM notes WHERE id = ?").bind(noteId).first();
    if (!note) return json({ error: "note_not_found" }, 404);
    const access = requireBoard(await boardAccess(env, await auth.me(), note.board_id));
    require(access.canMoveNote, "forbidden");

    const body = await readBody(request);
    const column_key = str(body.column_key, 20);
    if (!COLUMNS.has(column_key)) return json({ error: "invalid_column" }, 400);

    const beforeId = str(body.before_id, 40) || null;
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

  // ---- merge notes (board owner only, rule 8) ----
  if ((m = path.match(/^\/api\/boards\/([a-z0-9]+)\/merge$/)) && method === "POST") {
    const boardId = m[1];
    const access = requireBoard(await boardAccess(env, await auth.me(), boardId));
    require(access.canMerge, "forbidden");

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
    const victimVotes = await env.DB.prepare(`SELECT voter FROM votes WHERE note_id IN (${vph})`)
      .bind(...victimIds)
      .all();
    const ordered = ids.map((id) => results.find((r) => r.id === id));
    const mergedText = ordered.map((r) => r.text).join("\n╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌\n");
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

  // ---- toggle vote (rules 12 + 17: per identity, anonymous included) ----
  if ((m = path.match(/^\/api\/notes\/([a-z0-9]+)\/vote$/)) && method === "POST") {
    const noteId = m[1];
    const note = await env.DB.prepare("SELECT id, board_id FROM notes WHERE id = ?").bind(noteId).first();
    if (!note) return json({ error: "note_not_found" }, 404);
    const access = requireBoard(await boardAccess(env, await auth.me(), note.board_id));
    require(access.canVote, "forbidden");

    const me = await auth.ensureIdentity();
    const voter = me.identity;

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
    const row = await env.DB.prepare("SELECT COUNT(*) AS c FROM votes WHERE note_id = ?").bind(noteId).first();
    ctx.waitUntil(notifyBoardChange(env, note.board_id));
    return json({ vote_count: row.c, voted: existing ? 0 : 1 });
  }

  return json({ error: "not_found" }, 404);
}
