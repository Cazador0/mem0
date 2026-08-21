import type { NextStep } from "./intents";
import {
  buildRefMap,
  deriveStatus,
  effectiveTail,
  eventAsStep,
  type Thread,
} from "./thread";
import { evaluateGateResults } from "../orchestration/gates";
import type { EngramDeps } from "../deps";

/**
 * executeStep — the second switch of the two-switch split (12-factor factor 8):
 * pure execution of an already-chosen, already-recorded intent. Returns the
 * tool_response payload; the caller appends it as an event. Because the chosen
 * tool_call is persisted before execution, approval replays the recorded step
 * verbatim (server resume calls this directly with the effective tail's data).
 */
export interface ExecuteExtras {
  /** Injected by the loop so subagents can run without a circular import. */
  runLoop?: (threadId: string) => Promise<Thread>;
}

export async function executeStep(
  step: NextStep,
  thread: Thread,
  deps: EngramDeps,
  extras: ExecuteExtras = {},
): Promise<Record<string, unknown>> {
  const scope = { userId: thread.userId, agentId: thread.agentId, runId: thread.runId };
  const callSeq = effectiveTail(thread)?.seq ?? 0;

  switch (step.intent) {
    case "core_append": {
      const result = deps.core.append(thread.agentId, step.block, step.content);
      return { intent: step.intent, ok: result.ok, result: result.message };
    }

    case "core_replace": {
      const result = deps.core.replace(thread.agentId, step.block, step.old_text, step.new_text);
      return { intent: step.intent, ok: result.ok, result: result.message };
    }

    case "archival_insert": {
      const result = await deps.archival.insert({
        content: step.content,
        scope,
        memoryType: step.memory_type,
        metadata: step.metadata,
        sourceThreadId: thread.id,
        sourceEventSeqs: [callSeq],
      });
      // Result strings never carry raw memory UUIDs (constitution IV) — the
      // model addresses memories through search refs only.
      return {
        intent: step.intent,
        ok: true,
        result: result.created ? "memory saved" : "duplicate — this was already saved",
      };
    }

    case "archival_search": {
      // Reads are user-scoped (mem0's sharing model): memories belong to the
      // user, so a curator thread — whose own identity is agent_id "curator" —
      // sees what engram threads wrote. Writes keep the full thread identity.
      const hits = await deps.archival.search({
        query: step.query,
        scope: { userId: thread.userId },
        topK: step.top_k ?? 5,
        memoryType: step.memory_type,
        explain: step.explain,
      });
      let ref = nextRefFrom(thread);
      const results = hits.map(hit => ({
        ref: ref++,
        id: hit.id,
        memory: hit.payload.content,
        type: hit.payload.memoryType,
        created_at: hit.payload.createdAt,
        score: Number(hit.score.toFixed(4)),
        ...(hit.scoreDetails ? { score_details: hit.scoreDetails } : {}),
      }));
      return { intent: step.intent, ok: true, results };
    }

    case "recall_search": {
      const hits = deps.store.searchEvents(thread.id, step.query, {
        after: step.after,
        before: step.before,
        limit: step.limit,
      });
      return {
        intent: step.intent,
        ok: true,
        results: hits.map(hit => ({
          seq: hit.event.seq,
          type: hit.event.type,
          ts: hit.event.ts,
          snippet: hit.snippet,
        })),
      };
    }

    case "memory_update": {
      const id = buildRefMap(thread).get(step.ref);
      if (!id) {
        return { intent: step.intent, ok: false, result: unknownRef(step.ref) };
      }
      const result = await deps.archival.update(id, step.new_content, thread.agentId);
      return { intent: step.intent, ok: result.ok, result: result.message };
    }

    case "memory_delete": {
      // Reached only via the approval-replay path — the loop breaks before
      // executing gated intents.
      const id = buildRefMap(thread).get(step.ref);
      if (!id) {
        return { intent: step.intent, ok: false, result: unknownRef(step.ref) };
      }
      const result = deps.archival.delete(id, thread.agentId);
      return { intent: step.intent, ok: result.ok, result: result.message };
    }

    case "propose_plan": {
      // The gate runs in CODE, not in the prompt (constitution IV): an
      // unjustified failure — or a gate against an invented principle — comes
      // back as an ok:false tool_response, so the model revises the plan
      // instead of proceeding on a plan that violated a principle.
      const evaluation = evaluateGateResults(
        step.gate_results,
        deps.constitution.principles.map(p => p.title),
      );
      if (!evaluation.ok) {
        return { intent: step.intent, ok: false, result: evaluation.errors.join(" | ") };
      }
      return {
        intent: step.intent,
        ok: true,
        result:
          `plan accepted: ${step.steps.length} step(s), ` +
          `${step.gate_results.length} constitution gate(s) evaluated, ` +
          `${step.gate_results.filter(g => !g.pass).length} justified exception(s)`,
      };
    }

    case "spawn_subagent": {
      const def = deps.registry.get(step.agent_id);
      if (!def) {
        return { intent: step.intent, ok: false, result: `unknown agent "${step.agent_id}"` };
      }
      if (def.intents.includes("spawn_subagent")) {
        // Recursion guard: an agent that can itself spawn subagents would allow
        // unbounded synchronous recursion (each level burning a full step budget).
        return {
          intent: step.intent,
          ok: false,
          result: `refusing to spawn "${step.agent_id}": agents that can spawn subagents cannot be spawned`,
        };
      }
      if (!extras.runLoop) {
        return { intent: step.intent, ok: false, result: "subagent execution unavailable in this context" };
      }
      const child = deps.store.createThread(def.id, { userId: thread.userId, runId: thread.id });
      deps.store.appendEvent(child.id, "user_input", step.task);
      const finished = await extras.runLoop(child.id);
      const summary = subagentSummary(finished);
      // BMAD discipline: full output stays in the child thread (the artifact);
      // the parent receives only a bounded summary + a ref to drill into.
      return { intent: step.intent, ok: true, ...summary, ref: child.id };
    }

    case "request_human_input":
    case "needs_clarification":
    case "sleep_until":
    case "done_for_now":
    case "complete_task":
      // Break/terminal intents are handled by the loop's routing switch, never
      // executed here.
      return { intent: step.intent, ok: false, result: "not an executable intent" };
  }
}

function unknownRef(ref: number): string {
  return `unknown ref ${ref} — refs come from archival_search results earlier in this thread`;
}

function nextRefFrom(thread: Thread): number {
  let max = 0;
  for (const ref of buildRefMap(thread).keys()) max = Math.max(max, ref);
  return max + 1;
}

function subagentSummary(child: Thread): { verdict: string; summary: string } {
  const last = eventAsStep(effectiveTail(child));
  if (last?.intent === "complete_task") {
    return { verdict: last.outcome, summary: truncate(last.summary, 500) };
  }
  if (last?.intent === "done_for_now") {
    return { verdict: "paused", summary: truncate(last.message, 500) };
  }
  if (last?.intent === "request_human_input") {
    return { verdict: "needs_human", summary: truncate(last.question, 500) };
  }
  return { verdict: deriveStatus(child), summary: "(no summary produced)" };
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}
