import { z } from "zod";
import { agentLoop } from "../agent/loop";
import { executeStep } from "../agent/execute";
import { extractFromThread } from "../memory/extraction";
import { outwardText } from "../agent/render";
import { withThreadLock } from "../orchestration/lock";
import {
  awaitingApproval,
  awaitingHumanResponse,
  deriveStatus,
  effectiveTail,
  eventAsStep,
  isSleeping,
  stepCount,
  type Thread,
} from "../agent/thread";
import type { EngramDeps } from "../deps";

/**
 * Launch/pause/resume over HTTP (12-factor factor 6). A thread pauses by
 * breaking the loop; ANY channel can resume it by id. Resume payloads are
 * validated against the thread's DERIVED status — a response to a thread that
 * isn't awaiting one is a 400, not a silent append.
 */

const CreateThreadBody = z.object({
  message: z.string().min(1),
  agent_id: z.string().default("engram"),
  // Required: defaulting to "" would silently merge every anonymous caller
  // into one shared memory scope. The CLI supplies $USER for the same reason.
  user_id: z.string().min(1),
});

const ResumeBody = z.discriminatedUnion("type", [
  z.object({ type: z.literal("approval"), approved: z.boolean(), comment: z.string().optional() }),
  z.object({ type: z.literal("response"), response: z.string().min(1) }),
]);

export function createServer(deps: EngramDeps) {
  return Bun.serve({
    port: deps.config.port,
    fetch: async req => {
      try {
        return await route(req, deps);
      } catch (err) {
        const message = (err as Error).message ?? String(err);
        // Routine client mistakes are 4xx, not 500s that page someone.
        if (message.startsWith("thread not found")) {
          return Response.json({ error: message }, { status: 404 });
        }
        console.error(`[engram] request failed:`, err);
        return Response.json({ error: message }, { status: 500 });
      }
    },
  });
}

async function route(req: Request, deps: EngramDeps): Promise<Response> {
  const url = new URL(req.url);
  const parts = url.pathname.split("/").filter(Boolean);

  if (req.method === "GET" && url.pathname === "/health") {
    return Response.json({ ok: true });
  }

  if (url.pathname === "/threads" && req.method === "POST") {
    const body = CreateThreadBody.safeParse(await parseJson(req));
    if (!body.success) return badRequest(body.error.message);
    const { message, agent_id, user_id } = body.data;
    if (!deps.registry.get(agent_id)) return badRequest(`unknown agent "${agent_id}"`);
    const thread = deps.store.createThread(agent_id, { userId: user_id, agentId: agent_id });
    deps.store.appendEvent(thread.id, "user_input", message);
    const finished = await withThreadLock(thread.id, () => agentLoop(thread.id, deps));
    backgroundExtraction(deps, thread.id);
    return Response.json(threadView(finished));
  }

  if (url.pathname === "/threads" && req.method === "GET") {
    return Response.json({ threads: deps.store.listThreads() });
  }

  if (parts[0] === "threads" && parts.length === 2 && req.method === "GET") {
    const thread = deps.store.getThread(parts[1]!);
    return Response.json({ ...threadView(thread), events: thread.events });
  }

  if (parts[0] === "threads" && parts[2] === "response" && parts.length === 3 && req.method === "POST") {
    const body = await parseJson(req);
    return withThreadLock(parts[1]!, () => resumeThread(parts[1]!, body, deps));
  }

  return Response.json({ error: "not found" }, { status: 404 });
}

async function parseJson(req: Request): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    return null; // schema validation turns this into a 400, not a 500
  }
}

async function resumeThread(threadId: string, rawBody: unknown, deps: EngramDeps): Promise<Response> {
  const body = ResumeBody.safeParse(rawBody);
  if (!body.success) return badRequest(body.error.message);
  const thread = deps.store.getThread(threadId);

  // Route on the cross-product of payload type x derived status (12-factor server.ts).
  if (body.data.type === "approval") {
    if (!awaitingApproval(thread)) {
      return badRequest(`thread is ${deriveStatus(thread)}, not awaiting approval`);
    }
    const recorded = eventAsStep(effectiveTail(thread));
    if (!recorded) return badRequest("recorded step is malformed");
    if (body.data.approved) {
      // Replay the recorded, already-persisted tool_call verbatim (constitution IV).
      const result = await executeStep(recorded, thread, deps, {
        runLoop: id => agentLoop(id, deps),
      });
      // via_human marks a human decision: it starts a new turn for the step budget.
      deps.store.appendEvent(thread.id, "tool_response", { ...result, via_human: true });
    } else {
      deps.store.appendEvent(thread.id, "tool_response", {
        intent: recorded.intent,
        ok: false,
        result: `user denied the operation with feedback: "${body.data.comment ?? "no comment"}"`,
        via_human: true,
      });
    }
  } else {
    // A sleeping thread also accepts a response — as an early wake (the CLI
    // already behaves this way). The human_response supersedes the sleep; the
    // scheduler's pending wake is consumed as stale by the sleep_seq guard.
    if (!awaitingHumanResponse(thread) && !isSleeping(thread)) {
      return badRequest(`thread is ${deriveStatus(thread)}, not awaiting a response`);
    }
    deps.store.appendEvent(thread.id, "human_response", { response: body.data.response });
  }

  const finished = await agentLoop(threadId, deps);
  backgroundExtraction(deps, threadId);
  return Response.json(threadView(finished));
}

function threadView(thread: Thread) {
  return {
    thread_id: thread.id,
    agent_id: thread.agentId,
    status: deriveStatus(thread),
    steps: stepCount(thread),
    message: outwardText(thread),
  };
}

function backgroundExtraction(deps: EngramDeps, threadId: string): void {
  void extractFromThread(deps, threadId)
    .then(result => {
      if (result.added.length > 0) {
        console.log(`[engram] extracted ${result.added.length} memories from thread ${threadId}`);
      }
    })
    .catch(err => console.warn(`[engram] extraction failed for ${threadId}: ${(err as Error).message}`));
}

function badRequest(message: string): Response {
  return Response.json({ error: message }, { status: 400 });
}
