/* Free Retro — vanilla SPA
   Routes: #/ (home) · #/b/<boardId> (board) */

// ---------- tiny DOM helpers ----------
const $app = document.getElementById("app");

function h(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null) continue;
    if (k === "class") node.className = v;
    else if (k === "dataset") Object.assign(node.dataset, v);
    else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2), v);
    else if (k === "html") node.innerHTML = v; // static markup / icons only
    else if (v === true) node.setAttribute(k, "");
    else node.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    node.append(c.nodeType ? c : document.createTextNode(c));
  }
  return node;
}

const ICONS = {
  heart: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20.7C6.9 17 3.5 13.8 3.5 10.2A4.6 4.6 0 0 1 12 7.4a4.6 4.6 0 0 1 8.5 2.8c0 3.6-3.4 6.8-8.5 10.5z"/></svg>',
  pencil: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20l4.3-1L20 7.3a2.1 2.1 0 0 0-3-3L5.3 16 4 20z"/></svg>',
  trash: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg>',
  link: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10 14a5 5 0 0 0 7.5.5l2-2a5 5 0 0 0-7-7l-1.2 1.1M14 10a5 5 0 0 0-7.5-.5l-2 2a5 5 0 0 0 7 7l1.2-1.1"/></svg>',
  back: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 5l-7 7 7 7"/></svg>',
  plus: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>',
  send: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12l16-7-4.5 14L11 14l-7-2z"/></svg>',
  clock: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/></svg>',
  stop: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="7" y="7" width="10" height="10" rx="1.5"/></svg>',
  lock: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="10.5" width="14" height="9.5" rx="2"/><path d="M8 10.5V7.5a4 4 0 0 1 8 0v3"/></svg>',
  grip: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="9" cy="6" r="1.7"/><circle cx="15" cy="6" r="1.7"/><circle cx="9" cy="12" r="1.7"/><circle cx="15" cy="12" r="1.7"/><circle cx="9" cy="18" r="1.7"/><circle cx="15" cy="18" r="1.7"/></svg>',
  user: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="8" r="4"/><path d="M4.5 20a7.5 7.5 0 0 1 15 0"/></svg>',
};

// ---------- identity & palette ----------
const store = {
  get name() { return localStorage.getItem("retro:name") || ""; },
  set name(v) { localStorage.setItem("retro:name", v.trim().slice(0, 40)); },
  get voter() {
    let v = localStorage.getItem("retro:voter");
    if (!v) { v = crypto.randomUUID().replace(/-/g, ""); localStorage.setItem("retro:voter", v); }
    return v;
  },
  get showNames() { return localStorage.getItem("retro:showNames") === "1"; },
  set showNames(v) { localStorage.setItem("retro:showNames", v ? "1" : "0"); },
};

const PALETTE = ["yellow", "pink", "blue", "green", "orange"];
function hashStr(s) {
  let x = 5381;
  for (let i = 0; i < s.length; i++) x = ((x << 5) + x + s.charCodeAt(i)) >>> 0;
  return x;
}
const colorOf = (id) => PALETTE[hashStr(id) % PALETTE.length];
const tiltOf = (id) => (((hashStr(id + "t") % 100) / 100) * 2.8 - 1.4).toFixed(2) + "deg";
const tapeOf = (id) => (((hashStr(id + "w") % 100) / 100) * 8 - 4).toFixed(1) + "deg";
const avatarHue = (name) => 20 + (hashStr(name || "?") % 8) * 40; // warm hues
function initialsOf(name) {
  const parts = (name || "").trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "?";
  return (parts[0][0] + (parts[1]?.[0] || "")).toUpperCase();
}

function timeAgo(ts) {
  const diff = Date.now() - ts;
  const m = 60e3, hr = 36e5, day = 864e5;
  if (diff < m) return "just now";
  if (diff < hr) return `${Math.floor(diff / m)}m ago`;
  if (diff < day) return `${Math.floor(diff / hr)}h ago`;
  if (diff < 2 * day) return "yesterday";
  return new Date(ts).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

// ---------- toast ----------
let toastTimer;
function toast(msg) {
  const el = document.getElementById("toast");
  el.textContent = msg;
  el.hidden = false;
  requestAnimationFrame(() => el.classList.add("show"));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.classList.remove("show");
    setTimeout(() => (el.hidden = true), 250);
  }, 2200);
}

// ---------- api ----------
async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { "content-type": "application/json" },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (res.status === 401 && !path.startsWith("/api/auth/")) {
    showGate(); // session expired or revoked — re-lock the UI
    throw Object.assign(new Error("unauthorized"), { status: 401 });
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || res.statusText), { status: res.status, data });
  return data;
}

// ---------- app state ----------
const state = {
  route: { name: "home" },
  boards: [],
  board: null,
  notes: [],
  titleEditing: false,
  pollFailures: 0,
  timerEndsAt: null,   // epoch ms (server clock), null = no timer
  serverOffset: 0,     // serverNow - clientNow, keeps countdown honest across devices
};

const COLUMNS = [
  { key: "went_well", title: "What went well" },
  { key: "to_improve", title: "What could improve" },
  { key: "actions", title: "Action items" },
];

// ---------- router ----------
let routeSeq = 0; // guards against a stale async render landing after a newer route
let timerMenuCleanup = null; // releases the timer menu's document click listener

