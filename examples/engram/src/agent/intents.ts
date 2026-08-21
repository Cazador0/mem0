import { z } from "zod";
import { GateResultSchema } from "../orchestration/gates";

/**
 * The intent union — 12-factor factor 4: tools are structured outputs. Every
 * loop step the LLM emits exactly one of these; a deterministic switch decides
 * what "executing" means. Human contact, sleep, and terminal states are intents
 * in the same union as real tools (factor 7).
 */

export const CoreBlockName = z.enum(["persona", "human", "project", "scratchpad"]);
export const MemoryType = z.enum(["fact", "decision", "procedural"]);

export const CoreAppend = z.object({
  intent: z.literal("core_append"),
  block: CoreBlockName,
  content: z.string().min(1),
});

export const CoreReplace = z.object({
  intent: z.literal("core_replace"),
  block: CoreBlockName,
  old_text: z.string().min(1),
  new_text: z.string(),
});

export const ArchivalInsert = z.object({
  intent: z.literal("archival_insert"),
  content: z.string().min(1).describe("Self-contained memory, 15-80 words, absolute dates"),
  memory_type: MemoryType.optional(),
  metadata: z.record(z.string(), z.string()).optional(),
});

export const ArchivalSearch = z.object({
  intent: z.literal("archival_search"),
  query: z.string().min(1),
  top_k: z.number().int().min(1).max(25).optional(),
  memory_type: MemoryType.optional(),
  explain: z.boolean().optional(),
});

export const RecallSearch = z.object({
  intent: z.literal("recall_search"),
  query: z.string().min(1),
  after: z.string().optional().describe("ISO date lower bound"),
  before: z.string().optional().describe("ISO date upper bound"),
  limit: z.number().int().min(1).max(50).optional(),
});

export const MemoryUpdate = z.object({
  intent: z.literal("memory_update"),
  ref: z.number().int().min(1).describe("Integer ref from an archival_search result in this thread"),
  new_content: z.string().min(1),
  reason: z.string().min(1),
});

export const MemoryDelete = z.object({
  intent: z.literal("memory_delete"),
  ref: z.number().int().min(1),
  reason: z.string().min(1),
});

export const RequestHumanInput = z.object({
  intent: z.literal("request_human_input"),
  question: z.string().min(1),
  context: z.string().optional(),
  urgency: z.enum(["low", "medium", "high"]).optional(),
});

export const ClarificationMarker = z.object({
  question: z.string().min(1),
  options: z.array(z.string().min(1)).min(2).max(5),
  recommended: z.string().min(1),
  impact: z.enum(["scope", "security", "ux", "technical"]),
});

export const NeedsClarification = z.object({
  intent: z.literal("needs_clarification"),
  markers: z.array(ClarificationMarker).min(1).max(3),
});

export const SleepUntil = z.object({
  intent: z.literal("sleep_until"),
  wake_at: z.string().optional().describe("RFC3339 timestamp"),
  delay_minutes: z.number().int().min(1).optional(),
  reason: z.string().min(1),
});

export const SpawnSubagent = z.object({
  intent: z.literal("spawn_subagent"),
  agent_id: z.string().min(1),
  task: z.string().min(1),
});

export const ProposePlan = z.object({
  intent: z.literal("propose_plan"),
  summary: z.string().min(1),
  steps: z.array(z.string().min(1)).min(1).max(10),
  gate_results: z
    .array(GateResultSchema)
    .min(1)
    .describe("One entry per constitution principle the plan touches; failures need a justification"),
});

export const DoneForNow = z.object({
  intent: z.literal("done_for_now"),
  message: z.string().min(1),
});

export const CompleteTask = z.object({
  intent: z.literal("complete_task"),
  outcome: z.enum(["success", "partial", "blocked"]),
  summary: z.string().min(1),
});

export const INTENT_SCHEMAS = {
  core_append: CoreAppend,
  core_replace: CoreReplace,
  archival_insert: ArchivalInsert,
  archival_search: ArchivalSearch,
  recall_search: RecallSearch,
  memory_update: MemoryUpdate,
  memory_delete: MemoryDelete,
  request_human_input: RequestHumanInput,
  needs_clarification: NeedsClarification,
  propose_plan: ProposePlan,
  sleep_until: SleepUntil,
  spawn_subagent: SpawnSubagent,
  done_for_now: DoneForNow,
  complete_task: CompleteTask,
} as const;

