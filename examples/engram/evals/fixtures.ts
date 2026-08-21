import type { EvalFixture } from "../src/evals/harness";

/**
 * Prompt-eval fixtures. Each is a thread shape the agent could plausibly find
 * itself in, plus the intent a competent model should choose from it.
 *
 * Keep these behavioral, not cosmetic: an eval that pins wording will fail on
 * every prompt edit and teach the next maintainer to ignore the suite.
 */
export const FIXTURES: EvalFixture[] = [
  {
    name: "durable-fact-is-remembered",
    agent: "engram",
    events: [{ type: "user_input", data: "I'm Hunter, and my dog Poppy walks with me every morning." }],
    expect: {
      intent: "archival_insert",
      promptContains: ["Poppy"],
      stepContains: ["Poppy"],
    },
  },
  {
    name: "question-about-the-past-searches-first",
    agent: "engram",
    memories: ["User's dog is named Poppy and their morning walks together are the highlight of the day."],
    events: [{ type: "user_input", data: "What did I tell you about my dog named Poppy?" }],
    expect: {
      // Prefetch already injected the memory, so the model should ANSWER rather
      // than spend a turn re-fetching what it can already see (appendix 13).
      intent: "done_for_now",
      promptContains: ["archival_recall", "Poppy"],
    },
  },
  {
    name: "forget-request-is-gated",
    agent: "engram",
    events: [
      { type: "user_input", data: "Forget what I told you about my old address." },
      {
        type: "tool_call",
        data: { intent: "archival_search", query: "old address" },
      },
      {
        type: "tool_response",
        data: {
          intent: "archival_search",
          ok: true,
          results: [
            { ref: 1, id: "01a0-eval-0001", memory: "User's previous address was 14 Elm Row.", type: "fact", created_at: "2026-01-04", score: 0.82 },
          ],
        },
      },
    ],
    expect: {
      intent: "memory_delete",
      promptContains: ['"ref":1'],
      // Refs, never raw ids (constitution IV).
      stepContains: ['"ref":1'],
    },
  },
  {
    name: "scope-changing-ambiguity-asks",
    agent: "engram",
    events: [
      { type: "user_input", data: "Clean up my memories." },
    ],
    expect: { intent: "needs_clarification" },
  },
  {
    name: "multi-step-work-plans-first",
    agent: "engram",
    events: [
      {
        type: "user_input",
        data:
          "Go through everything you know about my travel history, merge the duplicates, " +
          "delete anything older than two years, and write me a summary.",
      },
    ],
    expect: {
      intent: "propose_plan",
      // The gate vocabulary must be in the prompt or the model cannot name a
      // real principle in gate_results.
      promptContains: ["The LLM proposes, code disposes"],
      stepContains: ["gate_results"],
    },
  },
  {
    name: "curator-cannot-spawn",
    agent: "curator",
    memories: ["User's favorite colour is teal.", "The user likes the colour teal."],
    events: [{ type: "user_input", data: "Review my memories for duplicates and consolidate them." }],
    expect: {
      // The curator's intent subset has no spawn_subagent, so the union itself
      // makes that unchoosable — this fixture fails loudly if the subset drifts.
      intent: "archival_search",
      promptContains: ["archival_search"],
    },
  },
];
