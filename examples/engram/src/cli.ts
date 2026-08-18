import { loadConfig } from "./config";
import { bootstrap } from "./bootstrap";
import { agentLoop } from "./agent/loop";
import { executeStep } from "./agent/execute";
import { extractFromThread } from "./memory/extraction";
import { startScheduler } from "./orchestration/scheduler";
import { outwardText } from "./agent/render";
import {
  awaitingApproval,
  awaitingHumanResponse,
  deriveStatus,
  eventAsStep,
  lastEvent,
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

for await (const line of console) {
  const input = line.trim();
  if (!input) {
    process.stdout.write("> ");
    continue;
  }

  const current = deps.store.getThread(thread.id);
  if (awaitingApproval(current)) {
    const recorded = eventAsStep(lastEvent(current));
    const approved = /^y(es)?$/i.test(input);
    if (recorded && approved) {
      const result = await executeStep(recorded, current, deps, { runLoop: id => agentLoop(id, deps) });
      deps.store.appendEvent(thread.id, "tool_response", result);
    } else if (recorded) {
      deps.store.appendEvent(thread.id, "tool_response", {
        intent: recorded.intent,
        ok: false,
        result: `user denied the operation with feedback: "${input}"`,
      });
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

  void extractFromThread(deps, thread.id)
    .then(result => {
      if (result.added.length > 0) console.log(`[memory] archived ${result.added.length} new memories`);
    })
    .catch(() => {});

  process.stdout.write("> ");
}
