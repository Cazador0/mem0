import type { EngramDeps } from "../deps";
import { conversationalText } from "./recall";
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

  const recentContext = thread.events
    .filter(e => e.seq <= thread.extractedSeq)
    .map(conversationalText)
    .filter((l): l is { role: string; text: string } => l !== null && l.text.trim() !== "")
    .slice(-10)
    .map(l => ({ role: l.role, text: l.text.length > 300 ? `${l.text.slice(0, 300)}…` : l.text }));

  // Phase 1 — existing memories, integer-ref indirection kept host-side.
  const query = newMessages.map(m => m.text).join("\n").slice(0, 2000);
  const existing = await deps.archival
    .search({ query, scope, topK: 10 })
    .catch(() => []);
  const refToId = new Map(existing.map((hit, i) => [i + 1, hit.id]));

  // Phase 2 — the only phase allowed to throw.
  const extraction = await deps.llm.structured({
    system: EXTRACTION_SYSTEM,
    user: buildExtractionUser({
      recentContext,
      existingMemories: existing.map((hit, i) => ({ ref: i + 1, text: hit.payload.content })),
      newMessages: newMessages.map(m => ({ role: m.role, text: m.text })),
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

  // Phase 8 — record the write in the thread, then advance the watermark past it.
  if (added.length > 0) {
    deps.store.appendEvent(thread.id, "memory_write", {
      count: added.length,
      ids: added.map(a => a.id),
    });
  }
  const refreshed = deps.store.getThread(thread.id);
  const maxSeq = refreshed.events.reduce((max, e) => Math.max(max, e.seq), -1);
  deps.store.setExtractedSeq(thread.id, maxSeq);

  return { added };
}
