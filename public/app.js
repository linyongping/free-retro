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
async function route() {
  const hash = location.hash || "#/";
  const m = hash.match(/^#\/b\/([a-z0-9]+)/);
  if (m) {
    state.route = { name: "board", id: m[1] };
    await loadBoard(m[1]);
  } else if (hash.startsWith("#/admin")) {
    state.route = { name: "admin" };
    await renderAdmin();
  } else {
    state.route = { name: "home" };
    await renderHome();
  }
}
window.addEventListener("hashchange", route);

// ---------- home ----------
async function renderHome() {
  document.title = "Free Retro — quick retrospective boards";
  $app.replaceChildren(h("div", { class: "home" }));

  const root = $app.firstChild;
  root.append(
    h("div", { class: "hero" },
      h("h1", {}, "Free ", h("span", { class: "hl" }, "Retro")),
      h("p", {}, "Tiny retrospective boards for your team. Create one, share the link, drop sticky notes — no sign-up."),
    ),
  );

  // create card
  const input = h("input", {
    type: "text", maxlength: "120", placeholder: "Sprint 42 retro…",
    "aria-label": "Board title",
    onkeydown: (e) => { if (e.key === "Enter") createBtn.click(); },
  });
  const createBtn = h("button", { class: "btn accent", onclick: doCreate }, "Create board");
  function defaultBoardTitle() {
    const date = new Date().toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
    return `${date} retro board`;
  }
  async function doCreate() {
    const title = input.value.trim() || defaultBoardTitle();
    createBtn.disabled = true;
    try {
      const { board } = await api("/api/boards", { method: "POST", body: { title } });
      location.hash = `#/b/${board.id}`;
    } catch (err) {
      toast("Couldn't create the board — try again.");
      createBtn.disabled = false;
    }
  }
  root.append(
    h("div", { class: "create-card" },
      h("label", {}, "Start a new retro"),
      h("div", { class: "create-row" }, input, createBtn),
    ),
  );

  // boards list
  const listWrap = h("div");
  root.append(h("div", { class: "section-label", style: "margin-top:0" }, "Recent boards"), listWrap);
  try {
    const { boards } = await api("/api/boards");
    state.boards = boards;
    if (!boards.length) {
      listWrap.append(
        h("div", { class: "empty-hint" },
          h("div", { class: "doodle" }, "Nothing here yet"),
          h("p", {}, "Create your first board above and share the link at your next retro."),
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
  root.append(
    h("div", { class: "home-foot" },
      "free-retro · runs entirely on Cloudflare's free tier · your data lives in D1 · ",
      h("a", { href: "#/admin" }, "Manage boards"),
    ),
  );
}

// ---------- admin: manage boards ----------
function shortDate(ts) {
  return new Date(ts).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

async function renderAdmin() {
  document.title = "Manage boards · Free Retro";
  $app.replaceChildren(h("div", { class: "home" }));
  const root = $app.firstChild;

  root.append(
    h("div", { class: "admin-head" },
      h("a", { class: "back-link", href: "#/" }, h("span", { html: ICONS.back }), "All boards"),
      h("h1", { class: "admin-title" }, "Manage boards"),
      h("p", { class: "admin-sub" }, "Deleting a board permanently removes all of its notes and votes. There is no undo."),
    ),
  );

  const listWrap = h("div");
  root.append(listWrap);
  try {
    const { boards } = await api("/api/boards");
    if (!boards.length) {
      listWrap.append(
        h("div", { class: "empty-hint" },
          h("div", { class: "doodle" }, "No boards to manage"),
          h("p", {}, "Create one from the home page first."),
        ),
      );
      return;
    }
    listWrap.append(
      h("div", { class: "section-label" }, `${boards.length} board${boards.length === 1 ? "" : "s"}`),
      h("div", { class: "admin-list" }, ...boards.map(adminRow)),
    );
  } catch {
    listWrap.append(h("div", { class: "empty-hint" }, h("p", {}, "Couldn't load boards — is the server awake?")));
  }
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
    delBtn.textContent = `Sure? ${notesWord} gone`;
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
      setTimeout(() => {
        row.remove();
        const list = $app.querySelector(".admin-list");
        if (list && !list.children.length) route(); // show the empty state
      }, 200);
      toast(`Deleted “${b.title}”`);
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

// ---------- silent-writing timer ----------
function fmtRemain() {
  const s = Math.max(0, Math.ceil((state.timerEndsAt - (Date.now() + state.serverOffset)) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function buildTimerControl() {
  const menu = h("div", { class: "timer-menu hidden" });
  const btn = h("button", { class: "btn ghost", title: "Silent-writing timer" });
  const wrap = h("div", { class: "timer-wrap" }, btn, menu);

  function closeMenu() {
    menu.classList.add("hidden");
    document.removeEventListener("click", onDocClick, true);
  }
  function onDocClick(e) {
    if (!wrap.contains(e.target)) closeMenu();
  }
  function renderMenu() {
    menu.replaceChildren();
    for (const min of [5, 10]) {
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
      renderMenu();
      menu.classList.remove("hidden");
      setTimeout(() => document.addEventListener("click", onDocClick, true), 0);
    } else {
      closeMenu();
    }
  });
  return wrap;
}

function updateTimerButton() {
  const btn = $app.querySelector(".timer-wrap > button");
  if (!btn) return;
  if (state.timerEndsAt) {
    btn.className = "timer-chip";
    btn.replaceChildren(h("span", { html: ICONS.clock }), h("span", { class: "t-remain" }, fmtRemain()));
  } else {
    btn.className = "btn ghost";
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
async function loadBoard(id) {
  state.titleEditing = false;
  $app.replaceChildren(h("div", { class: "board-page" }, h("div", { style: "padding:40px;text-align:center;font-family:var(--font-hand);font-size:20px;color:var(--ink-soft)" }, "Unrolling the paper…")));
  let data;
  try {
    data = await api(`/api/boards/${id}?voter=${encodeURIComponent(store.voter)}`);
  } catch (err) {
    if (err.status === 404) {
      document.title = "Board not found · Free Retro";
      $app.replaceChildren(
        h("div", { class: "home" },
          h("div", { class: "empty-hint" },
            h("div", { class: "doodle" }, "This board has wandered off"),
            h("p", {}, "The link may be wrong, or the board was never created."),
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
  renderBoardShell();
  applyTimerState();

  if (!store.name) showNameModal();
}

function renderBoardShell() {
  const b = state.board;

  // title (click to edit)
  const titleEl = h("h1", {
    class: "board-title", title: "Click to rename",
    onclick: startTitleEdit,
  }, b.title);

  const shareBtn = h("button", {
    class: "btn ghost", onclick: async () => {
      try { await navigator.clipboard.writeText(location.href); toast("Link copied — share it with your team"); }
      catch { toast("Copy failed — grab it from the address bar"); }
    },
  }, h("span", { html: ICONS.link }), "Share");

  const meBtn = h("button", { class: "me-chip", title: "Change your name", onclick: () => showNameModal() },
    h("span", { class: "avatar", style: `--av: hsl(${avatarHue(store.name)}, 70%, 72%)` }, initialsOf(store.name)),
    store.name || "Set your name",
  );

  const topbar = h("nav", { class: "topbar" },
    h("a", { class: "back", href: "#/" }, h("span", { html: ICONS.back }), "Boards"),
    titleEl,
    h("div", { class: "spacer" }),
    buildTimerControl(),
    shareBtn,
    meBtn,
  );

  const columnsWrap = h("main", { class: "columns" });
  for (const col of COLUMNS) columnsWrap.append(buildColumn(col));

  $app.replaceChildren(h("div", { class: "board-page" }, topbar, columnsWrap));
  renderNotes();
}

function startTitleEdit() {
  if (state.titleEditing) return;
  state.titleEditing = true;
  const titleEl = $app.querySelector(".board-title");
  const input = h("input", {
    class: "board-title-input", maxlength: "120", value: state.board.title,
    onkeydown: (e) => {
      if (e.key === "Enter") input.blur();
      if (e.key === "Escape") { input.value = state.board.title; input.blur(); }
    },
    onblur: async () => {
      state.titleEditing = false;
      const title = input.value.trim().slice(0, 120);
      if (!title || title === state.board.title) { titleEl.replaceWith(h("h1", { class: "board-title", title: "Click to rename", onclick: startTitleEdit }, state.board.title)); return; }
      try {
        await api(`/api/boards/${state.board.id}`, { method: "PATCH", body: { title } });
        state.board.title = title;
        document.title = `${title} · Free Retro`;
      } catch { toast("Rename failed"); }
      const fresh = $app.querySelector(".board-title-input");
      if (fresh) fresh.replaceWith(h("h1", { class: "board-title", title: "Click to rename", onclick: startTitleEdit }, state.board.title));
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
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); }
      if (e.key === "Escape") closeComposer();
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
        body: { column_key: col.key, text, author: store.name },
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
  if (b.vote_count !== a.vote_count) return b.vote_count - a.vote_count;
  return a.created_at - b.created_at;
}

function renderNotes() {
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
    title: note.voted ? "Remove your vote" : "Vote for this note",
    onclick: () => toggleVote(note),
  }, h("span", { html: ICONS.heart }), note.vote_count > 0 ? String(note.vote_count) : "");

  // edit (inline textarea)
  const editBtn = h("button", { class: "tool-btn edit", title: "Edit note", onclick: () => startEdit(note, card, textEl) },
    h("span", { html: ICONS.pencil }));

  // delete (two-step confirm)
  const delBtn = h("button", { class: "tool-btn del", title: "Delete note", onclick: () => confirmDelete(note, delBtn) },
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
    h("div", { class: "note-foot" }, author, h("span", { class: "note-tools" }, voteBtn, editBtn, delBtn)),
  );
  delete note._entering;
  return card;
}

function startEdit(note, card, textEl) {
  if (card.querySelector(".note-edit-ta")) return;
  const ta = h("textarea", { class: "note-edit-ta", maxlength: "500" });
  ta.value = note.text;
  const finish = async (save) => {
    const newText = ta.value.trim().slice(0, 500);
    if (save && newText && newText !== note.text) {
      note.text = newText;
      try { await api(`/api/notes/${note.id}`, { method: "PATCH", body: { text: newText } }); }
      catch { toast("Edit failed — will resync"); }
    }
    renderNotes();
  };
  ta.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); ta.blur(); }
    if (e.key === "Escape") { ta.value = note.text; ta.blur(); }
  });
  ta.addEventListener("blur", () => finish(true));
  textEl.replaceWith(ta);
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
setInterval(async () => {
  if (state.route.name !== "board" || !state.board || document.hidden) return;
  if (state.titleEditing) return;
  try {
    const data = await api(`/api/boards/${state.board.id}?voter=${encodeURIComponent(store.voter)}`);
    state.pollFailures = 0;
    const before = JSON.stringify(state.notes.map(({ id, text, vote_count, voted, author, column_key, updated_at }) => [id, text, vote_count, voted, author, column_key, updated_at]));
    const after = JSON.stringify(data.notes.map(({ id, text, vote_count, voted, author, column_key, updated_at }) => [id, text, vote_count, voted, author, column_key, updated_at]));
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
}, 3000);

// ---------- name modal ----------
function showNameModal() {
  if ($app.querySelector(".overlay")) return;
  const input = h("input", {
    type: "text", maxlength: "40", placeholder: "e.g. Amy", value: store.name,
    "aria-label": "Your name",
    onkeydown: (e) => { if (e.key === "Enter") save(); },
  });
  function save() {
    store.name = input.value;
    overlay.remove();
    renderBoardShell();
    if (!store.name) toast("You can stay anonymous — that's fine too");
  }
  const overlay = h("div", { class: "overlay", onclick: (e) => { if (e.target === overlay && store.name) overlay.remove(); } },
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

// ---------- boot ----------
route();
