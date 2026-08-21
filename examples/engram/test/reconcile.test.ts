import { describe, expect, test } from "bun:test";
import { testWorld } from "./harness";
import { LLMError, type LLMClient, type StructuredRequest } from "../src/agent/llm";
import { DELETE_APPROVAL_THRESHOLD, RECONCILE_ACTOR, reconcile } from "../src/memory/reconcile";
import type { MemoryRecord } from "../src/memory/archival";
import type { EngramDeps } from "../src/deps";

/**
 * Offline reconciliation: the only path where a model may rewrite or delete
 * stored memories. The tests care about what code does with what the model
 * says — clustering, validation, the volume gate, the audit trail.
 */

const SCOPE = { userId: "u1", agentId: "engram", runId: "" };
const DOG_A = "User has a dog named Poppy and their morning walks together are the highlight of the day.";
const DOG_B = "User has a dog named Poppy; morning walks with her are the highlight of the day.";
const DOG_MERGED = "User has a dog named Poppy and their morning walks with her are the highlight of the day.";
const JOB = "User works as a platform engineer at Northwind Logistics on the billing service.";
const RUN_A = "User is training for the Boston Marathon in April 2027 with a 3:30 goal.";
const RUN_B = "User is training for the Boston Marathon in April 2027, aiming for a 3:30 finish.";

interface ClusterMember {
  ref: number;
  text: string;
}
type Decide = (member: ClusterMember, cluster: ClusterMember[]) => Record<string, unknown> | null;

/**
 * A reconciler stand-in that reads the REAL prompt and answers per memory
 * content. Deliberately not the ScriptedLLM: refs are positional, and two
 * memories inserted in the same millisecond can order either way — a fixture
 * keyed on ref number would be a coin flip. Parsing the prompt also means a
 * change to `buildReconcileUser` breaks these tests loudly instead of quietly
 * feeding the model something else.
 */
class ClusterLLM implements LLMClient {
  readonly seen: ClusterMember[][] = [];
  constructor(
    private readonly decide: Decide,
    private readonly throwOnCall = -1,
  ) {}

  async structured<T>(req: StructuredRequest<T>): Promise<T> {
    const cluster = parseCluster(req.user);
    this.seen.push(cluster);
    if (this.seen.length === this.throwOnCall) throw new LLMError("reconciler unavailable");
    const decisions = cluster.map(m => this.decide(m, cluster)).filter(Boolean);
    return req.schema.parse({ decisions });
  }
}

function parseCluster(user: string): ClusterMember[] {
  return user
    .split("\n")
    .filter(line => line.startsWith("{"))
    .map(line => JSON.parse(line) as ClusterMember);
}

function withLLM(deps: EngramDeps, llm: LLMClient): EngramDeps {
  return { ...deps, llm };
}

async function seed(deps: EngramDeps, contents: string[]): Promise<string[]> {
  const ids: string[] = [];
  for (const content of contents) {
    ids.push((await deps.archival.insert({ content, scope: SCOPE })).id);
  }
  return ids;
}

function remaining(deps: EngramDeps): MemoryRecord[] {
  return deps.archival.listWithVectors({ userId: "u1" }).map(row => row.memory);
}

