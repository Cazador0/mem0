import { z } from "zod";
import { routeIntent, NextStepSchema, type NextStep } from "./intents";

/**
 * The Thread: an append-only event log unifying execution state and business
 * state (12-factor factor 5). Status is DERIVED from the tail of the log by the
 * predicates below — never stored as an authoritative flag (constitution I).
 */

export const EVENT_TYPES = [
  "user_input",
  "system_note",
  "tool_call",
  "tool_response",
  "human_response",
  "error",
  "memory_write",
] as const;

export const EventTypeSchema = z.enum(EVENT_TYPES);
export type EventType = z.infer<typeof EventTypeSchema>;

export interface ThreadEvent {
  id: string;
  threadId: string;
  seq: number;
  type: EventType;
  data: unknown;
  ts: string;
}

export interface Thread {
  id: string;
  agentId: string;
  scopeKey: string;
  userId: string;
  runId: string;
  extractedSeq: number;
  createdAt: string;
  updatedAt: string;
  events: ThreadEvent[];
}

export type ThreadStatus =
  | "idle"
  | "awaiting_human"
  | "awaiting_approval"
  | "sleeping"
  | "completed";

export function lastEvent(thread: Thread): ThreadEvent | undefined {
  return thread.events[thread.events.length - 1];
}

/** Parse a tool_call event's data as a NextStep, or undefined if malformed. */
export function eventAsStep(event: ThreadEvent | undefined): NextStep | undefined {
  if (!event || event.type !== "tool_call") return undefined;
  const parsed = NextStepSchema.safeParse(event.data);
  return parsed.success ? parsed.data : undefined;
}

export function awaitingApproval(thread: Thread): boolean {
  const step = eventAsStep(lastEvent(thread));
  return step !== undefined && routeIntent(step) === "gated";
}

export function awaitingHumanResponse(thread: Thread): boolean {
  const step = eventAsStep(lastEvent(thread));
  if (!step) return false;
  return (
    step.intent === "request_human_input" ||
    step.intent === "needs_clarification" ||
    step.intent === "done_for_now"
  );
}

export function isSleeping(thread: Thread): boolean {
  return eventAsStep(lastEvent(thread))?.intent === "sleep_until";
}

export function isCompleted(thread: Thread): boolean {
  return eventAsStep(lastEvent(thread))?.intent === "complete_task";
}

export function deriveStatus(thread: Thread): ThreadStatus {
  if (isCompleted(thread)) return "completed";
  if (awaitingApproval(thread)) return "awaiting_approval";
  if (awaitingHumanResponse(thread)) return "awaiting_human";
  if (isSleeping(thread)) return "sleeping";
  return "idle";
}

/** Count of LLM-chosen steps so far (factor 10: bound each agent's steps). */
export function stepCount(thread: Thread): number {
  return thread.events.filter(e => e.type === "tool_call").length;
}

/** Trailing consecutive error events (factor 9: escalate at ~3). */
export function consecutiveErrors(thread: Thread): number {
  let n = 0;
  for (let i = thread.events.length - 1; i >= 0; i--) {
    if (thread.events[i]!.type === "error") n++;
    else break;
  }
  return n;
}

/**
 * Rebuild the integer-ref -> memory-id map from the canonical log, so refs
 * survive pause/resume without out-of-band state (constitution I + IV). Refs
 * are assigned by archival_search tool responses.
 */
export function buildRefMap(thread: Thread): Map<number, string> {
  const map = new Map<number, string>();
  for (const event of thread.events) {
    if (event.type !== "tool_response") continue;
    const data = event.data as { results?: Array<{ ref?: number; id?: string }> } | undefined;
    if (!data || !Array.isArray(data.results)) continue;
    for (const result of data.results) {
      if (typeof result.ref === "number" && typeof result.id === "string") {
        map.set(result.ref, result.id);
      }
    }
  }
  return map;
}

export function nextRef(thread: Thread): number {
  let max = 0;
  for (const ref of buildRefMap(thread).keys()) max = Math.max(max, ref);
  return max + 1;
}
