import { z } from "zod";
import { loadConfig } from "../src/config";
import { openDb } from "../src/db/database";
import { prewarmStatementCache } from "../src/db/statements";
import { RecallStore } from "../src/memory/recall";
import { CoreMemory } from "../src/memory/core";
import { ArchivalMemory } from "../src/memory/archival";
import { defaultRegistry } from "../src/agents/registry";
import { loadConstitution } from "../src/orchestration/gates";
import { constitutionPointer } from "../src/bootstrap";
import { LLMError, type LLMClient, type StructuredRequest } from "../src/agent/llm";
import type { EmbeddingProvider } from "../src/memory/embeddings";
import type { EngramDeps } from "../src/deps";

/** A scripted response, or a marker that makes the ScriptedLLM throw once. */
export type ScriptItem = unknown | { __throw: string };

/**
 * Deterministic LLM stand-in: each structured() call consumes the next script
 * item and validates it against the requested schema, so fixture drift fails
 * loudly. No network in tests — ever.
 */
export class ScriptedLLM implements LLMClient {
  readonly calls: string[] = [];
  constructor(private readonly script: ScriptItem[] = []) {}

  push(...items: ScriptItem[]): void {
    this.script.push(...items);
  }

  async structured<T>(req: StructuredRequest<T>): Promise<T> {
    this.calls.push(req.schemaName);
    const next = this.script.shift();
    if (next === undefined) {
      throw new LLMError(`ScriptedLLM: no scripted response left for "${req.schemaName}"`);
    }
    if (typeof next === "object" && next !== null && "__throw" in next) {
      throw new LLMError(String((next as { __throw: string }).__throw));
    }
    return req.schema.parse(next);
  }
}

/** Deterministic bag-of-words embedder: shared tokens => cosine similarity. */
export class FakeEmbedder implements EmbeddingProvider {
  readonly dims = 64;

  async embed(text: string): Promise<Float32Array> {
    const vec = new Float32Array(this.dims);
    for (const token of text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean)) {
      vec[Number(Bun.hash.xxHash64(token) % BigInt(this.dims))] += 1;
    }
    let norm = 0;
    for (const x of vec) norm += x * x;
    norm = Math.sqrt(norm) || 1;
    for (let i = 0; i < vec.length; i++) vec[i]! /= norm;
    return vec;
  }

  async embedBatch(texts: string[]): Promise<Array<Float32Array | null>> {
    return Promise.all(texts.map(t => this.embed(t)));
  }
}

export interface TestWorld {
  deps: EngramDeps;
  llm: ScriptedLLM;
}

export function testWorld(opts: { script?: ScriptItem[]; embedder?: boolean; maxSteps?: number } = {}): TestWorld {
  const config = loadConfig();
  if (opts.maxSteps !== undefined) config.maxSteps = opts.maxSteps;
  const db = openDb(":memory:");
  prewarmStatementCache(db);
  const store = new RecallStore(db);
  const core = new CoreMemory(db);
  const archival = new ArchivalMemory(db, opts.embedder === false ? null : new FakeEmbedder());
  const registry = defaultRegistry();
  const constitution = loadConstitution(new URL("../constitution.md", import.meta.url).pathname);
  for (const agent of registry.list()) {
    core.seed(agent.id, agent.persona, constitutionPointer(constitution));
  }
  const llm = new ScriptedLLM(opts.script ?? []);
  return { deps: { db, config, store, core, archival, registry, llm, constitution }, llm };
}

/** Convenience: wrap an intent as the envelope the loop's schema expects. */
export function step(next_step: Record<string, unknown>): { next_step: Record<string, unknown> } {
  return { next_step };
}

export const AnySchema = z.unknown();
