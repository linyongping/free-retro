// API integration tests for Free Retro.
// Requires a running dev/prod server: TEST_BASE (default http://localhost:8787).
//
// Sign-in uses the dev-login endpoint, which only exists when ALLOW_DEV_LOGIN=1
// (set in .dev.vars locally; CI writes its own). That keeps the suite off OAuth
// while still exercising real sessions, roles and ownership.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";

const BASE = process.env.TEST_BASE ?? "http://localhost:8787";
const createdTeamIds = [];

// ---------------------------------------------------------------- test clients

// A client owns its own cookie jar, so several identities can talk to the API at
// once (that is the whole point of the permission tests).
function client() {
  const jar = new Map();

  function cookieHeader() {
    return [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
  }

  async function api(path, { method = "GET", body, raw } = {}) {
    const res = await fetch(BASE + path, {
      method,
      headers: { "content-type": "application/json", ...(jar.size ? { cookie: cookieHeader() } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      redirect: raw === "manual" ? "manual" : "follow",
    });
    const setCookies = res.headers.getSetCookie?.() ?? (res.headers.get("set-cookie") ? [res.headers.get("set-cookie")] : []);
    for (const c of setCookies) {
      const [pair] = c.split(";");
      const eq = pair.indexOf("=");
      const name = pair.slice(0, eq);
      const value = pair.slice(eq + 1);
      if (!value) jar.delete(name);
      else jar.set(name, value);
    }
    let data = null;
    try { data = await res.json(); } catch {}
    return { status: res.status, data, headers: res.headers };
  }

  return { api, jar };
}

const visitor = client();

async function signIn(name, email) {
  const c = client();
  const res = await c.api("/api/auth/dev-login", { method: "POST", body: { email, name } });
  assert.equal(res.status, 200, `dev-login failed for ${email}: ${JSON.stringify(res.data)}`);
  return c;
}

// a fresh team owned by `owner`, with one public board in it
async function makeTeam(owner, name = "QA team") {
  const t = await owner.api("/api/teams", { method: "POST", body: { name } });
  assert.equal(t.status, 201, JSON.stringify(t.data));
  createdTeamIds.push(t.data.team.id);
  const b = await owner.api("/api/boards", { method: "POST", body: { title: "QA board", team_id: t.data.team.id } });
  assert.equal(b.status, 201, JSON.stringify(b.data));
  return { teamId: t.data.team.id, boardId: b.data.board.id };
}

let alice;   // team admin (created the team)
let bob;     // a plain member of alice's team

before(async () => {
  alice = await signIn("Alice", "alice@example.com");
  bob = await signIn("Bob", "bob@example.com");
});

after(async () => {
  for (const id of createdTeamIds) await alice.api(`/api/teams/${id}`, { method: "DELETE" });
});

// ----------------------------------------------------------------------- auth

test("auth: a visitor is anonymous, dev-login identifies them", async () => {
  const me = await visitor.api("/api/me");
  assert.equal(me.status, 200);
  assert.equal(me.data.user, null);

  const signed = await signIn("Zoe", "zoe@example.com");
  const after = await signed.api("/api/me");
  assert.equal(after.data.user.email, "zoe@example.com");
  assert.deepEqual(after.data.teams, []);
});

test("auth: mutating endpoints reject an anonymous visitor", async () => {
  assert.equal((await visitor.api("/api/teams", { method: "POST", body: { name: "nope" } })).status, 401);
  assert.equal((await visitor.api("/api/me", { method: "PATCH", body: { display_name: "nope" } })).status, 401);
});

test("auth: a visitor gets an empty team list rather than an error", async () => {
  const res = await visitor.api("/api/teams");
  assert.equal(res.status, 200);
  assert.deepEqual(res.data.teams, []);
});

test("auth: signing out drops the session", async () => {
  const zoe = await signIn("Zoe2", "zoe2@example.com");
  assert.ok((await zoe.api("/api/me")).data.user);
  await zoe.api("/api/auth/logout", { method: "POST" });
  assert.equal((await zoe.api("/api/me")).data.user, null);
});

// ---------------------------------------------------------------------- teams

test("teams: the creator becomes the team admin", async () => {
  const { teamId } = await makeTeam(alice, "QA admin team");
  const t = await alice.api(`/api/teams/${teamId}`);
  assert.equal(t.status, 200);
  assert.equal(t.data.role, "admin");

  const list = await alice.api("/api/teams");
  assert.ok(list.data.teams.some((x) => x.id === teamId && x.role === "admin"));
});

test("teams: a non-member gets 404, never 403", async () => {
  const { teamId, boardId } = await makeTeam(alice, "QA private team");
  assert.equal((await bob.api(`/api/teams/${teamId}`)).status, 404);
  assert.equal((await bob.api(`/api/teams/${teamId}/boards`)).status, 404);
  assert.equal((await bob.api(`/api/teams/${teamId}`, { method: "PATCH", body: { name: "x" } })).status, 404);
  // a public board is still readable by link, which is what makes sharing work
  assert.equal((await bob.api(`/api/boards/${boardId}`)).status, 200);
});

test("members: an admin can add, promote, demote and remove", async () => {
  const { teamId } = await makeTeam(alice, "QA roster team");
  const bobUser = (await bob.api("/api/me")).data.user.id;

  const added = await alice.api(`/api/teams/${teamId}/members`, { method: "POST", body: { user_id: bobUser } });
  assert.equal(added.status, 201);
  assert.equal(added.data.role, "member");

  const promoted = await alice.api(`/api/teams/${teamId}/members/${bobUser}`, { method: "PATCH", body: { role: "admin" } });
  assert.equal(promoted.status, 200);
  assert.equal((await bob.api(`/api/teams/${teamId}`)).data.role, "admin");

  const demoted = await alice.api(`/api/teams/${teamId}/members/${bobUser}`, { method: "PATCH", body: { role: "member" } });
  assert.equal(demoted.status, 200);

  assert.equal((await alice.api(`/api/teams/${teamId}/members/${bobUser}`, { method: "DELETE" })).status, 200);
  assert.equal((await bob.api(`/api/teams/${teamId}`)).status, 404, "a removed member loses sight of the team");
});

test("members: a plain member cannot manage the roster", async () => {
  const { teamId } = await makeTeam(alice, "QA member limits");
  const bobUser = (await bob.api("/api/me")).data.user.id;
  await alice.api(`/api/teams/${teamId}/members`, { method: "POST", body: { user_id: bobUser } });

  const added = await bob.api(`/api/teams/${teamId}/members`, { method: "POST", body: { email: "someone@example.com" } });
  assert.equal(added.status, 403);
  assert.equal((await bob.api(`/api/teams/${teamId}/members/${bobUser}`, { method: "PATCH", body: { role: "admin" } })).status, 403);
  assert.equal((await bob.api(`/api/teams/${teamId}`, { method: "DELETE" })).status, 403);
});

test("members: the last admin cannot be demoted, removed or leave", async () => {
  const { teamId } = await makeTeam(alice, "QA last admin");
  const aliceUser = (await alice.api("/api/me")).data.user.id;

  const demote = await alice.api(`/api/teams/${teamId}/members/${aliceUser}`, { method: "PATCH", body: { role: "member" } });
  assert.equal(demote.status, 409);
  assert.equal((await alice.api(`/api/teams/${teamId}/members/${aliceUser}`, { method: "DELETE" })).status, 409);
  assert.equal((await alice.api(`/api/teams/${teamId}/leave`, { method: "POST" })).status, 409);
});

test("members: leaving is allowed once another admin exists", async () => {
  const { teamId } = await makeTeam(alice, "QA leave team");
  const bobUser = (await bob.api("/api/me")).data.user.id;
  await alice.api(`/api/teams/${teamId}/members`, { method: "POST", body: { user_id: bobUser, role: "admin" } });
  const left = await alice.api(`/api/teams/${teamId}/leave`, { method: "POST" });
  assert.equal(left.status, 200);
  assert.equal((await alice.api(`/api/teams/${teamId}`)).status, 404);
  // reinstate so cleanup can still delete the team
  await bob.api(`/api/teams/${teamId}/members`, { method: "POST", body: { user_id: (await alice.api("/api/me")).data.user.id, role: "admin" } });
});

// --------------------------------------------------------------------- boards

test("boards: creation needs an explicit team the caller belongs to", async () => {
  const missing = await alice.api("/api/boards", { method: "POST", body: { title: "no team" } });
  assert.equal(missing.status, 400);
  assert.equal(missing.data.error, "team_required");

  const { teamId } = await makeTeam(alice, "QA board rules");
  assert.equal((await bob.api("/api/boards", { method: "POST", body: { title: "x", team_id: teamId } })).status, 404);
  assert.equal((await visitor.api("/api/boards", { method: "POST", body: { title: "x", team_id: teamId } })).status, 401);
});

test("boards: a public board is readable and writable by a visitor (R1 + R2)", async () => {
  const { boardId } = await makeTeam(alice, "QA public sharing");
  const read = await visitor.api(`/api/boards/${boardId}`);
  assert.equal(read.status, 200);
  assert.equal(read.data.board.visibility, "public");

  const note = await visitor.api(`/api/boards/${boardId}/notes`, {
    method: "POST",
    body: { column_key: "went_well", text: "anonymous idea", author: "Anonymous" },
  });
  assert.equal(note.status, 201, JSON.stringify(note.data));
  assert.equal(note.data.note.can_edit, 1, "a visitor owns the note they just wrote");

  const state = await visitor.api(`/api/boards/${boardId}`);
  const mine = state.data.notes.find((n) => n.id === note.data.note.id);
  assert.equal(mine.mine, 1);
  assert.equal(mine.can_edit, 1);
});

test("boards: a team-only board is invisible to visitors and non-members", async () => {
  const { teamId, boardId } = await makeTeam(alice, "QA team-only board");
  const flip = await alice.api(`/api/boards/${boardId}`, { method: "PATCH", body: { visibility: "team" } });
  assert.equal(flip.status, 200);
  assert.equal(flip.data.board.visibility, "team");

  assert.equal((await visitor.api(`/api/boards/${boardId}`)).status, 404);
  assert.equal((await bob.api(`/api/boards/${boardId}`)).status, 404);
  assert.equal((await alice.api(`/api/boards/${boardId}`)).status, 200);

  const rejected = await visitor.api(`/api/boards/${boardId}/notes`, {
    method: "POST",
    body: { column_key: "went_well", text: "should not land", author: "x" },
  });
  assert.equal(rejected.status, 404, "a denied reader must not learn the board exists");
  assert.equal((await alice.api(`/api/teams/${teamId}/boards`)).data.boards.length, 1);
});

test("boards: only the owner or an admin may rename it", async () => {
  const { teamId, boardId } = await makeTeam(alice, "QA rename rules");
  const bobUser = (await bob.api("/api/me")).data.user.id;
  await alice.api(`/api/teams/${teamId}/members`, { method: "POST", body: { user_id: bobUser } });

  // bob is a member but not the owner
  assert.equal((await bob.api(`/api/boards/${boardId}`, { method: "PATCH", body: { title: "hijacked" } })).status, 403);
  assert.equal((await alice.api(`/api/boards/${boardId}`, { method: "PATCH", body: { title: "renamed" } })).status, 200, "the owner may rename");
  assert.equal((await visitor.api(`/api/boards/${boardId}`, { method: "PATCH", body: { title: "x" } })).status, 403);
});

test("boards: a removed member loses control of the board they created", async () => {
  // the regression this whole guard exists for: created_by survives removal, so a
  // bare owner check would leave them able to rename, delete and — worst —
  // flip the board public after they were kicked out
  const { teamId } = await makeTeam(alice, "QA removed owner");
  const bobUser = (await bob.api("/api/me")).data.user.id;
  await alice.api(`/api/teams/${teamId}/members`, { method: "POST", body: { user_id: bobUser } });

  const mine = await bob.api("/api/boards", { method: "POST", body: { title: "bob's board", team_id: teamId } });
  assert.equal(mine.status, 201);
  const boardId = mine.data.board.id;
  assert.equal((await bob.api(`/api/boards/${boardId}`, { method: "PATCH", body: { title: "still mine" } })).status, 200);

  await alice.api(`/api/teams/${teamId}/members/${bobUser}`, { method: "DELETE" });

  const afterRemoval = await bob.api(`/api/boards/${boardId}`, { method: "PATCH", body: { title: "hijacked" } });
  assert.equal(afterRemoval.status, 403, "board management must require current membership");
  assert.equal((await bob.api(`/api/boards/${boardId}`, { method: "PATCH", body: { visibility: "public" } })).status, 403);
  assert.equal((await bob.api(`/api/boards/${boardId}`, { method: "DELETE" })).status, 403);
  assert.equal((await alice.api(`/api/boards/${boardId}`, { method: "DELETE" })).status, 200, "the admin still can");
});

test("boards: the owner may soft-delete but not restore or purge", async () => {
  const { teamId } = await makeTeam(alice, "QA trash rules");
  const bobUser = (await bob.api("/api/me")).data.user.id;
  await alice.api(`/api/teams/${teamId}/members`, { method: "POST", body: { user_id: bobUser } });
  const board = (await bob.api("/api/boards", { method: "POST", body: { title: "bob's trash", team_id: teamId } })).data.board;

  assert.equal((await bob.api(`/api/boards/${board.id}/restore`, { method: "POST" })).status, 403, "restore is admin-only (rule 10)");
  assert.equal((await bob.api(`/api/boards/${board.id}?permanent=1`, { method: "DELETE" })).status, 403, "purge is admin-only");

  assert.equal((await bob.api(`/api/boards/${board.id}`, { method: "DELETE" })).status, 200);
  assert.equal((await bob.api(`/api/boards/${board.id}`)).status, 404);
  // admins can still see into the trash to make an informed restore
  assert.equal((await alice.api(`/api/boards/${board.id}`)).status, 200);
  assert.equal((await alice.api(`/api/boards/${board.id}/restore`, { method: "POST" })).status, 200);
  assert.equal((await alice.api(`/api/boards/${board.id}?permanent=1`, { method: "DELETE" })).status, 200);
});

test("boards: the trash list is admin-only", async () => {
  const { teamId, boardId } = await makeTeam(alice, "QA trash list");
  const bobUser = (await bob.api("/api/me")).data.user.id;
  await alice.api(`/api/teams/${teamId}/members`, { method: "POST", body: { user_id: bobUser } });
  await alice.api(`/api/boards/${boardId}`, { method: "DELETE" });

  assert.equal((await bob.api(`/api/teams/${teamId}/boards?trash=1`)).status, 403);
  const trash = await alice.api(`/api/teams/${teamId}/boards?trash=1`);
  assert.ok(trash.data.boards.some((b) => b.id === boardId));
});

// ---------------------------------------------------------------------- notes

test("notes: ownership decides edit and delete, not membership alone", async () => {
  const { teamId, boardId } = await makeTeam(alice, "QA note ownership");
  const bobUser = (await bob.api("/api/me")).data.user.id;
  await alice.api(`/api/teams/${teamId}/members`, { method: "POST", body: { user_id: bobUser } });

  const bobsNote = (await bob.api(`/api/boards/${boardId}/notes`, {
    method: "POST", body: { column_key: "went_well", text: "bob's note" },
  })).data.note;

  // alice is the team admin, so she may — that is the moderation path
  const adminEdit = await alice.api(`/api/notes/${bobsNote.id}`, { method: "PATCH", body: { text: "moderated" } });
  assert.equal(adminEdit.status, 200);

  const carol = await signIn("Carol", "carol@example.com");
  await alice.api(`/api/teams/${teamId}/members`, { method: "POST", body: { user_id: (await carol.api("/api/me")).data.user.id } });
  const carolTries = await carol.api(`/api/notes/${bobsNote.id}`, { method: "PATCH", body: { text: "not mine" } });
  assert.equal(carolTries.status, 403, "a fellow member cannot edit someone else's note");

  // the owner can still edit their own
  assert.equal((await bob.api(`/api/notes/${bobsNote.id}`, { method: "PATCH", body: { text: "mine again" } })).status, 200);
  assert.equal((await bob.api(`/api/notes/${bobsNote.id}`, { method: "DELETE" })).status, 200);
});

test("notes: a visitor can edit their own note and nobody else's", async () => {
  const { boardId } = await makeTeam(alice, "QA anon ownership");
  const anon = client();
  const mine = (await anon.api(`/api/boards/${boardId}/notes`, {
    method: "POST", body: { column_key: "to_improve", text: "anon note", author: "visitor" },
  })).data.note;

  const alices = (await alice.api(`/api/boards/${boardId}/notes`, {
    method: "POST", body: { column_key: "to_improve", text: "alice note" },
  })).data.note;

  assert.equal((await anon.api(`/api/notes/${mine.id}`, { method: "PATCH", body: { text: "edited myself" } })).status, 200);
  assert.equal((await anon.api(`/api/notes/${alices.id}`, { method: "PATCH", body: { text: "not mine" } })).status, 403);

  // a different visitor is a different identity
  const other = client();
  await other.api(`/api/boards/${boardId}`);
  assert.equal((await other.api(`/api/notes/${mine.id}`, { method: "PATCH", body: { text: "spoofed" } })).status, 403);

  // and the server never trusts a client-supplied identity
  const spoof = await other.api(`/api/notes/${mine.id}`, {
    method: "PATCH", body: { text: "spoofed", voter: "whatever", owner_id: "whatever" },
  });
  assert.equal(spoof.status, 403);
});

test("notes: the display name is client-supplied but grants nothing", async () => {
  const { boardId } = await makeTeam(alice, "QA display name");
  const n = await visitor.api(`/api/boards/${boardId}/notes`, {
    method: "POST", body: { column_key: "actions", text: "impersonation attempt", author: "Alice (admin)" },
  });
  assert.equal(n.status, 201);
  assert.equal(n.data.note.author, "Alice (admin)", "rule 19 allows the override");
  assert.equal(n.data.note.can_edit, 1, "…and the identity behind it is still just the visitor");
});

test("notes: a member's display name comes from their account", async () => {
  const { boardId } = await makeTeam(alice, "QA account name");
  await alice.api("/api/me", { method: "PATCH", body: { display_name: "Alice the Admin" } });
  const n = (await alice.api(`/api/boards/${boardId}/notes`, {
    method: "POST", body: { column_key: "actions", text: "signed note", author: "ignored" },
  })).data.note;
  assert.equal(n.author, "Alice the Admin");
});

test("notes: create, order, move and vote", async () => {
  const { boardId } = await makeTeam(alice, "QA note mechanics");
  for (const [i, col] of ["went_well", "to_improve", "actions"].entries()) {
    const n = await alice.api(`/api/boards/${boardId}/notes`, { method: "POST", body: { column_key: col, text: `note ${i + 1}` } });
    assert.equal(n.status, 201);
  }
  const state = await alice.api(`/api/boards/${boardId}`);
  assert.equal(state.data.notes.length, 3);
  const orders = state.data.notes.map((n) => n.sort_order);
  assert.deepEqual(orders, [...orders].sort((a, b) => a - b));

  const [n1, n2] = state.data.notes;
  const mv = await alice.api(`/api/notes/${n1.id}/move`, { method: "POST", body: { column_key: n2.column_key, before_id: n2.id } });
  assert.equal(mv.status, 200);
  assert.ok(mv.data.sort_order < n2.sort_order);

  const on = await alice.api(`/api/notes/${n2.id}/vote`, { method: "POST" });
  assert.equal(on.data.vote_count, 1);
  assert.equal(on.data.voted, 1);
  const off = await alice.api(`/api/notes/${n2.id}/vote`, { method: "POST" });
  assert.equal(off.data.vote_count, 0);
  assert.equal(off.data.voted, 0);
});

test("notes: a visitor can vote, and the vote sticks to their session", async () => {
  const { boardId } = await makeTeam(alice, "QA anon voting");
  const n = (await alice.api(`/api/boards/${boardId}/notes`, { method: "POST", body: { column_key: "actions", text: "vote for me" } })).data.note;

  const anon = client();
  const first = await anon.api(`/api/notes/${n.id}/vote`, { method: "POST" });
  assert.equal(first.data.vote_count, 1);
  assert.ok(anon.jar.has("retro_anon"), "the anonymous session is issued on the first write");

  const again = await anon.api(`/api/notes/${n.id}/vote`, { method: "POST" });
  assert.equal(again.data.vote_count, 0);

  // someone else is a different voter
  await visitor.api(`/api/notes/${n.id}/vote`, { method: "POST" });
  const state = await visitor.api(`/api/boards/${boardId}`);
  assert.equal(state.data.notes.find((x) => x.id === n.id).vote_count, 1);
});

test("merge: only the board owner, not the team admin (rule 8)", async () => {
  const { teamId } = await makeTeam(alice, "QA merge rules");
  const bobUser = (await bob.api("/api/me")).data.user.id;
  await alice.api(`/api/teams/${teamId}/members`, { method: "POST", body: { user_id: bobUser } });

  const bobsBoard = (await bob.api("/api/boards", { method: "POST", body: { title: "bob owns this", team_id: teamId } })).data.board;
  const a = (await bob.api(`/api/boards/${bobsBoard.id}/notes`, { method: "POST", body: { column_key: "went_well", text: "first" } })).data.note;
  const b = (await bob.api(`/api/boards/${bobsBoard.id}/notes`, { method: "POST", body: { column_key: "went_well", text: "second" } })).data.note;

  const adminTry = await alice.api(`/api/boards/${bobsBoard.id}/merge`, { method: "POST", body: { ids: [a.id, b.id] } });
  assert.equal(adminTry.status, 403, "the team admin does not get merge");

  const ownerTry = await bob.api(`/api/boards/${bobsBoard.id}/merge`, { method: "POST", body: { ids: [a.id, b.id] } });
  assert.equal(ownerTry.status, 200);
  assert.equal(ownerTry.data.deleted, 1);
  const state = await bob.api(`/api/boards/${bobsBoard.id}`);
  assert.equal(state.data.notes.length, 1);
});

// --------------------------------------------------------------------- export

test("export: admins only (rule 15)", async () => {
  const { teamId } = await makeTeam(alice, "QA export");
  const bobUser = (await bob.api("/api/me")).data.user.id;
  await alice.api(`/api/teams/${teamId}/members`, { method: "POST", body: { user_id: bobUser } });

  assert.equal((await bob.api(`/api/teams/${teamId}/export`)).status, 403);
  assert.equal((await visitor.api(`/api/teams/${teamId}/export`)).status, 404);
  const ok = await alice.api(`/api/teams/${teamId}/export`);
  assert.equal(ok.status, 200);
  assert.ok(Array.isArray(ok.data.boards));
});

// ------------------------------------------------------------------- teardown

test("team delete: cascades to boards, notes and votes", async () => {
  const t = (await alice.api("/api/teams", { method: "POST", body: { name: "QA doomed team" } })).data.team;
  const b = (await alice.api("/api/boards", { method: "POST", body: { title: "doomed", team_id: t.id } })).data.board;
  const n = (await alice.api(`/api/boards/${b.id}/notes`, { method: "POST", body: { column_key: "actions", text: "doomed note" } })).data.note;
  await alice.api(`/api/notes/${n.id}/vote`, { method: "POST" });

  assert.equal((await alice.api(`/api/teams/${t.id}`, { method: "DELETE" })).status, 200);
  assert.equal((await alice.api(`/api/teams/${t.id}`)).status, 404);
  assert.equal((await alice.api(`/api/boards/${b.id}`)).status, 404);
});

// ------------------------------------------------------------------ websocket

function wsConnect(url) {
  return new Promise((resolve) => {
    const result = { ws: new WebSocket(url), opened: false, messages: [] };
    result.ws.onopen = () => { result.opened = true; resolve(result); };
    result.ws.onclose = () => resolve(result);
    result.ws.onerror = () => resolve(result);
    result.ws.onmessage = (e) => result.messages.push(JSON.parse(e.data));
    setTimeout(() => resolve(result), 3000);
  });
}

test("ws: read access is the only gate, so a public board accepts a bare socket", async () => {
  const { boardId } = await makeTeam(alice, "QA ws public");
  const conn = await wsConnect(BASE.replace(/^http/, "ws") + `/api/boards/${boardId}/ws`);
  assert.equal(conn.opened, true, "a readable board is streamable; the socket only carries a change ping");
  conn.ws.close();
});

test("ws: a ticket opens the socket and mutations ping it", async () => {
  const { boardId } = await makeTeam(alice, "QA websocket");

  const ticket = await alice.api(`/api/boards/${boardId}/ws-ticket`, { method: "POST" });
  assert.equal(ticket.status, 200);
  const conn = await wsConnect(`${BASE.replace(/^http/, "ws")}/api/boards/${boardId}/ws?ticket=${encodeURIComponent(ticket.data.ticket)}`);
  assert.equal(conn.opened, true, "a valid ticket should open the socket");

  await alice.api(`/api/boards/${boardId}/notes`, { method: "POST", body: { column_key: "went_well", text: "ws ping" } });
  await new Promise((r) => setTimeout(r, 1200));
  conn.ws.close();
  assert.ok(conn.messages.some((m) => m.type === "changed"), `expected a changed ping, got ${JSON.stringify(conn.messages)}`);
});

test("ws: neither a visitor nor a bogus ticket may join a team-only board", async () => {
  const { boardId } = await makeTeam(alice, "QA ws privacy");
  await alice.api(`/api/boards/${boardId}`, { method: "PATCH", body: { visibility: "team" } });

  assert.equal((await wsConnect(BASE.replace(/^http/, "ws") + `/api/boards/${boardId}/ws`)).opened, false);
  assert.equal(
    (await wsConnect(`${BASE.replace(/^http/, "ws")}/api/boards/${boardId}/ws?ticket=1.2.3`)).opened,
    false,
    "a forged ticket must not open anything"
  );
  // and a ticket minted for one board must not open another
  const { boardId: otherBoard } = await makeTeam(alice, "QA ws other board");
  const ticket = (await alice.api(`/api/boards/${otherBoard}/ws-ticket`, { method: "POST" })).data.ticket;
  assert.equal(
    (await wsConnect(`${BASE.replace(/^http/, "ws")}/api/boards/${boardId}/ws?ticket=${encodeURIComponent(ticket)}`)).opened,
    false
  );
});
