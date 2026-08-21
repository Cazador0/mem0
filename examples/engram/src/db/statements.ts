import type { Database } from "bun:sqlite";
import { RECALL_SQL } from "../memory/recall";
import { CORE_SQL } from "../memory/core";
import { ARCHIVAL_SQL } from "../memory/archival";
import { SCHEDULER_SQL } from "../orchestration/scheduler";

/**
 * Claim bun's prepared-statement cache for the statements that actually matter.
 *
 * `db.query()` caches at most 20 persistent statements per Database, and the
 * policy is first-come-first-served with NO eviction
 * (`willCache = cachedQueriesKeys.length < 20`, bun/src/js/bun/sqlite.ts:566).
 * That is the opposite of an LRU: whichever 20 distinct SQL strings the process
 * happens to run FIRST are cached for its whole life, and every other string
 * re-prepares on every single call. This app has 47 distinct strings, so
 * without intervention the winners are an accident of which code path ran
 * first — a startup that happens to list threads or run a migration probe can
 * permanently displace `appendEvent`.
 *
 * So the fix is not "use fewer statements", it is "decide which 20 win". Each
 * entry below is the SAME string constant its call site passes, imported rather
 * than copied: a copy would drift on the first whitespace edit and silently
 * warm a statement nobody runs.
 *
 * Cold statements are deliberately absent. They cost a re-prepare per call,
 * which is the correct trade for something that runs once per hour.
 */
export const HOT_STATEMENTS: readonly string[] = [
  // Every appended event — the single busiest path in the app.
  RECALL_SQL.nextSeq,
  RECALL_SQL.insertEvent,
  RECALL_SQL.insertEventFts,
  RECALL_SQL.touchThread,
  // Every loop iteration reloads the thread.
  RECALL_SQL.getThread,
  RECALL_SQL.threadEvents,
  // Every system prompt renders the core blocks.
  CORE_SQL.getBlock,
  CORE_SQL.listBlocks,
  // Every archival insert probes for a duplicate; every search re-reads rows.
  ARCHIVAL_SQL.byHashInScope,
  ARCHIVAL_SQL.byId,
  // Every scheduler tick, once a minute for the life of the process.
  SCHEDULER_SQL.dueWakes,
  SCHEDULER_SQL.claimWake,
  SCHEDULER_SQL.markFired,
];

/** bun's per-Database cache size (Database.MAX_QUERY_CACHE_SIZE). */
export const QUERY_CACHE_SIZE = 20;

/**
 * Run once, immediately after opening the database and before any other query,
 * so the hot set occupies the cache regardless of what runs next.
 */
export function prewarmStatementCache(db: Database): number {
  for (const sql of HOT_STATEMENTS) db.query(sql);
  return HOT_STATEMENTS.length;
}
