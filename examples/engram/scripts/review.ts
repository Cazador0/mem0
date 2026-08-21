/**
 * Compile a capsule from a thread and fan out independent reviewers.
 *
 *   bun run review --thread <thread_id> --task "the proposal to review"
 *   bun run review --thread <id> --task "..." --reviewers reviewer-risk,reviewer-scope
 *
 * Each reviewer runs on its own thread with its own slice of the capsule and
 * returns one bounded verdict; the full reasoning stays in the child thread,
 * whose id is printed so you can read it with `curl :7749/threads/<ref>`.
 * Needs ANTHROPIC_API_KEY and reads/writes the real ENGRAM_DB.
 */
import { bootstrap } from "../src/bootstrap";
import { closeDb } from "../src/db/database";
import { agentLoop } from "../src/agent/loop";
import { compileCapsule, reviewFanOut } from "../src/orchestration/capsule";

function value(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

const threadId = value("thread");
const task = value("task");
if (!threadId || !task) {
  console.error('usage: bun run review --thread <thread_id> --task "<proposal>" [--reviewers a,b] [--title "..."]');
  process.exit(2);
}

const deps = bootstrap();
try {
  const reviewers = (value("reviewers") ?? "reviewer-evidence,reviewer-risk,reviewer-scope")
    .split(",")
    .map(id => id.trim())
    .filter(Boolean);

  const capsule = await compileCapsule(deps, {
    threadId,
    title: value("title") ?? task.slice(0, 80),
    task,
    reviewers,
  });
  console.log(`capsule ${capsule.id} — ${reviewers.length} reviewers\n`);

  for (const verdict of await reviewFanOut(deps, { capsule, runLoop: id => agentLoop(id, deps) })) {
    console.log(`${verdict.agentId}: ${verdict.verdict}`);
    console.log(`  ${verdict.summary}`);
    if (verdict.ref) console.log(`  full reasoning: thread ${verdict.ref}`);
    console.log();
  }
  console.log("Reviewers inform; they do not decide. Nothing was applied.");
} finally {
  closeDb(deps.db);
}
