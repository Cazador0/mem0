import { withThreadLock } from "../orchestration/lock";
import { buildScopeKey, type Scope } from "./recall";
import { cosineSimilarity } from "./scoring";
import { buildReconcileUser, RECONCILE_SYSTEM, ReconcileSchema } from "../prompts/reconcile";
import type { MemoryRecord } from "./archival";
import type { EngramDeps } from "../deps";

/**
 * Offline reconciliation — the ONE place UPDATE/DELETE decisions are made by a
 * model rather than by code.
 *
 * The extraction hot path is deliberately ADD-only (mem0's V3 design): asking a
 * model to mutate memory while a user waits on a turn is how stores lose facts.
 * Consolidation is therefore a separate, explicitly-invoked job — `bun run
 * reconcile`, a cron, an operator — with four properties the hot path could not
 * offer:
 *
 * 1. **It plans before it writes.** A dry run returns the full decision list;
 *    nothing is applied until asked.
 * 2. **Deletes are approval-gated by volume.** A pass that wants to delete more
 *    than DELETE_APPROVAL_THRESHOLD memories applies NOTHING and reports
 *    "awaiting_approval" — a mass delete is exactly the failure this job risks.
 * 3. **Nothing bypasses the facade.** Every mutation goes through
 *    `ArchivalMemory.update`/`delete` with actor `reconcile`, so each one
 *    re-embeds, reindexes FTS, relinks entities, and writes its `memory_history`
 *    row. That costs cross-decision atomicity (each mutation is its own
 *    transaction, so a mid-batch failure leaves earlier ones applied) — the
 *    trade is deliberate: a single hand-rolled transaction over the tables would
 *    skip all four of those side effects and silently corrupt derived state,
 *    while the audit trail makes a partial pass reconstructible.
 * 4. **A cluster can never be emptied.** If every ref comes back DELETE, the
 *    newest memory is force-kept and the pass warns.
 *
 * Clustering is raw cosine between stored vectors, NOT `search()`. Search's
 * blended score answers "how well does this row match a short query", and its
 * adaptive divisor and boosts make the number incomparable between two stored
 * memories — measured on the test corpus, a genuine near-duplicate pair scored
 * 0.45 while a memory scored 0.62 against ITSELF. Cosine is the signal that
 * means one thing here: how alike are these two memories.
 *
 * The cost is honest and stated rather than papered over: a memory with no
 * vector (no embedder configured, or an embedding outage at insert) cannot be
 * clustered, and `skippedNoVector` reports exactly how many were passed over.
 * A lexical fallback was considered and rejected — token overlap would cluster
 * on shared stopwords and hand a model two unrelated facts to "merge", which is
 * a worse failure than doing nothing and saying so.
 */

/**
 * Cosine at or above which two memories are considered near-duplicates worth
 * showing a model together. Deliberately strict: mem0 upserts entities at >=0.95
 * and matches reads at a 0.5 floor, and this sits between them. The threshold
 * only decides what gets LOOKED at — the model still answers NONE for most
 * clusters and deletes are volume-gated — so erring loose costs an LLM call and
 * erring tight costs a missed merge. Override to measure.
 */
export const CLUSTER_THRESHOLD = Number(process.env.ENGRAM_RECONCILE_THRESHOLD ?? 0.85);
/** Cluster ceiling: one LLM call sees at most this many memories. */
export const CLUSTER_MAX = 8;
/** Memories examined per pass, newest first. */
export const DEFAULT_LIMIT = 200;
/** Deletes above this in one pass require explicit approval. */
export const DELETE_APPROVAL_THRESHOLD = 5;
/** Audit actor recorded on every mutation this job makes. */
export const RECONCILE_ACTOR = "reconcile";

export type ReconcileAction = "UPDATE" | "DELETE" | "NONE";

export interface ReconcileDecision {
  memoryId: string;
  action: ReconcileAction;
  before: string;
  /** Replacement text (UPDATE only). */
  after?: string;
  reason?: string;
}

export interface ReconcileOutcome {
  /**
   * noop = nothing related enough to consider; planned = dry run;
   * awaiting_approval = too many deletes, NOTHING applied; applied = written.
   */
  status: "noop" | "planned" | "awaiting_approval" | "applied";
  clusters: number;
  decisions: ReconcileDecision[];
  updated: number;
  deleted: number;
  /** Mutations the facade refused or that threw (each already warned about). */
  failed: number;
  /** Clusters whose LLM call failed; they are skipped, not retried. */
  failedClusters: number;
  /** Memories that could not be clustered because they have no stored vector. */
  skippedNoVector: number;
}

