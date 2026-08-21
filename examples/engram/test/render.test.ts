import { describe, expect, test } from "bun:test";
import { step, testWorld } from "./harness";
import { outwardText, renderEvent, renderUserMessage } from "../src/agent/render";
import { evaluateGateResults, loadConstitution } from "../src/orchestration/gates";
import { agentLoop } from "../src/agent/loop";
import { buildSystemPrompt } from "../src/prompts/nextstep";
import type { ThreadEvent } from "../src/agent/thread";

function event(type: ThreadEvent["type"], data: unknown, seq = 0): ThreadEvent {
  return { id: "e", threadId: "t", seq, type, data, ts: "2026-08-18T00:00:00.000Z" };
}

describe("context rendering (the seam)", () => {
  test("tool_call events render under their intent tag with the intent key stripped", () => {
    const rendered = renderEvent(event("tool_call", { intent: "archival_insert", content: "a fact" }));
    expect(rendered).toBe("<archival_insert>\ncontent: a fact\n</archival_insert>");
  });

  test("plain events render under their type tag", () => {
    expect(renderEvent(event("user_input", "hello"))).toBe("<user_input>\nhello\n</user_input>");
  });

  test("secret-looking keys are redacted", () => {
    const rendered = renderEvent(event("tool_response", { api_key: "sk-secret-12345678", ok: true }));
    expect(rendered).toContain("[redacted]");
    expect(rendered).not.toContain("sk-secret");
  });

  test("resolved errors are hidden; the trailing error run is shown", () => {
    const { deps } = testWorld();
    const thread = deps.store.createThread("engram", { userId: "u" });
    deps.store.appendEvent(thread.id, "error", { message: "transient failure" });
    deps.store.appendEvent(thread.id, "tool_response", { intent: "recall_search", ok: true, results: [] });
    deps.store.appendEvent(thread.id, "error", { message: "current failure" });
    const rendered = renderUserMessage(deps.store.getThread(thread.id), null);
    expect(rendered).not.toContain("transient failure");
    expect(rendered).toContain("current failure");
  });

  test("long threads elide old events behind a marker", () => {
    const { deps } = testWorld();
    const thread = deps.store.createThread("engram", { userId: "u" });
    for (let i = 0; i < 60; i++) deps.store.appendEvent(thread.id, "user_input", `msg ${i}`);
    const rendered = renderUserMessage(deps.store.getThread(thread.id), null);
    expect(rendered).toContain('<elided count="10">');
    expect(rendered).not.toContain("msg 5\n");
    expect(rendered).toContain("msg 59");
  });

  test("outwardText presents the paused state", () => {
    const { deps } = testWorld();
    const thread = deps.store.createThread("engram", { userId: "u" });
    deps.store.appendEvent(thread.id, "tool_call", { intent: "done_for_now", message: "All set." });
    expect(outwardText(deps.store.getThread(thread.id))).toBe("All set.");
  });
});

describe("constitution + gates", () => {
  test("loads version and digest from constitution.md", () => {
    const info = loadConstitution(new URL("../constitution.md", import.meta.url).pathname);
    expect(info.version).toBe("1.0.0");
    expect(info.digest).toMatch(/^[0-9a-f]+$/);
    expect(info.content).toContain("append-only");
  });

  test("unjustified gate failures ERROR; justified ones pass", () => {
    const failed = evaluateGateResults([
      { principle: "Local-first, one artifact", pass: false },
      { principle: "Event log is canonical", pass: true },
    ]);
    expect(failed.ok).toBe(false);
    expect(failed.errors[0]).toContain("Local-first");

    const justified = evaluateGateResults([
      { principle: "Local-first, one artifact", pass: false, justification: "external vector DB required at >100k memories" },
    ]);
    expect(justified.ok).toBe(true);
  });
});

