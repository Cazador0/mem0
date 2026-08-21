-- Extraction used to advance its watermark past per-item insert failures, so a
-- memory that failed to store was never retried. Count consecutive partial
-- failures per thread so the watermark can be HELD for a bounded number of
-- attempts and then released (a permanently-failing item must not livelock
-- extraction forever).
ALTER TABLE threads ADD COLUMN extract_failures INTEGER NOT NULL DEFAULT 0;