export interface ReconcileOptions {
  scope: Scope;
  /** Write the decisions. Default false — plan only. */
  apply?: boolean;
  /** Permit a pass whose delete count exceeds DELETE_APPROVAL_THRESHOLD. */
  approveDeletes?: boolean;
  limit?: number;
}

/**
 * Reconcile one scope. Serialized per scope so two passes cannot decide about
 * the same memories concurrently; like every other lock here it is in-process.
 */
export async function reconcile(deps: EngramDeps, opts: ReconcileOptions): Promise<ReconcileOutcome> {
  return withThreadLock(`reconcile:${buildScopeKey(opts.scope)}`, () => reconcileLocked(deps, opts));
}

async function reconcileLocked(deps: EngramDeps, opts: ReconcileOptions): Promise<ReconcileOutcome> {
  const empty: ReconcileOutcome = {
    status: "noop",
    clusters: 0,
    decisions: [],
    updated: 0,
    deleted: 0,
    failed: 0,
    failedClusters: 0,
    skippedNoVector: 0,
  };

  const { clusters, skippedNoVector } = buildClusters(deps, opts);
  if (clusters.length === 0) return { ...empty, skippedNoVector };

  const decisions: ReconcileDecision[] = [];
  let failedClusters = 0;
  for (const cluster of clusters) {
    // Refs are positional and never leave this function — the model never sees
    // a memory UUID (constitution IV).
    const refToMemory = new Map(cluster.map((memory, i) => [i + 1, memory]));
    let result;
    try {
      result = await deps.llm.structured({
        system: RECONCILE_SYSTEM,
        user: buildReconcileUser(
          cluster.map((memory, i) => ({ ref: i + 1, text: memory.content, created: memory.createdAt.slice(0, 10) })),
        ),
        schema: ReconcileSchema,
        schemaName: "reconciliation",
      });
    } catch (err) {
      // Offline job: one bad cluster must not abandon the rest of the pass.
      failedClusters++;
      console.warn(`[engram] reconciliation LLM call failed for one cluster (skipping): ${(err as Error).message}`);
      continue;
    }
    decisions.push(...validateDecisions(result.decisions, refToMemory));
  }

  const deleteCount = decisions.filter(d => d.action === "DELETE").length;
  const updateCount = decisions.filter(d => d.action === "UPDATE").length;
  const plan: ReconcileOutcome = {
    status: "planned",
    clusters: clusters.length,
    decisions,
    updated: 0,
    deleted: 0,
    failed: 0,
    failedClusters,
    skippedNoVector,
  };
  if (!opts.apply) return plan;

  if (deleteCount > DELETE_APPROVAL_THRESHOLD && !opts.approveDeletes) {
    // Withhold the WHOLE pass, not just the deletes: applying the merges while
    // holding back the deletes they justify would leave duplicated content.
    console.warn(
      `[engram] reconciliation wants to delete ${deleteCount} memories (threshold ` +
        `${DELETE_APPROVAL_THRESHOLD}) — applying nothing until the pass is approved`,
    );
    return { ...plan, status: "awaiting_approval" };
  }
  if (updateCount === 0 && deleteCount === 0) return { ...plan, status: "applied" };

  let updated = 0;
  let deleted = 0;
  let failed = 0;
  for (const decision of decisions) {
    try {
      if (decision.action === "UPDATE") {
        const result = await deps.archival.update(decision.memoryId, decision.after!, RECONCILE_ACTOR);
        if (result.ok) updated++;
        else {
          failed++;
          console.warn(`[engram] reconciliation update refused: ${result.message}`);
        }
      } else if (decision.action === "DELETE") {
        const result = deps.archival.delete(decision.memoryId, RECONCILE_ACTOR);
        if (result.ok) deleted++;
        else {
          failed++;
          console.warn(`[engram] reconciliation delete refused: ${result.message}`);
        }
      }
    } catch (err) {
      failed++;
      console.warn(`[engram] reconciliation mutation failed (continuing): ${(err as Error).message}`);
    }
  }
  return { ...plan, status: "applied", updated, deleted, failed };
}

/**
 * Group the scope's memories into clusters of near-duplicates by cosine.
 *
 * Seed-centric, newest first: each memory joins at most one cluster, and a
 * cluster is every unassigned memory within CLUSTER_THRESHOLD of its seed.
 * Deliberately not single-link — chaining A~B~C where A and C are unrelated is
 * how a "merge these" prompt gets handed a topic instead of a duplicate.
 * Singletons are dropped: a memory alone has nothing to reconcile against,
 * which is what makes a clean store a zero-LLM-call pass.
 */
