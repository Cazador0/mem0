import { describe, expect, test } from "bun:test";
import { testWorld, type ScriptedLLM } from "./harness";
import { extractFromThread, MAX_EXTRACTION_ATTEMPTS } from "../src/memory/extraction";
import { buildExtractionUser } from "../src/prompts/extraction";
import { LLMError, type StructuredRequest } from "../src/agent/llm";

const SCOPE = { userId: "u1", agentId: "engram" };

/**
 * Deterministically hold the extraction at its Phase-2 LLM call: returns
 * { reached, release } so a test can act between the Phase-0 snapshot and the
 * pipeline's completion. No timers — awaiting the condition, per CLAUDE.md.
 */
function gateLlm(llm: ScriptedLLM): { reached: Promise<void>; release: () => void } {
  let release!: () => void;
  let markReached!: () => void;
  const gate = new Promise<void>(r => (release = r));
  const reached = new Promise<void>(r => (markReached = r));
  const original = llm.structured.bind(llm);
  llm.structured = async function <T>(req: StructuredRequest<T>): Promise<T> {
    markReached();
    await gate;
    return original(req);
  };
  return { reached, release };
}

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

    // The write is recorded in the thread; the watermark covers ONLY the
    // Phase-0 snapshot (seq 0) — events appended during extraction (including
    // the memory_write itself) stay above it so they are never skipped.
    const reloaded = deps.store.getThread(thread.id);
    expect(reloaded.events.some(e => e.type === "memory_write")).toBe(true);
    expect(reloaded.extractedSeq).toBe(0);
    expect(reloaded.events[reloaded.events.length - 1]!.seq).toBeGreaterThan(reloaded.extractedSeq);
  });

  test("watermark never covers conversational events appended during an in-flight extraction", async () => {
    const { deps, llm } = testWorld({
      script: [
        { memories: [{ text: "User's dog is named Rex.", linked_refs: [] }] },
        { memories: [{ text: "User's cat is named Whiskers.", linked_refs: [] }] },
      ],
    });
    const thread = deps.store.createThread("engram", SCOPE);
    deps.store.appendEvent(thread.id, "user_input", "My dog is named Rex.");

    // Simulate the race: the message that arrives mid-extraction is appended
    // after the pipeline snapshotted the thread (proven by the LLM gate having
    // been reached) but before it finished.
    const { reached, release } = gateLlm(llm);
    const inFlight = extractFromThread(deps, thread.id);
    await reached;
    deps.store.appendEvent(thread.id, "user_input", "Also my cat is named Whiskers.");
    release();
    await inFlight;

    // The cat message is still above the watermark, so the next run extracts it.
    const second = await extractFromThread(deps, thread.id);
    expect(second.added.length).toBe(1);
    expect(second.added[0]!.memory).toContain("Whiskers");
  });

  test("concurrent extractions on one thread serialize: one LLM call, no duplicates", async () => {
    const { deps, llm } = testWorld({
      script: [{ memories: [{ text: "User's dog is named Rex.", linked_refs: [] }] }],
    });
    const thread = deps.store.createThread("engram", SCOPE);
    deps.store.appendEvent(thread.id, "user_input", "My dog is named Rex.");

    // Fired without awaiting, exactly as backgroundExtraction does. The second
    // run queues behind the first on the extraction lock, re-reads the advanced
    // watermark, and returns empty WITHOUT consuming a script item — an
    // unserialized second run would exhaust the one-item script and throw.
    const [first, second] = await Promise.all([
      extractFromThread(deps, thread.id),
      extractFromThread(deps, thread.id),
    ]);
    expect(first.added.length + second.added.length).toBe(1);
    expect(llm.calls).toEqual(["extraction"]);
  });

  test("extraction watermark is monotonic: a stale writer can never move it backwards", () => {
    const { deps } = testWorld();
    const thread = deps.store.createThread("engram", SCOPE);
    deps.store.setExtractedSeq(thread.id, 5);
    deps.store.setExtractedSeq(thread.id, 3); // an older-snapshot extraction finishing last
    expect(deps.store.getThread(thread.id).extractedSeq).toBe(5);
  });

  test("assistant messages are extraction inputs (dated, role-labelled)", async () => {
    const { deps, llm } = testWorld({
      script: [{ memories: [{ text: "The user and Engram agreed to ship on May 9, 2026.", linked_refs: [] }] }],
    });
    const thread = deps.store.createThread("engram", SCOPE);
    deps.store.appendEvent(thread.id, "user_input", "So when do we ship?");
    deps.store.appendEvent(thread.id, "tool_call", {
      intent: "done_for_now",
      message: "We agreed to ship on Friday, May 9, 2026.",
    });

    let captured = "";
    const original = llm.structured.bind(llm);
    llm.structured = async function <T>(req: StructuredRequest<T>): Promise<T> {
      captured = req.user;
      return original(req);
    };
    const { added } = await extractFromThread(deps, thread.id);
    expect(added.length).toBe(1);
    expect(captured).toContain("assistant: We agreed to ship on Friday, May 9, 2026.");
    // Each new message carries its own grounding date (constitution VI).
    expect(captured).toMatch(/\[\d{4}-\d{2}-\d{2}\] user: So when do we ship\?/);
  });

  test("each message is dated from ITS OWN event, not from extraction day", async () => {
    // The whole point of per-message dates is multi-day batches (a slept
    // thread, a backlog). Stamping every message with the extraction day would
    // pass a looser assertion, so pin the exact distinct dates end-to-end.
    const { deps, llm } = testWorld({
      script: [{ memories: [{ text: "User flew to Osaka in August 2026.", linked_refs: [] }] }],
    });
    const thread = deps.store.createThread("engram", SCOPE);
    deps.store.appendEvent(thread.id, "user_input", "I flew to Osaka yesterday.");
    deps.store.appendEvent(thread.id, "user_input", "The jet lag finally cleared today.");

    // Backdate the stored events to different days (tests may read tables).
    deps.db.query("UPDATE events SET ts = ? WHERE thread_id = ? AND seq = 0").run("2026-08-01T09:00:00.000Z", thread.id);
    deps.db.query("UPDATE events SET ts = ? WHERE thread_id = ? AND seq = 1").run("2026-08-04T09:00:00.000Z", thread.id);

    let captured = "";
    const original = llm.structured.bind(llm);
    llm.structured = async function <T>(req: StructuredRequest<T>): Promise<T> {
      captured = req.user;
      return original(req);
    };
    await extractFromThread(deps, thread.id);

    expect(captured).toContain("[2026-08-01] user: I flew to Osaka yesterday.");
    expect(captured).toContain("[2026-08-04] user: The jet lag finally cleared today.");
    // Observation Date is the FIRST new message's date, not today's.
    expect(captured).toContain("## Observation Date (date of the first new message)\n2026-08-01");
  });

  test("extraction prompt grounds each new message on its own date", () => {
    const prompt = buildExtractionUser({
      recentContext: [],
      existingMemories: [],
      newMessages: [
        { role: "user", text: "I flew to Osaka yesterday.", date: "2026-08-01" },
        { role: "user", text: "The jet lag finally cleared today.", date: "2026-08-04" },
      ],
      observationDate: "2026-08-01",
      currentDate: "2026-08-19",
    });
    expect(prompt).toContain("[2026-08-01] user: I flew to Osaka yesterday.");
    expect(prompt).toContain("[2026-08-04] user: The jet lag finally cleared today.");
    expect(prompt).toContain("## Observation Date (date of the first new message)");
  });

  test("a failed insert holds the watermark for a bounded retry, then gives up", async () => {
    const facts = {
      memories: [
        { text: "User's dog is named Rex.", linked_refs: [] },
        { text: "POISON: this memory always fails to store.", linked_refs: [] },
      ],
    };
    const { deps } = testWorld({ script: [facts, facts, facts] });
    const thread = deps.store.createThread("engram", SCOPE);
    deps.store.appendEvent(thread.id, "user_input", "My dog is Rex and here is a poison fact.");

    // One item fails to store; the other succeeds.
    const realInsert = deps.archival.insert.bind(deps.archival);
    deps.archival.insert = async args => {
      if (args.content.startsWith("POISON")) throw new Error("disk full");
      return realInsert(args);
    };

    // Attempt 1: partial failure -> watermark HELD so the lost memory retries.
    const first = await extractFromThread(deps, thread.id);
    expect(first.added.length).toBe(1);
    expect(first.failures).toBe(1);
    expect(deps.store.getThread(thread.id).extractedSeq).toBe(-1); // not advanced
    expect(deps.store.extractFailures(thread.id)).toBe(1);

    // Attempt 2 re-extracts the same window; the good memory dedups by hash.
    const second = await extractFromThread(deps, thread.id);
    expect(second.added.length).toBe(0);
    expect(second.failures).toBe(1);

    // Bounded: after MAX attempts the watermark advances so the thread cannot
    // re-extract this window forever over one permanently-broken item.
    expect(deps.store.getThread(thread.id).extractedSeq).toBeGreaterThanOrEqual(0);
    expect(deps.store.extractFailures(thread.id)).toBe(0);
    expect(MAX_EXTRACTION_ATTEMPTS).toBe(2);
  });

  test("a clean run clears a previous partial-failure counter", async () => {
    const { deps } = testWorld({
      script: [{ memories: [{ text: "User prefers aisle seats on flights.", linked_refs: [] }] }],
    });
    const thread = deps.store.createThread("engram", SCOPE);
    deps.store.appendEvent(thread.id, "user_input", "I prefer aisle seats.");
    deps.store.setExtractFailures(thread.id, 1); // debris from an earlier bad run

    const result = await extractFromThread(deps, thread.id);
    expect(result.failures).toBe(0);
    expect(deps.store.extractFailures(thread.id)).toBe(0);
    expect(deps.store.getThread(thread.id).extractedSeq).toBe(0);
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
