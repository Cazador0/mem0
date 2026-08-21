-- Capsule artifacts (BMAD). `artifacts` already exists from 001 as a
-- single-blob placeholder (id/kind/content/status/timestamps); a capsule needs
-- two things it did not have — the thread it was compiled from, and a human
-- title — so the table is extended rather than redefined.
ALTER TABLE artifacts ADD COLUMN thread_id TEXT NOT NULL DEFAULT '';
ALTER TABLE artifacts ADD COLUMN title TEXT NOT NULL DEFAULT '';

-- Sections, because both permissions are per SECTION: who may READ one (a
-- reviewer's envelope IS the set of sections it is handed, which is what makes
-- reviewers asymmetric) and who may WRITE it (one owner each; host-compiled
-- sections have no agent owner and are immutable). `version` carries BMAD's
-- compare-and-set discipline into the write path.
CREATE TABLE IF NOT EXISTS artifact_sections (
  artifact_id    TEXT NOT NULL REFERENCES artifacts(id),
  name           TEXT NOT NULL,
  -- Empty means the host compiled it: no agent may write it, ever.
  owner_agent_id TEXT NOT NULL,
  content        TEXT NOT NULL,
  version        INTEGER NOT NULL DEFAULT 0,
  updated_at     TEXT NOT NULL,
  PRIMARY KEY (artifact_id, name)
);

CREATE INDEX IF NOT EXISTS idx_artifacts_thread ON artifacts(thread_id, created_at DESC);
