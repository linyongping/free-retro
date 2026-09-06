// API integration tests for Free Retro.
// Requires a running dev/prod server: TEST_BASE (default http://localhost:8787).
// The site passcode is read from TEST_PASSCODE or ../.dev.vars automatically.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHmac } from "node:crypto";

const BASE = process.env.TEST_BASE ?? "http://localhost:8787";
let cookie = "";
let sitePasscode = process.env.TEST_PASSCODE ?? "";
const createdTeamIds = [];

function wsToken() {
  const exp = String(Date.now() + 3600 * 1000);
  const sig = createHmac("sha256", sitePasscode).update(exp).digest("hex");
  return `${exp}.${sig}`;
}

// resolves on open, close/error, or after a 3s timeout
function wsConnect(url) {
  return new Promise((resolve) => {
    const result = { ws: new WebSocket(url), opened: false, closed: false, messages: [] };
    result.ws.onopen = () => { result.opened = true; resolve(result); };
    result.ws.onclose = () => { result.closed = true; resolve(result); };
    result.ws.onerror = () => { result.closed = true; resolve(result); };
    result.ws.onmessage = (e) => result.messages.push(JSON.parse(e.data));
    setTimeout(() => resolve(result), 3000);
  });
}

async function api(path, { method = "GET", body, voter } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      "content-type": "application/json",
      cookie,
      ...(voter ? { "x-test-voter": voter } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const setCookie = res.headers.get("set-cookie");
  if (setCookie) cookie = setCookie.split(";")[0];
  let data = null;
  try { data = await res.json(); } catch {}
  return { status: res.status, data };
}

before(async () => {
  let passcode = process.env.TEST_PASSCODE;
  if (!passcode) {
    try {
      for (const line of readFileSync(new URL("../.dev.vars", import.meta.url), "utf8").split("\n")) {
        const m = line.match(/^SITE_PASSCODE=(.*)$/);
        if (m) passcode = m[1].trim();
      }
    } catch {}
  }
  const check = await api("/api/auth/check");
  if (!check.data?.ok) {
    assert.ok(passcode, "site is locked but no passcode found (set TEST_PASSCODE or .dev.vars)");
    const login = await api("/api/auth/login", { method: "POST", body: { passcode } });
    assert.equal(login.status, 200, "login failed — passcode rejected");
    sitePasscode = passcode;
  }
});

after(async () => {
  for (const id of createdTeamIds) {
    await api(`/api/teams/${id}`, { method: "DELETE" });
  }
});

test("auth: unauthenticated API is rejected, check endpoint reports it", async () => {
  const saved = cookie;
  cookie = "";
  const res = await api("/api/teams");
  cookie = saved;
  assert.equal(res.status, 401);
});

test("team: create shows up in the list, rename persists", async () => {
  const t1 = await api("/api/teams", { method: "POST", body: { name: "QA team" } });
  assert.equal(t1.status, 201);
  createdTeamIds.push(t1.data.team.id);
  const list = await api("/api/teams");
  assert.ok(list.data.teams.some((t) => t.id === t1.data.team.id && t.name === "QA team"));
  const ren = await api(`/api/teams/${t1.data.team.id}`, { method: "PATCH", body: { name: "QA team renamed" } });
  assert.equal(ren.status, 200);
  assert.equal(ren.data.team.name, "QA team renamed");
});

test("board: create lands in its team with a title", async () => {
  const teams = (await api("/api/teams")).data.teams;
  const tid = teams[teams.length - 1].id;
  const b1 = await api("/api/boards", { method: "POST", body: { title: "QA board", team_id: tid } });
  assert.equal(b1.status, 201);
  assert.equal(b1.data.board.team_id, tid);
  const list = await api(`/api/teams/${tid}/boards`);
  assert.ok(list.data.boards.some((b) => b.id === b1.data.board.id && b.title === "QA board"));
});

test("notes: create in every column, state returns them ordered with sort_order", async () => {
  const teams = (await api("/api/teams")).data.teams;
  const tid = teams[teams.length - 1].id;
  const { boards } = (await api(`/api/teams/${tid}/boards`)).data;
  const bid = boards[boards.length - 1].id;
  for (const [i, col] of ["went_well", "to_improve", "actions"].entries()) {
    const n = await api(`/api/boards/${bid}/notes`, {
      method: "POST",
      body: { column_key: col, text: `note ${i + 1}`, author: "QA", voter: "qa-voter" },
    });
    assert.equal(n.status, 201);
  }
  const state = await api(`/api/boards/${bid}?voter=qa-voter`);
  assert.equal(state.status, 200);
  assert.equal(state.data.notes.length, 3);
  for (const n of state.data.notes) {
    assert.ok(typeof n.sort_order === "number", "sort_order must be present");
    assert.equal(n.mine, 1);
  }
  const orders = state.data.notes.map((n) => n.sort_order);
  assert.deepEqual(orders, [...orders].sort((a, b) => a - b), "notes should be ordered by sort_order");
});

test("edit: any voter may edit any note (open permission)", async () => {
  const teams = (await api("/api/teams")).data.teams;
  const tid = teams[teams.length - 1].id;
  const { boards } = (await api(`/api/teams/${tid}/boards`)).data;
  const bid = boards[boards.length - 1].id;
  const n = await api(`/api/boards/${bid}/notes`, {
    method: "POST",
    body: { column_key: "went_well", text: "original", author: "Alice", voter: "voter-alice" },
  });
  const edit = await api(`/api/notes/${n.data.note.id}`, {
    method: "PATCH",
    body: { text: "edited by bob", voter: "voter-bob" },
  });
  assert.equal(edit.status, 200, "edit must be open to everyone");
  const state = await api(`/api/boards/${bid}?voter=voter-bob`);
  assert.ok(state.data.notes.some((x) => x.text === "edited by bob"));
});

test("move: cross-column move updates column and sort_order", async () => {
  const teams = (await api("/api/teams")).data.teams;
  const tid = teams[teams.length - 1].id;
  const { boards } = (await api(`/api/teams/${tid}/boards`)).data;
  const bid = boards[boards.length - 1].id;
  const n1 = (await api(`/api/boards/${bid}/notes`, { method: "POST", body: { column_key: "went_well", text: "mover", author: "QA", voter: "qa" } })).data.note;
  const n2 = (await api(`/api/boards/${bid}/notes`, { method: "POST", body: { column_key: "actions", text: "anchor", author: "QA", voter: "qa" } })).data.note;
  const mv = await api(`/api/notes/${n1.id}/move`, {
    method: "POST",
    body: { column_key: "actions", before_id: n2.id, voter: "qa" },
  });
  assert.equal(mv.status, 200);
  assert.equal(mv.data.column_key, "actions");
  assert.ok(mv.data.sort_order < n2.sort_order, "moved note should sit before the anchor");
  const state = await api(`/api/boards/${bid}?voter=qa`);
  const inActions = state.data.notes.filter((x) => x.column_key === "actions").map((x) => x.text);
  assert.ok(inActions.includes("mover") && inActions.includes("anchor"));
  assert.ok(inActions.indexOf("mover") < inActions.indexOf("anchor"), "mover should sit before the anchor");
});

test("vote: toggle on and off", async () => {
  const teams = (await api("/api/teams")).data.teams;
  const tid = teams[teams.length - 1].id;
  const { boards } = (await api(`/api/teams/${tid}/boards`)).data;
  const bid = boards[boards.length - 1].id;
  const n = (await api(`/api/boards/${bid}/notes`, { method: "POST", body: { column_key: "went_well", text: "vote me", author: "QA", voter: "qa" } })).data.note;
  const on = await api(`/api/notes/${n.id}/vote`, { method: "POST", body: { voter: "voter-zoe" } });
  assert.equal(on.data.vote_count, 1);
  assert.equal(on.data.voted, 1);
  const off = await api(`/api/notes/${n.id}/vote`, { method: "POST", body: { voter: "voter-zoe" } });
  assert.equal(off.data.vote_count, 0);
  assert.equal(off.data.voted, 0);
});

test("delete: removing a note also drops its votes", async () => {
  const teams = (await api("/api/teams")).data.teams;
  const tid = teams[teams.length - 1].id;
  const { boards } = (await api(`/api/teams/${tid}/boards`)).data;
  const bid = boards[boards.length - 1].id;
  const n = (await api(`/api/boards/${bid}/notes`, { method: "POST", body: { column_key: "went_well", text: "delete me", author: "QA", voter: "qa" } })).data.note;
  await api(`/api/notes/${n.id}/vote`, { method: "POST", body: { voter: "voter-zoe" } });
  const del = await api(`/api/notes/${n.id}`, { method: "DELETE" });
  assert.equal(del.status, 200);
  const state = await api(`/api/boards/${bid}?voter=qa`);
  assert.ok(!state.data.notes.some((x) => x.id === n.id));
});

test("trash: soft delete, restore, and permanent purge", async () => {
  const teams = (await api("/api/teams")).data.teams;
  const tid = teams[teams.length - 1].id;
  const b = (await api("/api/boards", { method: "POST", body: { title: "QA trash board", team_id: tid } })).data.board;
  await api(`/api/boards/${b.id}/notes`, { method: "POST", body: { column_key: "went_well", text: "gone soon", author: "QA", voter: "qa" } });

  const soft = await api(`/api/boards/${b.id}`, { method: "DELETE" });
  assert.equal(soft.status, 200);
  assert.equal((await api(`/api/boards/${b.id}`)).status, 404, "trashed board is invisible");
  const trash = await api(`/api/teams/${tid}/boards?trash=1`);
  assert.ok(trash.data.boards.some((x) => x.id === b.id && x.deleted_at));

  const restore = await api(`/api/boards/${b.id}/restore`, { method: "POST" });
  assert.equal(restore.status, 200);
  const active = await api(`/api/teams/${tid}/boards`);
  assert.ok(active.data.boards.some((x) => x.id === b.id));

  const purge = await api(`/api/boards/${b.id}?permanent=1`, { method: "DELETE" });
  assert.equal(purge.status, 200);
  const trashAfter = await api(`/api/teams/${tid}/boards?trash=1`);
  assert.ok(!trashAfter.data.boards.some((x) => x.id === b.id));
});

test("ws: handshake requires a session token", async () => {
  const conn = await wsConnect(BASE.replace(/^http/, "ws") + "/api/boards/aaaaaaaa/ws");
  assert.equal(conn.opened, false, "unauthenticated websocket must not open");
});

test("ws: connected clients receive a change ping on mutations", async () => {
  const teams = (await api("/api/teams")).data.teams;
  const tid = teams[teams.length - 1].id;
  const { boards } = (await api(`/api/teams/${tid}/boards`)).data;
  const bid = boards[boards.length - 1].id;
  const token = wsToken();
  const conn = await wsConnect(`${BASE.replace(/^http/, "ws")}/api/boards/${bid}/ws?token=${encodeURIComponent(token)}`);
  assert.equal(conn.opened, true, "authenticated websocket should open");
  await api(`/api/boards/${bid}/notes`, {
    method: "POST",
    body: { column_key: "went_well", text: "ws ping check", author: "QA", voter: "qa" },
  });
  await new Promise((r) => setTimeout(r, 1200));
  conn.ws.close(); // release the socket so the test process can exit
  assert.ok(conn.messages.some((m) => m.type === "changed"), `expected a changed ping, got ${JSON.stringify(conn.messages)}`);
});

test("team delete: cascades to boards, notes and votes", async () => {
  const t = (await api("/api/teams", { method: "POST", body: { name: "QA doomed team" } })).data.team;
  const b = (await api("/api/boards", { method: "POST", body: { title: "doomed board", team_id: t.id } })).data.board;
  const n = (await api(`/api/boards/${b.id}/notes`, { method: "POST", body: { column_key: "actions", text: "doomed note", author: "QA", voter: "qa" } })).data.note;
  await api(`/api/notes/${n.id}/vote`, { method: "POST", body: { voter: "voter-zoe" } });

  const del = await api(`/api/teams/${t.id}`, { method: "DELETE" });
  assert.equal(del.status, 200);
  assert.equal((await api(`/api/teams/${t.id}`)).status, 404);
  assert.equal((await api(`/api/boards/${b.id}`)).status, 404);
});
