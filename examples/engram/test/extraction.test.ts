import { describe, expect, test } from "bun:test";
import { testWorld } from "./harness";
import { extractFromThread } from "../src/memory/extraction";
import { LLMError } from "../src/agent/llm";

const SCOPE = { userId: "u1", agentId: "engram" };

describe("archival extraction pipeline (mem0 V3, ADD-only)", () => {
  test("extracts memories from new conversational events with provenance", async () => {
    const { deps } = testWorld({
      script: [
        {
          memories: [
            { text: "User's name is Hunter and their dog Poppy joins their morning walks.", linked_refs: [] },
          ],
        },
      ],
    });
    const thread = deps.store.createThread("engram", SCOPE);
    deps.store.appendEvent(thread.id, "user_input", "I'm Hunter — my dog Poppy walks with me every morning.");

    const { added } = await extractFromThread(deps, thread.id);
    expect(added.length).toBe(1);

    const stored = deps.archival.getById(added[0]!.id)!;
    expect(stored.sourceThreadId).toBe(thread.id);
    expect(stored.sourceEventSeqs).toEqual([0]);

    // The write is recorded in the thread and the watermark advanced past it.
    const reloaded = deps.store.getThread(thread.id);
    expect(reloaded.events.some(e => e.type === "memory_write")).toBe(true);
    expect(reloaded.extractedSeq).toBe(reloaded.events[reloaded.events.length - 1]!.seq);
  });

  test("no new messages -> early return without an LLM call", async () => {
    const { deps, llm } = testWorld({
      script: [{ memories: [{ text: "User enjoys trail running in the Rockies.", linked_refs: [] }] }],
    });
    const thread = deps.store.createThread("engram", SCOPE);
    deps.store.appendEvent(thread.id, "user_input", "I love trail running in the Rockies.");
    await extractFromThread(deps, thread.id);

    // Second pass: nothing new — the (now empty) script must not be consulted.
    const { added } = await extractFromThread(deps, thread.id);
    expect(added).toEqual([]);
    expect(llm.calls.length).toBe(1);
  });

  test("hash dedup: re-extracting the same fact adds nothing", async () => {
    const sameMemory = { memories: [{ text: "User prefers window seats on flights.", linked_refs: [] }] };
    const { deps } = testWorld({ script: [sameMemory, sameMemory] });
    const thread = deps.store.createThread("engram", SCOPE);
    deps.store.appendEvent(thread.id, "user_input", "I always book window seats.");
    expect((await extractFromThread(deps, thread.id)).added.length).toBe(1);

    deps.store.appendEvent(thread.id, "user_input", "Did I mention I always book window seats?");
    expect((await extractFromThread(deps, thread.id)).added.length).toBe(0);
  });

  test("unknown linked refs from the LLM are dropped, valid ones persist as links", async () => {
    const { deps } = testWorld({
      script: [
        { memories: [{ text: "User's dog is named Poppy.", linked_refs: [] }] },
        { memories: [{ text: "Poppy the dog turned three in July 2026.", linked_refs: [1, 99] }] },
      ],
    });
    const thread = deps.store.createThread("engram", SCOPE);
    deps.store.appendEvent(thread.id, "user_input", "My dog is named Poppy.");
    const first = await extractFromThread(deps, thread.id);

    deps.store.appendEvent(thread.id, "user_input", "My dog Poppy is a good dog — Poppy turned three in July!");
    const second = await extractFromThread(deps, thread.id);

    const linked = deps.archival.getById(second.added[0]!.id)!;
    const links = JSON.parse(linked.metadata.links ?? "[]") as string[];
    expect(links).toEqual([first.added[0]!.id]); // ref 1 resolved, ref 99 dropped
  });

  test("only the LLM phase throws (typed), so callers can tell outage from no-facts", async () => {
    const { deps } = testWorld({ script: [{ __throw: "extraction model unavailable" }] });
    const thread = deps.store.createThread("engram", SCOPE);
    deps.store.appendEvent(thread.id, "user_input", "remember this");
    expect(extractFromThread(deps, thread.id)).rejects.toBeInstanceOf(LLMError);
  });
});
