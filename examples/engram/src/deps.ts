import type { Database } from "bun:sqlite";
import type { EngramConfig } from "./config";
import type { RecallStore } from "./memory/recall";
import type { CoreMemory } from "./memory/core";
import type { ArchivalMemory } from "./memory/archival";
import type { AgentRegistry } from "./agents/registry";
import type { LLMClient } from "./agent/llm";
import type { ConstitutionInfo } from "./orchestration/gates";

/** Everything the loop, executor, and pipelines need — one seam for tests. */
export interface EngramDeps {
  db: Database;
  config: EngramConfig;
  store: RecallStore;
  core: CoreMemory;
  archival: ArchivalMemory;
  registry: AgentRegistry;
  llm: LLMClient;
  constitution: ConstitutionInfo;
}
