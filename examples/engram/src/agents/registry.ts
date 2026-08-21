import type { IntentName } from "../agent/intents";
import { ALL_INTENTS } from "../agent/intents";
import type { CapsulePart } from "../orchestration/capsule";

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
  /**
   * Marks an agent as a capsule reviewer, and declares the ASYMMETRY: `parts`
   * is the set of capsule sections this reviewer is handed. Reviewers with
   * different parts cannot anchor on the same context, which is the point —
   * three agents reading one identical envelope produce one opinion three
   * times. `lens` is the single question this reviewer answers.
   */
  review?: {
    lens: string;
    parts: readonly CapsulePart[];
  };
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
  // Reviewers: narrow by construction. Their only moves are to return a verdict
  // or to say the envelope was not enough — a reviewer that could search would
  // pull in the context its envelope deliberately withheld.
  const REVIEWER_INTENTS: readonly IntentName[] = ["complete_task", "needs_clarification"];
  registry.register({
    id: "reviewer-evidence",
    persona:
      "An evidence reviewer. Checks that every claim in a proposal traces to something in the material provided, " +
      "and names anything asserted without support. Never supplies missing evidence from its own knowledge.",
    intents: REVIEWER_INTENTS,
    maxSteps: 3,
    review: {
      lens: "Does every claim trace to the material you were given? Name anything asserted without support.",
      parts: ["task", "memories"],
    },
  });
  registry.register({
    id: "reviewer-risk",
    persona:
      "A risk reviewer. Names the most damaging plausible failure of a proposal and whether it is reversible. " +
      "Concrete failure modes only — no generic cautions.",
    intents: REVIEWER_INTENTS,
    maxSteps: 3,
    review: {
      lens: "What breaks if this is wrong? Name the most damaging plausible failure and whether it is reversible.",
      parts: ["task", "history"],
    },
  });
  registry.register({
    id: "reviewer-scope",
    persona:
      "A scope reviewer. Checks a proposal against what was actually asked and against the constitution: " +
      "no more, no less, nothing that dilutes a principle.",
    intents: REVIEWER_INTENTS,
    maxSteps: 3,
    review: {
      lens: "Is this doing what was asked — no more, no less — and does anything conflict with the constitution?",
      parts: ["task", "constitution"],
    },
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
