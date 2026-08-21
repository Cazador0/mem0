#!/usr/bin/env bun
/**
 * PreToolUse(Bash): keep the test suite hermetic.
 *
 * CLAUDE.md says "never point a test at a real .sqlite file". That rule was
 * prose only, so nothing stopped it being broken. This denies the violating
 * command and re-states the correct one — bun's own hook pattern
 * (.claude/hooks/pre-bash-zig-build.js), with its cwd bug fixed: bun's version
 * hardcodes "/workspace/bun" and silently no-ops anywhere else, so this one
 * derives the app root from the hook's own location instead.
 */
import { dirname, resolve } from "node:path";

const APP_ROOT = resolve(dirname(new URL(import.meta.url).pathname), "..", "..");

function deny(reason) {
  console.log(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: reason,
      },
    }),
  );
  process.exit(0);
}

const raw = await Bun.stdin.text();
let input;
try {
  input = JSON.parse(raw);
} catch {
  process.exit(0); // never block on a malformed hook payload
}

const command = String(input?.tool_input?.command ?? "");
const cwd = String(input?.cwd ?? "");
// Only govern commands aimed at this app.
if (!command.includes("bun test") && !command.includes("bun run test")) process.exit(0);
if (cwd && !resolve(cwd).startsWith(APP_ROOT)) process.exit(0);

// Counter-evasion: split on shell separators FIRST, then strip each segment's
// own redirects. Stripping the whole command from the first `2>&1` onward would
// discard everything chained after it — `bun test | grep x && ENGRAM_DB=/real
// bun test` would sail through. Redirect targets are dropped per segment so a
// file that merely RECEIVES stdout is not mistaken for a database.
const segments = command
  .split(/\s*(?:&&|\|\||;|\|)\s*/)
  .map(seg => seg.replace(/\s*\d?>{1,2}\s*\S+/g, "").replace(/\s*2>&1/g, "").trim())
  .filter(Boolean);

const runsTests = segments.some(seg => /\bbun\s+(run\s+)?test\b/.test(seg));
if (!runsTests) process.exit(0);

// An assignment anywhere in the chain reaches the test run — `export ENGRAM_DB=…;
// bun test` is the same violation as putting it inline.
for (const seg of segments) {
  const assigned = /ENGRAM_DB=("|')?([^\s"']+)/.exec(seg);
  if (assigned && assigned[2] !== ":memory:") {
    deny(
      `Refusing: this sets ENGRAM_DB=${assigned[2]}, pointing the test suite at a real database file.\n` +
        `Tests must stay hermetic (CLAUDE.md, CRITICAL). Run plain \`bun test\` — testWorld() ` +
        `already opens an in-memory DB. If you genuinely need a file-backed DB for a WAL/sidecar ` +
        `assertion, create it inside the test with mkdtempSync(tmpdir()) and rmSync it in a finally.`,
    );
  }
}

// A .sqlite path passed TO the test run (a flag, an argument) is a database the
// suite would read. One in an unrelated segment (`rm stale.sqlite && bun test`)
// is not this hook's business.
for (const seg of segments) {
  if (/\bbun\s+(run\s+)?test\b/.test(seg) && /\.sqlite\b/.test(seg)) {
    deny(
      `Refusing: this test command references a .sqlite path.\n` +
        `Tests must stay hermetic (CLAUDE.md, CRITICAL). Use plain \`bun test\`; per-test temp ` +
        `databases belong inside the test via mkdtempSync(tmpdir()).`,
    );
  }
}

process.exit(0);
