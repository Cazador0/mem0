import { describe, expect, test } from "bun:test";
import { testWorld } from "./harness";
import { outwardText, renderEvent, renderUserMessage } from "../src/agent/render";
import { evaluateGateResults, loadConstitution } from "../src/orchestration/gates";
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
