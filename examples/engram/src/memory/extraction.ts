import type { EngramDeps } from "../deps";
import { conversationalText } from "./recall";
import { withThreadLock } from "../orchestration/lock";
import { buildExtractionUser, EXTRACTION_SYSTEM, ExtractionSchema } from "../prompts/extraction";

/**
 * The archival write pipeline — mem0's V3 phased, ADD-only design. Runs after
 * a loop pass (never inline in it). Numbered phases with per-item resilience;
 * the extraction LLM call is the ONLY phase that throws, so callers can tell
 * "LLM down" apart from "nothing to remember".
 *
 * Phase 0: scope + watermark → new conversational messages
 * Phase 1: top-10 existing memories, remapped to integer refs (anti-hallucination)
 * Phase 2: one LLM call (ADD-only, temporally grounded) — throws LLMError on failure
 * Phase 3-6: per-memory insert via the archival facade (embed → hash dedup →
 *            row + FTS + history in one transaction)
 * Phase 7: entity linking happens inside insert(), best-effort
 * Phase 8: memory_write event + watermark advance
 */
export async function extractFromThread(
  deps: EngramDeps,
  threadId: string,
): Promise<{ added: Array<{ id: string; memory: string }> }> {
  // Serialized per thread under a dedicated "extract:" lock namespace: two
  // background extractions must never snapshot the same watermark (the second
  // would re-process the first's messages and could regress extracted_seq).
  // A separate namespace so a multi-second extraction LLM call never blocks
  // user-facing loop entries, which hold the plain thread-id lock — concurrent
  // loop appends are safe against a running extraction by snapshot semantics.
  return withThreadLock(`extract:${threadId}`, () => extractLocked(deps, threadId));
}

async function extractLocked(
  deps: EngramDeps,
  threadId: string,
): Promise<{ added: Array<{ id: string; memory: string }> }> {
  const thread = deps.store.getThread(threadId);
  const scope = { userId: thread.userId, agentId: thread.agentId, runId: thread.runId };

  // Phase 0 — what's new since the last extraction.
  const newEvents = thread.events.filter(e => e.seq > thread.extractedSeq);
  const newMessages: Array<{ role: string; text: string; seq: number; ts: string }> = [];
  for (const event of newEvents) {
    const line = conversationalText(event);
    if (line?.text.trim()) newMessages.push({ ...line, seq: event.seq, ts: event.ts });
  }
  if (newMessages.length === 0) return { added: [] };

  // Already-processed context for pronoun resolution: the shared rolling
  // window over the sub-thread of events at or below the watermark.
  const recentContext = deps.store.recentWindow(
    { ...thread, events: thread.events.filter(e => e.seq <= thread.extractedSeq) },
    10,
    300,
  );

  // Phase 1 — existing memories, integer-ref indirection kept host-side.
  // User-scoped read (mem0's sharing model): dedup/linking context must span
  // every agent's writes for this user, not just this thread's identity.
  const query = newMessages.map(m => m.text).join("\n").slice(0, 2000);
  const existing = await deps.archival
    .search({ query, scope: { userId: thread.userId }, topK: 10 })
    .catch(() => []);
  const refToId = new Map(existing.map((hit, i) => [i + 1, hit.id]));

  // Phase 2 — the only phase allowed to throw.
  const extraction = await deps.llm.structured({
    system: EXTRACTION_SYSTEM,
    user: buildExtractionUser({
      recentContext,
      existingMemories: existing.map((hit, i) => ({ ref: i + 1, text: hit.payload.content })),
      newMessages: newMessages.map(m => ({ role: m.role, text: m.text, date: m.ts.slice(0, 10) })),
      observationDate: newMessages[0]!.ts.slice(0, 10),
      currentDate: new Date().toISOString().slice(0, 10),
    }),
    schema: ExtractionSchema,
    schemaName: "extraction",
  });

  // Phases 3-7 — per-memory insert; unknown refs are dropped (constitution IV).
  const sourceSeqs = newMessages.map(m => m.seq);
  const added: Array<{ id: string; memory: string }> = [];
  for (const memory of extraction.memories) {
    const links = memory.linked_refs
      .map(ref => refToId.get(ref))
      .filter((id): id is string => id !== undefined);
    try {
      const result = await deps.archival.insert({
        content: memory.text,
        scope,
        sourceThreadId: thread.id,
        sourceEventSeqs: sourceSeqs,
        metadata: links.length > 0 ? { links: JSON.stringify(links) } : {},
      });
      if (result.created) added.push({ id: result.id, memory: memory.text });
    } catch (err) {
      console.warn(`[engram] archival insert failed for one memory (continuing): ${(err as Error).message}`);
    }
  }

  // Phase 8 — record the write, then advance the watermark ONLY to the max seq
  // of the Phase-0 snapshot. Events appended while the LLM call was in flight
  // were not extracted, so they must stay above the watermark; the memory_write
  // event itself is non-conversational and is harmless above it.
  if (added.length > 0) {
    deps.store.appendEvent(thread.id, "memory_write", {
      count: added.length,
      ids: added.map(a => a.id),
    });
  }
  const snapshotMaxSeq = thread.events.reduce((max, e) => Math.max(max, e.seq), thread.extractedSeq);
  deps.store.setExtractedSeq(thread.id, snapshotMaxSeq);

  return { added };
}