function closeTimerMenu() {
  if (timerMenuCleanup) {
    timerMenuCleanup();
    timerMenuCleanup = null;
  }
}
async function route() {
  const seq = ++routeSeq;
  closeTimerMenu(); // never leak the menu's document listener across navigations
  const hash = location.hash || "#/";
  if (!hash.startsWith("#/b/")) closeBoardWS();
  const bm = hash.match(/^#\/b\/([a-z0-9]+)/);
  const am = hash.match(/^#\/t\/([a-z0-9]+)\/admin$/);
  const tm = hash.match(/^#\/t\/([a-z0-9]+)$/);
  if (bm) {
    state.route = { name: "board", id: bm[1] };
    await loadBoard(bm[1], seq);
  } else if (am) {
    state.route = { name: "teamAdmin", id: am[1] };
    adminTab = "active";
    await renderTeamAdmin(seq, am[1]);
  } else if (tm) {
    state.route = { name: "team", id: tm[1] };
    await renderTeam(seq, tm[1]);
  } else {
    state.route = { name: "home" };
    await renderHome(seq);
  }
}
window.addEventListener("hashchange", route);

// ---------- home: teams ----------
function defaultBoardTitle() {
  const date = new Date().toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  return `${date} retro board`;
}

async function renderHome(seq = routeSeq) {
  document.title = "Free Retro — quick retrospective boards";
  $app.replaceChildren(h("div", { class: "home" }));

  const root = $app.firstChild;
  root.append(
    h("div", { class: "hero" },
      h("h1", {}, "Free ", h("span", { class: "hl" }, "Retro")),
      h("p", {}, "Tiny retrospective boards. One link per team — share it, and everyone can run retros. No sign-up."),
    ),
  );

  // create-team card
  const input = h("input", {
    type: "text", maxlength: "60", placeholder: "e.g. Platform team",
    "aria-label": "Team name",
    onkeydown: (e) => { if (e.key === "Enter" && !e.isComposing) createBtn.click(); },
  });
  const createBtn = h("button", { class: "btn accent", onclick: doCreate }, "Create team");
  async function doCreate() {
    const name = input.value.trim();
    if (!name) { input.focus(); return; }
    createBtn.disabled = true;
    try {
      const { team } = await api("/api/teams", { method: "POST", body: { name } });
      location.hash = `#/t/${team.id}`;
    } catch {
      toast("Couldn't create the team — try again.");
      createBtn.disabled = false;
    }
  }
  root.append(
    h("div", { class: "create-card" },
      h("label", {}, "Create a team"),
      h("div", { class: "create-row" }, input, createBtn),
    ),
  );

  // teams grid
  const listWrap = h("div");
  root.append(h("div", { class: "section-label", style: "margin-top:0" }, "Your teams"), listWrap);
  try {
    const { teams } = await api("/api/teams");
    if (seq !== routeSeq) return; // a newer route took over while we fetched
    if (!teams.length) {
      listWrap.append(
        h("div", { class: "empty-hint" },
          h("div", { class: "doodle" }, "No teams yet"),
          h("p", {}, "Create your first team above — each team gets its own board space and a shareable link."),
        ),
      );
    } else {
      const grid = h("div", { class: "boards-grid" });
      for (const t of teams) {
        grid.append(
          h("a", { class: "board-card team-card", href: `#/t/${t.id}`, style: `--note-bg: var(--c-${colorOf(t.id)})` },
            h("h3", { class: "b-title" }, t.name),
            h("div", { class: "b-meta" },
              h("span", {}, `${t.board_count} board${t.board_count === 1 ? "" : "s"}`),
              h("span", {}, shortDate(t.created_at)),
              h("span", { class: "b-go" }, "open →"),
            ),
          ),
        );
      }
      listWrap.append(grid);
    }
  } catch {
    listWrap.append(h("div", { class: "empty-hint" }, h("p", {}, "Couldn't load teams — is the server awake?")));
  }
  root.append(
    h("div", { class: "home-foot" },
      "free-retro · runs entirely on Cloudflare's free tier · your data lives in D1",
    ),
  );
}

// ---------- team page ----------
async function renderTeam(seq = routeSeq, teamId) {
  document.title = "Free Retro — quick retrospective boards";
  $app.replaceChildren(h("div", { class: "home" }));
  const root = $app.firstChild;
  root.append(h("div", { style: "padding:40px;text-align:center;font-family:var(--font-hand);font-size:20px;color:var(--ink-soft)" }, "Opening the team space…"));

  let team;
  try {
    ({ team } = await api(`/api/teams/${teamId}`));
  } catch (err) {
    if (seq !== routeSeq) return; // a newer route took over while we fetched
    if (err && err.status === 404) {
      document.title = "Team not found · Free Retro";
      root.replaceChildren(
        h("div", { class: "empty-hint" },
          h("div", { class: "doodle" }, "This team link doesn't exist"),
          h("p", {}, "Check the link, or head back home to find your teams."),
          h("div", { style: "margin-top:18px" }, h("a", { class: "btn ghost", href: "#/" }, "Back to all teams")),
        ),
      );
      return;
    }
    root.replaceChildren(h("div", { class: "empty-hint" }, h("p", {}, "Couldn't load the team — is the server awake?")));
    return;
  }
  if (seq !== routeSeq) return;
  document.title = `${team.name} · Free Retro`;

  function startTeamEdit() {
    const titleEl = root.querySelector(".team-title");
    if (!titleEl || root.querySelector(".team-title-input")) return;
    const nameInput = h("input", {
      class: "team-title-input board-title-input", maxlength: "60", value: team.name,
      onkeydown: (e) => {
        if (e.key === "Enter" && !e.isComposing) nameInput.blur();
        if (e.key === "Escape") { nameInput.value = team.name; nameInput.blur(); }
      },
      onblur: async () => {
        const name = nameInput.value.trim().slice(0, 60);
        if (name && name !== team.name) {
          try {
            const res = await api(`/api/teams/${teamId}`, { method: "PATCH", body: { name } });
            team.name = res.team.name;
            document.title = `${team.name} · Free Retro`;
          } catch { toast("Rename failed"); }
        }
        const cur = root.querySelector(".team-title-input");
        if (cur) cur.replaceWith(h("h1", { class: "board-title team-title", "data-tip": "Click to rename the team", onclick: startTeamEdit }, team.name));
      },
    });
    titleEl.replaceWith(nameInput);
    nameInput.focus();
    nameInput.select();
  }

  const head = h("nav", { class: "topbar" },
    h("a", { class: "back", href: "#/" }, h("span", { html: ICONS.back }), "Teams"),
    h("h1", { class: "board-title team-title", "data-tip": "Click to rename the team", onclick: startTeamEdit }, team.name),
    h("div", { class: "spacer" }),
    h("button", {
      class: "btn ghost", "data-tip": "Copy the team link to share", "data-tip-align": "right", onclick: async () => {
        try { await navigator.clipboard.writeText(location.href); toast("Team link copied — share it with your teammates"); }
        catch { toast("Copy failed — grab it from the address bar"); }
      },
    }, h("span", { html: ICONS.link }), "Team link"),
    h("a", { class: "btn ghost", href: `#/t/${teamId}/admin`, "data-tip": "Manage boards, trash, and team deletion", "data-tip-align": "right" }, "Manage"),
  );

  // create-board card (scoped to this team); pre-filled with the dated default
  const input = h("input", {
    type: "text", maxlength: "120", value: defaultBoardTitle(),
    "aria-label": "Board title",
    onfocus: (e) => e.target.select(),
    onkeydown: (e) => { if (e.key === "Enter" && !e.isComposing) createBtn.click(); },
  });
  const createBtn = h("button", { class: "btn accent", onclick: doCreate }, "Create board");
  async function doCreate() {
    const title = input.value.trim() || defaultBoardTitle();
    createBtn.disabled = true;
    try {
      const { board } = await api("/api/boards", { method: "POST", body: { title, team_id: teamId } });
      location.hash = `#/b/${board.id}`;
    } catch {
      toast("Couldn't create the board — try again.");
      createBtn.disabled = false;
    }
  }

  const listWrap = h("div");
  root.replaceChildren(
    h("div", { class: "home" },
      head,
      h("div", { class: "create-card team-create" },
        h("label", {}, "Start a new retro"),
        h("div", { class: "create-row" }, input, createBtn),
      ),
      h("div", { class: "section-label" }, "Boards"),
      listWrap,
    ),
  );

  try {
    const { boards } = await api(`/api/teams/${teamId}/boards`);
    if (seq !== routeSeq) return;
    if (!boards.length) {
      listWrap.append(
        h("div", { class: "empty-hint" },
          h("div", { class: "doodle" }, "No retros yet"),
          h("p", {}, "Create the first board above, then share the team link with your teammates."),
        ),
      );
    } else {
      const grid = h("div", { class: "boards-grid" });
      for (const b of boards) {
        grid.append(
          h("a", { class: "board-card", href: `#/b/${b.id}`, style: `--note-bg: var(--c-${colorOf(b.id)})` },
            h("h3", { class: "b-title" }, b.title),
            h("div", { class: "b-meta" },
              h("span", {}, `${b.note_count} note${b.note_count === 1 ? "" : "s"}`),
              h("span", {}, timeAgo(b.last_activity || b.created_at)),
              h("span", { class: "b-go" }, "open →"),
            ),
          ),
        );
      }
      listWrap.append(grid);
    }
  } catch {
    listWrap.append(h("div", { class: "empty-hint" }, h("p", {}, "Couldn't load boards — is the server awake?")));
  }
}

// ---------- team admin: manage this team's boards ----------
let adminTab = "active"; // "active" | "trash"
let adminTeamId = null;

function shortDate(ts) {
  return new Date(ts).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

async function renderTeamAdmin(seq = routeSeq, teamId) {
  adminTeamId = teamId;
  document.title = "Manage boards · Free Retro";
  $app.replaceChildren(h("div", { class: "home" }));
  const root = $app.firstChild;

  root.append(
    h("div", { class: "admin-head" },
      h("a", { class: "back-link", href: `#/t/${teamId}` }, h("span", { html: ICONS.back }), "Back to team"),
      h("h1", { class: "admin-title" }, "Manage boards"),
      h("p", { class: "admin-sub" }, "Deleted boards wait in the trash for 30 days, then are purged for good."),
    ),
  );

  const body = h("div", {}, h("div", { style: "text-align:center;padding:30px;font-family:var(--font-hand);font-size:18px;color:var(--ink-soft)" }, "Fetching boards…"));
  root.append(body);

  let active = [], trash = [];
  try {
    [active, trash] = (await Promise.all([
      api(`/api/teams/${teamId}/boards`),
      api(`/api/teams/${teamId}/boards?trash=1`),
    ])).map((r) => r.boards);
  } catch { /* fall through with empty lists */ }
  if (seq !== routeSeq) return; // a newer route took over while we fetched

  const tabs = h("div", { class: "admin-tabs" },
    adminTabButton("active", `Boards (${active.length})`),
    adminTabButton("trash", `Trash (${trash.length})`),
  );
  body.replaceChildren(tabs);

  if (adminTab === "active") {
    if (!active.length) {
      body.append(h("div", { class: "empty-hint" },
        h("div", { class: "doodle" }, "No boards to manage"),
        h("p", {}, "Create one from the team page first.")));
    } else {
      body.append(
        h("div", { class: "section-label" }, `${active.length} board${active.length === 1 ? "" : "s"}`),
        h("div", { class: "admin-list" }, ...active.map(adminRow)),
      );
    }
  } else {
    if (!trash.length) {
      body.append(h("div", { class: "empty-hint" },
        h("div", { class: "doodle" }, "Trash is empty"),
        h("p", {}, "Deleted boards wait here for 30 days before they are purged.")));
    } else {
      body.append(
        h("div", { class: "section-label" }, `deleted · auto-purged after 30 days`),
        h("div", { class: "admin-list" }, ...trash.map(trashRow)),
      );
    }
  }

  // danger zone: delete the whole team
  const totalBoards = active.length + trash.length;
  const boardsWord = `${totalBoards} board${totalBoards === 1 ? "" : "s"}`;
  const delTeamBtn = h("button", { class: "btn ghost admin-del", "data-tip": "Permanently delete this team and all its boards", "data-tip-align": "right", onclick: confirmTeamDelete }, "Delete team");
  let confirmTimer;
  function confirmTeamDelete() {
    if (delTeamBtn.dataset.confirm) {
      clearTimeout(confirmTimer);
      deleteTeam();
      return;
    }
    delTeamBtn.dataset.confirm = "1";
    delTeamBtn.classList.add("confirm");
    delTeamBtn.textContent = `Sure? ${boardsWord} gone`;
    confirmTimer = setTimeout(() => {
      delete delTeamBtn.dataset.confirm;
      delTeamBtn.classList.remove("confirm");
      delTeamBtn.textContent = "Delete team";
    }, 3200);
  }
  async function deleteTeam() {
    try {
      await api(`/api/teams/${teamId}`, { method: "DELETE" });
      toast(`Team deleted — ${boardsWord} removed`);
      location.hash = "#/";
    } catch {
      toast("Delete failed — try again");
    }
  }
  body.append(
    h("div", { class: "danger-zone" },
      h("div", { class: "dz-text" },
        h("h3", {}, "Danger zone"),
        h("p", {}, `Deleting this team permanently removes all ${boardsWord} — including the trash — with every note and vote. There is no undo.`),
      ),
      delTeamBtn,
    ),
  );
}

function adminTabButton(tab, label) {
  return h("button", {
    class: "admin-tab" + (adminTab === tab ? " on" : ""),
    onclick: () => { adminTab = tab; renderTeamAdmin(routeSeq, adminTeamId); },
  }, label);
}

function daysLeft(deletedAt) {
  return Math.max(0, Math.ceil((deletedAt + 30 * 864e5 - Date.now()) / 864e5));
}

function trashRow(b) {
  const row = h("div", { class: "admin-row trashed" });
  const notesWord = `${b.note_count} note${b.note_count === 1 ? "" : "s"}`;

  const purgeBtn = h("button", { class: "btn ghost admin-del", onclick: confirmPurge }, "Delete forever");
  let confirmTimer;
  function confirmPurge() {
    if (purgeBtn.dataset.confirm) {
      clearTimeout(confirmTimer);
      purge();
      return;
    }
    purgeBtn.dataset.confirm = "1";
    purgeBtn.classList.add("confirm");
    purgeBtn.textContent = "Forever? No undo";
    confirmTimer = setTimeout(() => {
      delete purgeBtn.dataset.confirm;
      purgeBtn.classList.remove("confirm");
      purgeBtn.textContent = "Delete forever";
    }, 3200);
  }
  async function purge() {
    row.classList.add("deleting");
    try {
      await api(`/api/boards/${b.id}?permanent=1`, { method: "DELETE" });
      setTimeout(() => { row.remove(); maybeShowEmptyTrash(); }, 200);
      toast(`“${b.title}” is gone for good`);
    } catch {
      row.classList.remove("deleting");
      toast("Delete failed — try again");
    }
  }

  row.append(
    h("div", { class: "a-info" },
      h("span", { class: "a-title" }, b.title),
      h("div", { class: "a-meta" },
        `${notesWord} · deleted ${timeAgo(b.deleted_at)} · purges in ${daysLeft(b.deleted_at)} day${daysLeft(b.deleted_at) === 1 ? "" : "s"}`,
      ),
    ),
    h("div", { class: "a-actions" },
      h("button", {
        class: "btn ghost", onclick: async () => {
          try {
            await api(`/api/boards/${b.id}/restore`, { method: "POST" });
            toast(`Restored “${b.title}”`);
            adminTab = "active"; // show it where the user can find it
            renderTeamAdmin(routeSeq, adminTeamId);
          } catch { toast("Restore failed — try again"); }
        },
      }, "Restore"),
      purgeBtn,
    ),
  );
  return row;
}

function maybeShowEmptyTrash() {
  const list = $app.querySelector(".admin-list");
  if (list && !list.children.length) renderTeamAdmin(routeSeq, adminTeamId);
}

function adminRow(b) {
  const row = h("div", { class: "admin-row" });
  const notesWord = `${b.note_count} note${b.note_count === 1 ? "" : "s"}`;

  const delBtn = h("button", { class: "btn ghost admin-del", onclick: confirmBoardDelete }, "Delete");
  let confirmTimer;
  function confirmBoardDelete() {
    if (delBtn.dataset.confirm) {
      clearTimeout(confirmTimer);
      deleteBoard();
      return;
    }
    delBtn.dataset.confirm = "1";
    delBtn.classList.add("confirm");
    delBtn.textContent = `Trash it?`;
    confirmTimer = setTimeout(() => {
      delete delBtn.dataset.confirm;
      delBtn.classList.remove("confirm");
      delBtn.textContent = "Delete";
    }, 3200);
  }
  async function deleteBoard() {
    row.classList.add("deleting");
    try {
      await api(`/api/boards/${b.id}`, { method: "DELETE" });
      setTimeout(() => { row.remove(); maybeShowEmptyList(); }, 200);
      toast(`“${b.title}” moved to trash`);
    } catch {
      row.classList.remove("deleting");
      toast("Delete failed — try again");
    }
  }

  row.append(
    h("div", { class: "a-info" },
      h("a", { class: "a-title", href: `#/b/${b.id}` }, b.title),
      h("div", { class: "a-meta" },
        `${notesWord} · created ${shortDate(b.created_at)} · active ${timeAgo(b.last_activity || b.created_at)}`,
      ),
    ),
    h("div", { class: "a-actions" },
      h("a", { class: "btn ghost", href: `#/b/${b.id}` }, "Open"),
      delBtn,
    ),
  );
  return row;
}

function maybeShowEmptyList() {
  const list = $app.querySelector(".admin-list");
  if (list && !list.children.length) renderTeamAdmin(routeSeq, adminTeamId);
}

// ---------- silent-writing timer ----------
function fmtRemain() {
  const s = Math.max(0, Math.ceil((state.timerEndsAt - (Date.now() + state.serverOffset)) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function buildTimerControl() {
  const menu = h("div", { class: "timer-menu hidden" });
  const btn = h("button", { class: "btn ghost", "data-tip": "Silent-writing timer — hide notes while the team writes" },
    h("span", { html: ICONS.clock }), "Timer");
  const wrap = h("div", { class: "timer-wrap" }, btn, menu);

  function closeMenu() {
    menu.classList.add("hidden");
    closeTimerMenu();
    updateTimerButton(); // bring the button tooltip back
  }
  function onDocClick(e) {
    if (!wrap.isConnected) { closeTimerMenu(); return; } // menu was rebuilt/detached
    if (!wrap.contains(e.target)) closeMenu();
  }
  function renderMenu() {
    menu.replaceChildren();
    for (const min of [5, 8, 10]) {
      menu.append(
        h("button", { onclick: () => { closeMenu(); startTimer(min); } },
          h("span", { html: ICONS.clock }), `${min} minutes`),
      );
    }
    if (state.timerEndsAt) {
      menu.append(
        h("button", { class: "danger", onclick: () => { closeMenu(); stopTimer(); } },
          h("span", { html: ICONS.stop }), "Stop timer"),
      );
    }
  }
  btn.addEventListener("click", () => {
    if (menu.classList.contains("hidden")) {
      closeTimerMenu(); // never two live document listeners
      renderMenu();
      menu.classList.remove("hidden");
      btn.removeAttribute("data-tip"); // tooltip would sit on top of the menu
      // adding synchronously is safe: onDocClick ignores clicks inside the wrap,
      // so the very click that opens the menu won't immediately close it
      timerMenuCleanup = () => document.removeEventListener("click", onDocClick, true);
      document.addEventListener("click", onDocClick, true);
    } else {
      closeMenu();
    }
  });
  return wrap;
}

// viewer-side toggle: show/hide author names on note cards (default hidden)
function buildNamesToggle() {
  const btn = h("button", {
    class: "btn ghost names-toggle" + (store.showNames ? " on" : ""),
    "data-tip": "Show or hide author names on notes", "data-tip-align": "right",
    onclick: () => {
      store.showNames = !store.showNames;
      btn.classList.toggle("on", store.showNames);
      renderNotes();
    },
  }, h("span", { html: ICONS.user }), "Names");
  return btn;
}

function updateTimerButton() {
  const btn = $app.querySelector(".timer-wrap > button");
  if (!btn) return;
  const menuOpen = !btn.parentElement?.querySelector(".timer-menu")?.classList.contains("hidden");
  if (menuOpen) { btn.removeAttribute("data-tip"); return; } // tooltip would cover the menu
  if (state.timerEndsAt) {
    btn.className = "timer-chip";
    btn.setAttribute("data-tip", "Silent writing is on — click to stop or restart");
    btn.replaceChildren(h("span", { html: ICONS.clock }), h("span", { class: "t-remain" }, fmtRemain()));
  } else {
    btn.className = "btn ghost";
    btn.setAttribute("data-tip", "Silent-writing timer — hide notes while the team writes");
    btn.replaceChildren(h("span", { html: ICONS.clock }), "Timer");
  }
}

function applyTimerState() {
  const cols = $app.querySelector(".columns");
  if (cols) cols.classList.toggle("blurred", !!state.timerEndsAt);

  let banner = $app.querySelector(".timer-banner");
  if (state.timerEndsAt) {
    if (!banner) {
      banner = h("div", { class: "timer-banner" },
        h("span", { class: "t-pill" },
          h("span", { class: "t-icon", html: ICONS.clock }),
          h("span", {}, "Silent writing — notes are hidden"),
          h("span", { class: "t-count" }, fmtRemain()),
        ),
      );
      const page = $app.querySelector(".board-page");
      page.insertBefore(banner, cols);
    }
  } else if (banner) {
    banner.remove();
  }
  updateTimerButton();
}

async function startTimer(minutes) {
  try {
    const res = await api(`/api/boards/${state.board.id}/timer`, { method: "POST", body: { minutes } });
    state.serverOffset = res.now - Date.now();
    state.timerEndsAt = res.board.timer_ends_at;
    applyTimerState();
    toast(`Silent writing started — ${minutes} minutes on the clock`);
  } catch {
    toast("Couldn't start the timer — try again");
  }
}

async function stopTimer() {
  try {
    const res = await api(`/api/boards/${state.board.id}/timer`, { method: "DELETE" });
    state.serverOffset = res.now - Date.now();
    state.timerEndsAt = null;
    applyTimerState();
    toast("Timer stopped — notes are visible");
  } catch {
    toast("Couldn't stop the timer");
  }
}

// countdown ticker: updates the chip + banner, fires "time's up"
setInterval(() => {
  if (state.route.name !== "board" || !state.timerEndsAt) return;
  if (state.timerEndsAt - (Date.now() + state.serverOffset) <= 0) {
    state.timerEndsAt = null;
    applyTimerState();
    toast("Time's up — sticky notes are visible again");
    return;
  }
  const text = fmtRemain();
  for (const el of $app.querySelectorAll(".t-remain, .t-count")) el.textContent = text;
}, 500);

// ---------- board ----------
async function loadBoard(id, seq = routeSeq) {
  state.titleEditing = false;
  $app.replaceChildren(h("div", { class: "board-page" }, h("div", { style: "padding:40px;text-align:center;font-family:var(--font-hand);font-size:20px;color:var(--ink-soft)" }, "Unrolling the paper…")));
  let data;
  try {
    data = await api(`/api/boards/${id}?voter=${encodeURIComponent(store.voter)}`);
  } catch (err) {
    if (seq !== routeSeq) return; // user moved on while we were loading
    if (err.status === 404) {
      document.title = "Board not found · Free Retro";
      $app.replaceChildren(
        h("div", { class: "home" },
          h("div", { class: "empty-hint" },
            h("div", { class: "doodle" }, "This board has wandered off"),
          h("p", {}, "The link may be wrong, or the board was deleted — a teammate can restore it from the trash in Manage boards."),
            h("div", { style: "margin-top:18px" },
              h("a", { class: "btn ghost", href: "#/" }, "Back to all boards")),
          ),
        ),
      );
      return;
    }
    toast("Couldn't reach the server — retrying…");
    setTimeout(() => { if (state.route.name === "board" && state.route.id === id) loadBoard(id); }, 2000);
    return;
  }

  state.board = data.board;
  state.notes = data.notes;
  state.pollFailures = 0;
  state.timerEndsAt = data.board.timer_ends_at || null;
  state.serverOffset = (data.now || Date.now()) - Date.now();
  document.title = `${data.board.title} · Free Retro`;
  if (seq !== routeSeq) return; // a newer route took over while we fetched
  renderBoardShell();
  applyTimerState();
  connectBoardWS(id);

  if (!store.name) showNameModal();
}

function renderBoardShell() {
  const b = state.board;

  // title (click to edit)
  const titleEl = h("h1", {
    class: "board-title", "data-tip": "Click to rename the board",
    onclick: startTitleEdit,
  }, b.title);

  const shareBtn = h("button", {
    class: "btn ghost", "data-tip": "Copy the board link to share with your team", "data-tip-align": "right", onclick: async () => {
      try { await navigator.clipboard.writeText(location.href); toast("Link copied — share it with your team"); }
      catch { toast("Copy failed — grab it from the address bar"); }
    },
  }, h("span", { html: ICONS.link }), "Share");

  const meBtn = h("button", { class: "me-chip", "data-tip": "Change your name", "data-tip-align": "right", onclick: () => showNameModal() },
    h("span", { class: "avatar", style: `--av: hsl(${avatarHue(store.name)}, 70%, 72%)` }, initialsOf(store.name)),
    store.name || "Set your name",
  );

  const topbar = h("nav", { class: "topbar" },
    h("a", { class: "back", href: `#/t/${state.board.team_id || ""}` }, h("span", { html: ICONS.back }), "Boards"),
    titleEl,
    h("div", { class: "spacer" }),
    buildTimerControl(),
    shareBtn,
    buildNamesToggle(),
    meBtn,
  );

  const columnsWrap = h("main", { class: "columns" });
  for (const col of COLUMNS) columnsWrap.append(buildColumn(col));

  $app.replaceChildren(h("div", { class: "board-page" }, topbar, columnsWrap));
  renderNotes();
  updateTimerButton(); // topbar may be rebuilt outside loadBoard (e.g. after the name modal)
}

function startTitleEdit() {
  if (state.titleEditing) return;
  state.titleEditing = true;
  const titleEl = $app.querySelector(".board-title");
  const input = h("input", {
    class: "board-title-input", maxlength: "120", value: state.board.title,
    onkeydown: (e) => {
      if (e.key === "Enter" && !e.isComposing) input.blur();
      if (e.key === "Escape") { input.value = state.board.title; input.blur(); }
    },
    onblur: async () => {
      state.titleEditing = false;
      const title = input.value.trim().slice(0, 120);
      if (!title || title === state.board.title) { titleEl.replaceWith(h("h1", { class: "board-title", "data-tip": "Click to rename the board", onclick: startTitleEdit }, state.board.title)); return; }
      try {
        await api(`/api/boards/${state.board.id}`, { method: "PATCH", body: { title } });
        state.board.title = title;
        document.title = `${title} · Free Retro`;
      } catch { toast("Rename failed"); }
      const fresh = $app.querySelector(".board-title-input");
      if (fresh) fresh.replaceWith(h("h1", { class: "board-title", "data-tip": "Click to rename the board", onclick: startTitleEdit }, state.board.title));
    },
  });
  titleEl.replaceWith(input);
  input.focus();
  input.select();
}

// ---------- columns & composer ----------
function buildColumn(col) {
  const notesWrap = h("div", { class: "notes", dataset: { column: col.key } });

  const composerColor = { went_well: "green", to_improve: "orange", actions: "blue" }[col.key];

  const openBtn = h("button", { class: "composer-open", onclick: openComposer }, "+ add a note");
  const ta = h("textarea", {
    placeholder: "Type, then hit Enter…", "aria-label": `Add note to ${col.title}`,
    onkeydown: (e) => {
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); submit(); }
      if (e.key === "Escape" && !e.isComposing) closeComposer();
    },
  });
  const addBtn = h("button", { class: "btn accent", onclick: submit }, h("span", { html: ICONS.send }), "Add");
  const doneBtn = h("button", { class: "btn done", onclick: closeComposer }, "Done");
  const form = h("div", { class: "composer-form hidden", style: `--composer-bg: var(--c-${composerColor})` }, ta,
    h("div", { class: "composer-actions" }, doneBtn, addBtn));

  function openComposer() {
    openBtn.classList.add("hidden");
    form.classList.remove("hidden");
    ta.focus();
  }
  function closeComposer() {
    form.classList.add("hidden");
    openBtn.classList.remove("hidden");
    ta.value = "";
  }
  async function submit() {
    const text = ta.value.trim();
    if (!text) return;
    addBtn.disabled = true;
    try {
      const { note } = await api(`/api/boards/${state.board.id}/notes`, {
        method: "POST",
        body: { column_key: col.key, text, author: store.name, voter: store.voter },
      });
      note._entering = true;
      state.notes.push(note);
      renderNotes();
      ta.value = "";
      ta.focus();
      if (state.timerEndsAt) toast("Stashed — it will appear when the timer ends");
    } catch {
      toast("Couldn't add the note — try again");
    }
    addBtn.disabled = false;
  }

  return h("section", { class: `column col-${col.key}` },
    h("header", {},
      h("h2", {}, h("span", { class: "hl" }, col.title)),
      h("span", { class: "count", dataset: { count: col.key } }, "0"),
    ),
    h("div", { class: "composer" }, openBtn, form),
    notesWrap,
  );
}

// ---------- notes ----------
function sortNotes(a, b) {
  return (a.sort_order ?? a.created_at) - (b.sort_order ?? b.created_at);
}

let dragInProgress = false; // freeze note re-renders while a drag is live

function renderNotes() {
  if (dragInProgress) return; // a live drag holds the DOM
  if ($app.querySelector(".note-edit-ta")) return; // don't stomp an open editor
  for (const col of COLUMNS) {
    const wrap = $app.querySelector(`.notes[data-column="${col.key}"]`);
    if (!wrap) continue;
    const list = state.notes.filter((n) => n.column_key === col.key).sort(sortNotes);
    const countEl = $app.querySelector(`[data-count="${col.key}"]`);
    if (countEl) countEl.textContent = String(list.length);
    wrap.replaceChildren(...list.map(noteCard));

    if (!list.length) {
      wrap.append(h("div", { class: "empty-col" },
        { went_well: "Wins go here — big or small.", to_improve: "What tripped you up?", actions: "What will we change next sprint?" }[col.key]));
    }
  }
}

// ---------- drag to move notes (vertical within a column, or across columns) ----------
let dropIndicator = null;

function startDrag(e, note, card) {
  const rect = card.getBoundingClientRect();
  const ghost = card.cloneNode(true);
  ghost.classList.add("drag-ghost");
  ghost.style.width = `${rect.width}px`;
  document.body.append(ghost);
  card.classList.add("drag-source");
  dragInProgress = true;
  const offX = e.clientX - rect.left;
  const offY = e.clientY - rect.top;
  let target = null;

  const move = (ev) => {
    ghost.style.left = `${ev.clientX - offX}px`;
    ghost.style.top = `${ev.clientY - offY}px`;
    target = findDropTarget(ev.clientX, ev.clientY, card);
    paintIndicator(target);
  };
  const finish = (apply) => {
    ghost.remove();
    card.classList.remove("drag-source");
    clearIndicator();
    dragInProgress = false;
    if (apply && target) applyMove(note, target);
    else renderNotes();
  };
  const onMove = (ev) => move(ev);
  const onUp = () => {
    card.removeEventListener("pointermove", onMove);
    card.removeEventListener("pointerup", onUp);
    card.removeEventListener("pointercancel", onCancel);
    finish(true);
  };
  const onCancel = () => {
    card.removeEventListener("pointermove", onMove);
    card.removeEventListener("pointerup", onUp);
    card.removeEventListener("pointercancel", onCancel);
    finish(false);
  };
  card.addEventListener("pointermove", onMove);
  card.addEventListener("pointerup", onUp);
  card.addEventListener("pointercancel", onCancel);
  move(e);
}

// where would a note dropped at (clientX, clientY) land?
function findDropTarget(clientX, clientY, draggedCard) {
  const columns = [...$app.querySelectorAll(".column")];
  let column = null;
  let bestDist = Infinity;
  for (const col of columns) {
    const r = col.getBoundingClientRect();
    const dist = clientX >= r.left && clientX <= r.right ? 0 : Math.min(Math.abs(clientX - r.left), Math.abs(clientX - r.right));
    if (dist < bestDist) { bestDist = dist; column = col; }
  }
  if (!column) return null;
  const columnKey = [...column.classList].find((c) => c.startsWith("col-"))?.slice(4);
  if (!columnKey) return null;

  const cards = [...column.querySelectorAll(".note")].filter((c) => !c.classList.contains("drag-source"));
  let beforeEl = null;
  for (const c of cards) {
    const r = c.getBoundingClientRect();
    if (clientY < r.top + r.height / 2) { beforeEl = c; break; }
  }
  return { columnKey, beforeId: beforeEl?.dataset.id || null, columnEl: column, beforeEl };
}

function paintIndicator(target) {
  clearIndicator();
  if (!target || !target.columnEl) return;
  dropIndicator = h("div", { class: "drop-indicator" });
  const notesWrap = target.columnEl.querySelector(".notes");
  if (target.beforeEl) notesWrap.insertBefore(dropIndicator, target.beforeEl);
  else notesWrap.append(dropIndicator);
}

function clearIndicator() {
  dropIndicator?.remove();
  dropIndicator = null;
}

async function applyMove(note, target) {
  // optimistic local placement: just above the before-note, or appended
  const siblings = state.notes.filter((n) => n.column_key === target.columnKey && n.id !== note.id).sort(sortNotes);
  const before = siblings.find((n) => n.id === target.beforeId);
  let provisional;
  if (before) {
    const idx = siblings.indexOf(before);
    const above = siblings[idx - 1];
    provisional = above ? (above.sort_order + before.sort_order) / 2 : before.sort_order - 500;
  } else {
    provisional = (siblings.length ? siblings[siblings.length - 1].sort_order : 0) + 1000;
  }
  note.column_key = target.columnKey;
  note.sort_order = provisional;
  renderNotes();
  try {
    const res = await api(`/api/notes/${note.id}/move`, {
      method: "POST",
      body: { column_key: target.columnKey, before_id: target.beforeId, voter: store.voter },
    });
    note.column_key = res.column_key;
    note.sort_order = res.sort_order;
  } catch (err) {
    if (err?.status !== 401) toast("Move failed — will resync");
  }
  renderNotes();
}

function noteCard(note) {
  const c = colorOf(note.id);
  const card = h("article", {
    class: "note" + (note._entering ? " entering" : ""),
    style: `--note-bg: var(--c-${c}); --tilt: ${tiltOf(note.id)}; --tape-tilt: ${tapeOf(note.id)};`,
    dataset: { id: note.id },
  });

  const textEl = h("div", { class: "note-text" }, note.text);

  // author
  const author = note.author
    ? h("span", { class: "note-author" },
        h("span", { class: "avatar", style: `--av: hsl(${avatarHue(note.author)}, 70%, 72%)` }, initialsOf(note.author)),
        h("span", { class: "a-name" }, note.author))
    : h("span", { class: "note-author anon" }, "anonymous");

  // vote
  const voteBtn = h("button", {
    class: "vote" + (note.voted ? " voted" : ""),
    "data-tip": note.voted ? "Remove your vote" : "Vote for this note",
    "aria-label": note.voted ? "Remove your vote" : "Vote for this note",
    onclick: () => toggleVote(note),
  }, h("span", { html: ICONS.heart }), note.vote_count > 0 ? String(note.vote_count) : "");

  // edit + delete are open to everyone (trusted-team model, like dragging)
  const editBtn = h("button", { class: "tool-btn edit", "data-tip": "Edit this note", "aria-label": "Edit this note", onclick: () => startEdit(note, card, textEl) },
    h("span", { html: ICONS.pencil }));

  // drag grip: anyone can move any note (drag is open by design)
  const grip = h("button", { class: "drag-grip", "data-tip": "Drag to move this note", "aria-label": "Drag to move" }, h("span", { html: ICONS.grip }));
  grip.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    try { grip.setPointerCapture(e.pointerId); } catch {}
    startDrag(e, note, card);
  });
  card.prepend(grip);

  // delete (two-step confirm)
  const delBtn = h("button", { class: "tool-btn del", "data-tip": "Delete note", "aria-label": "Delete note", onclick: () => confirmDelete(note, delBtn) },
    h("span", { html: ICONS.trash }));
  let confirmTimer;
  function confirmDelete(note, btn) {
    if (btn.classList.contains("confirm")) {
      clearTimeout(confirmTimer);
      doDelete(note, card);
    } else {
      btn.classList.add("confirm");
      btn.textContent = "Sure?";
      confirmTimer = setTimeout(() => {
        btn.classList.remove("confirm");
        btn.replaceChildren(h("span", { html: ICONS.trash }));
      }, 2600);
    }
  }

  card.append(
    textEl,
    h("div", { class: "note-foot" },
      store.showNames ? author : null,
      h("span", { class: "note-tools" }, voteBtn, editBtn, delBtn)),
  );
  delete note._entering;
  return card;
}

function startEdit(note, card, textEl) {
  if (card.querySelector(".note-edit-ta")) return;
  const ta = h("textarea", { class: "note-edit-ta", maxlength: "500", enterkeyhint: "done" });
  ta.value = note.text;
  let closing = false;
  const wrap = h("div", {}, ta);
  const finish = async (save) => {
    if (closing) return;
    closing = true;
    const newText = ta.value.trim().slice(0, 500);
    if (save && newText && newText !== note.text) {
      note.text = newText;
      try { await api(`/api/notes/${note.id}`, { method: "PATCH", body: { text: newText } }); }
      catch { toast("Edit failed — will resync"); }
    }
    // remove the editor first — renderNotes skips rebuilds while it's in the DOM
    wrap.remove();
    renderNotes();
  };
  ta.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); ta.blur(); }
    if (e.key === "Escape") { ta.value = note.text; ta.blur(); }
  });
  ta.addEventListener("blur", () => {
    // a transient blur (mobile keyboard dismissing, focus race) must not close
    // the editor — only finish for real if focus doesn't come back right away
    setTimeout(() => {
      if (document.activeElement === ta) return;
      finish(true);
    }, 200);
  });
  const saveBtn = h("button", { class: "btn accent note-save", onclick: () => finish(true) }, "Done");
  wrap.append(h("div", { class: "note-edit-actions" }, saveBtn));
  textEl.replaceWith(wrap);
  ta.focus();
  ta.setSelectionRange(ta.value.length, ta.value.length);
}

