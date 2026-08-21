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
import type { Server } from "bun";
/** Bun types Server as generic over its WebSocket data; this app opens none. */
type EngramServer = Server<undefined>;
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
    fetch: async (req, server) => {
      try {
        const denied = authorize(req, deps);
        if (denied) return denied;
        return await route(req, deps, server);
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

/**
 * Opt-in bearer auth. Unset token = open, which is the local-first default and
 * the documented threat model; when a token IS set, everything except the
 * health probe requires it. Comparison is length-safe and constant-time-ish:
 * a mismatch never short-circuits on the first differing byte.
 */
function authorize(req: Request, deps: EngramDeps): Response | null {
  const expected = deps.config.apiToken;
  if (!expected) return null;
  if (new URL(req.url).pathname === "/health") return null;

  // RFC 7235: the auth scheme is case-insensitive, so accept "bearer" too
  // rather than 401-ing a correct token over capitalization.
  const header = req.headers.get("authorization") ?? "";
  const presented = /^bearer /i.test(header) ? header.slice(7) : "";
  if (!secretsEqual(presented, expected)) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  return null;
}

function secretsEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function route(req: Request, deps: EngramDeps, server?: EngramServer): Promise<Response> {
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

    // Same turn, two presentations. A turn can run for many LLM steps, so a
    // client that wants to show progress asks for the stream; everyone else
    // gets the single JSON view they always got.
    if (wantsStream(req, url)) {
      return streamTurn(req, deps, thread.id, () => deps.store.appendEvent(thread.id, "user_input", message), server);
    }
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

function wantsStream(req: Request, url: URL): boolean {
  return url.searchParams.get("stream") === "1" || (req.headers.get("accept") ?? "").includes("text/event-stream");
}

function sse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/**
 * Stream one turn as Server-Sent Events.
 *
 * Bun streams an async generator Response body, yielding each chunk as it is
 * produced. Two details matter: `server.timeout(req, 0)` disables the default
 * 10s idle timeout (a turn with several LLM calls easily exceeds it), and the
 * generator's `finally` runs when the client disconnects, so the subscription
 * is released even if nobody ever reads the end of the stream.
 *
 * Events are pushed from RecallStore's post-commit subscription, so the client
 * only ever sees events that are durably in the log.
 */
function streamTurn(
  req: Request,
  deps: EngramDeps,
  threadId: string,
  seed: () => void,
  server?: EngramServer,
): Response {
  server?.timeout(req, 0);

  const queue: string[] = [];
  let wake: (() => void) | null = null;
  const push = (chunk: string) => {
    queue.push(chunk);
    wake?.();
    wake = null;
  };
  const unsubscribe = deps.store.subscribe(threadId, event =>
    push(sse("event", { seq: event.seq, type: event.type, data: event.data, ts: event.ts })),
  );

  let done = false;
  let failure: string | null = null;
  // Start the turn but do not await it here: the generator below streams what
  // the subscription reports while it runs.
  const turn = (async () => {
    seed();
    return withThreadLock(threadId, () => agentLoop(threadId, deps));
  })()
    .catch(err => {
      failure = (err as Error).message;
      return null;
    })
    .finally(() => {
      done = true;
      wake?.();
      wake = null;
    });

  async function* body(): AsyncGenerator<string> {
    try {
      yield sse("thread", { thread_id: threadId });
      while (!done || queue.length > 0) {
        while (queue.length > 0) yield queue.shift()!;
        if (done) break;
        await new Promise<void>(resolve => (wake = resolve));
      }
      const finished = await turn;
      if (failure) {
        yield sse("error", { error: failure });
        return;
      }
      if (finished) {
        backgroundExtraction(deps, threadId);
        yield sse("done", threadView(finished));
      }
    } finally {
      // Client disconnect lands here too — never leave the store holding a
      // subscription for a reader that has gone away.
      unsubscribe();
    }
  }

  return new Response(body() as unknown as ReadableStream, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    },
  });
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
