-- Link each schedules row to the sleep_until tool_call event that created it,
-- so a superseded sleep's row can be recognized as stale instead of waking the
-- thread early out of a NEWER sleep.
ALTER TABLE schedules ADD COLUMN sleep_seq INTEGER NOT NULL DEFAULT -1;
