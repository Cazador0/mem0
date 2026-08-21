import { describe, expect, test } from "bun:test";
import { testWorld } from "./harness";
import { agentLoop } from "../src/agent/loop";
import {
  CAPSULE_PARTS,
  HOST_OWNER,
  compileCapsule,
  listSections,
  readSection,
  renderEnvelope,
  reviewFanOut,
  reviewSection,
  writeSection,
} from "../src/orchestration/capsule";
import type { LLMClient, StructuredRequest } from "../src/agent/llm";
import type { EngramDeps } from "../src/deps";

/**
 * Capsule compiler + review fan-out. Two claims are under test: the envelope a
 * reviewer receives is exactly its declared slice (and never another
 * reviewer's findings), and section ownership is enforced in code.
 */

const SCOPE = { userId: "u1", agentId: "engram", runId: "" };
const REVIEWERS = ["reviewer-evidence", "reviewer-risk", "reviewer-scope"] as const;

/**
 * Answers from whatever envelope it is handed. Scripted fixtures cannot be used
 * here: the fan-out runs reviewers concurrently, so call order is not fixed.
 */
class EnvelopeLLM implements LLMClient {
  readonly envelopes: string[] = [];
  constructor(private readonly reply: (envelope: string) => Record<string, unknown>) {}
  async structured<T>(req: StructuredRequest<T>): Promise<T> {
    this.envelopes.push(req.user);
    return req.schema.parse({ next_step: this.reply(req.user) });
  }
}

function lensOf(envelope: string): string {
  return /^Your lens: (.*)$/m.exec(envelope)?.[1] ?? "";
}

async function world(): Promise<{ deps: EngramDeps; threadId: string }> {
  const { deps } = testWorld();
  await deps.archival.insert({ content: "User prefers window seats on flights longer than three hours.", scope: SCOPE });
  await deps.archival.insert({ content: "User's dog Poppy needs a morning walk before any early meeting.", scope: SCOPE });
  const thread = deps.store.createThread("engram", SCOPE);
  deps.store.appendEvent(thread.id, "user_input", "Book me a flight for the offsite");
  deps.store.appendEvent(thread.id, "tool_call", { intent: "done_for_now", message: "Which day works?" });
  return { deps, threadId: thread.id };
}

describe("capsule compiler", () => {
  test("compiles every part as a section, host-owned, plus an empty one per reviewer", async () => {
    const { deps, threadId } = await world();

    const capsule = await compileCapsule(deps, {
      threadId,
      title: "Flight booking proposal",
      task: "Book the window seat on the morning flight",
      reviewers: REVIEWERS,
    });

    const sections = listSections(deps, capsule.id);
    expect(sections.map(s => s.name).sort()).toEqual(
      [...CAPSULE_PARTS, ...REVIEWERS.map(reviewSection)].sort(),
    );
    for (const part of CAPSULE_PARTS) {
      expect(readSection(deps, capsule.id, part)!.ownerAgentId).toBe(HOST_OWNER);
    }
    for (const agentId of REVIEWERS) {
      const own = readSection(deps, capsule.id, reviewSection(agentId))!;
      expect({ owner: own.ownerAgentId, content: own.content, version: own.version }).toEqual({
        owner: agentId,
        content: "",
        version: 0,
      });
    }

    // Compiled deterministically from what already existed — no LLM call.
    expect(readSection(deps, capsule.id, "memories")!.content).toContain("window seats");
    expect(readSection(deps, capsule.id, "history")!.content).toContain("Book me a flight");
    expect(readSection(deps, capsule.id, "constitution")!.content).toContain("Constitution v");
  });

  test("refuses to compile for an agent that is not a reviewer", async () => {
    const { deps, threadId } = await world();
    await expect(
      compileCapsule(deps, { threadId, title: "t", task: "t", reviewers: ["curator"] }),
    ).rejects.toThrow(/not a reviewer/);
    await expect(
      compileCapsule(deps, { threadId, title: "t", task: "t", reviewers: ["nobody"] }),
    ).rejects.toThrow(/unknown reviewer/);
  });

  test("an envelope is exactly the reviewer's declared slice, and never another's findings", async () => {
    const { deps, threadId } = await world();
    const capsule = await compileCapsule(deps, {
      threadId,
      title: "Flight booking proposal",
      task: "Book the window seat on the morning flight",
      reviewers: REVIEWERS,
    });
    // A finding already recorded by one reviewer must stay invisible to the others.
    writeSection(deps, {
      capsuleId: capsule.id,
      name: reviewSection("reviewer-risk"),
      agentId: "reviewer-risk",
      content: "blocked: the morning walk conflicts with an early flight",
    });

    const evidence = renderEnvelope(deps, capsule.id, "reviewer-evidence");
    const scope = renderEnvelope(deps, capsule.id, "reviewer-scope");

    // evidence gets task + memories; scope gets task + constitution.
    expect(evidence).toContain("## memories");
    expect(evidence).toContain("window seats");
    expect(evidence).not.toContain("## constitution");
    expect(evidence).not.toContain("## history");
    expect(scope).toContain("## constitution");
    expect(scope).not.toContain("## memories");
    // Neither sees the risk reviewer's finding.
    expect(evidence).not.toContain("morning walk conflicts");
    expect(scope).not.toContain("morning walk conflicts");
    // ...but its author does.
    expect(renderEnvelope(deps, capsule.id, "reviewer-risk")).toContain("morning walk conflicts");
  });

  test("section ownership is enforced in code, not asked for in a prompt", async () => {
    const { deps, threadId } = await world();
    const capsule = await compileCapsule(deps, {
      threadId,
      title: "t",
      task: "t",
      reviewers: ["reviewer-risk"],
    });

    const foreign = writeSection(deps, {
      capsuleId: capsule.id,
      name: reviewSection("reviewer-risk"),
      agentId: "reviewer-evidence",
      content: "not mine to write",
    });
    expect(foreign).toEqual({
      ok: false,
      message: 'section "review:reviewer-risk" belongs to "reviewer-risk" — "reviewer-evidence" may not write it',
    });

    const compiled = writeSection(deps, {
      capsuleId: capsule.id,
      name: "task",
      agentId: "reviewer-risk",
      content: "rewriting the brief",
    });
    expect(compiled.ok).toBe(false);
    expect(compiled.message).toContain("compiled by the host");

    const missing = writeSection(deps, {
      capsuleId: capsule.id,
      name: "review:nobody",
      agentId: "nobody",
      content: "x",
    });
    expect(missing.ok).toBe(false);

    // The refusals left the capsule exactly as compiled.
    expect(readSection(deps, capsule.id, "task")!.content).toBe("t");
    expect(readSection(deps, capsule.id, reviewSection("reviewer-risk"))!.content).toBe("");
  });

  test("a stale writer loses: the write is compare-and-set", async () => {
    const { deps, threadId } = await world();
    const capsule = await compileCapsule(deps, { threadId, title: "t", task: "t", reviewers: ["reviewer-risk"] });
    const name = reviewSection("reviewer-risk");
    const stale = readSection(deps, capsule.id, name)!.version;

    const first = writeSection(deps, { capsuleId: capsule.id, name, agentId: "reviewer-risk", content: "first" });
    const second = writeSection(deps, {
      capsuleId: capsule.id,
      name,
      agentId: "reviewer-risk",
      content: "second",
      expectedVersion: stale,
    });

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(false);
    expect(second.message).toContain("changed since you read it");
    expect(readSection(deps, capsule.id, name)!.content).toBe("first");
  });
});

