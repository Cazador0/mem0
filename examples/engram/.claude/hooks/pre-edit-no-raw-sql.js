#!/usr/bin/env bun
/**
 * PreToolUse(Write|Edit): no raw writes to `events` or `memories`.
 *
 * Those tables have invariants the facades own — seq allocation and FTS
 * projection for events, hash dedup plus history audit plus entity relink for
 * memories. A raw INSERT/UPDATE/DELETE corrupts derived state silently, so the
 * CLAUDE.md rule gets a machine check rather than trusting prose.
 *
 * Migrations are exempt (DDL defines the tables), and reads are always fine.
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
  process.exit(0);
}

const filePath = String(input?.tool_input?.file_path ?? "");
if (!filePath || !resolve(filePath).startsWith(APP_ROOT)) process.exit(0);
if (filePath.includes("/migrations/")) process.exit(0); // DDL owns the schema

const payload = [input?.tool_input?.content, input?.tool_input?.new_string]
  .filter(v => typeof v === "string")
  .join("\n");
if (!payload) process.exit(0);

// The facades themselves are the legitimate writers.
const isFacade = /src\/memory\/(recall|archival)\.ts$/.test(filePath);
if (isFacade) process.exit(0);

const rawWrite = /\b(INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+(events|memories)\b/i.exec(payload);
if (rawWrite) {
  deny(
    `Refusing: this writes raw SQL (${rawWrite[1].toUpperCase()} ... ${rawWrite[2]}) against the ` +
      `${rawWrite[2]} table from ${filePath.replace(APP_ROOT + "/", "")}.\n` +
      `Events go through RecallStore.appendEvent (seq + FTS projection + immediate transaction); ` +
      `archival mutations go through ArchivalMemory (hash dedup + history audit + entity relink). ` +
      `Bypassing them corrupts derived state (CLAUDE.md, CRITICAL). Tests may READ these tables ` +
      `directly — only writes are blocked.`,
  );
}

process.exit(0);
