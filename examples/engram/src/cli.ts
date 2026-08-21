import { loadConfig } from "./config";
import { bootstrap } from "./bootstrap";
import { closeDb } from "./db/database";
import { agentLoop } from "./agent/loop";
import { extractFromThread } from "./memory/extraction";
import { startScheduler } from "./orchestration/scheduler";
import { runCliTurn } from "./channels/cli-turn";

/**
 * Local chat REPL — the CLI channel adapter. The same thread machinery the
 * HTTP server uses; the channel only decides how pauses are presented. All
 * decision logic lives in channels/cli-turn.ts so it is testable without a
 * terminal; this file is I/O only.
 */
const config = loadConfig();
const deps = bootstrap(config);
startScheduler(deps, id => agentLoop(id, deps));

// Scope is the whole point of the memory tiers, so never pick it silently:
// with neither variable set (containers, CI, some systemd units) every session
// would share one "local" scope — the same anonymous-merging problem the HTTP
// channel rejects outright by requiring user_id.
const configuredUser = process.env.ENGRAM_USER ?? process.env.USER ?? "";
if (!configuredUser) {
  console.warn(
    "[engram] neither ENGRAM_USER nor USER is set — this session reads and writes the " +
      'shared "local" memory scope. Set ENGRAM_USER to keep your memories separate.',
  );
}
const userId = configuredUser || "local";
const thread = deps.store.createThread("engram", { userId, agentId: "engram" });

// Ctrl+C is the normal way out of a REPL, so it is the normal shutdown path:
// checkpoint the WAL rather than leaving sidecars behind.
process.on("SIGINT", () => {
  console.log("\n[engram] closing the database");
  closeDb(deps.db);
  process.exit(0);
});

console.log(`engram chat — thread ${thread.id} (model ${config.model}). Type a message; Ctrl+C to exit.\n`);
process.stdout.write("> ");

for await (const line of console) {
  const input = line.trim();
  if (!input) {
    process.stdout.write("> ");
    continue;
  }

  const turn = await runCliTurn(deps, thread.id, input);

  if (turn.action === "reprompt") {
    // Neither clearly yes nor no while a gated step is pending: re-prompt
    // instead of silently treating "Yes please" typos as a denial.
    console.log("\n(a gated action is awaiting approval — please answer yes or no)\n");
  } else if (turn.error) {
    console.error(`\n[engram] loop failed: ${turn.error}\n`);
  } else if (turn.action !== "noop") {
    if (turn.outward) console.log(`\nengram: ${turn.outward}\n`);
    else console.log(`\n(status: ${turn.status})\n`);
  }

  if (turn.handled) {
    void extractFromThread(deps, thread.id)
      .then(result => {
        if (result.added.length > 0) console.log(`[memory] archived ${result.added.length} new memories`);
      })
      .catch(() => {});
  }

  process.stdout.write("> ");
}
