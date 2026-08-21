import { describe, expect, test } from "bun:test";
import { openDb } from "../src/db/database";
import {
  HOT_STATEMENTS,
  prewarmStatementCache,
  QUERY_CACHE_SIZE,
} from "../src/db/statements";
import { RECALL_SQL, RecallStore } from "../src/memory/recall";

/**
 * bun caches at most 20 prepared statements per Database, first-come-first-
 * served with no eviction. Cache membership is observable through object
 * identity: a cached string returns the SAME Statement every time, an uncached
 * one returns a fresh object per call.
 */
const isCached = (db: ReturnType<typeof openDb>, sql: string) => db.query(sql) === db.query(sql);

describe("prepared-statement cache", () => {
  test("the hot set fits, with headroom", () => {
    expect(HOT_STATEMENTS.length).toBeLessThanOrEqual(QUERY_CACHE_SIZE);
    expect(new Set(HOT_STATEMENTS).size).toBe(HOT_STATEMENTS.length); // no duplicates wasting a slot
  });

  test("identity really does reveal cache membership", () => {
    const db = openDb(":memory:");
    // Sanity-check the instrument before trusting it: an obviously-cached
    // statement is stable, and once the cache is full a novel one is not.
    expect(isCached(db, "SELECT 1")).toBe(true);
    for (let i = 0; i < QUERY_CACHE_SIZE + 5; i++) db.query(`SELECT ${i + 100}`);
    expect(isCached(db, "SELECT 'definitely past the cap'")).toBe(false);
    db.close();
  });

  test("pre-warming makes every hot statement cached", () => {
    const db = openDb(":memory:");
    prewarmStatementCache(db);
    for (const sql of HOT_STATEMENTS) {
      expect({ sql: sql.slice(0, 40), cached: isCached(db, sql) }).toEqual({
        sql: sql.slice(0, 40),
        cached: true,
      });
    }
    db.close();
  });

  test("without pre-warming, cold traffic can displace the hot path", () => {
    // This is the failure the module exists to prevent: the cache is NOT an
    // LRU, so whatever runs first wins permanently.
    const db = openDb(":memory:");
    for (let i = 0; i < QUERY_CACHE_SIZE; i++) db.query(`SELECT ${i} AS cold_startup_query`);
    expect(isCached(db, RECALL_SQL.insertEvent)).toBe(false); // appendEvent loses its slot

    const warmed = openDb(":memory:");
    prewarmStatementCache(warmed);
    for (let i = 0; i < QUERY_CACHE_SIZE; i++) warmed.query(`SELECT ${i} AS cold_startup_query`);
    expect(isCached(warmed, RECALL_SQL.insertEvent)).toBe(true); // ...and keeps it when warmed
    db.close();
    warmed.close();
  });

  test("the warmed strings are the ones the code actually runs", () => {
    // The whole scheme collapses if the list drifts from the call sites, so
    // exercise a real write and assert it did not add a new cache entry.
    const db = openDb(":memory:");
    prewarmStatementCache(db);
    const store = new RecallStore(db);
    const thread = store.createThread("engram", { userId: "u1", agentId: "engram" });
    store.appendEvent(thread.id, "user_input", "hello");
    store.getThread(thread.id);

    for (const sql of [
      RECALL_SQL.nextSeq,
      RECALL_SQL.insertEvent,
      RECALL_SQL.insertEventFts,
      RECALL_SQL.touchThread,
      RECALL_SQL.getThread,
      RECALL_SQL.threadEvents,
    ]) {
      expect(isCached(db, sql)).toBe(true);
    }
    db.close();
  });
});