async function toggleVote(note) {
  note.voted = note.voted ? 0 : 1;
  note.vote_count += note.voted ? 1 : -1;
  renderNotes(); // re-sort with the new count
  $app.querySelector(`.note[data-id="${note.id}"] .vote`)?.classList.add("bump");
  try {
    const res = await api(`/api/notes/${note.id}/vote`, { method: "POST", body: { voter: store.voter } });
    note.voted = res.voted;
    note.vote_count = res.vote_count;
  } catch {
    note.voted = note.voted ? 0 : 1;
    note.vote_count += note.voted ? 1 : -1;
    toast("Vote didn't stick — check your connection");
  }
  renderNotes();
}

async function doDelete(note, card) {
  card.classList.add("deleting");
  state.notes = state.notes.filter((n) => n.id !== note.id);
  setTimeout(renderNotes, 180);
  try { await api(`/api/notes/${note.id}`, { method: "DELETE" }); }
  catch { toast("Delete failed — it may reappear"); }
}

// ---------- polling sync ----------
// ---------- live sync: websocket push (board room), lazy polling as fallback ----------
async function refreshBoard() {
  if (state.route.name !== "board" || !state.board) return;
  if (state.titleEditing || dragInProgress || document.hidden) return;
  try {
    const data = await api(`/api/boards/${state.board.id}?voter=${encodeURIComponent(store.voter)}`);
    state.pollFailures = 0;
    const before = JSON.stringify(state.notes.map(({ id, text, vote_count, voted, author, column_key, sort_order, updated_at }) => [id, text, vote_count, voted, author, column_key, sort_order, updated_at]));
    const after = JSON.stringify(data.notes.map(({ id, text, vote_count, voted, author, column_key, sort_order, updated_at }) => [id, text, vote_count, voted, author, column_key, sort_order, updated_at]));
    state.notes = data.notes;
    if (before !== after) renderNotes();
    state.serverOffset = (data.now || Date.now()) - Date.now();
    const prevTimer = state.timerEndsAt;
    state.timerEndsAt = data.board.timer_ends_at || null;
    if ((prevTimer || null) !== (state.timerEndsAt || null)) applyTimerState();
    if (data.board.title !== state.board.title && !state.titleEditing) {
      state.board = data.board;
      const titleEl = $app.querySelector(".board-title");
      if (titleEl) titleEl.textContent = data.board.title;
      document.title = `${data.board.title} · Free Retro`;
    }
  } catch (err) {
    if (err && err.status === 404) {
      toast("This board was deleted");
      location.hash = "#/";
      return;
    }
    state.pollFailures++;
    if (state.pollFailures === 3) toast("Connection hiccup — retrying…");
  }
}

