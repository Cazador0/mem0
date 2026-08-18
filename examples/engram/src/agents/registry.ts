import type { IntentName } from "../agent/intents";
import { ALL_INTENTS } from "../agent/intents";

/**
 * Specialist agents as data (BMAD): persona + a scoped subset of the intent
 * union. Removing an intent from an agent's list removes the capability —
 * capability is presence in the union (12-factor appendix 13).
 */
export interface AgentDefinition {
  id: string;
  persona: string;
  intents: readonly IntentName[];
  maxSteps?: number;
}

export class AgentRegistry {
  private readonly agents = new Map<string, AgentDefinition>();

  register(def: AgentDefinition): void {
    this.agents.set(def.id, def);
  }

  get(id: string): AgentDefinition | undefined {
    return this.agents.get(id);
  }

  list(): AgentDefinition[] {
    return [...this.agents.values()];
  }
}

const CURATOR_INTENTS: readonly IntentName[] = [
  "archival_search",
  "archival_insert",
  "memory_update",
  "memory_delete",
  "recall_search",
  "request_human_input",
  "done_for_now",
  "complete_task",
];

export function defaultRegistry(): AgentRegistry {
  const registry = new AgentRegistry();
  registry.register({
    id: "engram",
    persona:
      "Engram, the primary assistant. Helpful, direct, and honest about uncertainty. " +
      "Maintains its own memory diligently: durable facts about the human go to core and archival memory as they appear.",
    intents: ALL_INTENTS,
  });
  registry.register({
    id: "curator",
    persona:
      "The memory curator. Reviews archival memories for duplicates, contradictions, and staleness; " +
      "proposes consolidations and deletions (deletions always require human approval). Never invents facts.",
    intents: CURATOR_INTENTS,
    maxSteps: 12,
  });
  return registry;
}
