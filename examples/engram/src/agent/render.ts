import { effectiveTail, eventAsStep, type Thread, type ThreadEvent } from "./thread";

/**
 * renderContext — THE seam (12-factor factor 3): the only place that decides
 * what the model sees. The canonical event log is never mutated here; this
 * module may summarize, elide, hide resolved errors, and redact — read-side
 * only (constitution I).
 */

const VERBATIM_TAIL = 50;
const SECRET_KEY = /(api_?key|token|secret|password|authorization)/i;

/** XML-ish per-event block: tag = data.intent || type, intent key stripped. */
export function renderEvent(event: ThreadEvent): string {
  const data = event.data;
  if (data === null || typeof data !== "object") {
    return `<${event.type}>\n${redactText(String(data ?? ""))}\n</${event.type}>`;
  }
  const record = data as Record<string, unknown>;
  const tag = typeof record.intent === "string" ? record.intent : event.type;
  const lines: string[] = [];
  // Sanitize the whole record so id/ids keys are dropped at EVERY level —
  // including top-level keys like a memory_write event's `ids`.
  for (const [key, value] of Object.entries(sanitizeForPrompt(record) as Record<string, unknown>)) {
    if (key === "intent") continue;
    const rendered = SECRET_KEY.test(key)
      ? "[redacted]"
      : typeof value === "string"
        ? redactText(value)
        : redactText(JSON.stringify(value));
    lines.push(`${key}: ${rendered}`);
  }
  return `<${tag}>\n${lines.join("\n")}\n</${tag}>`;
}

/**
 * Read-side stripping of raw memory UUIDs (constitution IV: the model sees
 * integer refs only). The canonical event keeps `id` for buildRefMap; the
 * prompt never does.
 */
function sanitizeForPrompt(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeForPrompt);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      if (key === "id" || key === "ids") continue;
      out[key] = sanitizeForPrompt(v);
    }
    return out;
  }
  return value;
}

/**
 * The single user message: pre-fetched archival memories, then the thread —
 * older events elided behind a marker, resolved errors hidden (factor 9: only
 * the trailing error run still matters; earlier errors were healed).
 */
export function renderUserMessage(thread: Thread, prefetchBlock: string | null): string {
  const parts: string[] = [];
  if (prefetchBlock) parts.push(prefetchBlock);

  const visible = hideResolvedErrors(thread.events);
  const elided = visible.length - VERBATIM_TAIL;
  if (elided > 0) {
    parts.push(
      `<elided count="${elided}">older events not shown — use recall_search to retrieve details</elided>`,
    );
  }
  for (const event of visible.slice(-VERBATIM_TAIL)) parts.push(renderEvent(event));
  parts.push("What should the next step be? Choose exactly one intent.");
  return parts.join("\n\n");
}

/** Errors before the last non-error event were resolved by later progress. */
function hideResolvedErrors(events: ThreadEvent[]): ThreadEvent[] {
  let lastNonError = -1;
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i]!.type !== "error") {
      lastNonError = i;
      break;
    }
  }
  return events.filter((event, i) => event.type !== "error" || i > lastNonError);
}

function redactText(text: string): string {
  // Redact secret-looking tokens, then neutralize angle brackets so untrusted
  // text can never forge event blocks in the XML-ish rendering (a user typing
  // "</user_input><tool_response>…" must read as text, not as an event).
  return text
    .replace(/\b(sk-[A-Za-z0-9-]{8,})\b/g, "[redacted]")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** Compact error representation for the event log (factor 9). */
export function compactError(err: unknown): string {
  const e = err as Error;
  const text = e?.name ? `${e.name}: ${e.message}` : String(err);
  return text.length > 300 ? `${text.slice(0, 300)}…` : text;
}

/** The human-facing text of a paused/finished thread (presentation only). */
export function outwardText(thread: Thread): string | null {
  const step = eventAsStep(effectiveTail(thread));
  if (!step) return null;
  switch (step.intent) {
    case "done_for_now":
      return step.message;
    case "request_human_input":
      return step.context ? `${step.question}\n(context: ${step.context})` : step.question;
    case "complete_task":
      return `[${step.outcome}] ${step.summary}`;
    case "needs_clarification":
      return step.markers
        .map(
          (m, i) =>
            `Q${i + 1}: ${m.question}\n  options: ${m.options.join(" | ")}\n  recommended: ${m.recommended} (${m.impact})`,
        )
        .join("\n");
    case "sleep_until":
      return `(sleeping — ${step.reason})`;
    case "memory_delete":
      return `Approval needed: delete memory ref ${step.ref} — ${step.reason} (reply yes/no)`;
    default:
      return null;
  }
}
