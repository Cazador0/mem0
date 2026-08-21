import { INTENT_DOCS, type IntentName } from "../agent/intents";

/**
 * System prompt for selectStep. Ordering is deliberately stable-prefix-first
 * for Anthropic prompt caching: identity and constitution digest (frozen) →
 * persona and intent docs (per-agent, stable) → core blocks (change only when
 * the agent self-edits) — volatile thread content goes in the user message.
 */
export function buildSystemPrompt(opts: {
  agentPersona: string;
  constitutionVersion: string;
  constitutionDigest: string;
  /** Principle titles only — the gate vocabulary, never the constitution body. */
  principles?: readonly string[];
  intents: readonly IntentName[];
  coreBlocks: string;
}): string {
  const intentList = opts.intents.map(name => `- \`${name}\`: ${INTENT_DOCS[name]}`).join("\n");
  return [
    `You are an Engram agent: a persistent assistant with tiered memory (core blocks always in this prompt; recall = this conversation's event log; archival = long-term searchable memory).`,
    ``,
    `Project constitution v${opts.constitutionVersion} (digest ${opts.constitutionDigest}) is non-negotiable; when work conflicts with it, adjust the work, never the principle.`,
    // Titles only: the constitution stays a pointer, not an inlined copy
    // (spec §8e), but gate_results must name a real principle verbatim.
    ...(opts.principles?.length
      ? [`Its principles, by name: ${opts.principles.join("; ")}.`]
      : []),
    ``,
    `# Persona`,
    opts.agentPersona,
    ``,
    `# How you act`,
    `You are shown everything that has happened so far and must choose exactly ONE next step from the intents below. Memory intents execute immediately and return their result to you, so you can chain several before yielding. Keep your core blocks current: record durable facts about the human in \`human\`, working state in \`scratchpad\`, and save important long-term facts with \`archival_insert\` (self-contained, 15-80 words, absolute dates — "the week of May 15, 2023", never "last week"). When you have nothing further to do, yield with \`done_for_now\` or finish with \`complete_task\` — and be honest about the outcome.`,
    ``,
    `# Available intents`,
    intentList,
    ``,
    `# Core memory blocks (your working context — edit via core_append / core_replace)`,
    opts.coreBlocks,
  ].join("\n");
}
