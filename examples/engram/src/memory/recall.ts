import type { Database } from "bun:sqlite";
import { nowIso } from "../db/database";
import { ftsMatchExpr } from "./scoring";
import type { EventType, Thread, ThreadEvent } from "../agent/thread";

/**
 * Recall tier: the append-only event log plus FTS5 keyword search over it.
 * This module is the ONLY writer of the threads/events tables (constitution I).
 */

export interface Scope {
  userId?: string;
  agentId?: string;
  runId?: string;
}

/** Deterministic, escaped scope key (mem0's `_build_session_scope`). */
export function buildScopeKey(scope: Scope): string {
  const esc = (v: string | undefined) => encodeURIComponent(v ?? "");
  return `agent_id=${esc(scope.agentId)}&run_id=${esc(scope.runId)}&user_id=${esc(scope.userId)}`;
}

const IDENTITY_KEYS = ["user_id", "agent_id", "run_id", "userId", "agentId", "runId"];

/**
 * Identity keys never enter payloads through metadata — scope is structural
 * (constitution III; mem0's `_strip_identity_keys`).
 */
export function stripIdentityKeys(metadata: Record<string, string>): Record<string, string> {
  const clean: Record<string, string> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (IDENTITY_KEYS.includes(key)) {
      console.warn(`[engram] dropping identity key "${key}" from metadata — scope is set structurally`);
      continue;
    }
    clean[key] = value;
  }
  return clean;
}

interface ThreadRow {
  id: string;
  agent_id: string;
  scope_key: string;
  user_id: string;
  run_id: string;
  status_hint: string;
  extracted_seq: number;
  created_at: string;
  updated_at: string;
}

interface EventRow {
  id: string;
  thread_id: string;
  seq: number;
  type: string;
  data: string;
  ts: string;
}

export interface RecallHit {
  event: ThreadEvent;
  snippet: string;
}

export class RecallStore {
  constructor(private readonly db: Database) {}

  createThread(agentId: string, scope: Scope): Thread {
    const id = Bun.randomUUIDv7();
    const now = nowIso();
    this.db
      .query(
        `INSERT INTO threads (id, agent_id, scope_key, user_id, run_id, status_hint, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'new', ?, ?)`,
      )
      .run(id, agentId, buildScopeKey({ ...scope, agentId }), scope.userId ?? "", scope.runId ?? "", now, now);
    return this.getThread(id);
  }

  getThread(id: string): Thread {
    const row = this.db.query("SELECT * FROM threads WHERE id = ?").get(id) as ThreadRow | null;
    if (!row) throw new Error(`thread not found: ${id}`);
    const events = (
      this.db.query("SELECT * FROM events WHERE thread_id = ? ORDER BY seq ASC").all(id) as EventRow[]
    ).map(rowToEvent);
    return {
      id: row.id,
      agentId: row.agent_id,
      scopeKey: row.scope_key,
      userId: row.user_id,
      runId: row.run_id,
      extractedSeq: row.extracted_seq,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      events,
    };
  }

  listThreads(): Array<{ id: string; agentId: string; statusHint: string; updatedAt: string }> {
    const rows = this.db
      .query("SELECT id, agent_id, status_hint, updated_at FROM threads ORDER BY updated_at DESC")
      .all() as ThreadRow[];
    return rows.map(r => ({ id: r.id, agentId: r.agent_id, statusHint: r.status_hint, updatedAt: r.updated_at }));
  }

  /**
   * Append one event; seq is allocated inside an immediate transaction and the
   * UNIQUE(thread_id, seq) constraint makes concurrent appends fail loudly
   * rather than interleave silently.
   */
  appendEvent(threadId: string, type: EventType, data: unknown): ThreadEvent {
    const id = Bun.randomUUIDv7();
    const ts = nowIso();
    const insert = this.db.transaction(() => {
      const row = this.db
        .query("SELECT COALESCE(MAX(seq), -1) + 1 AS seq FROM events WHERE thread_id = ?")
        .get(threadId) as { seq: number };
      this.db
        .query("INSERT INTO events (id, thread_id, seq, type, data, ts) VALUES (?, ?, ?, ?, ?, ?)")
        .run(id, threadId, row.seq, type, JSON.stringify(data ?? null), ts);
      this.db
        .query("INSERT INTO events_fts (content, event_id, thread_id) VALUES (?, ?, ?)")
        .run(projectForFts(type, data), id, threadId);
      this.db.query("UPDATE threads SET updated_at = ? WHERE id = ?").run(ts, threadId);
      return row.seq;
    });
    const seq = insert.immediate() as number;
    return { id, threadId, seq, type, data: data ?? null, ts };
  }