let boardWS = null;
let boardWSBoardId = null;
let wsRetryDelay = 2000;
let lazyTimer = null;
let lazyDelay = 5000;

function connectBoardWS(boardId) {
  stopLazyPoll();
  if (boardWS && boardWSBoardId === boardId) return; // already wired to this room
  if (boardWS) { const old = boardWS; boardWS = null; boardWSBoardId = null; try { old.onclose = null; old.close(); } catch {} }

  boardWSBoardId = boardId;
  const proto = location.protocol === "https:" ? "wss" : "ws";
  let sock;
  try {
    sock = new WebSocket(`${proto}://${location.host}/api/boards/${boardId}/ws`);
  } catch {
    scheduleLazyPoll(boardId);
    scheduleWSReconnect(boardId);
    return;
  }
  boardWS = sock;
  sock.onopen = () => {
    wsRetryDelay = 2000;
    stopLazyPoll(); // push is live again
    refreshBoard();
  };
  sock.onmessage = (e) => {
    try {
      const msg = JSON.parse(e.data);
      if (msg.type === "changed") refreshBoard();
    } catch {}
  };
  sock.onclose = () => {
    if (boardWS !== sock) return; // superseded by a newer connection
    boardWS = null;
    if (boardWSBoardId !== boardId || state.route.name !== "board") return;
    scheduleLazyPoll(boardId); // degrade to slow polling while reconnecting
    const delay = wsRetryDelay;
    wsRetryDelay = Math.min(wsRetryDelay * 2, 30000);
    setTimeout(() => {
      if (boardWSBoardId === boardId && !boardWS && state.route.name === "board") connectBoardWS(boardId);
    }, delay);
  };
  sock.onerror = () => { try { sock.close(); } catch {} };
}

