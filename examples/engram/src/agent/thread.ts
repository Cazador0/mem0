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

/**
 * The event that determines a thread's status. Annotation events appended by
 * background work (memory_write) and by the scheduler (system_note) do not
 * change what the thread is waiting for, so status derivation skips them —
 * otherwise a background extraction would flip a paused thread to "idle" and
 * make it unresumable.
 */
export const ANNOTATION_TYPES: ReadonlySet<EventType> = new Set(["memory_write", "system_note"]);

/**
 * Annotations appended by BACKGROUND work only. system_note is excluded: a
 * scheduler wake is a turn boundary, so it legitimately resets an error run.
 * Derived from ANNOTATION_TYPES so a new annotation type cannot be added to one
 * notion of "annotation" and silently missed by the other.
 */
const BACKGROUND_ANNOTATIONS: ReadonlySet<EventType> = new Set(
  [...ANNOTATION_TYPES].filter(t => t !== "system_note"),
);

export function effectiveTail(thread: Thread): ThreadEvent | undefined {
  for (let i = thread.events.length - 1; i >= 0; i--) {
    const event = thread.events[i]!;
    if (!ANNOTATION_TYPES.has(event.type)) return event;
  }
  return undefined;
}

/** Parse a tool_call event's data as a NextStep, or undefined if malformed. */
export function eventAsStep(event: ThreadEvent | undefined): NextStep | undefined {
  if (!event || event.type !== "tool_call") return undefined;
  const parsed = NextStepSchema.safeParse(event.data);
  return parsed.success ? parsed.data : undefined;
}

export function awaitingApproval(thread: Thread): boolean {
  const step = eventAsStep(effectiveTail(thread));
  return step !== undefined && routeIntent(step) === "gated";
}

export function awaitingHumanResponse(thread: Thread): boolean {
  const step = eventAsStep(effectiveTail(thread));
  if (!step) return false;
  return (
    step.intent === "request_human_input" ||
    step.intent === "needs_clarification" ||
    step.intent === "done_for_now"
  );
}

export function isSleeping(thread: Thread): boolean {
  return eventAsStep(effectiveTail(thread))?.intent === "sleep_until";
}

export function isCompleted(thread: Thread): boolean {
  return eventAsStep(effectiveTail(thread))?.intent === "complete_task";
}

export function deriveStatus(thread: Thread): ThreadStatus {
  if (isCompleted(thread)) return "completed";
  if (awaitingApproval(thread)) return "awaiting_approval";
  if (awaitingHumanResponse(thread)) return "awaiting_human";
  if (isSleeping(thread)) return "sleeping";
  return "idle";
}

/** Count of LLM-chosen steps over the thread's whole life (display only). */
export function stepCount(thread: Thread): number {
  return thread.events.filter(e => e.type === "tool_call").length;
}

/**
 * Steps taken in the CURRENT turn — tool_calls since the latest turn boundary.
 * The loop budget uses this (factor 10) so it resets whenever a new turn
 * starts; a lifetime count would permanently brick long-lived threads.
 *
 * Turn boundaries: human input (user_input/human_response), a scheduler wake
 * (system_note — otherwise a recurring sleep/wake thread accumulates steps
 * across cycles until it silently stalls forever), and a human approval or
 * denial (tool_responses the resume paths mark with via_human).
 */
export function stepsThisTurn(thread: Thread): number {
  let steps = 0;
  for (let i = thread.events.length - 1; i >= 0; i--) {
    const event = thread.events[i]!;
    if (event.type === "user_input" || event.type === "human_response" || event.type === "system_note") break;
    if (event.type === "tool_response" && (event.data as { via_human?: boolean })?.via_human === true) break;
    if (event.type === "tool_call") steps++;
  }
  return steps;
}

/**
 * Trailing consecutive error events (factor 9: escalate at ~3). A background
 * extraction's memory_write landing between two errors is skipped — it must
 * not reset the escalation count (same reasoning as effectiveTail). A
 * system_note DOES break the run: a scheduler wake starts a new turn.
 */
export function consecutiveErrors(thread: Thread): number {
  let n = 0;
  for (let i = thread.events.length - 1; i >= 0; i--) {
    const type = thread.events[i]!.type;
    if (BACKGROUND_ANNOTATIONS.has(type)) continue;
    if (type === "error") n++;
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
