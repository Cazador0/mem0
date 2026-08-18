import { describe, expect, test } from "bun:test";
import { step, testWorld, FakeEmbedder } from "./harness";
import { agentLoop } from "../src/agent/loop";
import { executeStep } from "../src/agent/execute";
import { extractJson } from "../src/agent/llm";
import { renderEvent, renderUserMessage } from "../src/agent/render";
import { ArchivalMemory } from "../src/memory/archival";
import { tickScheduler, scheduleWake } from "../src/orchestration/scheduler";
import {
  awaitingApproval,
  awaitingHumanResponse,
  buildRefMap,
  deriveStatus,
  stepsThisTurn,
} from "../src/agent/thread";

const SCOPE = { userId: "u1", agentId: "engram" };

describe("review regressions", () => {
  test("background memory_write does not flip a paused thread to idle (resumability)", async () => {
    const { deps } = testWorld({
      script: [step({ intent: "done_for_now", message: "What's your dog's name?" })],
    });
    const thread = deps.store.createThread("engram", SCOPE);
    deps.store.appendEvent(thread.id, "user_input", "hi");
    await agentLoop(thread.id, deps);

    // Background extraction appends its annotation after the pause.
    deps.store.appendEvent(thread.id, "memory_write", { count: 1, ids: ["x"] });
    const reloaded = deps.store.getThread(thread.id);
    expect(awaitingHumanResponse(reloaded)).toBe(true);
    expect(deriveStatus(reloaded)).toBe("awaiting_human");
  });

  test("gated approval survives a trailing memory_write annotation", async () => {
    const { deps } = testWorld({
      script: [
        step({ intent: "archival_search", query: "old fact forget" }),
        step({ intent: "memory_delete", ref: 1, reason: "cleanup" }),
      ],
    });
    await deps.archival.insert({ content: "Old fact to forget.", scope: SCOPE });
    const thread = deps.store.createThread("engram", SCOPE);
    deps.store.appendEvent(thread.id, "user_input", "forget the old fact");
    await agentLoop(thread.id, deps);
    deps.store.appendEvent(thread.id, "memory_write", { count: 1, ids: ["y"] });
    expect(awaitingApproval(deps.store.getThread(thread.id))).toBe(true);
  });

  test("step budget is per turn, not per lifetime — human input resets it", async () => {
    const { deps, llm } = testWorld({
      maxSteps: 2,
      script: [
        step({ intent: "core_append", block: "scratchpad", content: "a" }),
        step({ intent: "core_append", block: "scratchpad", content: "b" }),
      ],
    });
    const thread = deps.store.createThread("engram", SCOPE);
    deps.store.appendEvent(thread.id, "user_input", "go");
    const paused = await agentLoop(thread.id, deps);
    expect(stepsThisTurn(paused)).toBe(3); // 2 steps + budget done_for_now

    // The human replies: the budget must reset and the LLM must run again.
    deps.store.appendEvent(thread.id, "human_response", { response: "continue" });
    llm.push(step({ intent: "done_for_now", message: "carried on" }));
    const resumed = await agentLoop(thread.id, deps);
    const tail = resumed.events[resumed.events.length - 1]!.data as { message: string };
    expect(tail.message).toBe("carried on"); // NOT the budget message
  });

  test("BM25 candidates are scoped in SQL — other scopes cannot starve a search (degraded mode)", async () => {
    const { deps } = testWorld({ embedder: false });
    for (let i = 0; i < 220; i++) {
      await deps.archival.insert({
        content: `User B coffee note number ${i}: enjoys coffee tasting session ${i}.`,
        scope: { userId: "B" },
      });
    }
    await deps.archival.insert({ content: "User prefers dark roast coffee.", scope: { userId: "A" } });
    const hits = await deps.archival.search({ query: "coffee", scope: { userId: "A" } });
    expect(hits.length).toBe(1);
    expect(hits[0]!.payload.content).toContain("dark roast");
  });

  test("memories stored without an embedding remain findable in embedder mode", async () => {
    const { deps } = testWorld();
    const flaky = new FakeEmbedder();
    const throwingEmbed = () => Promise.reject(new Error("embedding endpoint down"));
    const archival = new ArchivalMemory(deps.db, {
      dims: flaky.dims,
      embed: throwingEmbed,
      embedBatch: async texts => texts.map(() => null),
    });
    // Stored during the outage: no vector.
    await archival.insert({ content: "Wifi password hint lives in the red notebook.", scope: SCOPE });

    // Search later with a healthy embedder against the same table.
    const healthy = new ArchivalMemory(deps.db, flaky);
    const hits = await healthy.search({ query: "wifi password notebook", scope: SCOPE });
    expect(hits.length).toBe(1);
    expect(hits[0]!.payload.content).toContain("red notebook");
  });

  test("update() to content duplicating another memory returns ok:false, not a thrown UNIQUE error", async () => {
    const { deps } = testWorld();
    const tea = await deps.archival.insert({ content: "User likes tea.", scope: SCOPE });
    const coffee = await deps.archival.insert({ content: "User likes coffee.", scope: SCOPE });
    const result = await deps.archival.update(coffee.id, "User likes tea.");
    expect(result.ok).toBe(false);
    expect(result.message).toContain(tea.id);
    expect(deps.archival.getById(coffee.id)?.content).toBe("User likes coffee.");
  });

  test("core_replace treats new_text literally — $& is not a replacement pattern", () => {
    const { deps } = testWorld();
    deps.core.append("engram", "scratchpad", "cost is HIGH today");
    const result = deps.core.replace("engram", "scratchpad", "HIGH", "over $100 ($& baseline)");
    expect(result.ok).toBe(true);
    expect(deps.core.get("engram", "scratchpad")?.content).toBe("cost is over $100 ($& baseline) today");
  });

  test("extractJson preserves code fences inside JSON string values", () => {
    const raw = '{"next_step":{"intent":"archival_insert","content":"User prefers ```json fenced examples"}}';
    expect(extractJson(raw)).toEqual({
      next_step: { intent: "archival_insert", content: "User prefers ```json fenced examples" },
    });
    // Fenced replies still salvage.
    expect(extractJson('```json\n{"a": 1}\n```')).toEqual({ a: 1 });
  });

  test("secrets in human_response values are redacted at the render seam", () => {
    const rendered = renderEvent({
      id: "e",
      threadId: "t",
      seq: 0,
      type: "human_response",
      data: { response: "my key is sk-ant-abc12345 ok?" },
      ts: "2026-08-18T00:00:00.000Z",
    });
    expect(rendered).toContain("[redacted]");
    expect(rendered).not.toContain("sk-ant-abc12345");
  });

  test("raw memory UUIDs are stripped from the prompt but kept in the canonical log for refs", async () => {
    const { deps } = testWorld({
      script: [
        step({ intent: "archival_search", query: "dog named Poppy" }),
        step({ intent: "done_for_now", message: "found it" }),
      ],
    });
    const { id } = await deps.archival.insert({ content: "User's dog is named Poppy.", scope: SCOPE });
    const thread = deps.store.createThread("engram", SCOPE);
    deps.store.appendEvent(thread.id, "user_input", "what's my dog named Poppy up to");
    const finished = await agentLoop(thread.id, deps);

    expect(renderUserMessage(finished, null)).not.toContain(id); // prompt: refs only
    expect(buildRefMap(finished).get(1)).toBe(id); // log: id preserved for replay
  });

  test("spawning an agent that can itself spawn is refused (recursion guard)", async () => {
    const { deps } = testWorld({
      script: [
        step({ intent: "spawn_subagent", agent_id: "engram", task: "spawn yourself forever" }),
        step({ intent: "done_for_now", message: "ok, doing it myself" }),
      ],
    });
    const thread = deps.store.createThread("engram", SCOPE);
    deps.store.appendEvent(thread.id, "user_input", "delegate to yourself");
    const finished = await agentLoop(thread.id, deps);
    const response = finished.events.find(e => e.type === "tool_response")!.data as { result: string };
    expect(response.result).toContain("cannot be spawned");
  });

  test("stale wakes are consumed without disturbing a thread that moved on", async () => {
    const { deps, llm } = testWorld({
      script: [step({ intent: "complete_task", outcome: "success", summary: "done early" }), { summary: "run summary" }],
    });
    const thread = deps.store.createThread("engram", SCOPE);
    scheduleWake(deps, thread.id, new Date(Date.now() - 1000).toISOString(), "old sleep");
    deps.store.appendEvent(thread.id, "user_input", "never mind, wrap up now");
    await agentLoop(thread.id, deps); // thread completes; schedule row is now stale

    const llmCallsBefore = llm.calls.length;
    const fired = await tickScheduler(deps, id => agentLoop(id, deps));
    expect(fired).toBe(0);
    expect(llm.calls.length).toBe(llmCallsBefore); // no LLM call, no wake note
    expect(deps.store.getThread(thread.id).events.some(e => e.type === "system_note")).toBe(false);
  });

  test("approval-replay still works via executeStep on the effective tail after annotations", async () => {
    const { deps } = testWorld({
      script: [
        step({ intent: "archival_search", query: "temporary fact" }),
        step({ intent: "memory_delete", ref: 1, reason: "requested" }),
      ],
    });
    const { id } = await deps.archival.insert({ content: "Temporary fact here.", scope: SCOPE });
    const thread = deps.store.createThread("engram", SCOPE);
    deps.store.appendEvent(thread.id, "user_input", "delete the temporary fact");
    const paused = await agentLoop(thread.id, deps);
    deps.store.appendEvent(thread.id, "memory_write", { count: 1, ids: ["z"] });

    const reloaded = deps.store.getThread(thread.id);
    expect(awaitingApproval(reloaded)).toBe(true);
    // The recorded step is the effective tail, not the raw last event.
    const { effectiveTail, eventAsStep } = await import("../src/agent/thread");
    const recorded = eventAsStep(effectiveTail(reloaded))!;
    const result = await executeStep(recorded, reloaded, deps);
    expect((result as { ok: boolean }).ok).toBe(true);
    expect(deps.archival.getById(id)).toBeNull();
  });
});