describe("constitution gate wiring (spec-kit justify-or-ERROR)", () => {
  test("the constitution's principles parse into the gate vocabulary", () => {
    const { deps } = testWorld();
    const titles = deps.constitution.principles.map(p => p.title);
    expect(deps.constitution.principles.length).toBe(7);
    expect(deps.constitution.principles[0]!.id).toBe("I");
    expect(titles).toContain("The LLM proposes, code disposes");
  });

  test("an unjustified gate failure is rejected and handed back for revision", async () => {
    const { deps, llm } = testWorld({
      script: [
        step({
          intent: "propose_plan",
          summary: "Bulk-delete stale memories without approval",
          steps: ["scan archival", "delete everything older than a year"],
          gate_results: [{ principle: "The LLM proposes, code disposes", pass: false }],
        }),
        step({
          intent: "propose_plan",
          summary: "Propose deletions, let the human approve each",
          steps: ["scan archival", "propose deletions one at a time"],
          gate_results: [
            { principle: "The LLM proposes, code disposes", pass: true },
            {
              principle: "The event log is canonical and append-only",
              pass: false,
              justification: "compaction is read-side only; the log is untouched",
            },
          ],
        }),
        step({ intent: "done_for_now", message: "plan ready" }),
      ],
    });
    const thread = deps.store.createThread("engram", { userId: "u1", agentId: "engram" });
    deps.store.appendEvent(thread.id, "user_input", "clean up my old memories");
    const finished = await agentLoop(thread.id, deps);

    const responses = finished.events
      .filter(e => e.type === "tool_response")
      .map(e => e.data as { ok: boolean; result: string });
    // First plan: failing gate with no justification -> rejected, in code.
    expect(responses[0]!.ok).toBe(false);
    expect(responses[0]!.result).toContain("without justification");
    // Revised plan: the failure now carries a justification -> accepted.
    expect(responses[1]!.ok).toBe(true);
    expect(responses[1]!.result).toContain("1 justified exception");
    expect(finished.events.filter(e => e.type === "error")).toEqual([]);
    expect(llm.calls.filter(c => c === "next_step_envelope").length).toBe(3);
  });

  test("a gate against an invented principle is rejected", () => {
    const { deps } = testWorld();
    const known = deps.constitution.principles.map(p => p.title);
    const invented = evaluateGateResults([{ principle: "Move fast", pass: true }], known);
    expect(invented.ok).toBe(false);
    expect(invented.errors[0]).toContain("unknown constitution principle");
    // Without the vocabulary the check is skipped (the module stays reusable).
    expect(evaluateGateResults([{ principle: "Move fast", pass: true }]).ok).toBe(true);
  });

  test("the prompt names the principles but never inlines the constitution body", () => {
    const { deps } = testWorld();
    const prompt = buildSystemPrompt({
      agentPersona: "p",
      constitutionVersion: deps.constitution.version,
      constitutionDigest: deps.constitution.digest,
      principles: deps.constitution.principles.map(p => p.title),
      intents: ["propose_plan", "done_for_now"],
      coreBlocks: "",
    });
    expect(prompt).toContain("The LLM proposes, code disposes");
    // Pointer-not-copy (spec §8e): the body text stays out of the prompt.
    expect(prompt.length).toBeLessThan(deps.constitution.content.length);
    expect(prompt).not.toContain("MUST");
  });
});

describe("system prompt (the cached stable prefix)", () => {
  const build = (intents: Parameters<typeof buildSystemPrompt>[0]["intents"]) =>
    buildSystemPrompt({
      agentPersona: "PERSONA-MARKER",
      constitutionVersion: "1.0.0",
      constitutionDigest: "abc123",
      intents,
      coreBlocks: "<core_block label=\"human\">BLOCK-MARKER</core_block>",
    });

  test("sections stay in cache-stable order: identity -> constitution -> persona -> intents -> core", () => {
    const prompt = build(["archival_search", "done_for_now"]);
    const order = [
      prompt.indexOf("You are an Engram agent"),
      prompt.indexOf("Project constitution v1.0.0"),
      prompt.indexOf("PERSONA-MARKER"),
      prompt.indexOf("# Available intents"),
      prompt.indexOf("BLOCK-MARKER"),
    ];
    expect(order.every(i => i >= 0)).toBe(true);
    // Volatile content last: reordering these breaks prompt-cache hit rates.
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(prompt).toContain("digest abc123");
  });

  test("only the agent's own intents are documented (capability = presence)", () => {
    const prompt = build(["archival_search", "done_for_now"]);
    expect(prompt).toContain("`archival_search`");
    expect(prompt).not.toContain("`spawn_subagent`");
    expect(prompt).not.toContain("`memory_delete`");
  });
});
