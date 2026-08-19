import type { EngramDeps } from "../deps";
import type { Thread } from "../agent/thread";

/**
 * Deterministic memory injection (12-factor appendix 13): if retrieval is
 * predictable, run it in code and hand the model results — don't make it spend
 * a step asking. Pre-fetched results are rendered into the context only; they
 * are NOT canonical events. Mutation refs come solely from archival_search
 * tool responses, so the ref map stays derivable from the log alone.
 */
export interface PrefetchResult {
  block: string;
  count: number;
}

export async function prefetchArchival(deps: EngramDeps, thread: Thread): Promise<PrefetchResult | null> {
  const seed = latestHumanText(thread);
  if (!seed) return null;
  // User-scoped read (mem0's sharing model), matching archival_search in
  // execute.ts — a curator thread pre-fetches the user's memories too.
  const results = await deps.archival.search({
    query: seed,
    scope: { userId: thread.userId },
    topK: 5,
  });
  if (results.length === 0) return null;
  // Memory content derives from user text — neutralize angle brackets so it
  // cannot forge event blocks in the rendered context (same rule as render.ts).
  const escape = (text: string) => text.replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const lines = results.map(
    r =>
      `- (${r.payload.memoryType}, ${r.payload.createdAt.slice(0, 10)}, score ${r.score.toFixed(2)}) ${escape(r.payload.content)}`,
  );
  const block =
    `<archival_recall query=${JSON.stringify(escape(seed.slice(0, 120)))}>\n` +
    `${lines.join("\n")}\n` +
    `(pre-fetched from archival memory — to update or delete one, first locate it with archival_search to get a ref)\n` +
    `</archival_recall>`;
  return { block, count: results.length };
}

function latestHumanText(thread: Thread): string | null {
  for (let i = thread.events.length - 1; i >= 0; i--) {
    const event = thread.events[i]!;
    if (event.type === "user_input") return asText(event.data);
    if (event.type === "human_response") {
      const data = event.data as { response?: unknown } | null;
      return asText(data?.response ?? event.data);
    }
  }
  return null;
}

function asText(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value;
  return null;
}
