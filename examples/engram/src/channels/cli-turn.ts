import { agentLoop } from "../agent/loop";
import { executeStep } from "../agent/execute";
import { outwardText } from "../agent/render";
import { classifyApprovalReply } from "../agent/approval";
import { withThreadLock } from "../orchestration/lock";
import {
  awaitingApproval,
  awaitingHumanResponse,
  deriveStatus,
  effectiveTail,
  eventAsStep,
  type Thread,
  type ThreadStatus,
} from "../agent/thread";
import type { NextStep } from "../agent/intents";
import type { EngramDeps } from "../deps";

/**
 * The CLI channel's testable core. `src/cli.ts` is an I/O shell — it reads
 * lines and prints — while every decision about what a line MEANS lives here,
 * so the channel's behavior can be tested without a terminal.
 *
 * The HTTP channel gets its action from a typed payload (`{type: "approval"}`);
 * the CLI has to infer it from free text plus the thread's derived status. That
 * inference is the only thing that differs between the two channels.
 */

export type CliAction =
  | { kind: "approve"; step: NextStep }
  | { kind: "deny"; step: NextStep }
  | { kind: "reprompt" }
  | { kind: "noop" }
  | { kind: "respond" }
  | { kind: "message" };

/** Pure: what does this input mean, given what the thread is waiting for? */
export function decideCliAction(thread: Thread, input: string): CliAction {
  if (awaitingApproval(thread)) {
    const step = eventAsStep(effectiveTail(thread));
    // Unreachable in practice — awaitingApproval() only returns true because it
    // already parsed this same event — but the type is Optional, and silently
    // swallowing beats recording a reply against an unparseable gate.
    if (!step) return { kind: "noop" };
    const reply = classifyApprovalReply(input);
    if (reply === "approve") return { kind: "approve", step };
    if (reply === "deny") return { kind: "deny", step };
    return { kind: "reprompt" };
  }
  if (awaitingHumanResponse(thread)) return { kind: "respond" };
  return { kind: "message" };
}

export interface CliTurnResult {
  /** false = the line was not consumed (re-prompt; do not run extraction). */
  handled: boolean;
  action: CliAction["kind"];
  /** Human-facing text from the loop, or null when it produced none. */
  outward: string | null;
  status: ThreadStatus;
  /** Set when the loop itself threw; the turn is still "handled". */
  error?: string;
}

/**
 * Apply one line of human input to a thread and run the loop.
 *
 * The whole read-decide-append-run sequence holds the thread lock, so a
 * scheduler wake firing mid-typing can never interleave a second loop into
 * this log. Approvals and denials are marked `via_human` — they start a new
 * turn for the step budget (see src/agent/CLAUDE.md).
 */
export async function runCliTurn(
  deps: EngramDeps,
  threadId: string,
  input: string,
): Promise<CliTurnResult> {
  return withThreadLock(threadId, async () => {
    const current = deps.store.getThread(threadId);
    const action = decideCliAction(current, input);

    switch (action.kind) {
      case "reprompt":
        return { handled: false, action: action.kind, outward: null, status: deriveStatus(current) };
      case "noop":
        return { handled: true, action: action.kind, outward: null, status: deriveStatus(current) };
      case "approve": {
        // Replay the recorded, already-persisted tool_call verbatim (constitution IV).
        const result = await executeStep(action.step, current, deps, {
          runLoop: id => agentLoop(id, deps),
        });
        deps.store.appendEvent(threadId, "tool_response", { ...result, via_human: true });
        break;
      }
      case "deny":
        deps.store.appendEvent(threadId, "tool_response", {
          intent: action.step.intent,
          ok: false,
          result: `user denied the operation with feedback: "${input}"`,
          via_human: true,
        });
        break;
      case "respond":
        deps.store.appendEvent(threadId, "human_response", { response: input });
        break;
      case "message":
        deps.store.appendEvent(threadId, "user_input", input);
        break;
    }

    try {
      const finished = await agentLoop(threadId, deps);
      return {
        handled: true,
        action: action.kind,
        outward: outwardText(finished),
        status: deriveStatus(finished),
      };
    } catch (err) {
      return {
        handled: true,
        action: action.kind,
        outward: null,
        status: deriveStatus(deps.store.getThread(threadId)),
        error: (err as Error).message,
      };
    }
  });
}
