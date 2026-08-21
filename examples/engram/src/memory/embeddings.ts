/**
 * Embedding provider contract (mem0's capability-detection pattern).
 *
 * Anthropic ships no embeddings API, so the vector leg of archival search is
 * optional: configure an OpenAI-compatible endpoint via ENGRAM_EMBEDDINGS_URL,
 * or run degraded (FTS5 + entity boost only). Degradation is detected once at
 * startup and warned about once (constitution principle VII).
 */
export interface EmbeddingProvider {
  readonly dims: number;
  embed(text: string): Promise<Float32Array>;
  embedBatch(texts: string[]): Promise<Array<Float32Array | null>>;
}

/** Float32Array <-> BLOB codecs for bun:sqlite. */
export function vecToBlob(vec: Float32Array): Uint8Array {
  return new Uint8Array(vec.buffer.slice(vec.byteOffset, vec.byteOffset + vec.byteLength));
}

export function blobToVec(blob: Uint8Array): Float32Array {
  const buf = blob.buffer.slice(blob.byteOffset, blob.byteOffset + blob.byteLength);
  return new Float32Array(buf);
}

/** OpenAI-compatible /embeddings client with per-item fallback on batch failure. */
export class HttpEmbeddingProvider implements EmbeddingProvider {
  constructor(
    private readonly baseUrl: string,
    private readonly model: string,
    readonly dims: number,
    private readonly apiKey: string = process.env.ENGRAM_EMBEDDINGS_API_KEY ?? "",
  ) {}

  async embed(text: string): Promise<Float32Array> {
    const [vec] = await this.request([text]);
    if (!vec) throw new Error("embedding endpoint returned no vector");
    return vec;
  }

  /** Batch embed; individual failures degrade to null rather than failing the batch (mem0 phase-3 pattern). */
  async embedBatch(texts: string[]): Promise<Array<Float32Array | null>> {
    try {
      const vecs = await this.request(texts);
      return texts.map((_, i) => vecs[i] ?? null);
    } catch {
      const out: Array<Float32Array | null> = [];
      for (const text of texts) {
        try {
          out.push(await this.embed(text));
        } catch (err) {
          console.warn(`[engram] embedding failed for one text: ${(err as Error).message}`);
          out.push(null);
        }
      }
      return out;
    }
  }

  private async request(input: string[]): Promise<Float32Array[]> {
    const res = await fetch(`${this.baseUrl.replace(/\/$/, "")}/embeddings`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
      },
      body: JSON.stringify({ model: this.model, input }),
    });
    if (!res.ok) throw new Error(`embeddings endpoint ${res.status}: ${await res.text()}`);
    const body = (await res.json()) as { data: Array<{ index: number; embedding: number[] }> };
    const out: Float32Array[] = new Array(input.length);
    for (const item of body.data) {
      // Validate dims HERE, at the boundary. A model whose vectors do not match
      // the configured size otherwise stores silently and only surfaces later as
      // cosine 0 against every existing memory — retrieval that looks empty
      // rather than broken (constitution VII: fail loudly, not quietly).
      if (item.embedding.length !== this.dims) {
        throw new Error(
          `embeddings endpoint returned ${item.embedding.length}-dim vectors but ` +
            `ENGRAM_EMBEDDINGS_DIMS is ${this.dims}. Set _DIMS to match the model ` +
            `(${this.model}), or point _MODEL at one that emits ${this.dims} dims. ` +
            `Storing the mismatch would make every later search silently miss.`,
        );
      }
      out[item.index] = Float32Array.from(item.embedding);
    }
    return out;
  }
}

let warnedDegraded = false;

/** Resolve the configured provider, or null (degraded mode) with a one-time warning. */
export function resolveEmbedder(config: {
  embeddingsUrl: string;
  embeddingsModel: string;
  embeddingsDims: number;
}): EmbeddingProvider | null {
  if (config.embeddingsUrl) {
    return new HttpEmbeddingProvider(config.embeddingsUrl, config.embeddingsModel, config.embeddingsDims);
  }
  if (!warnedDegraded) {
    warnedDegraded = true;
    console.warn(
      "[engram] no embeddings endpoint configured (ENGRAM_EMBEDDINGS_URL) — " +
        "archival search runs degraded on FTS5 + entity boost only.",
    );
  }
  return null;
}