function buildClusters(
  deps: EngramDeps,
  opts: ReconcileOptions,
): { clusters: MemoryRecord[][]; skippedNoVector: number } {
  const rows = deps.archival.listWithVectors(opts.scope, { limit: opts.limit ?? DEFAULT_LIMIT });
  const withVector = rows.filter((row): row is { memory: MemoryRecord; vector: Float32Array } => row.vector !== null);
  const skippedNoVector = rows.length - withVector.length;
  if (skippedNoVector > 0) {
    console.warn(
      `[engram] reconciliation skipped ${skippedNoVector} memories with no stored vector — ` +
        `near-duplicate detection needs embeddings (configure ENGRAM_EMBEDDINGS_URL)`,
    );
  }

  const assigned = new Set<string>();
  const clusters: MemoryRecord[][] = [];
  for (const seed of withVector) {
    if (assigned.has(seed.memory.id)) continue;
    assigned.add(seed.memory.id);
    const related = withVector
      .filter(other => !assigned.has(other.memory.id))
      .map(other => ({ other, similarity: cosineSimilarity(seed.vector, other.vector) }))
      .filter(candidate => candidate.similarity >= CLUSTER_THRESHOLD)
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, CLUSTER_MAX - 1);
    if (related.length === 0) continue;
    for (const candidate of related) assigned.add(candidate.other.memory.id);
    // Oldest first: the prompt tells the model newer memories win conflicts,
    // and a stable order makes a decision list readable against the plan.
    clusters.push(
      [seed.memory, ...related.map(c => c.other.memory)].sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    );
  }
  return { clusters, skippedNoVector };
}

/**
 * Code disposes (constitution IV). Refs the model invented, refs it answered
 * twice, UPDATEs with no text or with text identical to what is already stored,
 * and a cluster it wants emptied entirely are all corrected here rather than
 * trusted into the store.
 */
function validateDecisions(
  raw: Array<{ ref: number; action: ReconcileAction; text?: string; reason?: string }>,
  refToMemory: Map<number, MemoryRecord>,
): ReconcileDecision[] {
  const seen = new Set<number>();
  const decisions: ReconcileDecision[] = [];
  for (const decision of raw) {
    const memory = refToMemory.get(decision.ref);
    if (!memory) {
      console.warn(`[engram] reconciliation named unknown ref ${decision.ref} (dropped)`);
      continue;
    }
    if (seen.has(decision.ref)) {
      console.warn(`[engram] reconciliation decided ref ${decision.ref} twice (keeping the first)`);
      continue;
    }
    seen.add(decision.ref);

    if (decision.action === "UPDATE") {
      const text = decision.text?.trim() ?? "";
      // A no-op rewrite is a NONE: applying it would burn an embed call and
      // write a history row saying nothing changed.
      if (!text || text === memory.content.trim()) {
        decisions.push({ memoryId: memory.id, action: "NONE", before: memory.content, reason: decision.reason });
        continue;
      }
      decisions.push({
        memoryId: memory.id,
        action: "UPDATE",
        before: memory.content,
        after: text,
        reason: decision.reason,
      });
      continue;
    }
    decisions.push({
      memoryId: memory.id,
      action: decision.action,
      before: memory.content,
      reason: decision.reason,
    });
  }

  return keepAtLeastOne(decisions, refToMemory);
}

/**
 * A cluster whose every member is deleted loses the fact outright — no keeper,
 * no UPDATE carrying it forward. Force-keep the newest member: when memories
 * conflict the later one is the current state of the fact.
 */
function keepAtLeastOne(
  decisions: ReconcileDecision[],
  refToMemory: Map<number, MemoryRecord>,
): ReconcileDecision[] {
  const survives = decisions.some(d => d.action !== "DELETE");
  const decidedIds = new Set(decisions.map(d => d.memoryId));
  const undecided = [...refToMemory.values()].some(m => !decidedIds.has(m.id));
  if (survives || undecided || decisions.length === 0) return decisions;

  const newestId = [...refToMemory.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]!.id;
  console.warn("[engram] reconciliation wanted to delete an entire cluster — keeping the newest memory");
  return decisions.map(d => (d.memoryId === newestId ? { ...d, action: "NONE" as const } : d));
}
