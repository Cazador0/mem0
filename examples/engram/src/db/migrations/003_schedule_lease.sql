-- Wake delivery was at-most-once: the claim (fired = 1) happened BEFORE the
-- wake event was recorded, so a crash in that window lost the wake forever.
-- claimed_at turns the claim into a LEASE: a claimed-but-unfired row becomes
-- reclaimable once the lease expires, and `fired` is now set in the same
-- transaction as the wake event, so the two can never disagree.
ALTER TABLE schedules ADD COLUMN claimed_at TEXT;
CREATE INDEX IF NOT EXISTS idx_schedules_claim ON schedules(fired, claimed_at);
