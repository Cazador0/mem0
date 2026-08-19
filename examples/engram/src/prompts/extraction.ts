import { z } from "zod";

/**
 * ADD-only archival extraction, following mem0's ADDITIVE_EXTRACTION_PROMPT
 * (mem0/configs/prompts.py): contextually rich not atomic, temporally grounded
 * against the Observation Date, integer-ID indirection for existing memories,
 * strict integrity rules. Reconciliation is deliberately NOT part of this hot
 * path — dedup happens in code, consolidation offline.
 */

export const ExtractionSchema = z.object({
  memories: z.array(
    z.object({
      text: z.string().min(1),
      linked_refs: z
        .array(z.number().int())
        .default([])
        .describe("Integer refs of related Existing Memories, for linking only"),
    }),
  ),
});
export type ExtractionResult = z.infer<typeof ExtractionSchema>;

export const EXTRACTION_SYSTEM = `# ROLE
You are a Memory Extractor — a precise, evidence-bound processor that extracts rich, contextual memories from conversations. Your sole operation is ADD: identify every piece of memorable information and produce self-contained, contextually rich factual statements. You extract from BOTH user and assistant messages.

# RULES
- Contextually rich, not atomic. Bad: "User has a dog". Good: "User has a dog named Poppy and their morning walks together are the highlight of their day".
- Concise but complete: 15-80 words per memory.
- Temporal grounding: every New Message line is prefixed with the date it was said ([YYYY-MM-DD]). Resolve ALL relative time references ("yesterday", "last week") against THAT message's own date — never the Current Date. "User went to Paris last week" is useless 6 months later; "User went to Paris the week of May 15, 2023" is meaningful forever.
- Existing Memories are provided ONLY for deduplication and linking — do NOT extract new memories from them, and do NOT import their details into new memories. When a new memory relates to an Existing Memory (same topic, overlapping entities, updated preference, follow-up event), put that memory's integer ref in "linked_refs".
- No fabrication: every detail must trace to the inputs. No implicit inference of gender, age, ethnicity, etc.
- No echo extraction: when an assistant message merely restates what the user already said, do not extract it again.
- No meta-extraction: extract the CONTENT of what was shared, not a description of the act of sharing.
- Skip anything semantically equivalent to an Existing Memory.
- When in doubt, extract: a slightly redundant memory costs less than a missing one — deduplication downstream handles true duplicates.
- If nothing is memorable, return an empty "memories" array.`;

export function buildExtractionUser(opts: {
  recentContext: Array<{ role: string; text: string }>;
  existingMemories: Array<{ ref: number; text: string }>;
  newMessages: Array<{ role: string; text: string; date: string }>;
  observationDate: string;
  currentDate: string;
}): string {
  const lines = (msgs: Array<{ role: string; text: string }>) =>
    msgs.map(m => `${m.role}: ${m.text}`).join("\n") || "(none)";
  // Per-message dates: one batch can span days (a thread that slept, a backlog
  // extraction) and a single batch-level date would mis-ground later messages.
  const datedLines = (msgs: Array<{ role: string; text: string; date: string }>) =>
    msgs.map(m => `[${m.date}] ${m.role}: ${m.text}`).join("\n") || "(none)";
  const existing =
    opts.existingMemories.map(m => JSON.stringify({ ref: m.ref, text: m.text })).join("\n") || "(none)";
  return [
    `## Recent Context (already processed — for pronoun/reference resolution only)`,
    lines(opts.recentContext),
    ``,
    `## Existing Memories`,
    existing,
    ``,
    `## New Messages (extract from these; each line's [date] grounds its relative times)`,
    datedLines(opts.newMessages),
    ``,
    `## Observation Date (date of the first new message)`,
    opts.observationDate,
    ``,
    `## Current Date`,
    opts.currentDate,
  ].join("\n");
}

/** Procedural-memory summarization (mem0's PROCEDURAL_MEMORY prompt structure). */
export const ProceduralSchema = z.object({ summary: z.string().min(1) });

export const PROCEDURAL_SYSTEM = `You are a memory summarization system that records the complete interaction history between a human and an AI agent. Produce a comprehensive summary containing every detail necessary to continue the task without ambiguity.

Structure:
- **Overview**: Task Objective, Progress Status.
- **Sequential Agent Actions (numbered)**: for each step — the agent action, its exact unaltered result, and key findings / errors / current context.

Preserve outputs verbatim where they matter. Output only the summary.`;

export function buildProceduralUser(transcript: string): string {
  return `# Execution history\n${transcript}\n\nSummarize per the required structure.`;
}
