/**
 * Operator surface for the offline reconciliation job.
 *
 *   bun run reconcile --user hunter                    # plan only (default)
 *   bun run reconcile --user hunter --apply            # apply, unless the
 *                                                      # delete count is gated
 *   bun run reconcile --user hunter --apply --approve-deletes
 *
 * Planning is the default on purpose: this is the only path in Engram where a
 * model decides to delete stored memories, so the operator reads the plan
 * first. Needs ANTHROPIC_API_KEY and writes to the real ENGRAM_DB.
 */
import { bootstrap } from "../src/bootstrap";
import { closeDb } from "../src/db/database";
import { DELETE_APPROVAL_THRESHOLD, reconcile } from "../src/memory/reconcile";

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function value(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

const userId = value("user");
if (!userId) {
  console.error("usage: bun run reconcile --user <user_id> [--agent <id>] [--run <id>] [--limit N] [--apply] [--approve-deletes]");
  process.exit(2);
}

const deps = bootstrap();
try {
  const outcome = await reconcile(deps, {
    // Only the keys actually supplied restrict the read (mem0 subset
    // semantics) — the default pass is every memory of this user.
    scope: { userId, ...(value("agent") ? { agentId: value("agent") } : {}), ...(value("run") ? { runId: value("run") } : {}) },
    apply: flag("apply"),
    approveDeletes: flag("approve-deletes"),
    limit: value("limit") ? Number(value("limit")) : undefined,
  });

  console.log(`status: ${outcome.status}`);
  console.log(`clusters: ${outcome.clusters}  (${outcome.failedClusters} skipped after an LLM failure)`);
  if (outcome.skippedNoVector > 0) {
    console.log(`unclusterable: ${outcome.skippedNoVector} memories have no stored vector`);
  }
  for (const decision of outcome.decisions) {
    if (decision.action === "NONE") continue;
    console.log(`\n${decision.action}${decision.reason ? `  — ${decision.reason}` : ""}`);
    console.log(`  before: ${decision.before}`);
    if (decision.after) console.log(`  after:  ${decision.after}`);
  }
  const kept = outcome.decisions.filter(d => d.action === "NONE").length;
  console.log(`\nkept ${kept}, updated ${outcome.updated}, deleted ${outcome.deleted}, failed ${outcome.failed}`);

  if (outcome.status === "planned") {
    console.log("\n(plan only — re-run with --apply to write it)");
  }
  if (outcome.status === "awaiting_approval") {
    console.log(
      `\nNOTHING was applied: this pass wants to delete more than ${DELETE_APPROVAL_THRESHOLD} memories. ` +
        `Read the DELETEs above, then re-run with --apply --approve-deletes if they are right.`,
    );
    process.exit(1);
  }
} finally {
  closeDb(deps.db);
}
