import { describe, expect, test } from "bun:test";

/**
 * The enforcement hooks turn two CLAUDE.md CRITICAL rules from prose into
 * machine checks. They are only worth having if they actually decide correctly,
 * and a hook that over-denies is worse than none — so both directions are
 * pinned here: the violation is refused, and the legitimate neighbours are not.
 */
const APP_ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");

interface Decision {
  denied: boolean;
  reason: string;
}

async function runHook(hook: string, input: Record<string, unknown>): Promise<Decision> {
  await using proc = Bun.spawn({
    cmd: ["bun", `${APP_ROOT}/.claude/hooks/${hook}`],
    cwd: APP_ROOT,
    stdin: new TextEncoder().encode(JSON.stringify(input)),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  expect(code).toBe(0); // a hook must never fail the tool call by crashing
  if (!out.trim()) return { denied: false, reason: "" };
  const parsed = JSON.parse(out) as {
    hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string };
  };
  return {
    denied: parsed.hookSpecificOutput?.permissionDecision === "deny",
    reason: parsed.hookSpecificOutput?.permissionDecisionReason ?? "",
  };
}

const bash = (command: string, cwd = APP_ROOT) =>
  runHook("pre-bash-hermetic-tests.js", { tool_input: { command }, cwd });

const edit = (file_path: string, content: string) =>
  runHook("pre-edit-no-raw-sql.js", { tool_input: { file_path, content } });

describe("hook: tests stay hermetic", () => {
  test("refuses a test run pointed at a real database file", async () => {
    const d = await bash("ENGRAM_DB=/home/user/engram.sqlite bun test");
    expect(d.denied).toBe(true);
    expect(d.reason).toContain("hermetic");
    expect(d.reason).toContain("mkdtempSync"); // re-teaches the correct move
  });

  test("redirects and pipes cannot smuggle a real database past the check", async () => {
    // The evasion bun's own hook had to defend against: appending a pipe so the
    // offending assignment is no longer at the end of the command.
    expect((await bash("ENGRAM_DB=/tmp/real.sqlite bun test 2>&1 | tail -3")).denied).toBe(true);
    expect((await bash("bun test 2>&1 | grep -c fail && ENGRAM_DB=/tmp/r.sqlite bun test")).denied).toBe(true);
    // A flag pointing the run at a database is caught wherever it appears.
    expect((await bash("bun test --db ./engram.sqlite")).denied).toBe(true);
    // But a redirect TARGET that merely ends in .sqlite is not a database the
    // suite reads — stripping redirects before matching is what makes the
    // evasion above fail, and it correctly makes this allowed.
    expect((await bash("bun test ./test/foo.test.ts > /tmp/out.sqlite")).denied).toBe(false);
  });

  test("allows the correct forms", async () => {
    expect((await bash("bun test")).denied).toBe(false);
    expect((await bash("ENGRAM_DB=:memory: bun test")).denied).toBe(false);
    expect((await bash("bun test test/memory.test.ts -t 'archival'")).denied).toBe(false);
  });

  test("stays out of the way of unrelated commands and other projects", async () => {
    expect((await bash("git status --porcelain")).denied).toBe(false);
    expect((await bash("rm -rf /home/user/other/engram.sqlite")).denied).toBe(false);
    // Same offending command, but a cwd this app does not govern.
    expect((await bash("ENGRAM_DB=/x/y.sqlite bun test", "/home/user/bun")).denied).toBe(false);
  });
});

describe("hook: no raw writes to events or memories", () => {
  test("refuses raw INSERT/UPDATE/DELETE against the guarded tables", async () => {
    const insert = await edit(`${APP_ROOT}/test/scratch.test.ts`, `db.run("INSERT INTO events (id) VALUES (?)")`);
    expect(insert.denied).toBe(true);
    expect(insert.reason).toContain("RecallStore.appendEvent");

    expect((await edit(`${APP_ROOT}/src/agent/loop.ts`, `db.run("DELETE FROM memories WHERE id = ?")`)).denied).toBe(true);
    expect((await edit(`${APP_ROOT}/test/x.test.ts`, `db.run("update  memories set content = ?")`)).denied).toBe(true);
  });

  test("reads are always allowed", async () => {
    expect((await edit(`${APP_ROOT}/test/x.test.ts`, `db.query("SELECT * FROM events").all()`)).denied).toBe(false);
    expect(
      (await edit(`${APP_ROOT}/test/x.test.ts`, `db.query("SELECT COUNT(*) FROM memories").get()`)).denied,
    ).toBe(false);
  });

  test("migrations and the facades themselves are exempt", async () => {
    // DDL defines the tables; the facades ARE the legitimate writers.
    expect(
      (await edit(`${APP_ROOT}/src/db/migrations/005_x.sql`, `INSERT INTO events SELECT * FROM old_events;`)).denied,
    ).toBe(false);
    expect(
      (await edit(`${APP_ROOT}/src/memory/recall.ts`, `this.db.query("INSERT INTO events (id) VALUES (?)")`)).denied,
    ).toBe(false);
    expect(
      (await edit(`${APP_ROOT}/src/memory/archival.ts`, `this.db.query("UPDATE memories SET content = ?")`)).denied,
    ).toBe(false);
  });

  test("other repositories are none of its business", async () => {
    expect((await edit("/home/user/bun/test/x.test.ts", `INSERT INTO events VALUES (1)`)).denied).toBe(false);
  });
});
