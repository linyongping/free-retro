-- 0001 — user management & permission control (2026-09-15)
--
-- Run ONCE against an existing database, before deploying the matching code:
--   npx wrangler d1 execute free-retro-db --remote --file=./migrations/0001-user-management.sql
--
-- New databases do not need this file — schema.sql already has the final shape.
-- SQLite has no "ADD COLUMN IF NOT EXISTS", so re-running this will fail on the
-- ALTER statements at the bottom; that is expected, not a bug.
--
-- Deploy order matters (see docs/permission-matrix.md §14). This migration is
-- additive and NULL-tolerant, so it is safe to apply before the code ships: the
-- old code ignores the new tables, and the new code reads `visibility !== 'team'`
-- so it treats anything unspecified as public.

-- ---------------------------------------------------------------- new tables
-- (same definitions as schema.sql; IF NOT EXISTS keeps this re-runnable)

CREATE TABLE IF NOT EXISTS users (
  id           TEXT PRIMARY KEY,
  email        TEXT,
  name         TEXT,             -- provider nickname
  display_name TEXT,             -- user-chosen override shown on notes (rule 19)
  avatar_url   TEXT,
  created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_users_email ON users (email);

CREATE TABLE IF NOT EXISTS oauth_identities (
  provider         TEXT NOT NULL,
  provider_user_id TEXT NOT NULL,
  user_id          TEXT NOT NULL,
  created_at       INTEGER NOT NULL,
  PRIMARY KEY (provider, provider_user_id)
);
CREATE INDEX IF NOT EXISTS idx_oauth_identities_user ON oauth_identities (user_id);

CREATE TABLE IF NOT EXISTS sessions (
  id         TEXT PRIMARY KEY,
  user_id    TEXT,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user   ON sessions (user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions (expires_at);

CREATE TABLE IF NOT EXISTS team_members (
  team_id  TEXT NOT NULL,
  user_id  TEXT NOT NULL,
  role     TEXT NOT NULL,
  added_by TEXT,
  added_at INTEGER NOT NULL,
  PRIMARY KEY (team_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_team_members_user ON team_members (user_id);

-- ------------------------------------------------------------------ new columns
-- Existing boards become `public`, which is both the new default and the only
-- value that keeps already-shared links working. It is also mandatory: legacy
-- teams have no members at all, so marking these boards `team` would make them
-- unreadable by everyone, including the people holding a live link.
ALTER TABLE boards ADD COLUMN visibility TEXT NOT NULL DEFAULT 'public';
ALTER TABLE boards ADD COLUMN created_by TEXT;
ALTER TABLE teams  ADD COLUMN created_by TEXT;

UPDATE boards SET visibility = 'public' WHERE visibility IS NULL;

CREATE INDEX IF NOT EXISTS idx_notes_owner ON notes (owner_id);

-- ------------------------------------------------------- legacy ownership
-- Nothing above assigns an owner to existing teams, and a team with no admin can
-- never be managed again (no global admin exists by design). After the first
-- person signs in with OAuth, claim the legacy teams for them:
--
--   1. find the user id
--      SELECT id, email, name FROM users;
--   2. list the teams still unowned
--      SELECT t.id, t.name, (SELECT COUNT(*) FROM boards b WHERE b.team_id = t.id) AS boards
--      FROM teams t WHERE t.created_by IS NULL;
--   3. make that user the admin of every unowned team
--      INSERT OR IGNORE INTO team_members (team_id, user_id, role, added_by, added_at)
--      SELECT t.id, '<USER_ID>', 'admin', NULL, strftime('%s','now') * 1000
--      FROM teams t WHERE t.created_by IS NULL;
--      UPDATE teams SET created_by = '<USER_ID>' WHERE created_by IS NULL;
--
-- Until that runs, legacy boards stay in a frozen state: publicly readable and
-- writable, but with no owner and no admin, so nobody can rename, delete or
-- merge them (docs/permission-matrix.md §10 #2).
