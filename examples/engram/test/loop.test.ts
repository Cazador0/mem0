import { describe, expect, test } from "bun:test";
import { step, testWorld } from "./harness";
import { agentLoop } from "../src/agent/loop";
import { executeStep } from "../src/agent/execute";
import { awaitingApproval, awaitingHumanResponse, deriveStatus, eventAsStep, lastEvent } from "../src/agent/thread";
import { tickScheduler } from "../src/orchestration/scheduler";

const SCOPE = { userId: "u1", agentId: "engram" };

describe("agent loop (stateless reducer)", () => {
  test("chains sync memory intents before yielding (heartbeat), persisting tool_call before tool_response", async () => {
    const { deps } = testWorld({
      script: [
        step({ intent: "core_append", block: "human", content: "Name: Hunter; dog: Poppy" }),
        step({ intent: "archival_insert", content: "User's dog is named Poppy and joins their morning walks." }),
        step({ intent: "done_for_now", message: "Noted — I'll remember Poppy." }),
      ],
    });
    const thread = deps.store.createThread("engram", SCOPE);
    deps.store.appendEvent(thread.id, "user_input", "My dog is named Poppy.");

    const finished = await agentLoop(thread.id, deps);

    expect(finished.events.map(e => e.type)).toEqual([
      "user_input",
      "tool_call",
      "tool_response",
      "tool_call",
      "tool_response",
      "tool_call",
    ]);
    expect(deps.core.get("engram", "human")?.content).toContain("Poppy");
    const memories = await deps.archival.search({ query: "dog Poppy", scope: SCOPE });
    expect(memories.length).toBe(1);
    expect(awaitingHumanResponse(finished)).toBe(true);
    expect(deriveStatus(finished)).toBe("awaiting_human");
  });

  test("gated memory_delete breaks for approval; approval replays the recorded step verbatim", async () => {
    const { deps } = testWorld({
      script: [
        step({ intent: "archival_search", query: "stale fact" }),
        step({ intent: "memory_delete", ref: 1, reason: "user asked to forget it" }),
      ],
    });
    const { id } = await deps.archival.insert({ content: "Stale fact the user wants forgotten.", scope: SCOPE });
    const thread = deps.store.createThread("engram", SCOPE);
    deps.store.appendEvent(thread.id, "user_input", "Please forget the stale fact.");

    const paused = await agentLoop(thread.id, deps);
    expect(awaitingApproval(paused)).toBe(true);
    expect(deps.archival.getById(id)).not.toBeNull(); // recorded, NOT executed

    const recorded = eventAsStep(lastEvent(paused))!;
    const result = await executeStep(recorded, paused, deps);
    deps.store.appendEvent(paused.id, "tool_response", result);
    expect(deps.archival.getById(id)).toBeNull(); // executed only after approval
    expect(deps.archival.history(id).map(h => h.action)).toEqual(["ADD", "DELETE"]);
  });

  test("denial becomes an ordinary tool_response the model can read", async () => {
    const { deps } = testWorld({
      script: [
        step({ intent: "archival_search", query: "anything" }),
        step({ intent: "memory_delete", ref: 1, reason: "cleanup" }),
      ],
    });
    await deps.archival.insert({ content: "A fact under consideration.", scope: SCOPE });
    const thread = deps.store.createThread("engram", SCOPE);
    deps.store.appendEvent(thread.id, "user_input", "clean up memory");
    const paused = await agentLoop(thread.id, deps);
    const recorded = eventAsStep(lastEvent(paused))!;

    deps.store.appendEvent(paused.id, "tool_response", {
      intent: recorded.intent,
      ok: false,
      result: 'user denied the operation with feedback: "keep it"',
    });
    const reloaded = deps.store.getThread(paused.id);
    expect(awaitingApproval(reloaded)).toBe(false);
    expect((lastEvent(reloaded)?.data as { result: string }).result).toContain("keep it");
  });

  test("unknown refs are rejected readably (anti-hallucination)", async () => {
    const { deps } = testWorld({
      script: [
        step({ intent: "memory_update", ref: 42, new_content: "x", reason: "y" }),
        step({ intent: "done_for_now", message: "ok" }),
      ],
    });
    const thread = deps.store.createThread("engram", SCOPE);
    deps.store.appendEvent(thread.id, "user_input", "update memory 42");
    const finished = await agentLoop(thread.id, deps);
    const response = finished.events.find(e => e.type === "tool_response")!;
    expect((response.data as { result: string }).result).toContain("unknown ref 42");
  });

  test("three consecutive LLM failures escalate to a human through the intent machinery", async () => {
    const { deps } = testWorld({
      script: [{ __throw: "model down" }, { __throw: "model down" }, { __throw: "model down" }],
    });
    const thread = deps.store.createThread("engram", SCOPE);
    deps.store.appendEvent(thread.id, "user_input", "hello");
    const finished = await agentLoop(thread.id, deps);
    expect(finished.events.filter(e => e.type === "error").length).toBe(3);
    const forced = eventAsStep(lastEvent(finished));
    expect(forced?.intent).toBe("request_human_input");
    expect(deriveStatus(finished)).toBe("awaiting_human");
  });

  test("step budget forces a yield with a handoff message (factor 10)", async () => {
    const { deps } = testWorld({
      maxSteps: 2,
      script: [
        step({ intent: "core_append", block: "scratchpad", content: "a" }),
        step({ intent: "core_append", block: "scratchpad", content: "b" }),
        step({ intent: "core_append", block: "scratchpad", content: "never reached" }),
      ],
    });
    const thread = deps.store.createThread("engram", SCOPE);
    deps.store.appendEvent(thread.id, "user_input", "go");
    const finished = await agentLoop(thread.id, deps);
    const last = eventAsStep(lastEvent(finished));
    expect(last?.intent).toBe("done_for_now");
    expect((last as { message: string }).message).toContain("Step budget");
  });

  test("spawn_subagent runs a scoped child thread and returns only a bounded summary", async () => {
    // Script items are consumed in call order: parent selects spawn_subagent,
    // the child selects complete_task, the child's terminal triggers a
    // procedural summarization call, then the parent yields.
    const { deps: world } = testWorld({
      script: [
        step({ intent: "spawn_subagent", agent_id: "curator", task: "Review archival memory for duplicates." }),
        step({ intent: "complete_task", outcome: "success", summary: "No duplicates found." }),
        { summary: "Task: review duplicates. Outcome: none found." },
        step({ intent: "done_for_now", message: "Curator ran." }),
      ],
    });
    const thread = world.store.createThread("engram", SCOPE);
    world.store.appendEvent(thread.id, "user_input", "run the curator");
    const finished = await agentLoop(thread.id, world);

    const response = finished.events.find(e => e.type === "tool_response")!.data as {
      verdict: string;
      summary: string;
      ref: string;
    };
    expect(response.verdict).toBe("success");
    expect(response.summary).toBe("No duplicates found.");
    const child = world.store.getThread(response.ref);
    expect(child.agentId).toBe("curator");
    expect(deriveStatus(child)).toBe("completed");
  });

  test("sleep_until writes a durable schedule; the tick wakes the thread exactly once", async () => {
    const { deps, llm } = testWorld({
      script: [step({ intent: "sleep_until", delay_minutes: 1, reason: "wait for the build" })],
    });
    const thread = deps.store.createThread("engram", SCOPE);
    deps.store.appendEvent(thread.id, "user_input", "check back in a minute");
    const paused = await agentLoop(thread.id, deps);
    expect(deriveStatus(paused)).toBe("sleeping");

    llm.push(step({ intent: "done_for_now", message: "I'm back after the wait." }));
    const future = new Date(Date.now() + 5 * 60_000);
    const fired = await tickScheduler(deps, id => agentLoop(id, deps), future);
    expect(fired).toBe(1);
    const woken = deps.store.getThread(thread.id);
    expect(woken.events.some(e => e.type === "system_note")).toBe(true);
    expect(deriveStatus(woken)).toBe("awaiting_human");

    // CAS: a second tick must not fire the same schedule again.
    expect(await tickScheduler(deps, id => agentLoop(id, deps), future)).toBe(0);
  });
});
