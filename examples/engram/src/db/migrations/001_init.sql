-- Engram schema. One SQLite file holds every tier.
-- Scope columns default to '' (not NULL) so UNIQUE constraints dedupe correctly.

CREATE TABLE IF NOT EXISTS threads (
  id            TEXT PRIMARY KEY,
  agent_id      TEXT NOT NULL,
  scope_key     TEXT NOT NULL,
  user_id       TEXT NOT NULL DEFAULT '',
  run_id        TEXT NOT NULL DEFAULT '',
  status_hint   TEXT NOT NULL DEFAULT 'new',
  extracted_seq INTEGER NOT NULL DEFAULT -1,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  id        TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES threads(id),
  seq       INTEGER NOT NULL,
  type      TEXT NOT NULL,
  data      TEXT NOT NULL,
  ts        TEXT NOT NULL,
  UNIQUE (thread_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_events_thread ON events(thread_id, seq);

CREATE VIRTUAL TABLE IF NOT EXISTS events_fts USING fts5(
  content,
  event_id UNINDEXED,
  thread_id UNINDEXED,
  tokenize = 'porter unicode61'
);

CREATE TABLE IF NOT EXISTS core_blocks (
  agent_id   TEXT NOT NULL,
  label      TEXT NOT NULL,
  content    TEXT NOT NULL DEFAULT '',
  char_limit INTEGER NOT NULL DEFAULT 2000,
  read_only  INTEGER NOT NULL DEFAULT 0,
  version    INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (agent_id, label)
);

CREATE TABLE IF NOT EXISTS memories (
  id                TEXT PRIMARY KEY,
  content           TEXT NOT NULL,
  hash              TEXT NOT NULL,
  embedding         BLOB,
  user_id           TEXT NOT NULL DEFAULT '',
  agent_id          TEXT NOT NULL DEFAULT '',
  run_id            TEXT NOT NULL DEFAULT '',
  memory_type       TEXT NOT NULL DEFAULT 'fact',
  source_thread_id  TEXT,
  source_event_seqs TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  expiration_date   TEXT,
  metadata          TEXT NOT NULL DEFAULT '{}',
  UNIQUE (hash, user_id, agent_id, run_id)
);
CREATE INDEX IF NOT EXISTS idx_memories_scope ON memories(user_id, agent_id, run_id);

CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
  content,
  memory_id UNINDEXED,
  tokenize = 'porter unicode61'
);

CREATE TABLE IF NOT EXISTS entities (
  id                TEXT PRIMARY KEY,
  data              TEXT NOT NULL,
  entity_type       TEXT NOT NULL,
  linked_memory_ids TEXT NOT NULL DEFAULT '[]',
  user_id           TEXT NOT NULL DEFAULT '',
  agent_id          TEXT NOT NULL DEFAULT '',
  run_id            TEXT NOT NULL DEFAULT '',
  UNIQUE (data, user_id, agent_id, run_id)
);

CREATE TABLE IF NOT EXISTS memory_history (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  memory_id      TEXT NOT NULL,
  previous_value TEXT,
  new_value      TEXT,
  action         TEXT NOT NULL,
  created_at     TEXT NOT NULL,
  is_deleted     INTEGER NOT NULL DEFAULT 0,
  actor_id       TEXT
);
CREATE INDEX IF NOT EXISTS idx_memory_history_memory ON memory_history(memory_id);

CREATE TABLE IF NOT EXISTS schedules (
  id         TEXT PRIMARY KEY,
  thread_id  TEXT NOT NULL,
  wake_at    TEXT NOT NULL,
  note       TEXT NOT NULL DEFAULT '',
  fired      INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_schedules_due ON schedules(fired, wake_at);

CREATE TABLE IF NOT EXISTS artifacts (
  id         TEXT PRIMARY KEY,
  kind       TEXT NOT NULL,
  content    TEXT NOT NULL DEFAULT '',
  status     TEXT NOT NULL DEFAULT 'draft',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
