import { Database } from "bun:sqlite";
import { ArchivalMemory } from "./archival";
import type { EmbeddingProvider } from "./embeddings";
import type { ReaderRequest, ReaderResponse } from "./reader-protocol";

/**
 * Worker side of the extraction candidate scan.
 *
 * This Worker NEVER writes. It opens the database read-only (or deserializes a
 * snapshot when the main thread's database is `:memory:`, which no second
 * connection can reach) and runs the same `ArchivalMemory.search` the main
 * thread would have run. Every write in Engram stays on the main thread under
 * the `extract:<threadId>` lock, so the single-writer invariant is preserved by
 * construction rather than by a queue.
 *
 * Embeddings are NOT computed here: the main thread passes the query vector it
 * already had to embed anyway, so no API key, no network and no secret ever
 * crosses into the Worker.
 */

/**
 * `lib` is ESNext-only (no DOM, no webworker) so the worker globals are not in
 * scope; declaring exactly the two used here keeps the tsconfig narrow and the
 * message contract explicit.
 */
declare const self: {
  onmessage: ((event: MessageEvent<ReaderRequest>) => void) | null;
  postMessage(message: ReaderResponse): void;
};

/** Returns the vector the main thread already computed, whatever it is asked. */
class FixedVectorEmbedder implements EmbeddingProvider {
  readonly dims: number;
  constructor(private readonly vector: Float32Array) {
    this.dims = vector.length;
  }
  async embed(): Promise<Float32Array> {
    return this.vector;
  }
  async embedBatch(texts: string[]): Promise<Array<Float32Array | null>> {
    return texts.map(() => this.vector);
  }
}

/** File-backed databases are reopened once; a snapshot is per-request data. */
let cached: { path: string; db: Database } | null = null;

function openForRead(req: ReaderRequest): Database {
  if (req.snapshot) return Database.deserialize(req.snapshot);
  if (cached?.path === req.dbPath) return cached.db;
  cached?.db.close();
  // readonly, so WAL readers coexist with the main thread's single writer.
  const db = new Database(req.dbPath, { readonly: true, strict: true });
  cached = { path: req.dbPath, db };
  return db;
}

self.onmessage = (event: MessageEvent<ReaderRequest>) => {
  const req = event.data;
  void (async () => {
    let snapshotDb: Database | null = null;
    try {
      const db = openForRead(req);
      if (req.snapshot) snapshotDb = db;
      const archival = new ArchivalMemory(db, req.queryVector ? new FixedVectorEmbedder(req.queryVector) : null);
      const hits = await archival.search({ query: req.query, scope: req.scope, topK: req.topK });
      const response: ReaderResponse = {
        id: req.id,
        ok: true,
        memories: hits.map(hit => ({ id: hit.id, content: hit.payload.content })),
      };
      self.postMessage(response);
    } catch (err) {
      const response: ReaderResponse = { id: req.id, ok: false, error: (err as Error).message };
      self.postMessage(response);
    } finally {
      // A snapshot database is a private copy — never leave one behind.
      snapshotDb?.close();
    }
  })();
};