describe("review fan-out", () => {
  test("each reviewer answers its own lens, on its own thread, into its own section", async () => {
    const { deps, threadId } = await world();
    const llm = new EnvelopeLLM(envelope => ({
      intent: "complete_task",
      outcome: lensOf(envelope).startsWith("What breaks") ? "blocked" : "success",
      summary: `answering: ${lensOf(envelope).slice(0, 24)}`,
    }));
    const deps2 = { ...deps, llm };
    const capsule = await compileCapsule(deps2, {
      threadId,
      title: "Flight booking proposal",
      task: "Book the window seat on the morning flight",
      reviewers: REVIEWERS,
    });

    const verdicts = await reviewFanOut(deps2, {
      capsule,
      runLoop: id => agentLoop(id, deps2),
    });

    expect(verdicts.map(v => v.agentId)).toEqual([...REVIEWERS]);
    expect(verdicts.map(v => v.verdict)).toEqual(["success", "blocked", "success"]);
    // Three envelopes, three different lenses — the fan-out is not one opinion
    // asked three times.
    expect(new Set(llm.envelopes.map(lensOf)).size).toBe(3);

    for (const verdict of verdicts) {
      // Full reasoning stayed in the child thread; the section holds the bound.
      const child = deps2.store.getThread(verdict.ref);
      expect(child.events.filter(e => e.type === "error")).toEqual([]);
      expect(child.agentId).toBe(verdict.agentId);
      expect(child.runId).toBe(threadId);
      const section = readSection(deps2, capsule.id, reviewSection(verdict.agentId))!;
      expect(section.content).toBe(`${verdict.verdict}: ${verdict.summary}`);
      expect(section.version).toBe(1);
    }
  });

  test("a reviewer that cannot judge from its envelope says so instead of inventing", async () => {
    const { deps, threadId } = await world();
    const llm = new EnvelopeLLM(() => ({
      intent: "needs_clarification",
      markers: [
        {
          question: "the envelope states no acceptance criteria",
          options: ["treat the task line as the criteria", "ask the requester"],
          recommended: "ask the requester",
          impact: "scope",
        },
      ],
    }));
    const deps2 = { ...deps, llm };
    const capsule = await compileCapsule(deps2, { threadId, title: "t", task: "t", reviewers: ["reviewer-scope"] });

    const [verdict] = await reviewFanOut(deps2, { capsule, runLoop: id => agentLoop(id, deps2) });

    // Not a verdict, and not a fabricated one either: the thread pauses on the
    // clarification and the section records that honestly.
    expect(verdict!.verdict).toBe("awaiting_human");
    const child = deps2.store.getThread(verdict!.ref);
    expect(child.events.map(e => e.type)).toEqual(["user_input", "tool_call"]);
    expect(child.events.filter(e => e.type === "error")).toEqual([]);
    expect(readSection(deps2, capsule.id, reviewSection("reviewer-scope"))!.content).toContain(verdict!.verdict);
  });

  test("one reviewer failing does not fail the fan-out", async () => {
    const { deps, threadId } = await world();
    const llm = new EnvelopeLLM(envelope => ({
      intent: "complete_task",
      outcome: "success",
      summary: lensOf(envelope).slice(0, 20),
    }));
    const deps2 = { ...deps, llm };
    const capsule = await compileCapsule(deps2, { threadId, title: "t", task: "t", reviewers: REVIEWERS });

    const verdicts = await reviewFanOut(deps2, {
      capsule,
      runLoop: async id => {
        const thread = deps2.store.getThread(id);
        if (thread.agentId === "reviewer-risk") throw new Error("reviewer crashed");
        return agentLoop(id, deps2);
      },
    });

    expect(verdicts.map(v => v.verdict)).toEqual(["success", "failed", "success"]);
    expect(verdicts.find(v => v.agentId === "reviewer-risk")!.summary).toBe("reviewer crashed");
  });
});