function closeBoardWS() {
  boardWSBoardId = null;
  stopLazyPoll();
  if (boardWS) {
    const sock = boardWS;
    boardWS = null;
    try { sock.onclose = null; sock.onmessage = null; sock.onerror = null; sock.close(); } catch {}
  }
}

function scheduleLazyPoll(boardId) {
  if (lazyTimer) return;
  lazyTimer = setTimeout(async () => {
    lazyTimer = null;
    if (state.route.name !== "board" || boardWSBoardId !== boardId || boardWS) return;
    await refreshBoard();
    lazyDelay = Math.min(lazyDelay * 2, 30000);
    scheduleLazyPoll(boardId);
  }, lazyDelay);
}

function stopLazyPoll() {
  clearTimeout(lazyTimer);
  lazyTimer = null;
  lazyDelay = 5000;
}

document.addEventListener("visibilitychange", () => {
  if (!document.hidden && state.route.name === "board") refreshBoard(); // catch up after backgrounding
});

// ---------- name modal ----------
function showNameModal() {
  if (document.querySelector(".overlay.name-overlay")) return;
  const input = h("input", {
    type: "text", maxlength: "40", placeholder: "e.g. Amy", value: store.name,
    "aria-label": "Your name",
    onkeydown: (e) => { if (e.key === "Enter" && !e.isComposing) save(); },
  });
  function save() {
    store.name = input.value;
    overlay.remove();
    renderBoardShell();
    if (!store.name) toast("You can stay anonymous — that's fine too");
  }
  const overlay = h("div", { class: "overlay name-overlay", onclick: (e) => { if (e.target === overlay && store.name) overlay.remove(); } },
    h("div", { class: "name-card" },
      h("h3", {}, "Who's adding notes today?"),
      h("p", {}, "Your name shows on your sticky notes. Stored only in your browser."),
      input,
      h("button", { class: "btn accent", onclick: save }, store.name ? "Save" : "Join the board"),
    ),
  );
  document.body.append(overlay);
  input.focus();
  input.select();
}

