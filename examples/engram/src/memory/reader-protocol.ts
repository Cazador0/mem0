import type { Scope } from "./recall";

/**
 * Wire types between the main thread and the extraction reader Worker.
 * Separate from both sides so the Worker module — which touches `self` and is
 * only loadable inside a Worker — never has to be imported by the client.
 */

export interface ReaderRequest {
  id: number;
  /** Path for a file-backed database; ignored when a snapshot is supplied. */
  dbPath: string;
  /** Whole-database copy, required when the main thread's DB is `:memory:`. */
  snapshot?: Uint8Array;
  query: string;
  /** Pre-computed by the main thread; null runs the degraded keyword path. */
  queryVector: Float32Array | null;
  scope: Scope;
  topK: number;
}

export type ReaderResponse =
  | { id: number; ok: true; memories: Array<{ id: string; content: string }> }
  | { id: number; ok: false; error: string };