describe("offline reconciliation", () => {
  test("a store with no near-duplicates is a zero-LLM-call noop", async () => {
    const { deps, llm } = testWorld();
    await seed(deps, [DOG_A, JOB, RUN_A]);

    const outcome = await reconcile(deps, { scope: { userId: "u1" }, apply: true });

    expect(outcome.status).toBe("noop");
    expect(outcome.clusters).toBe(0);
    // The ScriptedLLM has an empty script: any call would have thrown.
    expect(llm.calls).toEqual([]);
    expect(remaining(deps)).toHaveLength(3);
  });

  test("planning is the default: it decides, and writes nothing", async () => {
    const { deps } = testWorld();
    await seed(deps, [DOG_A, DOG_B]);
    const llm = new ClusterLLM(m =>
      m.text === DOG_B ? { ref: m.ref, action: "DELETE", reason: "same fact" } : { ref: m.ref, action: "UPDATE", text: DOG_MERGED },
    );

    const outcome = await reconcile(withLLM(deps, llm), { scope: { userId: "u1" } });

    expect(outcome.status).toBe("planned");
    expect(outcome.clusters).toBe(1);
    expect(outcome.decisions.map(d => d.action).sort()).toEqual(["DELETE", "UPDATE"]);
    expect(outcome.updated).toBe(0);
    expect(outcome.deleted).toBe(0);
    // Nothing touched: both originals still stored, verbatim.
    expect(remaining(deps).map(m => m.content).sort()).toEqual([DOG_A, DOG_B].sort());
  });

  test("applying merges the cluster through the facade, with the audit naming the actor", async () => {
    const { deps } = testWorld();
    await seed(deps, [DOG_A, DOG_B]);
    const llm = new ClusterLLM(m =>
      m.text === DOG_B ? { ref: m.ref, action: "DELETE" } : { ref: m.ref, action: "UPDATE", text: DOG_MERGED },
    );

    const outcome = await reconcile(withLLM(deps, llm), { scope: { userId: "u1" }, apply: true });

    expect(outcome.status).toBe("applied");
    expect({ updated: outcome.updated, deleted: outcome.deleted, failed: outcome.failed }).toEqual({
      updated: 1,
      deleted: 1,
      failed: 0,
    });
    const left = remaining(deps);
    expect(left.map(m => m.content)).toEqual([DOG_MERGED]);

    // Through the facade means: audited, re-embedded, FTS and entities relinked.
    const history = deps.archival.history(left[0]!.id);
    expect(history.map(h => [h.action, h.actorId])).toEqual([
      ["ADD", null],
      ["UPDATE", RECONCILE_ACTOR],
    ]);
    const hits = await deps.archival.search({ query: "Poppy morning walks", scope: { userId: "u1" } });
    expect(hits.map(h => h.payload.content)).toEqual([DOG_MERGED]);
  });

  test("code disposes: unknown refs, repeat refs, and no-op rewrites are corrected", async () => {
    const { deps } = testWorld();
    await seed(deps, [DOG_A, DOG_B]);
    const llm = new ClusterLLM((m, cluster) => {
      if (m.ref !== cluster[0]!.ref) return { ref: m.ref, action: "NONE" };
      return { ref: m.ref, action: "UPDATE", text: m.text }; // rewrite to what is already stored
    });
    // Two extra decisions the model had no business sending.
    const noisy: LLMClient = {
      structured: async req => {
        const parsed = (await llm.structured(req)) as { decisions: unknown[] };
        const first = parsed.decisions[0] as { ref: number };
        return req.schema.parse({
          decisions: [
            ...parsed.decisions,
            { ref: first.ref, action: "DELETE" }, // same ref decided twice
            { ref: 99, action: "DELETE" }, // a ref that was never offered
          ],
        });
      },
    };

    const outcome = await reconcile(withLLM(deps, noisy), { scope: { userId: "u1" }, apply: true });

    // The unknown ref is dropped, the repeat is ignored, and the rewrite that
    // changes nothing becomes a NONE rather than an embed + history row.
    expect(outcome.decisions.map(d => d.action)).toEqual(["NONE", "NONE"]);
    expect({ updated: outcome.updated, deleted: outcome.deleted }).toEqual({ updated: 0, deleted: 0 });
    expect(remaining(deps)).toHaveLength(2);
  });

  test("a pass that wants too many deletes applies nothing until it is approved", async () => {
    const { deps } = testWorld();
    const many = Array.from({ length: 8 }, (_, i) => `${RUN_A} Repeated in conversation number ${i + 1}.`);
    await seed(deps, many);
    // Keep the first, delete the other seven — over the threshold of five.
    const llm = new ClusterLLM((m, cluster) =>
      m.ref === cluster[0]!.ref ? { ref: m.ref, action: "NONE" } : { ref: m.ref, action: "DELETE" },
    );

    const gated = await reconcile(withLLM(deps, llm), { scope: { userId: "u1" }, apply: true });

    expect(gated.clusters).toBe(1);
    expect(gated.decisions.filter(d => d.action === "DELETE").length).toBeGreaterThan(DELETE_APPROVAL_THRESHOLD);
    expect(gated.status).toBe("awaiting_approval");
    // The WHOLE pass is withheld, not just the deletes.
    expect({ updated: gated.updated, deleted: gated.deleted }).toEqual({ updated: 0, deleted: 0 });
    expect(remaining(deps)).toHaveLength(8);

    const approved = await reconcile(withLLM(deps, llm), {
      scope: { userId: "u1" },
      apply: true,
      approveDeletes: true,
    });
    expect(approved.status).toBe("applied");
    expect(approved.deleted).toBe(7);
    expect(remaining(deps)).toHaveLength(1);
  });

  test("a cluster is never emptied, however the model votes", async () => {
    const { deps } = testWorld();
    await seed(deps, [RUN_A, RUN_B]);
    const newestBefore = remaining(deps)
      .map(m => m.createdAt)
      .sort()
      .at(-1)!;
    const llm = new ClusterLLM(m => ({ ref: m.ref, action: "DELETE" }));

    const outcome = await reconcile(withLLM(deps, llm), { scope: { userId: "u1" }, apply: true });

    expect(outcome.decisions.filter(d => d.action === "NONE")).toHaveLength(1);
    const left = remaining(deps);
    expect(left).toHaveLength(1);
    // The survivor is the newest — when memories conflict, the later one is
    // the current state of the fact.
    expect(left[0]!.createdAt).toBe(newestBefore);
    expect(outcome.deleted).toBe(1);
  });

  test("one cluster's LLM failure skips that cluster and the pass continues", async () => {
    const { deps } = testWorld();
    await seed(deps, [DOG_A, DOG_B, RUN_A, RUN_B]);
    const llm = new ClusterLLM(m => ({ ref: m.ref, action: "NONE" }), 1);

    const outcome = await reconcile(withLLM(deps, llm), { scope: { userId: "u1" } });

    expect(outcome.clusters).toBe(2);
    expect(outcome.failedClusters).toBe(1);
    // The surviving cluster still produced decisions.
    expect(outcome.decisions).toHaveLength(2);
    expect(remaining(deps)).toHaveLength(4);
  });

  test("without vectors nothing is clustered, and the pass says so instead of guessing", async () => {
    const { deps, llm } = testWorld({ embedder: false });
    await seed(deps, [DOG_A, DOG_B]);

    const outcome = await reconcile(deps, { scope: { userId: "u1" }, apply: true });

    expect(outcome.status).toBe("noop");
    expect(outcome.skippedNoVector).toBe(2);
    expect(llm.calls).toEqual([]); // no model is asked to merge what was never compared
    expect(remaining(deps)).toHaveLength(2);
  });

  test("another user's near-duplicates are never in this pass", async () => {
    const { deps } = testWorld();
    await seed(deps, [DOG_A]);
    await deps.archival.insert({ content: DOG_B, scope: { userId: "u2", agentId: "engram", runId: "" } });
    const llm = new ClusterLLM(m => ({ ref: m.ref, action: "DELETE" }));

    const outcome = await reconcile(withLLM(deps, llm), { scope: { userId: "u1" }, apply: true });

    expect(outcome.status).toBe("noop");
    expect(outcome.clusters).toBe(0);
    expect(deps.archival.listWithVectors({ userId: "u2" })).toHaveLength(1);
  });
});
