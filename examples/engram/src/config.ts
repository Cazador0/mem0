export interface EngramConfig {
  /** Path to the SQLite file, or ":memory:". */
  dbPath: string;
  /** Claude model id used for every LLM call. */
  model: string;
  /** Server-side refusal fallbacks (beta). On by default for Opus-tier models. */
  fallbacks: boolean;
  /** OpenAI-compatible embeddings endpoint (POST {base}/embeddings). Empty = degraded FTS-only archival search. */
  embeddingsUrl: string;
  embeddingsModel: string;
  embeddingsDims: number;
  /** Hard bound on LLM steps per loop entry (12-factor: small, focused agents). */
  maxSteps: number;
  port: number;
  /**
   * Bearer token required by the HTTP API. Empty = open (the local-first
   * default); set ENGRAM_API_TOKEN to require `Authorization: Bearer <token>`
   * on every route except /health.
   */
  apiToken: string;
  /**
   * Run extraction's candidate scan in a read-only Worker instead of on the
   * main thread. Off by default — see docs/RETRIEVAL-NOTES.md for what it buys
   * and what it costs.
   */
  extractionWorker: boolean;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): EngramConfig {
  return {
    dbPath: env.ENGRAM_DB ?? "engram.sqlite",
    model: env.ENGRAM_MODEL ?? "claude-opus-5",
    fallbacks: (env.ENGRAM_FALLBACKS ?? "on") !== "off",
    embeddingsUrl: env.ENGRAM_EMBEDDINGS_URL ?? "",
    embeddingsModel: env.ENGRAM_EMBEDDINGS_MODEL ?? "text-embedding-3-small",
    embeddingsDims: Number(env.ENGRAM_EMBEDDINGS_DIMS ?? 1536),
    maxSteps: Number(env.ENGRAM_MAX_STEPS ?? 20),
    port: Number(env.PORT ?? 7749),
    apiToken: env.ENGRAM_API_TOKEN ?? "",
    extractionWorker: (env.ENGRAM_EXTRACTION_WORKER ?? "off") === "on",
  };
}
