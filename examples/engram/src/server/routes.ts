import { z } from "zod";
import { agentLoop } from "../agent/loop";
import { executeStep } from "../agent/execute";
import { extractFromThread } from "../memory/extraction";
import { outwardText } from "../agent/render";
import {
  awaitingApproval,
  awaitingHumanResponse,
  deriveStatus,
  effectiveTail,
  eventAsStep,
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
  user_id: z.string().default(""),
});

const ResumeBody = z.discriminatedUnion("type", [
  z.object({ type: z.literal("approval"), approved: z.boolean(), comment: z.string().optional() }),
  z.object({ type: z.literal("response"), response: z.string().min(1) }),
]);

/**
 * Per-thread serialization: Bun.serve handles requests concurrently, and the
 * approval branch awaits between the derived-status check and the event append
 * — without a lock, two simultaneous approvals would both pass the check,
 * execute the recorded step twice, and interleave two loops into one log.
 */
const threadLocks = new Map<string, Promise<void>>();

async function withThreadLock<T>(threadId: string, fn: () => Promise<T>): Promise<T> {
  const previous = threadLocks.get(threadId) ?? Promise.resolve();
  const run = previous.then(fn, fn);
  const chain = run.then(
    () => undefined,
    () => undefined,
  );
  threadLocks.set(threadId, chain);
  void chain.then(() => {
    // Drop the entry once the chain we stored has fully settled — a newer
    // chain replaces it first if more work queued behind us.
    if (threadLocks.get(threadId) === chain) threadLocks.delete(threadId);
  });
  return run;
}

export function createServer(deps: EngramDeps) {
  return Bun.serve({
    port: deps.config.port,
    fetch: async req => {
      try {
        return await route(req, deps);
      } catch (err) {
        console.error(`[engram] request failed:`, err);
        return Response.json({ error: (err as Error).message }, { status: 500 });
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
    const body = CreateThreadBody.safeParse(await req.json());
    if (!body.success) return badRequest(body.error.message);
    const { message, agent_id, user_id } = body.data;
    if (!deps.registry.get(agent_id)) return badRequest(`unknown agent "${agent_id}"`);
    const thread = deps.store.createThread(agent_id, { userId: user_id, agentId: agent_id });
    deps.store.appendEvent(thread.id, "user_input", message);
    const finished = await agentLoop(thread.id, deps);
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
    const body = await req.json();
    return withThreadLock(parts[1]!, () => resumeThread(parts[1]!, body, deps));
  }

  return Response.json({ error: "not found" }, { status: 404 });
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
      deps.store.appendEvent(thread.id, "tool_response", result);
    } else {
      deps.store.appendEvent(thread.id, "tool_response", {
        intent: recorded.intent,
        ok: false,
        result: `user denied the operation with feedback: "${body.data.comment ?? "no comment"}"`,
      });
    }
  } else {
    if (!awaitingHumanResponse(thread)) {
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
