import { describe, expect, test } from "bun:test";
import { testWorld } from "./harness";
import { EntityIndex, extractEntities } from "../src/memory/entities";
import { buildScopeKey, stripIdentityKeys } from "../src/memory/recall";

const SCOPE = { userId: "u1", agentId: "engram", runId: "" };

describe("core tier", () => {
  test("seeds default blocks plus a read-only constitution pointer", () => {
    const { deps } = testWorld();
    const labels = deps.core.list("engram").map(b => b.label);
    expect(labels).toEqual(["constitution", "human", "persona", "project", "scratchpad"]);
    expect(deps.core.get("engram", "constitution")?.readOnly).toBe(true);
    expect(deps.core.get("engram", "constitution")?.content).toContain("Constitution v1.0.0");
  });

  test("append and replace respect budgets, exact match, and read-only", () => {
    const { deps } = testWorld();
    expect(deps.core.append("engram", "human", "Name: Hunter").ok).toBe(true);
    expect(deps.core.get("engram", "human")?.content).toBe("Name: Hunter");

    const replaced = deps.core.replace("engram", "human", "Hunter", "Hunter B.");
    expect(replaced.ok).toBe(true);
    expect(deps.core.get("engram", "human")?.content).toBe("Name: Hunter B.");

    expect(deps.core.replace("engram", "human", "does-not-exist", "x").ok).toBe(false);
    expect(deps.core.append("engram", "human", "y".repeat(5000)).message).toContain("budget exceeded");
    expect(deps.core.append("engram", "constitution", "sneaky edit").message).toContain("read-only");

    // Every successful edit bumps the version (CAS audit trail).
    expect(deps.core.get("engram", "human")?.version).toBe(3);
  });

  test("render shows per-block budget pressure", () => {
    const { deps } = testWorld();
    deps.core.append("engram", "scratchpad", "wip");
    expect(deps.core.render("engram")).toContain('<core_block label="scratchpad" chars="3/2000">');
  });
});

describe("archival tier", () => {
  test("insert dedupes by content hash and audits ADD", async () => {
    const { deps } = testWorld();
    const first = await deps.archival.insert({ content: "User's dog is named Poppy.", scope: SCOPE });
    const second = await deps.archival.insert({ content: "  user's dog is  named poppy. ", scope: SCOPE });
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.id).toBe(first.id);
    const history = deps.archival.history(first.id);
    expect(history.map(h => h.action)).toEqual(["ADD"]);
  });

  test("hybrid search ranks the related memory first and can explain", async () => {
    const { deps } = testWorld();
    await deps.archival.insert({ content: "User's dog is named Poppy and loves morning walks.", scope: SCOPE });
    await deps.archival.insert({ content: "User works as a platform engineer at a fintech startup.", scope: SCOPE });

    const hits = await deps.archival.search({ query: "dog named Poppy", scope: SCOPE, explain: true });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.payload.content).toContain("Poppy");
    expect(hits[0]!.scoreDetails).toBeDefined();
    expect(hits[0]!.scoreDetails!.maxPossibleScore).toBeGreaterThanOrEqual(1);
  });

  test("degraded mode (no embedder) still finds memories via FTS", async () => {
    const { deps } = testWorld({ embedder: false });
    await deps.archival.insert({ content: "User's favorite editor is Neovim with a custom config.", scope: SCOPE });
    const hits = await deps.archival.search({ query: "neovim editor", scope: SCOPE });
    expect(hits.length).toBe(1);
    expect(hits[0]!.payload.content).toContain("Neovim");
  });

  test("update rewrites content, rehashes, and audits before/after", async () => {
    const { deps } = testWorld();
    const { id, memory } = await deps.archival.insert({ content: "User lives in Austin.", scope: SCOPE });
    const result = await deps.archival.update(id, "User lives in Denver as of June 2026.");
    expect(result.ok).toBe(true);
    const updated = deps.archival.getById(id);
    expect(updated?.content).toContain("Denver");
    expect(updated?.hash).not.toBe(memory.hash);
    const actions = deps.archival.history(id).map(h => h.action);
    expect(actions).toEqual(["ADD", "UPDATE"]);
  });

  test("delete removes the row but keeps a soft-deleted audit trail", async () => {
    const { deps } = testWorld();
    const { id } = await deps.archival.insert({ content: "Temporary fact to delete.", scope: SCOPE });
    expect(deps.archival.delete(id).ok).toBe(true);
    expect(deps.archival.getById(id)).toBeNull();
    const history = deps.archival.history(id);
    expect(history.map(h => h.action)).toEqual(["ADD", "DELETE"]);
    expect(history[1]!.isDeleted).toBe(true);
  });

  test("scope isolates memories", async () => {
    const { deps } = testWorld();
    await deps.archival.insert({ content: "User speaks fluent Portuguese.", scope: SCOPE });
    const otherScope = await deps.archival.search({ query: "portuguese", scope: { userId: "someone-else" } });
    expect(otherScope).toEqual([]);
  });

  test("expired memories are filtered at read time", async () => {
    const { deps } = testWorld();
    await deps.archival.insert({
      content: "User has a temporary parking permit for lot B.",
      scope: SCOPE,
      expirationDate: "2020-01-01",
    });
    const hidden = await deps.archival.search({ query: "parking permit", scope: SCOPE });
    expect(hidden).toEqual([]);
    const shown = await deps.archival.search({ query: "parking permit", scope: SCOPE, showExpired: true });
    expect(shown.length).toBe(1);
  });
});

