-- Free Retro schema (D1 / SQLite)
--
-- Two ways this file is used:
--   fresh database    → run the whole file
--   existing database → do NOT re-run it; apply migrations/ instead (SQLite has
--                       no "ADD COLUMN IF NOT EXISTS", so the ALTERs would fail
--                       on a database that already has those columns)

CREATE TABLE IF NOT EXISTS users (
  id           TEXT PRIMARY KEY,
  email        TEXT,
  name         TEXT,             -- provider nickname
  display_name TEXT,             -- user-chosen override shown on notes (rule 19)
  avatar_url   TEXT,
  created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_users_email ON users (email);

-- one row per (provider, provider_user_id). Email is deliberately NOT the
-- identity key: GitHub often exposes no usable public email, so two providers
-- can only be linked through an explicit action.
CREATE TABLE IF NOT EXISTS oauth_identities (
  provider         TEXT NOT NULL,       -- 'google' | 'github'
  provider_user_id TEXT NOT NULL,
  user_id          TEXT NOT NULL,
  created_at       INTEGER NOT NULL,
  PRIMARY KEY (provider, provider_user_id)
);
CREATE INDEX IF NOT EXISTS idx_oauth_identities_user ON oauth_identities (user_id);

-- login sessions (user_id set) and anonymous sessions (user_id NULL).
-- The anonymous session is issued lazily on the first write, so a read-only
-- visitor never costs a row.
CREATE TABLE IF NOT EXISTS sessions (
  id         TEXT PRIMARY KEY,
  user_id    TEXT,                      -- NULL = anonymous visitor
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user   ON sessions (user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions (expires_at);

-- membership + the team-level role. A team may have several admins; the team
-- creator is inserted here as 'admin' at creation time.
CREATE TABLE IF NOT EXISTS team_members (
  team_id  TEXT NOT NULL,
  user_id  TEXT NOT NULL,
  role     TEXT NOT NULL,               -- 'admin' | 'member'
  added_by TEXT,
  added_at INTEGER NOT NULL,
  PRIMARY KEY (team_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_team_members_user ON team_members (user_id);

CREATE TABLE IF NOT EXISTS teams (
  id         TEXT PRIMARY KEY,     -- short id; the team link acts as its credential
  name       TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  created_by TEXT                  -- record only, no permission meaning (transfer was cancelled)
);

CREATE TABLE IF NOT EXISTS boards (
  id            TEXT PRIMARY KEY,
  title         TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  team_id       TEXT,              -- owning team
  created_by    TEXT,              -- board owner: merge + rename/delete/visibility
  visibility    TEXT NOT NULL DEFAULT 'public',  -- 'public' | 'team'
  timer_ends_at INTEGER,           -- silent-writing countdown end (epoch ms), NULL = off
  deleted_at    INTEGER            -- soft delete (recycle bin), NULL = active
);

CREATE INDEX IF NOT EXISTS idx_boards_team ON boards (team_id, deleted_at);

CREATE TABLE IF NOT EXISTS notes (
  id         TEXT PRIMARY KEY,
  board_id   TEXT NOT NULL,
  column_key TEXT NOT NULL,
  text       TEXT NOT NULL,
  author     TEXT NOT NULL DEFAULT '',   -- display name only; never used for permission
  owner_id   TEXT,                -- signing identity of the creator: signed-in user id
                                  -- or anonymous session id; NULL = legacy, TADMIN-only
  sort_order REAL,                -- manual position within its column (smaller = higher)
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_notes_board ON notes (board_id, created_at);
CREATE INDEX IF NOT EXISTS idx_notes_owner ON notes (owner_id);

CREATE TABLE IF NOT EXISTS votes (
  note_id    TEXT NOT NULL,
  voter      TEXT NOT NULL,       -- signing identity: user id or anonymous session id
  created_at INTEGER NOT NULL,
  PRIMARY KEY (note_id, voter)
);

CREATE INDEX IF NOT EXISTS idx_votes_note ON votes (note_id);
