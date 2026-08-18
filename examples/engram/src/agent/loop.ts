import { envelopeForIntents, routeIntent, type NextStep } from "./intents";
import { consecutiveErrors, deriveStatus, lastEvent, stepsThisTurn, type Thread } from "./thread";
import { executeStep } from "./execute";
import { compactError, renderUserMessage } from "./render";
import { buildSystemPrompt } from "../prompts/nextstep";
import { prefetchArchival } from "../memory/prefetch";
import { summarizeRun } from "../memory/procedural";
import { scheduleWake } from "../orchestration/scheduler";
import type { EngramDeps } from "../deps";

/**
 * The stateless reducer (12-factor factor 12): agentLoop(thread) -> thread'.
 * One LLM call per iteration returns one intent; the routing switch decides
 * execute-and-continue vs persist-and-break. The tool_call event is persisted
 * BEFORE execution so approvals replay the recorded step verbatim.
 */
export async function agentLoop(threadId: string, deps: EngramDeps): Promise<Thread> {
  let thread = deps.store.getThread(threadId);
  const agent = deps.registry.get(thread.agentId);
  if (!agent) throw new Error(`unknown agent "${thread.agentId}" for thread ${threadId}`);
  const maxSteps = agent.maxSteps ?? deps.config.maxSteps;

  loop: while (true) {
    if (stepsThisTurn(thread) >= maxSteps) {
      // Factor 10: bounded agents. Overflow yields with a handoff message.
      deps.store.appendEvent(thread.id, "tool_call", {
        intent: "done_for_now",
        message: `Step budget (${maxSteps}) reached — pausing for guidance before continuing.`,
      });
      break;
    }

    let step: NextStep;
    try {
      const prefetched = await prefetchArchival(deps, thread).catch(() => null);
      const system = buildSystemPrompt({
        agentPersona: agent.persona,
        constitutionVersion: deps.constitution.version,
        constitutionDigest: deps.constitution.digest,
        intents: agent.intents,
        coreBlocks: deps.core.render(thread.agentId),
      });
      const user = renderUserMessage(thread, prefetched?.block ?? null);
      const envelope = await deps.llm.structured({
        system,
        user,
        schema: envelopeForIntents(agent.intents),
        schemaName: "next_step_envelope",
      });
      step = envelope.next_step;
    } catch (err) {
      thread = appendAndReload(deps, thread.id, "error", { message: compactError(err) });
      if (escalateIfStuck(deps, thread)) break;
      continue;
    }

    // Persist the chosen step BEFORE execution (constitution I + IV).
    deps.store.appendEvent(thread.id, "tool_call", step);
    thread = deps.store.getThread(thread.id);

    switch (routeIntent(step)) {
      case "gated":
        // Recorded but unexecuted — awaits human approval via the resume path.
        break loop;

      case "break":
        if (step.intent === "sleep_until") {
          const wake = resolveWakeAt(step);
          if (!wake.ok) {
            // Malformed sleep gets the same readable-feedback treatment as any
            // other bad intent: the model reads the error and retries, instead
            // of the thread durably sleeping for a time nobody chose.
            thread = appendAndReload(deps, thread.id, "tool_response", {
              intent: step.intent,
              ok: false,
              result: wake.error,
            });
            continue;
          }
          // Link the row to this sleep_until event so a superseded sleep's
          // row is recognized as stale by the scheduler.
          scheduleWake(deps, thread.id, wake.wakeAt, step.reason, lastEvent(thread)!.seq);
        }
        break loop;

      case "terminal":
        await summarizeRun(deps, thread).catch(err =>
          console.warn(`[engram] procedural summarization failed: ${compactError(err)}`),
        );
        break loop;

      case "sync": {
        try {
          const result = await executeStep(step, thread, deps, {
            runLoop: id => agentLoop(id, deps),
          });
          thread = appendAndReload(deps, thread.id, "tool_response", result);
        } catch (err) {
          thread = appendAndReload(deps, thread.id, "error", { message: compactError(err) });
          if (escalateIfStuck(deps, thread)) break loop;
        }
        continue;
      }
    }
  }

  thread = deps.store.getThread(thread.id);
  deps.store.setStatusHint(thread.id, deriveStatus(thread));
  return thread;
}

function appendAndReload(
  deps: EngramDeps,
  threadId: string,
  type: "error" | "tool_response",
  data: Record<string, unknown>,
): Thread {
  deps.store.appendEvent(threadId, type, data);
  return deps.store.getThread(threadId);
}

/** Factor 9: after 3 consecutive errors, escalate to a human through the same intent machinery. */
function escalateIfStuck(deps: EngramDeps, thread: Thread): boolean {
  if (consecutiveErrors(thread) < 3) return false;
  deps.store.appendEvent(thread.id, "tool_call", {
    intent: "request_human_input",
    question: "I hit repeated errors and need guidance before continuing.",
    context: String((thread.events[thread.events.length - 1]?.data as { message?: string })?.message ?? ""),
    urgency: "high",
  });
  return true;
}

type WakeResolution = { ok: true; wakeAt: string } | { ok: false; error: string };

function resolveWakeAt(step: Extract<NextStep, { intent: "sleep_until" }>): WakeResolution {
  const hasWakeAt = step.wake_at !== undefined;
  const hasDelay = step.delay_minutes !== undefined;
  if (hasWakeAt === hasDelay) {
    return { ok: false, error: "sleep_until needs exactly one of wake_at (RFC3339) or delay_minutes" };
  }
  if (hasWakeAt) {
    const parsed = new Date(step.wake_at!);
    if (Number.isNaN(parsed.getTime())) {
      return { ok: false, error: `wake_at "${step.wake_at}" is not a parseable RFC3339 timestamp — use e.g. 2026-08-18T09:00:00Z or delay_minutes` };
    }
    if (parsed.getTime() <= Date.now()) {
      return { ok: false, error: `wake_at "${step.wake_at}" resolves to the past — provide a future RFC3339 timestamp or delay_minutes` };
    }
    return { ok: true, wakeAt: parsed.toISOString() };
  }
  return { ok: true, wakeAt: new Date(Date.now() + step.delay_minutes! * 60_000).toISOString() };
}
