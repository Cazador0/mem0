import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testWorld } from "./harness";
import { closeDb } from "../src/db/database";
import { closeReaderWorker, readCandidates } from "../src/memory/reader-client";
import { extractFromThread } from "../src/memory/extraction";
import type { EngramDeps } from "../src/deps";

/**
 * Worker-isolated extraction reads (ENGRAM_EXTRACTION_WORKER=on).
 *
 * The claim under test is narrow and worth stating: the Worker returns exactly
 * what the in-thread scan returns, it never writes, and when it cannot run the
 * extraction proceeds anyway. It is an optimization, not a dependency.
 */

const SCOPE = { userId: "u1", agentId: "engram", runId: "" };
const CORPUS = [
  "User has a dog named Poppy and their morning walks together are the highlight of the day.",
  "User works as a platform engineer at Northwind Logistics on the billing service.",
  "User's partner Mei is finishing a PhD in marine biology at Kyoto University.",
  "User is training for the Boston Marathon in April 2027 with a 3:30 goal.",
  "User keeps their notes in a repository called field-notes and syncs it nightly.",
];
const QUERY = "Tell me about the dog and the morning walks";

async function seed(deps: EngramDeps): Promise<void> {
  for (const content of CORPUS) await deps.archival.insert({ content, scope: SCOPE });
}

function memoryCount(deps: EngramDeps): number {
  return (deps.db.query("SELECT COUNT(*) AS n FROM memories").get() as { n: number }).n;
}

afterAll(() => closeReaderWorker());

describe("extraction reader worker", () => {
  test("returns exactly what the in-thread scan returns, from an in-memory snapshot", async () => {
    const { deps } = testWorld();
    await seed(deps);

    const queryVector = await deps.archival.embedQuery(QUERY);
    const inThread = await deps.archival.search({ query: QUERY, scope: { userId: "u1" }, topK: 10 });
    const viaWorker = await readCandidates(deps, { query: QUERY, queryVector, scope: { userId: "u1" }, topK: 10 });

    expect(viaWorker.map(m => m.content)).toEqual(inThread.map(h => h.payload.content));
    expect(viaWorker.map(m => m.id)).toEqual(inThread.map(h => h.id));
    expect(viaWorker.length).toBeGreaterThan(0); // a parity test over two empty lists proves nothing
  });

  test("reads a file-backed database over a read-only connection, and writes nothing", async () => {
    // A real file, because the read-only-connection branch cannot exist in
    // :memory: — a second connection can never reach an in-memory database.
    const dir = mkdtempSync(join(tmpdir(), "engram-worker-"));
    const path = join(dir, "engram.sqlite");
    const { deps } = testWorld({ dbPath: path });
    try {
      await seed(deps);
      const before = memoryCount(deps);

      const queryVector = await deps.archival.embedQuery(QUERY);
      const inThread = await deps.archival.search({ query: QUERY, scope: { userId: "u1" }, topK: 10 });
      const viaWorker = await readCandidates(deps, { query: QUERY, queryVector, scope: { userId: "u1" }, topK: 10 });

      expect(viaWorker.map(m => m.content)).toEqual(inThread.map(h => h.payload.content));
      expect(viaWorker.length).toBeGreaterThan(0);
      expect(memoryCount(deps)).toBe(before); // the scan is a read, and stays one
    } finally {
      closeReaderWorker(); // release the worker's connection before the file goes
      closeDb(deps.db);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("degraded mode travels too: no query vector, same keyword results", async () => {
    const { deps } = testWorld({ embedder: false });
    await seed(deps);

    const inThread = await deps.archival.search({ query: QUERY, scope: { userId: "u1" }, topK: 10 });
    const viaWorker = await readCandidates(deps, {
      query: QUERY,
      queryVector: null,
      scope: { userId: "u1" },
      topK: 10,
    });

    expect(viaWorker.map(m => m.content)).toEqual(inThread.map(h => h.payload.content));
  });

  test("an extraction whose worker cannot open the database still stores its memories", async () => {
    const { deps } = testWorld({
      script: [{ memories: [{ text: "User has a dog named Poppy.", linked_refs: [] }] }],
    });
    deps.config.extractionWorker = true;
    // Not :memory:, so the client skips the snapshot and hands the Worker a
    // path it cannot open — the failure the fallback exists for.
    const dir = mkdtempSync(join(tmpdir(), "engram-missing-"));
    const missing = join(dir, "engram.sqlite");
    deps.config.dbPath = missing;
    const thread = deps.store.createThread("engram", SCOPE);
    deps.store.appendEvent(thread.id, "user_input", "My dog is named Poppy");
    try {
      const outcome = await extractFromThread(deps, thread.id);

      expect(outcome.added.map(a => a.memory)).toEqual(["User has a dog named Poppy."]);
      expect(outcome.failures).toBe(0);
      // Also pins the connection being read-only: a read-write connection
      // would have happily CREATED this file instead of failing to open it.
      expect(existsSync(missing)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("worker-backed extraction stores what the in-thread one does", async () => {
    const script = () => [{ memories: [{ text: "User has a dog named Poppy.", linked_refs: [1] }] }];
    const run = async (worker: boolean) => {
      const { deps } = testWorld({ script: script() });
      deps.config.extractionWorker = worker;
      await seed(deps);
      const thread = deps.store.createThread("engram", SCOPE);
      deps.store.appendEvent(thread.id, "user_input", "Reminder: the dog is Poppy and we walk each morning");
      const outcome = await extractFromThread(deps, thread.id);
      const stored = deps.archival.getById(outcome.added[0]!.id)!;
      return { texts: outcome.added.map(a => a.memory), links: stored.metadata.links };
    };

    const [inThread, viaWorker] = [await run(false), await run(true)];

    expect(viaWorker.texts).toEqual(inThread.texts);
    // ref 1 resolved to a real memory id on both paths — the refs the Worker
    // returns must map the same way, or linking would silently break.
    expect(Boolean(viaWorker.links)).toBe(true);
    expect(Boolean(inThread.links)).toBe(true);
  });

  test("closing the worker is safe when there is none", () => {
    closeReaderWorker();
    expect(() => closeReaderWorker()).not.toThrow();
  });
});