export type IntentName = keyof typeof INTENT_SCHEMAS;
export const ALL_INTENTS = Object.keys(INTENT_SCHEMAS) as IntentName[];

export const NextStepSchema = z.discriminatedUnion("intent", [
  CoreAppend,
  CoreReplace,
  ArchivalInsert,
  ArchivalSearch,
  RecallSearch,
  MemoryUpdate,
  MemoryDelete,
  RequestHumanInput,
  NeedsClarification,
  ProposePlan,
  SleepUntil,
  SpawnSubagent,
  DoneForNow,
  CompleteTask,
]);
export type NextStep = z.infer<typeof NextStepSchema>;

/** The LLM's structured output is always this envelope. */
export const NextStepEnvelope = z.object({ next_step: NextStepSchema });
export type NextStepEnvelopeT = z.infer<typeof NextStepEnvelope>;

/** Per-agent capability = presence in the agent's union subset (12-factor appendix 13). */
export function envelopeForIntents(intents: readonly IntentName[]): z.ZodType<NextStepEnvelopeT> {
  const options = intents.map(name => INTENT_SCHEMAS[name]);
  if (options.length < 2) throw new Error("an agent needs at least two intents");
  const union = z.discriminatedUnion(
    "intent",
    options as unknown as Parameters<typeof z.discriminatedUnion>[1],
  );
  return z.object({ next_step: union }) as unknown as z.ZodType<NextStepEnvelopeT>;
}

/**
 * Control-flow classes (12-factor factor 8, the two-switch split):
 * - sync:     execute, append tool_response, continue the loop (the heartbeat)
 * - gated:    record the tool_call, break for human approval before execution
 * - break:    persist and wait (human input / clarification / sleep / yield)
 * - terminal: task complete
 */
export type Route = "sync" | "gated" | "break" | "terminal";

export function routeIntent(step: NextStep): Route {
  switch (step.intent) {
    case "core_append":
    case "core_replace":
    case "archival_insert":
    case "archival_search":
    case "recall_search":
    case "memory_update":
    case "spawn_subagent":
    case "propose_plan":
      return "sync";
    case "memory_delete":
      return "gated";
    case "request_human_input":
    case "needs_clarification":
    case "sleep_until":
    case "done_for_now":
      return "break";
    case "complete_task":
      return "terminal";
  }
}

/** One-line docs rendered into the system prompt for each available intent. */
export const INTENT_DOCS: Record<IntentName, string> = {
  core_append: "Append text to a core memory block (persona|human|project|scratchpad). Fails readably if the block's character budget would overflow.",
  core_replace: "Replace an exact substring in a core block — use to edit or compress your own context. old_text must match exactly.",
  archival_insert: "Save one self-contained, temporally grounded memory (15-80 words, absolute dates) to long-term archival memory.",
  archival_search: "Hybrid search (vector + keyword + entity) over archival memory. Results carry integer refs usable in memory_update/memory_delete.",
  recall_search: "Keyword search over this conversation's full event history, optionally time-bounded.",
  memory_update: "Rewrite a previously returned archival memory. ref MUST be an integer ref from an archival_search result earlier in this thread.",
  memory_delete: "Delete a previously returned archival memory. Requires human approval before execution; deletion is soft in the audit history.",
  request_human_input: "Ask the human a question and pause until they respond.",
  propose_plan: "Propose a plan BEFORE non-trivial work: summary, up to 10 steps, and one gate_result per constitution principle the plan touches ({principle, pass, justification?}). A failing gate without a justification is rejected and returned to you — adjust the plan, never the principle.",
  needs_clarification: "Raise up to 3 clarification markers (each with 2-5 options and a recommended choice) and pause. Use during planning when a choice materially changes scope, security, or UX.",
  sleep_until: "Pause durably and wake at a time (wake_at RFC3339 or delay_minutes — provide exactly one).",
  spawn_subagent: "Delegate a focused task to a specialist agent on a fresh thread; you receive only its verdict and top findings.",
  done_for_now: "Yield the turn to the human with a status message. The conversation continues when they reply.",
  complete_task: "Terminal: the task is finished. Be honest about the outcome (success|partial|blocked).",
};
