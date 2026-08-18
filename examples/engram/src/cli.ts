import { loadConfig } from "./config";
import { bootstrap } from "./bootstrap";
import { agentLoop } from "./agent/loop";
import { executeStep } from "./agent/execute";
import { extractFromThread } from "./memory/extraction";
import { startScheduler } from "./orchestration/scheduler";
import { withThreadLock } from "./orchestration/lock";
import { outwardText } from "./agent/render";
import {
  awaitingApproval,
  awaitingHumanResponse,
  deriveStatus,
  effectiveTail,
  eventAsStep,
} from "./agent/thread";

/**
 * Local chat REPL — the CLI channel adapter. The same thread machinery the
 * HTTP server uses; the channel only decides how pauses are presented.
 */
const config = loadConfig();
const deps = bootstrap(config);
startScheduler(deps, id => agentLoop(id, deps));

const userId = process.env.USER ?? "local";
const thread = deps.store.createThread("engram", { userId, agentId: "engram" });

console.log(`engram chat — thread ${thread.id} (model ${config.model}). Type a message; Ctrl+C to exit.\n`);
process.stdout.write("> ");

const APPROVE = /^(y|yes|yep|yeah|approve|approved|ok|okay|sure|go ahead)\b/i;
const DENY = /^(n|no|nope|deny|denied|reject|rejected|stop|cancel)\b/i;

for await (const line of console) {
  const input = line.trim();
  if (!input) {
    process.stdout.write("> ");
    continue;
  }

  // The whole read-append-run sequence holds the thread lock so a scheduler
  // wake firing mid-typing can never interleave a second loop into this log.
  const handled = await withThreadLock(thread.id, async () => {
    const current = deps.store.getThread(thread.id);
    if (awaitingApproval(current)) {
      const recorded = eventAsStep(effectiveTail(current));
      if (!recorded) return true;
      if (APPROVE.test(input)) {
        const result = await executeStep(recorded, current, deps, { runLoop: id => agentLoop(id, deps) });
        deps.store.appendEvent(thread.id, "tool_response", { ...result, via_human: true });
      } else if (DENY.test(input)) {
        deps.store.appendEvent(thread.id, "tool_response", {
          intent: recorded.intent,
          ok: false,
          result: `user denied the operation with feedback: "${input}"`,
          via_human: true,
        });
      } else {
        // Neither clearly yes nor no while a gated step is pending: re-prompt
        // instead of silently treating "Yes please" typos as a denial.
        console.log("\n(a gated action is awaiting approval — please answer yes or no)\n");
        return false;
      }
    } else if (awaitingHumanResponse(current)) {
      deps.store.appendEvent(thread.id, "human_response", { response: input });
    } else {
      deps.store.appendEvent(thread.id, "user_input", input);
    }

    try {
      const finished = await agentLoop(thread.id, deps);
      const message = outwardText(finished);
      if (message) console.log(`\nengram: ${message}\n`);
      else console.log(`\n(status: ${deriveStatus(finished)})\n`);
    } catch (err) {
      console.error(`\n[engram] loop failed: ${(err as Error).message}\n`);
    }
    return true;
  });
  if (!handled) {
    process.stdout.write("> ");
    continue;
  }

  void extractFromThread(deps, thread.id)
    .then(result => {
      if (result.added.length > 0) console.log(`[memory] archived ${result.added.length} new memories`);
    })
    .catch(() => {});

  process.stdout.write("> ");
}
