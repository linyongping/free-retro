-- Free Retro schema (D1 / SQLite)

CREATE TABLE IF NOT EXISTS boards (
  id             TEXT PRIMARY KEY,
  title          TEXT NOT NULL,
  created_at     INTEGER NOT NULL,
  timer_ends_at  INTEGER,             -- silent-writing countdown end (epoch ms), NULL = off
  deleted_at     INTEGER              -- soft delete (recycle bin), NULL = active
);

CREATE TABLE IF NOT EXISTS notes (
  id         TEXT PRIMARY KEY,
  board_id   TEXT NOT NULL,
  column_key TEXT NOT NULL,
  text       TEXT NOT NULL,
  author     TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_notes_board ON notes (board_id, created_at);

CREATE TABLE IF NOT EXISTS votes (
  note_id TEXT NOT NULL,
  voter   TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (note_id, voter)
);

CREATE INDEX IF NOT EXISTS idx_votes_note ON votes (note_id);