describe("entity side-index", () => {
  test("extracts proper nouns, quoted text, and identifiers", () => {
    const names = extractEntities('My dog Poppy runs "morning laps" using the fitness_tracker.app').map(e => e.data);
    expect(names).toContain("Poppy");
    expect(names).toContain("morning laps");
    expect(names).toContain("fitness_tracker.app");
  });

  test("links memories and boosts them for entity queries, with unlink on delete", async () => {
    const { deps } = testWorld();
    const { id } = await deps.archival.insert({ content: "User's dog is named Poppy.", scope: SCOPE });
    const index = new EntityIndex(deps.db);
    const boosts = index.boostsForQuery("Tell me about Poppy", SCOPE);
    expect(boosts[id]).toBeGreaterThan(0);
    deps.archival.delete(id);
    expect(index.boostsForQuery("Tell me about Poppy", SCOPE)[id]).toBeUndefined();
  });
});

describe("recall tier", () => {
  test("events get monotonic seqs and are FTS-searchable", () => {
    const { deps } = testWorld();
    const thread = deps.store.createThread("engram", SCOPE);
    deps.store.appendEvent(thread.id, "user_input", "Let's plan the Lisbon trip for October.");
    deps.store.appendEvent(thread.id, "user_input", "Also remind me about the dentist.");
    const reloaded = deps.store.getThread(thread.id);
    expect(reloaded.events.map(e => e.seq)).toEqual([0, 1]);

    const hits = deps.store.searchEvents(thread.id, "lisbon trip");
    expect(hits.length).toBe(1);
    expect(hits[0]!.event.seq).toBe(0);
  });

  test("recent window truncates long messages and keeps the last n", () => {
    const { deps } = testWorld();
    const thread = deps.store.createThread("engram", SCOPE);
    for (let i = 0; i < 15; i++) deps.store.appendEvent(thread.id, "user_input", `message ${i} ${"x".repeat(400)}`);
    const window = deps.store.recentWindow(deps.store.getThread(thread.id), 10, 100);
    expect(window.length).toBe(10);
    expect(window[0]!.text.length).toBeLessThanOrEqual(101);
    expect(window[9]!.text).toContain("message 14");
  });

  test("scope keys are deterministic and identity keys are stripped from metadata", () => {
    expect(buildScopeKey({ agentId: "a", userId: "u" })).toBe("agent_id=a&run_id=&user_id=u");
    const cleaned = stripIdentityKeys({ user_id: "spoof", color: "green" });
    expect(cleaned).toEqual({ color: "green" });
  });
});
