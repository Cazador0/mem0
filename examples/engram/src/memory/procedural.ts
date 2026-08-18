import type { EngramDeps } from "../deps";
import type { Thread } from "../agent/thread";
import { renderEvent } from "../agent/render";
import { buildProceduralUser, PROCEDURAL_SYSTEM, ProceduralSchema } from "../prompts/extraction";

/**
 * Procedural memory (mem0's memory_type=procedural_memory — the tier the TS
 * SDK never ported): on complete_task, compress the finished run into one
 * verbatim-preserving execution summary stored through the same archival
 * pipeline, retrievable later by memory_type filter.
 */
export async function summarizeRun(deps: EngramDeps, thread: Thread): Promise<string | null> {
  if (thread.events.length < 3) return null;
  const transcript = thread.events
    .slice(-100)
    .map(renderEvent)
    .join("\n")
    .slice(0, 12000);

  const { summary } = await deps.llm.structured({
    system: PROCEDURAL_SYSTEM,
    user: buildProceduralUser(transcript),
    schema: ProceduralSchema,
    schemaName: "procedural_summary",
  });

  await deps.archival.insert({
    content: summary,
    scope: { userId: thread.userId, agentId: thread.agentId, runId: thread.runId },
    memoryType: "procedural",
    sourceThreadId: thread.id,
  });
  return summary;
}
