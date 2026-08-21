import { loadConfig, type EngramConfig } from "./config";
import { openDb } from "./db/database";
import { prewarmStatementCache } from "./db/statements";
import { RecallStore } from "./memory/recall";
import { CoreMemory } from "./memory/core";
import { ArchivalMemory } from "./memory/archival";
import { resolveEmbedder } from "./memory/embeddings";
import { defaultRegistry } from "./agents/registry";
import { AnthropicLLM } from "./agent/llm";
import { loadConstitution, type ConstitutionInfo } from "./orchestration/gates";
import type { EngramDeps } from "./deps";

/** Wire the production dependency graph. Tests build their own with a ScriptedLLM. */
export function bootstrap(config: EngramConfig = loadConfig()): EngramDeps {
  const db = openDb(config.dbPath);
  prewarmStatementCache(db); // claim the query cache before anything else runs
  const store = new RecallStore(db);
  const core = new CoreMemory(db);
  const archival = new ArchivalMemory(db, resolveEmbedder(config));
  const registry = defaultRegistry();
  const constitution = loadConstitution(new URL("../constitution.md", import.meta.url).pathname);
  for (const agent of registry.list()) {
    core.seed(agent.id, agent.persona, constitutionPointer(constitution));
  }
  const llm = new AnthropicLLM(config.model, config.fallbacks);
  return { db, config, store, core, archival, registry, llm, constitution };
}

export function constitutionPointer(constitution: ConstitutionInfo): string {
  return (
    `Constitution v${constitution.version} (digest ${constitution.digest}). ` +
    `Read constitution.md — non-negotiable: conflicts require adjusting the work, never diluting the principle.`
  );
}
