import { describe, expect, test } from "bun:test";
import { FakeEmbedder, testWorld } from "./harness";
import { closeDb, openDb, probeFts5 } from "../src/db/database";
import { mkdtempSync, rmSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArchivalMemory } from "../src/memory/archival";
import { EntityIndex, extractEntities } from "../src/memory/entities";
import { crowdPenalty, ENTITY_BOOST_WEIGHT, getBm25Params, scoreAndRank } from "../src/memory/scoring";
import { buildScopeKey, RecallStore, stripIdentityKeys } from "../src/memory/recall";

const SCOPE = { userId: "u1", agentId: "engram", runId: "" };

/** A FakeEmbedder with a failure toggle, for outage-path tests. */
class FlakyEmbedder extends FakeEmbedder {
  fail = false;
  override async embed(text: string): Promise<Float32Array> {
    if (this.fail) throw new Error("embedding endpoint down");
    return super.embed(text);
  }
}

describe("database bootstrap", () => {
  test("openDb probes FTS5 at startup; closeDb checkpoints and closes", () => {
    const db = openDb(":memory:");
    // Reaching this line means the startup FTS5 probe passed (constitution VII
    // capability detection); on a build without FTS5 openDb throws a named error.
    closeDb(db); // checkpoint + close must not throw
    expect(() => db.query("SELECT 1").get()).toThrow(); // really closed
  });

  test("the FTS5 probe fails loudly with the remedy when the build lacks FTS5", () => {
    // The real failure only happens where Bun dlopens a system SQLite without
    // FTS5 (macOS), so drive the probe with a stub to cover the branch here.
    const stub = {
      run(sql: string) {
        if (sql.includes("fts5")) throw new Error("no such module: fts5");
        return undefined;
      },
    };
    expect(() => probeFts5(stub)).toThrow(/no FTS5 support/);
    expect(() => probeFts5(stub)).toThrow(/setCustomSQLite/); // names the remedy
  });

  test("an existing database upgrades in place and re-migrating is a no-op", () => {
    const dir = mkdtempSync(join(tmpdir(), "engram-migrate-"));
    const path = join(dir, "engram.sqlite");
    try {
      const first = openDb(path);
      const store = new RecallStore(first);
      const thread = store.createThread("engram", SCOPE);
      store.appendEvent(thread.id, "user_input", "a memory from before the upgrade");

      // Rewind to the pre-lease schema: this is the shape an engram.sqlite
      // created by an earlier version actually has on disk.
      first.run("DELETE FROM migrations WHERE name IN ('003_schedule_lease.sql', '004_extract_failures.sql')");
      first.run("DROP INDEX IF EXISTS idx_schedules_claim");
      first.run("ALTER TABLE schedules DROP COLUMN claimed_at");
      first.run("ALTER TABLE threads DROP COLUMN extract_failures");
      closeDb(first);

      // Re-opening must add the columns without touching the existing rows.
      const upgraded = openDb(path);
      const names = (upgraded.query("SELECT name FROM migrations").all() as Array<{ name: string }>).map(r => r.name);
      expect(names).toContain("003_schedule_lease.sql");
      expect(names).toContain("004_extract_failures.sql");

      const store2 = new RecallStore(upgraded);
      const reloaded = store2.getThread(thread.id);
      expect(reloaded.events.length).toBe(1); // data survived
      expect(store2.extractFailures(thread.id)).toBe(0); // new column defaulted
      closeDb(upgraded);

      // Idempotent: a second open must not re-run ALTER (duplicate column).
      const again = openDb(path);
      const count = again.query("SELECT COUNT(*) AS n FROM migrations").get() as { n: number };
      expect(count.n).toBe(4);
      closeDb(again);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("closeDb checkpoints the WAL so no sidecar outlives the process", () => {
    // The one place a test may touch a real file: a throwaway temp database,
    // because WAL sidecar behavior cannot be observed in :memory:.
    const dir = mkdtempSync(join(tmpdir(), "engram-wal-"));
    const path = join(dir, "engram.sqlite");
    try {
      const db = openDb(path);
      const store = new RecallStore(db);
      const thread = store.createThread("engram", SCOPE);
      store.appendEvent(thread.id, "user_input", "write something into the WAL");
      expect(statSync(`${path}-wal`).size).toBeGreaterThan(0); // WAL is live pre-close

      closeDb(db);
      // TRUNCATE checkpoint folds the WAL back into the main file: the sidecar
      // is gone or empty, so reopening never depends on leftover state.
      const walGone = !existsSync(`${path}-wal`) || statSync(`${path}-wal`).size === 0;
      expect(walGone).toBe(true);

      // The data itself survived the checkpoint.
      const reopened = openDb(path);
      const rows = reopened.query("SELECT COUNT(*) AS n FROM events").get() as { n: number };
      expect(rows.n).toBe(1);
      closeDb(reopened);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("core tier", () => {
  test("seeds default blocks plus a read-only constitution pointer", () => {
    const { deps } = testWorld();
    const labels = deps.core.list("engram").map(b => b.label);
    expect(labels).toEqual(["constitution", "human", "persona", "project", "scratchpad"]);
    expect(deps.core.get("engram", "constitution")?.readOnly).toBe(true);
    expect(deps.core.get("engram", "constitution")?.content).toContain("Constitution v1.0.0");
  });

  test("append and replace respect budgets, exact match, and read-only", () => {
    const { deps } = testWorld();
    expect(deps.core.append("engram", "human", "Name: Hunter").ok).toBe(true);
    expect(deps.core.get("engram", "human")?.content).toBe("Name: Hunter");

    const replaced = deps.core.replace("engram", "human", "Hunter", "Hunter B.");
    expect(replaced.ok).toBe(true);
    expect(deps.core.get("engram", "human")?.content).toBe("Name: Hunter B.");

    expect(deps.core.replace("engram", "human", "does-not-exist", "x").ok).toBe(false);
    expect(deps.core.append("engram", "human", "y".repeat(5000)).message).toContain("budget exceeded");
    expect(deps.core.append("engram", "constitution", "sneaky edit").message).toContain("read-only");

    // Every successful edit bumps the version (CAS audit trail).
    expect(deps.core.get("engram", "human")?.version).toBe(3);
  });

  test("render shows per-block budget pressure", () => {
    const { deps } = testWorld();
    deps.core.append("engram", "scratchpad", "wip");
    expect(deps.core.render("engram")).toContain('<core_block label="scratchpad" chars="3/2000">');
  });
});

describe("archival tier", () => {
  test("insert dedupes by content hash and audits ADD", async () => {
    const { deps } = testWorld();
    const first = await deps.archival.insert({ content: "User's dog is named Poppy.", scope: SCOPE });
    const second = await deps.archival.insert({ content: "  user's dog is  named poppy. ", scope: SCOPE });
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.id).toBe(first.id);
    const history = deps.archival.history(first.id);
    expect(history.map(h => h.action)).toEqual(["ADD"]);
  });

  test("hybrid search ranks the related memory first and can explain", async () => {
    const { deps } = testWorld();
    await deps.archival.insert({ content: "User's dog is named Poppy and loves morning walks.", scope: SCOPE });
    await deps.archival.insert({ content: "User works as a platform engineer at a fintech startup.", scope: SCOPE });

    const hits = await deps.archival.search({ query: "dog named Poppy", scope: SCOPE, explain: true });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.payload.content).toContain("Poppy");
    // All three signals are active for this query (semantic + BM25 + entity),
    // so the adaptive divisor must be exactly 1.0 + 1.0 + 0.5.
    expect(hits[0]!.scoreDetails!.maxPossibleScore).toBe(2.5);
    expect(hits[0]!.scoreDetails!.entityBoost).toBeGreaterThan(0);
  });

  test("ranking orders candidates by combined score, best first", async () => {
    const { deps } = testWorld();
    await deps.archival.insert({ content: "dog naps daily", scope: SCOPE });
    await deps.archival.insert({ content: "User's dog Poppy loves long walks", scope: SCOPE });
    const hits = await deps.archival.search({ query: "dog Poppy walks", scope: SCOPE });
    expect(hits.length).toBe(2);
    expect(hits[0]!.payload.content).toContain("Poppy");
    expect(hits[1]!.payload.content).toContain("naps");
    expect(hits[0]!.score).toBeGreaterThan(hits[1]!.score);
  });

  test("keyword/entity boosts never resurrect a semantically gated-out candidate", async () => {
    const { deps } = testWorld();
    // One shared token ("Poppy") out of many: cosine ~0.25 < the 0.3 gate,
    // while FTS matches the keyword squarely.
    await deps.archival.insert({
      content:
        "Poppy quietly wandered around seventeen distant meadows yesterday while gentle breezes carried autumn fragrances toward remote villages",
      scope: SCOPE,
    });
    const hits = await deps.archival.search({ query: "Poppy", scope: SCOPE });
    expect(hits).toEqual([]);
  });
});

describe("scoreAndRank unit guarantees (mem0 semantics)", () => {
  const payload = {};

  test("threshold gates semantic score BEFORE boosts are added", () => {
    const ranked = scoreAndRank(
      [{ id: "gated", score: 0.2, payload }],
      { gated: 0.9 },
      { gated: 0.5 },
      0.3,
      10,
    );
    expect(ranked).toEqual([]);
  });

  test("scores combine additively and rank descending", () => {
    const ranked = scoreAndRank(
      [
        { id: "a", score: 0.5, payload },
        { id: "b", score: 0.4, payload },
      ],
      { a: 0.1, b: 0.9 },
      {},
      0.3,
      10,
    );
    // maxPossible = 2.0 (semantic + bm25): a = 0.6/2, b = 1.3/2.
    expect(ranked.map(r => r.id)).toEqual(["b", "a"]);
    expect(ranked[0]!.score).toBeCloseTo(0.65, 5);
    expect(ranked[1]!.score).toBeCloseTo(0.3, 5);
  });

  test("the divisor adapts to which signals are active", () => {
    const semanticOnly = scoreAndRank([{ id: "x", score: 0.8, payload }], {}, {}, 0.3, 1, true);
    expect(semanticOnly[0]!.scoreDetails!.maxPossibleScore).toBe(1.0);
    const withBm25 = scoreAndRank([{ id: "x", score: 0.8, payload }], { x: 0.5 }, {}, 0.3, 1, true);
    expect(withBm25[0]!.scoreDetails!.maxPossibleScore).toBe(2.0);
    const withBoth = scoreAndRank([{ id: "x", score: 0.8, payload }], { x: 0.5 }, { x: 0.2 }, 0.3, 1, true);
    expect(withBoth[0]!.scoreDetails!.maxPossibleScore).toBe(2.5);
  });

  test("mem0-ported constants are pinned: sigmoid table, crowd penalty, entity weight", () => {
    // Query-length-adaptive sigmoid parameters (mem0/utils/scoring.py table).
    expect(getBm25Params("one two")).toEqual([5.0, 0.7]);
    expect(getBm25Params("a b c d e")).toEqual([7.0, 0.6]);
    expect(getBm25Params("a b c d e f g h")).toEqual([9.0, 0.5]);
    expect(getBm25Params(Array(12).fill("w").join(" "))).toEqual([10.0, 0.5]);
    expect(getBm25Params(Array(20).fill("w").join(" "))).toEqual([12.0, 0.5]);
    // Hub-entity damping: 1/(1+0.001*(n-1)^2).
    expect(crowdPenalty(1)).toBe(1.0);
    expect(crowdPenalty(11)).toBeCloseTo(1 / 1.1, 10);
    expect(ENTITY_BOOST_WEIGHT).toBe(0.5);
  });
});

describe("archival tier: mutations and read filters", () => {
  test("degraded mode (no embedder) still finds memories via FTS", async () => {
    const { deps } = testWorld({ embedder: false });
    await deps.archival.insert({ content: "User's favorite editor is Neovim with a custom config.", scope: SCOPE });
    const hits = await deps.archival.search({ query: "neovim editor", scope: SCOPE });
    expect(hits.length).toBe(1);
    expect(hits[0]!.payload.content).toContain("Neovim");
  });

  test("update rewrites content, rehashes, and audits before/after", async () => {
    const { deps } = testWorld();
    const { id, memory } = await deps.archival.insert({ content: "User lives in Austin.", scope: SCOPE });
    const result = await deps.archival.update(id, "User lives in Denver as of June 2026.");
    expect(result.ok).toBe(true);
    const updated = deps.archival.getById(id);
    expect(updated?.content).toContain("Denver");
    expect(updated?.hash).not.toBe(memory.hash);
    const actions = deps.archival.history(id).map(h => h.action);
    expect(actions).toEqual(["ADD", "UPDATE"]);
  });

  test("delete removes the row but keeps a soft-deleted audit trail", async () => {
    const { deps } = testWorld();
    const { id } = await deps.archival.insert({ content: "Temporary fact to delete.", scope: SCOPE });
    expect(deps.archival.delete(id).ok).toBe(true);
    expect(deps.archival.getById(id)).toBeNull();
    const history = deps.archival.history(id);
    expect(history.map(h => h.action)).toEqual(["ADD", "DELETE"]);
    expect(history[1]!.isDeleted).toBe(true);
  });

  test("scope isolates memories", async () => {
    const { deps } = testWorld();
    await deps.archival.insert({ content: "User speaks fluent Portuguese.", scope: SCOPE });
    const otherScope = await deps.archival.search({ query: "portuguese", scope: { userId: "someone-else" } });
    expect(otherScope).toEqual([]);
  });

  test("reads filter only on supplied scope keys: other agents' threads see the user's memories", async () => {
    const { deps } = testWorld();
    // Written from an engram thread's identity, as executeStep/extraction do.
    await deps.archival.insert({ content: "User's favorite color is teal.", scope: SCOPE });

    // A user-scoped read (what archival_search now passes) sees it regardless
    // of the reading thread's own agent/run identity.
    const userWide = await deps.archival.search({ query: "favorite color teal", scope: { userId: "u1" } });
    expect(userWide.length).toBe(1);

    // Supplying a key still restricts — subset semantics, never wildcard.
    const wrongAgent = await deps.archival.search({
      query: "favorite color teal",
      scope: { userId: "u1", agentId: "curator" },
    });
    expect(wrongAgent).toEqual([]);

    // And "" is an exact value, not a wildcard: anonymous stays anonymous.
    const emptyUser = await deps.archival.search({ query: "favorite color teal", scope: { userId: "" } });
    expect(emptyUser).toEqual([]);
  });

  test("update stores NULL embedding on re-embed failure so the NEW content stays findable", async () => {
    const { deps } = testWorld();
    const flaky = new FlakyEmbedder();
    const archival = new ArchivalMemory(deps.db, flaky);
    const { id } = await archival.insert({ content: "User lives in Austin.", scope: SCOPE });

    flaky.fail = true;
    expect((await archival.update(id, "User lives in Denver as of June 2026.")).ok).toBe(true);
    flaky.fail = false;

    // Reachable by its new content via the NULL-embedding BM25 fallback…
    const byNew = await archival.search({ query: "Denver", scope: SCOPE });
    expect(byNew.map(h => h.payload.content)).toEqual(["User lives in Denver as of June 2026."]);
    // …and the stale Austin vector no longer routes old-content queries to it.
    expect(await archival.search({ query: "Austin", scope: SCOPE })).toEqual([]);
  });

  test("search degrades to keyword scoring when the query embed fails", async () => {
    const { deps } = testWorld();
    const flaky = new FlakyEmbedder();
    const archival = new ArchivalMemory(deps.db, flaky);
    await archival.insert({ content: "User's favorite editor is Neovim with a custom config.", scope: SCOPE });

    flaky.fail = true;
    const hits = await archival.search({ query: "neovim editor", scope: SCOPE });
    expect(hits.length).toBe(1);
    expect(hits[0]!.payload.content).toContain("Neovim");
  });

  test("expired memories are filtered at read time", async () => {
    const { deps } = testWorld();
    await deps.archival.insert({
      content: "User has a temporary parking permit for lot B.",
      scope: SCOPE,
      expirationDate: "2020-01-01",
    });
    const hidden = await deps.archival.search({ query: "parking permit", scope: SCOPE });
    expect(hidden).toEqual([]);
    const shown = await deps.archival.search({ query: "parking permit", scope: SCOPE, showExpired: true });
    expect(shown.length).toBe(1);
  });
});

describe("entity side-index", () => {
  test("extracts proper nouns, quoted text, and identifiers", () => {
    const names = extractEntities('My dog Poppy runs "morning laps" using the fitness_tracker.app').map(e => e.data);
    expect(names).toContain("Poppy");
    expect(names).toContain("morning laps");
    expect(names).toContain("fitness_tracker.app");
  });

  test("a bare entity name — the most natural query there is — fires the boost", async () => {
    const { deps } = testWorld();
    const { id } = await deps.archival.insert({ content: "User's dog is named Poppy.", scope: SCOPE });
    const index = new EntityIndex(deps.db);

    // Mid-sentence phrasing always worked, which is why this gap survived four
    // review rounds: every prior test asked "Tell me about Poppy".
    expect(index.boostsForQuery("Tell me about Poppy", SCOPE)[id]).toBeGreaterThan(0);
    // The bare name is the case the indexing heuristic's sentence-starter guard
    // used to swallow entirely.
    expect(index.boostsForQuery("Poppy", SCOPE)[id]).toBeGreaterThan(0);
    expect(index.boostsForQuery("Poppy's walk", SCOPE)[id]).toBeGreaterThan(0);

    // Indexing stays conservative — a sentence starter must not become an entity.
    expect(extractEntities("Also my cat is hungry").map(e => e.data)).not.toContain("Also");
    // ...while the permissive query pass may produce it; harmless, it matches nothing.
    expect(extractEntities("Also my cat is hungry", { lineInitialSingles: true }).map(e => e.data)).toContain("Also");
  });

  test("links memories and boosts them for entity queries, with unlink on delete", async () => {
    const { deps } = testWorld();
    const { id } = await deps.archival.insert({ content: "User's dog is named Poppy.", scope: SCOPE });
    const index = new EntityIndex(deps.db);
    const boosts = index.boostsForQuery("Tell me about Poppy", SCOPE);
    expect(boosts[id]).toBeGreaterThan(0);
    deps.archival.delete(id);
    expect(index.boostsForQuery("Tell me about Poppy", SCOPE)[id]).toBeUndefined();
  });
});

describe("recall tier", () => {
  test("events get monotonic seqs and are FTS-searchable", () => {
    const { deps } = testWorld();
    const thread = deps.store.createThread("engram", SCOPE);
    deps.store.appendEvent(thread.id, "user_input", "Let's plan the Lisbon trip for October.");
    deps.store.appendEvent(thread.id, "user_input", "Also remind me about the dentist.");
    const reloaded = deps.store.getThread(thread.id);
    expect(reloaded.events.map(e => e.seq)).toEqual([0, 1]);

    const hits = deps.store.searchEvents(thread.id, "lisbon trip");
    expect(hits.length).toBe(1);
    expect(hits[0]!.event.seq).toBe(0);
  });

  test("recent window truncates long messages and keeps the last n", () => {
    const { deps } = testWorld();
    const thread = deps.store.createThread("engram", SCOPE);
    for (let i = 0; i < 15; i++) deps.store.appendEvent(thread.id, "user_input", `message ${i} ${"x".repeat(400)}`);
    const window = deps.store.recentWindow(deps.store.getThread(thread.id), 10, 100);
    expect(window.length).toBe(10);
    expect(window[0]!.text.length).toBeLessThanOrEqual(101);
    expect(window[9]!.text).toContain("message 14");
  });

  test("scope keys are deterministic and identity keys are stripped from metadata", () => {
    expect(buildScopeKey({ agentId: "a", userId: "u" })).toBe("agent_id=a&run_id=&user_id=u");
    const cleaned = stripIdentityKeys({ user_id: "spoof", color: "green" });
    expect(cleaned).toEqual({ color: "green" });
  });
});
