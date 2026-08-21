/**
 * What does ENGRAM_EXTRACTION_WORKER=on actually buy?
 *
 * Run: bun scripts/bench-extraction-worker.ts
 *
 * HONEST SCOPE — read before quoting any number from this:
 * - It measures ONE thing: extraction's Phase-1 candidate scan, in-thread vs in
 *   the read-only Worker. It says nothing about the LLM call (network-bound and
 *   identical on both paths) or about the writes (main thread on both).
 * - Vectors are random 1536-dim unit vectors, matching the default embedding
 *   dims. Cosine cost depends on dims and candidate count, not on what a real
 *   model would return, so this part is representative.
 * - "main-thread lag" is the metric that matters: the longest gap observed by a
 *   1ms interval timer while the scan runs. That is what an open SSE stream or
 *   an in-flight HTTP request feels.
 * - Single machine, single run each, no warmup discipline beyond one throwaway
 *   pass. Treat the ratio as indicative, not as a benchmark result.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDb, openDb } from "../src/db/database";
import { ArchivalMemory } from "../src/memory/archival";
import { closeReaderWorker, readCandidates } from "../src/memory/reader-client";
import type { EmbeddingProvider } from "../src/memory/embeddings";
import type { EngramConfig } from "../src/config";
import type { EngramDeps } from "../src/deps";

const MEMORIES = Number(process.env.BENCH_MEMORIES ?? 1000);
const DIMS = 1536;
const SCOPE = { userId: "bench", agentId: "engram", runId: "" };
const QUERY = "what has the user said about their work, their training, and their notes";

/** Random unit vectors at production dims: the cosine cost is what we measure. */
class RandomEmbedder implements EmbeddingProvider {
  readonly dims = DIMS;
  async embed(): Promise<Float32Array> {
    const vec = new Float32Array(DIMS);
    let norm = 0;
    for (let i = 0; i < DIMS; i++) {
      vec[i] = Math.random() - 0.5;
      norm += vec[i]! * vec[i]!;
    }
    norm = Math.sqrt(norm) || 1;
    for (let i = 0; i < DIMS; i++) vec[i]! /= norm;
    return vec;
  }
  async embedBatch(texts: string[]): Promise<Array<Float32Array | null>> {
    return Promise.all(texts.map(() => this.embed()));
  }
}

/**
 * Longest gap a 1ms timer observes while `run` is in flight.
 *
 * The `setTimeout` after `run()` is load-bearing, not padding: a synchronous
 * stretch is one macrotask, so the interval cannot fire during it, and awaiting
 * the result resumes on the microtask queue — clearing the timer there would
 * report zero ticks and a lag of 0 for a scan that blocked for 30ms. Yielding
 * once lets the timer observe the gap it just sat through. `ticks` is reported
 * so a probe that never fired is visible rather than published as "no lag".
 */
async function withLagProbe<T>(run: () => Promise<T>): Promise<{ result: T; ms: number; lagMs: number; ticks: number }> {
  let last = performance.now();
  let lag = 0;
  let ticks = 0;
  const timer = setInterval(() => {
    const now = performance.now();
    ticks++;
    lag = Math.max(lag, now - last - 1);
    last = now;
  }, 1);
  const started = performance.now();
  const result = await run();
  const ms = performance.now() - started;
  await new Promise(resolve => setTimeout(resolve, 5));
  clearInterval(timer);
  return { result, ms, lagMs: lag, ticks };
}

const dir = mkdtempSync(join(tmpdir(), "engram-bench-worker-"));
const path = join(dir, "engram.sqlite");
const db = openDb(path);
const embedder = new RandomEmbedder();
const archival = new ArchivalMemory(db, embedder);

console.log(`seeding ${MEMORIES} memories at ${DIMS} dims…`);
for (let i = 0; i < MEMORIES; i++) {
  await archival.insert({
    content: `Memory ${i}: the user mentioned project ${i % 37}, a deadline in week ${i % 52}, and a note about topic ${i % 11}.`,
    scope: SCOPE,
  });
}

const config = { dbPath: path } as EngramConfig;
const deps = { db, config, archival } as unknown as EngramDeps;
const queryVector = await embedder.embed();
const read = { query: QUERY, queryVector, scope: { userId: SCOPE.userId }, topK: 10 };

// One throwaway pass each: first-call costs (worker spawn, page cache, JIT)
// would otherwise be reported as the steady-state number.
await archival.search({ query: QUERY, scope: { userId: SCOPE.userId }, topK: 10 });
await readCandidates(deps, read);

const inThread = await withLagProbe(() => archival.search({ query: QUERY, scope: { userId: SCOPE.userId }, topK: 10 }));
const viaWorker = await withLagProbe(() => readCandidates(deps, read));

const sameResults =
  JSON.stringify(inThread.result.map(h => h.id)) === JSON.stringify(viaWorker.result.map(m => m.id));

console.log(`\nmemories: ${MEMORIES}  (candidate ceiling ${500})`);
console.log(`identical results: ${sameResults}`);
console.log(`\n                 wall ms   main-thread lag ms   probe ticks`);
console.log(
  `in-thread        ${inThread.ms.toFixed(1).padStart(7)}   ${inThread.lagMs.toFixed(1).padStart(6)}` +
    `               ${String(inThread.ticks).padStart(3)}`,
);
console.log(
  `worker           ${viaWorker.ms.toFixed(1).padStart(7)}   ${viaWorker.lagMs.toFixed(1).padStart(6)}` +
    `               ${String(viaWorker.ticks).padStart(3)}`,
);
console.log(
  `\nThe worker trades wall-clock (message passing + a second connection) for a ` +
    `main thread that stays free. Read the lag column, not the wall column.`,
);

closeReaderWorker();
closeDb(db);
rmSync(dir, { recursive: true, force: true });
