import { z } from "zod";
import { nowIso } from "../db/database";
import { renderEvent, VERBATIM_TAIL, type CompactedHistory } from "../agent/render";
import { withThreadLock } from "../orchestration/lock";
import type { Thread, ThreadEvent } from "../agent/thread";
import type { EngramDeps } from "../deps";

/**
 * Compaction of the elided region at the render seam.
 *
 * `render.ts` shows the last VERBATIM_TAIL events and used to drop everything
 * before them behind a marker. For a memory app whose premise is long-lived
 * threads, that loses exactly what matters — decisions taken, alternatives
 * already rejected, constraints the human stated once. `recall_search` recovers
 * wording, not commitments.
 *
 * The contract is BMAD's distillator, not "summarize": compression with a
 * never-drop list, so the compacted block is shorter but not lossier in the
 * dimensions that change what the agent should do next.
 *
 * Three properties this must keep:
 * - **Canonical events are never touched** (constitution I). Compaction writes
 *   to its own table; the originals stay queryable by `recall_search`.
 * - **Rendering stays pure and synchronous.** The LLM call happens here, in the
 *   loop, and the result is handed to `renderUserMessage` like prefetch is.
 * - **Idempotent per boundary.** `(thread_id, up_to_seq)` is UNIQUE, so a retry
 *   or a concurrent loop entry cannot produce two summaries of the same span.
 */

/** Re-compact only once the boundary has advanced this far past the stored one. */
export const COMPACT_STRIDE = 25;

const CompactionSchema = z.object({ distillate: z.string().min(1) });

export const COMPACTION_SYSTEM = `You compress the earlier part of an agent's conversation log so it can be carried forward in a smaller context. This is COMPRESSION, NOT SUMMARIZATION: the result must let the agent act correctly without re-reading the originals.

NEVER DROP, even if it costs length:
- Decisions that were made, and by whom (the human or the agent).
- Alternatives that were explicitly REJECTED, and why — otherwise they get re-proposed.
- Open questions that were never answered.
- Constraints, preferences, and commitments the human stated.
- Exact values that would be wrong if paraphrased: names, dates, numbers, identifiers, file paths.

DO DROP:
- Pleasantries, restatements, and the agent's own narration of what it is about to do.
- Tool mechanics whose result is already reflected in a later state.
- Anything already superseded by a later, clearly final statement.

Write terse bullets grouped under short headings. Prefer fragments over sentences. No preamble, no closing summary. Output the distillate only.`;

export function buildCompactionUser(renderedEvents: string, previous: string | null): string {
  return [
    previous
      ? `## Distillate so far (already compressed; carry forward anything still live)\n${previous}`
      : `## Distillate so far\n(none — this is the first compaction of this thread)`,
    ``,
    `## Newly compressible events\n${renderedEvents}`,
    ``,
    `Produce the updated distillate covering BOTH sections.`,
  ].join("\n");
}

interface CompactionRow {
  up_to_seq: number;
  summary: string;
  event_count: number;
}

/** The newest stored compaction for a thread, or null. */
export function latestCompaction(deps: EngramDeps, threadId: string): CompactedHistory | null {
  const row = deps.db
    .query(
      "SELECT up_to_seq, summary, event_count FROM compactions WHERE thread_id = ? ORDER BY up_to_seq DESC LIMIT 1",
    )
    .get(threadId) as CompactionRow | null;
  return row ? { summary: row.summary, upToSeq: row.up_to_seq, eventCount: row.event_count } : null;
}

/**
 * Compact if the thread has grown enough to warrant it, and return whatever
 * distillate should be rendered this turn (possibly the existing one).
 *
 * Failures are non-fatal: a compaction that cannot be produced degrades to the
 * plain elision marker, exactly as before this feature existed.
 */
export async function compactIfNeeded(deps: EngramDeps, thread: Thread): Promise<CompactedHistory | null> {
  const existing = latestCompaction(deps, thread.id);
  const uncompacted = existing
    ? thread.events.filter(e => e.seq > existing.upToSeq)
    : thread.events;

  // Everything still fits verbatim after the stored distillate — nothing to do.
  const overflow = uncompacted.length - VERBATIM_TAIL;
  if (overflow <= 0) return existing;
  // Wait for a worthwhile batch instead of re-compacting on every single event.
  if (existing && overflow < COMPACT_STRIDE) return existing;

  const compressible = uncompacted.slice(0, overflow);
  const upToSeq = compressible[compressible.length - 1]!.seq;

  try {
    const distillate = await withThreadLock(`compact:${thread.id}`, async () => {
      // Re-check inside the lock: a concurrent turn may have just compacted.
      const current = latestCompaction(deps, thread.id);
      if (current && current.upToSeq >= upToSeq) return current;

      const result = await deps.llm.structured({
        system: COMPACTION_SYSTEM,
        user: buildCompactionUser(renderCompressible(compressible), current?.summary ?? null),
        schema: CompactionSchema,
        schemaName: "compaction",
      });
      const eventCount = (current?.eventCount ?? 0) + compressible.length;
      deps.db
        .query(
          `INSERT INTO compactions (id, thread_id, up_to_seq, summary, event_count, created_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT (thread_id, up_to_seq) DO NOTHING`,
        )
        .run(Bun.randomUUIDv7(), thread.id, upToSeq, result.distillate, eventCount, nowIso());
      return latestCompaction(deps, thread.id);
    });
    return distillate ?? existing;
  } catch (err) {
    // Degrade honestly: the marker is what the seam did before compaction existed.
    console.warn(`[engram] compaction failed for thread ${thread.id} (continuing): ${(err as Error).message}`);
    return existing;
  }
}

function renderCompressible(events: ThreadEvent[]): string {
  return events.map(renderEvent).join("\n");
}