  setStatusHint(threadId: string, hint: string): void {
    this.db.query("UPDATE threads SET status_hint = ?, updated_at = ? WHERE id = ?").run(hint, nowIso(), threadId);
  }

  setExtractedSeq(threadId: string, seq: number): void {
    // Monotonic: an extraction that snapshotted earlier but finished later must
    // never move the watermark backwards (that would re-process — and
    // re-charge — messages a completed extraction already covered).
    this.db
      .query("UPDATE threads SET extracted_seq = max(extracted_seq, ?) WHERE id = ?")
      .run(seq, threadId);
  }

  /** FTS5 keyword search over a thread's event history (the recall_search intent). */
  searchEvents(
    threadId: string,
    query: string,
    opts: { after?: string; before?: string; limit?: number } = {},
  ): RecallHit[] {
    const match = ftsMatchExpr(query);
    if (!match) return [];
    const rows = this.db
      .query(
        `SELECT e.id, e.thread_id, e.seq, e.type, e.data, e.ts,
                snippet(events_fts, 0, '[', ']', '…', 12) AS snip
         FROM events_fts f
         JOIN events e ON e.id = f.event_id
         WHERE events_fts MATCH ? AND f.thread_id = ?
           AND (? = '' OR e.ts >= ?)
           AND (? = '' OR e.ts <= ?)
         ORDER BY rank
         LIMIT ?`,
      )
      .all(
        match,
        threadId,
        opts.after ?? "",
        opts.after ?? "",
        opts.before ?? "",
        opts.before ?? "",
        opts.limit ?? 10,
      ) as Array<EventRow & { snip: string }>;
    return rows.map(r => ({ event: rowToEvent(r), snippet: r.snip }));
  }

  /**
   * Rolling window of the most recent conversational events, truncated per
   * message (mem0's last-10-messages pattern — read-side only; raw events are
   * never evicted).
   */
  recentWindow(thread: Thread, n = 10, truncateTo = 300): Array<{ role: string; text: string; ts: string }> {
    const out: Array<{ role: string; text: string; ts: string }> = [];
    for (const event of thread.events) {
      const line = conversationalText(event);
      if (line) out.push({ role: line.role, text: truncate(line.text, truncateTo), ts: event.ts });
    }
    return out.slice(-n);
  }
}

function rowToEvent(row: EventRow): ThreadEvent {
  return {
    id: row.id,
    threadId: row.thread_id,
    seq: row.seq,
    type: row.type as EventType,
    data: JSON.parse(row.data),
    ts: row.ts,
  };
}

/** Text projection of an event for the FTS index. */
function projectForFts(type: EventType, data: unknown): string {
  if (typeof data === "string") return `${type} ${data}`;
  if (data && typeof data === "object") {
    const parts: string[] = [type];
    for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
      parts.push(key, typeof value === "string" ? value : JSON.stringify(value));
    }
    return parts.join(" ");
  }
  return type;
}

/** Which events count as conversation for windows and extraction. */
export function conversationalText(event: ThreadEvent): { role: string; text: string } | null {
  const data = event.data as Record<string, unknown> | string | null;
  switch (event.type) {
    case "user_input":
      return { role: "user", text: asText(data) };
    case "human_response":
      return { role: "user", text: asText((data as Record<string, unknown>)?.response ?? data) };
    case "tool_call": {
      const d = data as Record<string, unknown> | null;
      if (d?.intent === "done_for_now") return { role: "assistant", text: String(d.message ?? "") };
      if (d?.intent === "complete_task") return { role: "assistant", text: String(d.summary ?? "") };
      if (d?.intent === "request_human_input") return { role: "assistant", text: String(d.question ?? "") };
      return null;
    }
    default:
      return null;
  }
}

function asText(value: unknown): string {
  if (typeof value === "string") return value;
  return JSON.stringify(value ?? "");
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}
