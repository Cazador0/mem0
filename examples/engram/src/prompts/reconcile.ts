import { z } from "zod";

/**
 * Offline reconciliation, following the shape of mem0's legacy
 * `DEFAULT_UPDATE_MEMORY_PROMPT`: the model sees a cluster of related existing
 * memories addressed by integer ref and returns one decision per ref.
 *
 * Deliberate divergence from mem0's four-verb vocabulary: there is no ADD.
 * mem0's reconciler runs against a batch of NEW facts extracted from a fresh
 * message, so ADD is how those facts enter the store. This job runs offline
 * over memories that are ALREADY stored — it has no new conversation to add
 * from, and a minted memory would carry no `source_thread_id` /
 * `source_event_seqs`, breaking the provenance every other memory has.
 * Consolidating a cluster is expressed as UPDATE on the keeper plus DELETE on
 * the rest, which keeps extraction the single ADD path (constitution II).
 */

export const ReconcileSchema = z.object({
  decisions: z.array(
    z.object({
      ref: z.number().int().describe("The integer ref of the memory this decision applies to"),
      action: z.enum(["UPDATE", "DELETE", "NONE"]),
      text: z
        .string()
        .optional()
        .describe("Required for UPDATE: the full replacement text for that memory"),
      reason: z.string().optional().describe("One short clause explaining the decision"),
    }),
  ),
});
export type ReconcileResult = z.infer<typeof ReconcileSchema>;

export const RECONCILE_SYSTEM = `# ROLE
You are a Memory Reconciler. You are given a CLUSTER of existing memories about one user that a similarity search judged related. Decide, for each memory, whether it should stay as it is, be rewritten, or be removed.

# ACTIONS
- NONE — keep the memory exactly as it is. This is the default and should be the most common answer.
- UPDATE — replace this memory's text. Use it to merge a cluster into one keeper, or to correct a memory that a later memory supersedes. Supply the FULL replacement text in "text"; it must remain self-contained (a reader with no other memory must still understand it).
- DELETE — remove this memory. Only when it is genuinely redundant (its content is fully carried by another memory in the cluster, including the keeper's updated text) or flatly contradicted by a newer memory in the cluster.

# RULES
- Related is not the same as duplicate. Two memories about the same person, project, or pet are usually BOTH worth keeping. Return NONE for everything unless consolidating clearly loses nothing.
- Never delete a fact that no surviving memory states. Before returning DELETE, check the exact detail is present in a memory you are keeping or in an UPDATE you are writing in this same response.
- Preserve specifics verbatim when merging: names, dates, numbers, places, identifiers. A merge that rounds "the week of May 15, 2023" to "in 2023" is a bad merge.
- Newer memories win over older ones when they conflict — the memories are listed oldest first.
- Never invent detail that is not in the cluster. You are consolidating text, not reasoning about the user.
- Distinct facts that merely share an entity must not be merged into one memory. Merging is for restatements of the SAME fact.
- Return a decision for every ref you were given, and only for refs you were given.`;

export function buildReconcileUser(cluster: Array<{ ref: number; text: string; created: string }>): string {
  return [
    `## Cluster (oldest first)`,
    cluster.map(m => JSON.stringify({ ref: m.ref, created: m.created, text: m.text })).join("\n"),
    ``,
    `Return one decision per ref. Prefer NONE. Only merge when nothing is lost.`,
  ].join("\n");
}
