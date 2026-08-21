import { describe, expect, test } from "bun:test";
import { step, testWorld } from "./harness";
import { agentLoop } from "../src/agent/loop";
import { decideCliAction, runCliTurn } from "../src/channels/cli-turn";
import { awaitingApproval, deriveStatus } from "../src/agent/thread";

const SCOPE = { userId: "u1", agentId: "engram" };

/** Drive a thread to a pending gated memory_delete (the approval fixture). */
async function threadAwaitingApproval() {
  const world = testWorld({
    script: [
      step({ intent: "archival_search", query: "stale fact" }),
      step({ intent: "memory_delete", ref: 1, reason: "cleanup" }),
    ],
  });
  const { id } = await world.deps.archival.insert({ content: "Stale fact to clean up.", scope: SCOPE });
  const thread = world.deps.store.createThread("engram", SCOPE);
  world.deps.store.appendEvent(thread.id, "user_input", "clean up the stale fact");
  const paused = await agentLoop(thread.id, world.deps);
  expect(awaitingApproval(paused)).toBe(true);
  return { ...world, threadId: thread.id, memoryId: id };
}

describe("CLI channel: turn dispatch", () => {
  test("a plain line becomes user_input and the loop's reply comes back", async () => {
    const { deps, llm } = testWorld({
      script: [step({ intent: "done_for_now", message: "noted — Poppy it is" })],
    });
    const thread = deps.store.createThread("engram", SCOPE);

    const turn = await runCliTurn(deps, thread.id, "my dog is named Poppy");
    expect(turn).toMatchObject({ handled: true, action: "message", outward: "noted — Poppy it is" });
    expect(turn.error).toBeUndefined();

    const events = deps.store.getThread(thread.id).events;
    expect(events[0]!.type).toBe("user_input");
    expect(events.filter(e => e.type === "error")).toEqual([]);
    expect(llm.calls).toEqual(["next_step_envelope"]);
  });

  test("a line answering a question becomes human_response, not a new user_input", async () => {
    const { deps } = testWorld({
      script: [
        step({ intent: "request_human_input", question: "Which city?" }),
        step({ intent: "done_for_now", message: "Lisbon it is" }),
      ],
    });
    const thread = deps.store.createThread("engram", SCOPE);
    deps.store.appendEvent(thread.id, "user_input", "book my trip");
    await agentLoop(thread.id, deps);

    const turn = await runCliTurn(deps, thread.id, "Lisbon");
    expect(turn.action).toBe("respond");
    const types = deps.store.getThread(thread.id).events.map(e => e.type);
    expect(types.filter(t => t === "user_input").length).toBe(1); // NOT a second user_input
    expect(types).toContain("human_response");
  });

  test("'yes' at a gate replays the recorded step and marks the response via_human", async () => {
    const { deps, llm, threadId, memoryId } = await threadAwaitingApproval();
    llm.push(step({ intent: "done_for_now", message: "cleaned up" }));

    const turn = await runCliTurn(deps, threadId, "yes, go ahead");
    expect(turn).toMatchObject({ handled: true, action: "approve", outward: "cleaned up" });
    expect(deps.archival.getById(memoryId)).toBeNull(); // the gated delete really executed

    const response = deps.store
      .getThread(threadId)
      .events.find(e => e.type === "tool_response" && (e.data as { intent?: string }).intent === "memory_delete");
    // via_human is what resets the step budget for the new turn.
    expect((response!.data as { via_human?: boolean }).via_human).toBe(true);
  });

  test("'no' at a gate records a denial with feedback and leaves the memory alone", async () => {
    const { deps, llm, threadId, memoryId } = await threadAwaitingApproval();
    llm.push(step({ intent: "done_for_now", message: "left it alone" }));

    const turn = await runCliTurn(deps, threadId, "no, keep that one");
    expect(turn.action).toBe("deny");
    expect(deps.archival.getById(memoryId)).not.toBeNull();

    const response = deps.store
      .getThread(threadId)
      .events.findLast(e => e.type === "tool_response")!.data as {
      ok: boolean;
      result: string;
      via_human?: boolean;
    };
    expect(response.ok).toBe(false);
    expect(response.result).toContain("no, keep that one"); // the feedback reaches the model
    expect(response.via_human).toBe(true);
  });

  test("an ambiguous reply at a gate re-prompts: nothing is appended and no LLM call happens", async () => {
    const { deps, llm, threadId, memoryId } = await threadAwaitingApproval();
    const before = deps.store.getThread(threadId).events.length;
    const callsBefore = llm.calls.length;

    const turn = await runCliTurn(deps, threadId, "hmm, what would that delete exactly?");
    expect(turn).toMatchObject({ handled: false, action: "reprompt", status: "awaiting_approval" });
    expect(deps.store.getThread(threadId).events.length).toBe(before); // silence, not a denial
    expect(llm.calls.length).toBe(callsBefore);
    expect(deps.archival.getById(memoryId)).not.toBeNull();
  });

  test("typing to a sleeping thread wakes it early (CLI parity with the HTTP channel)", async () => {
    const { deps, llm } = testWorld({
      script: [step({ intent: "sleep_until", delay_minutes: 60, reason: "hold until fares refresh" })],
    });
    const thread = deps.store.createThread("engram", SCOPE);
    deps.store.appendEvent(thread.id, "user_input", "watch the fares");
    const slept = await agentLoop(thread.id, deps);
    expect(deriveStatus(slept)).toBe("sleeping");

    llm.push(step({ intent: "done_for_now", message: "hold released" }));
    const turn = await runCliTurn(deps, thread.id, "never mind, cancel the hold");
    expect(turn).toMatchObject({ handled: true, outward: "hold released" });
    // done_for_now yields the turn back to the human — the thread is no longer
    // sleeping, which is the point: the early wake superseded the sleep.
    expect(deriveStatus(deps.store.getThread(thread.id))).toBe("awaiting_human");
  });

  test("a failing LLM leaves the turn handled with the error recorded on the thread", async () => {
    const { deps } = testWorld({ script: [{ __throw: "model unavailable" }] });
    const thread = deps.store.createThread("engram", SCOPE);

    const turn = await runCliTurn(deps, thread.id, "hello");
    expect(turn.handled).toBe(true); // the REPL keeps going
    const events = deps.store.getThread(thread.id).events;
    expect(events.some(e => e.type === "error")).toBe(true);
  });
});

describe("CLI channel: decideCliAction is pure", () => {
  test("classification depends on derived status, not on stored flags", async () => {
    const { deps } = testWorld();
    const thread = deps.store.createThread("engram", SCOPE);
    expect(decideCliAction(deps.store.getThread(thread.id), "anything").kind).toBe("message");

    deps.store.appendEvent(thread.id, "tool_call", {
      intent: "request_human_input",
      question: "Which city?",
    });
    expect(decideCliAction(deps.store.getThread(thread.id), "Lisbon").kind).toBe("respond");

    // A malformed gate can't be replayed — the line is swallowed, not recorded
    // as conversation against a pending approval.
    const other = deps.store.createThread("engram", SCOPE);
    deps.store.appendEvent(other.id, "tool_call", { intent: "memory_delete", ref: 1 }); // no reason => unparseable
    expect(decideCliAction(deps.store.getThread(other.id), "yes").kind).toBe("message");
  });
});
