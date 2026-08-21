import type { ReaderRequest, ReaderResponse } from "./reader-protocol";
import type { Scope } from "./recall";
import type { EngramDeps } from "../deps";

/**
 * Main-thread client for the extraction reader Worker (`ENGRAM_EXTRACTION_WORKER=on`).
 *
 * WHY: extraction's Phase 1 scans up to CANDIDATE_LIMIT memories, decodes every
 * stored vector and cosines it against the query. That is the one genuinely
 * CPU-bound stretch in a background extraction, and it runs on the same thread
 * serving HTTP — including any open SSE stream, which visibly stalls while it
 * runs. Moving it to a Worker keeps the event loop responsive.
 *
 * WHY READ-ONLY: writes stay on the main thread, under the existing
 * `extract:<threadId>` lock and the archival facade. A Worker with its own
 * writable connection would be a second writer that the in-process lock cannot
 * see — the invariant this app is built on.
 *
 * The Worker is spawned lazily, reused across extractions, and `unref`'d so it
 * never holds the process open.
 */

let worker: Worker | null = null;
let nextId = 1;
const pending = new Map<number, { resolve: (r: ReaderResponse) => void; reject: (e: Error) => void }>();

function ensureWorker(): Worker {
  if (worker) return worker;
  const spawned = new Worker(new URL("./reader-worker.ts", import.meta.url).href);
  spawned.onmessage = (event: MessageEvent<ReaderResponse>) => {
    const waiter = pending.get(event.data.id);
    if (!waiter) return; // a response to a request that already timed out or failed
    pending.delete(event.data.id);
    waiter.resolve(event.data);
  };
  spawned.onerror = event => {
    // A worker-level failure kills every in-flight request; callers fall back.
    const error = new Error(`extraction reader worker failed: ${event.message ?? "unknown error"}`);
    for (const [, waiter] of pending) waiter.reject(error);
    pending.clear();
    worker = null;
    spawned.terminate();
  };
  spawned.unref();
  worker = spawned;
  return spawned;
}

export interface ReaderQuery {
  query: string;
  queryVector: Float32Array | null;
  scope: Scope;
  topK: number;
}

/**
 * Run one candidate scan in the Worker. Rejects on worker failure — callers are
 * expected to fall back to the in-thread read rather than fail the extraction.
 */
export async function readCandidates(
  deps: EngramDeps,
  args: ReaderQuery,
): Promise<Array<{ id: string; content: string }>> {
  const id = nextId++;
  const request: ReaderRequest = {
    id,
    dbPath: deps.config.dbPath,
    query: args.query,
    queryVector: args.queryVector,
    scope: args.scope,
    topK: args.topK,
    // An in-memory database is unreachable from a second connection, so it
    // travels as a whole-database copy. That copy is O(database size) per call:
    // the Worker path is a win for file-backed stores and a tax for :memory:.
    ...(deps.config.dbPath === ":memory:" ? { snapshot: deps.db.serialize() } : {}),
  };
  const response = await new Promise<ReaderResponse>((resolve, reject) => {
    pending.set(id, { resolve, reject });
    try {
      ensureWorker().postMessage(request);
    } catch (err) {
      pending.delete(id);
      reject(err as Error);
    }
  });
  if (!response.ok) throw new Error(response.error);
  return response.memories;
}

/** Shut the Worker down (process exit, tests). Safe to call when none exists. */
export function closeReaderWorker(): void {
  worker?.terminate();
  worker = null;
  for (const [, waiter] of pending) waiter.reject(new Error("extraction reader worker closed"));
  pending.clear();
}
