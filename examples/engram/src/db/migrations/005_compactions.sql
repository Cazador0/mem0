-- Render-seam compaction. Everything past the verbatim tail used to be elided
-- behind a marker, so a long-lived thread lost its own mid-thread commitments —
-- keyword recall_search finds wording, not decisions.
--
-- The summary lives in its own table rather than in the event log: the event
-- vocabulary is closed (adding a type means touching every derived-status
-- predicate), and the archival store is cross-thread, where a half-conversation
-- could surface in an unrelated thread's search. Keyed by (thread_id, up_to_seq)
-- so compaction is idempotent per boundary and the canonical events are never
-- touched.
CREATE TABLE IF NOT EXISTS compactions (
  id          TEXT PRIMARY KEY,
  thread_id   TEXT NOT NULL,
  up_to_seq   INTEGER NOT NULL,
  summary     TEXT NOT NULL,
  event_count INTEGER NOT NULL,
  created_at  TEXT NOT NULL,
  UNIQUE (thread_id, up_to_seq)
);
CREATE INDEX IF NOT EXISTS idx_compactions_thread ON compactions(thread_id, up_to_seq DESC);
