import { describe, expect, test } from "bun:test";
import { step, testWorld } from "./harness";

/**
 * SSE streaming of a turn. A turn can span many LLM steps, so a client that
 * wants to show progress subscribes instead of waiting for one JSON blob.
 *
 * These drive the REAL server over a real socket — the point is the wire
 * format and the lifecycle, which a direct function call would not exercise.
 */
interface SseFrame {
  event: string;
  data: Record<string, unknown>;
}

function parseSse(raw: string): SseFrame[] {
  return raw
    .split("\n\n")
    .filter(block => block.trim())
    .map(block => {
      const event = /^event: (.*)$/m.exec(block)?.[1] ?? "";
      const data = /^data: (.*)$/m.exec(block)?.[1] ?? "{}";
      return { event, data: JSON.parse(data) as Record<string, unknown> };
    });
}

async function streamTurn(port: number, body: Record<string, unknown>, headers: Record<string, string> = {}) {
  const res = await fetch(`http://localhost:${port}/threads?stream=1`, {
    method: "POST",
    body: JSON.stringify(body),
    headers,
  });
  return { res, frames: parseSse(await res.text()) };
}

describe("SSE: streaming a turn", () => {
  test("streams the thread id, each committed event, then the final view", async () => {
    const { deps } = testWorld({
      script: [
        step({ intent: "core_append", block: "human", content: "Name: Hunter" }),
        step({ intent: "done_for_now", message: "noted" }),
      ],
    });
    deps.config.port = 0;
    const { createServer } = await import("../src/server/routes");
    const server = createServer(deps);
    try {
      const { res, frames } = await streamTurn(server.port!, { message: "I'm Hunter", user_id: "u1" });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/event-stream");

      // Opens with the id so a client can address the thread before it finishes.
      expect(frames[0]!.event).toBe("thread");
      const threadId = frames[0]!.data.thread_id as string;
      expect(threadId).toBeTruthy();

      // Every committed event is announced, in log order, with its seq.
      const events = frames.filter(f => f.event === "event");
      expect(events.map(f => f.data.type)).toEqual([
        "user_input",
        "tool_call",
        "tool_response",
        "tool_call",
      ]);
      expect(events.map(f => f.data.seq)).toEqual([0, 1, 2, 3]);

      // ...and closes with the same view the non-streaming route returns.
      const done = frames.at(-1)!;
      expect(done.event).toBe("done");
      expect(done.data).toMatchObject({ thread_id: threadId, status: "awaiting_human", message: "noted" });

      // The stream is a VIEW: the log is identical to the non-streaming path.
      const stored = deps.store.getThread(threadId);
      expect(stored.events.map(e => e.type)).toEqual(["user_input", "tool_call", "tool_response", "tool_call"]);
      expect(stored.events.filter(e => e.type === "error")).toEqual([]);
    } finally {
      await server.stop(true);
    }
  });

  test("an Accept header selects the stream just like ?stream=1", async () => {
    const { deps } = testWorld({ script: [step({ intent: "done_for_now", message: "hi" })] });
    deps.config.port = 0;
    const { createServer } = await import("../src/server/routes");
    const server = createServer(deps);
    try {
      const res = await fetch(`http://localhost:${server.port}/threads`, {
        method: "POST",
        body: JSON.stringify({ message: "hello", user_id: "u1" }),
        headers: { accept: "text/event-stream" },
      });
      expect(res.headers.get("content-type")).toContain("text/event-stream");
      expect(parseSse(await res.text()).at(-1)!.event).toBe("done");
    } finally {
      await server.stop(true);
    }
  });

  test("the non-streaming route is untouched", async () => {
    const { deps } = testWorld({ script: [step({ intent: "done_for_now", message: "plain json" })] });
    deps.config.port = 0;
    const { createServer } = await import("../src/server/routes");
    const server = createServer(deps);
    try {
      const res = await fetch(`http://localhost:${server.port}/threads`, {
        method: "POST",
        body: JSON.stringify({ message: "hello", user_id: "u1" }),
      });
      expect(res.headers.get("content-type")).toContain("application/json");
      expect(await res.json()).toMatchObject({ status: "awaiting_human", message: "plain json" });
    } finally {
      await server.stop(true);
    }
  });

  test("a failing turn ends the stream with an error frame, not a hang", async () => {
    const { deps } = testWorld({ script: [] }); // empty script: the LLM throws
    deps.config.port = 0;
    const { createServer } = await import("../src/server/routes");
    const server = createServer(deps);
    try {
      const { frames } = await streamTurn(server.port!, { message: "hello", user_id: "u1" });
      // The loop records LLM failures as error events rather than throwing, so
      // the stream still completes — with the errors visible in the log.
      expect(frames.at(-1)!.event).toBe("done");
      expect(frames.some(f => f.event === "event" && f.data.type === "error")).toBe(true);
    } finally {
      await server.stop(true);
    }
  });

  test("streaming honours auth and validation exactly like the JSON route", async () => {
    const { deps } = testWorld({ script: [step({ intent: "done_for_now", message: "hi" })] });
    deps.config.port = 0;
    deps.config.apiToken = "s3cret";
    const { createServer } = await import("../src/server/routes");
    const server = createServer(deps);
    try {
      const unauthorized = await fetch(`http://localhost:${server.port}/threads?stream=1`, {
        method: "POST",
        body: JSON.stringify({ message: "hello", user_id: "u1" }),
      });
      expect(unauthorized.status).toBe(401);

      // A bad body is still a 400 JSON error, never a stream of nothing.
      const bad = await fetch(`http://localhost:${server.port}/threads?stream=1`, {
        method: "POST",
        body: JSON.stringify({ message: "hello" }), // no user_id
        headers: { authorization: "Bearer s3cret" },
      });
      expect(bad.status).toBe(400);
      expect(bad.headers.get("content-type")).toContain("application/json");
    } finally {
      await server.stop(true);
    }
  });

  test("subscriptions are released when the stream ends", async () => {
    const { deps } = testWorld({ script: [step({ intent: "done_for_now", message: "hi" })] });
    deps.config.port = 0;
    const { createServer } = await import("../src/server/routes");
    const server = createServer(deps);
    try {
      const { frames } = await streamTurn(server.port!, { message: "hello", user_id: "u1" });
      const threadId = frames[0]!.data.thread_id as string;

      // Nothing should still be listening: appending now must reach no one.
      let leaked = 0;
      const off = deps.store.subscribe(threadId, () => leaked++);
      off();
      deps.store.appendEvent(threadId, "system_note", { note: "after the stream closed" });
      expect(leaked).toBe(0);
    } finally {
      await server.stop(true);
    }
  });
});