// ---------- site passcode gate ----------
function showGate() {
  if (document.getElementById("gate")) return;
  document.title = "Locked · Free Retro";
  const input = h("input", {
    type: "password", placeholder: "Passcode", "aria-label": "Site passcode",
    autocomplete: "current-password",
    onkeydown: (e) => { if (e.key === "Enter" && !e.isComposing) unlock(); },
  });
  const err = h("p", { class: "gate-err hidden" }, "Wrong passcode — try again");
  const btn = h("button", { class: "btn accent", onclick: unlock }, "Unlock");
  let busy = false;
  async function unlock() {
    if (busy) return;
    busy = true;
    btn.disabled = true;
    err.classList.add("hidden");
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ passcode: input.value }),
      });
      if (res.ok) {
        document.getElementById("gate").remove();
        document.title = "Free Retro — quick retrospective boards";
        route();
        return;
      }
      err.textContent = "Wrong passcode — try again";
      err.classList.remove("hidden");
      input.value = "";
      input.focus();
    } catch {
      err.textContent = "Couldn't reach the server — try again";
      err.classList.remove("hidden");
    }
    btn.disabled = false;
    busy = false;
  }
  document.body.append(
    h("div", { class: "overlay gate", id: "gate" },
      h("div", { class: "name-card gate-card" },
        h("div", { class: "gate-lock", html: ICONS.lock }),
        h("h3", {}, "This space is locked"),
        h("p", {}, "Enter the site passcode to view and run retros."),
        input,
        err,
        btn,
      ),
    ),
  );
  input.focus();
}

// ---------- boot ----------
async function boot() {
  try {
    await api("/api/auth/check");
    route();
  } catch {
    showGate(); // api() already rendered the gate on 401
  }
}
boot();
