import type { Database } from "bun:sqlite";
import { nowIso } from "../db/database";
import { blobToVec, vecToBlob, type EmbeddingProvider } from "./embeddings";
import { EntityIndex } from "./entities";
import {
  cosineSimilarity,
  ftsMatchExpr,
  getBm25Params,
  normalizeBm25,
  scoreAndRank,
  type ScoredCandidate,
} from "./scoring";
import { stripIdentityKeys, type Scope } from "./recall";

/**
 * Archival tier: vector-searchable long-term memory following mem0's design —
 * payload-as-document rows, xxHash64 content dedup, append-only history audit
 * (constitution II), entity side-index maintenance, expiration filtered at
 * read time, hybrid scoring with semantic-threshold gating.
 *
 * All writes go through this facade — never touch the memories table directly.
 */

export type MemoryType = "fact" | "decision" | "procedural";

export interface MemoryRecord {
  id: string;
  content: string;
  hash: string;
  userId: string;
  agentId: string;
  runId: string;
  memoryType: MemoryType;
  sourceThreadId: string | null;
  sourceEventSeqs: number[] | null;
  createdAt: string;
  updatedAt: string;
  expirationDate: string | null;
  metadata: Record<string, string>;
}

export interface InsertArgs {
  content: string;
  scope: Scope;
  memoryType?: MemoryType;
  metadata?: Record<string, string>;
  sourceThreadId?: string;
  sourceEventSeqs?: number[];
  expirationDate?: string;
}

export interface SearchArgs {
  query: string;
  scope: Scope;
  topK?: number;
  memoryType?: MemoryType;
  explain?: boolean;
  showExpired?: boolean;
}

export type ScoredMemory = ScoredCandidate<MemoryRecord>;

export interface HistoryRow {
  id: number;
  memoryId: string;
  previousValue: string | null;
  newValue: string | null;
  action: "ADD" | "UPDATE" | "DELETE";
  createdAt: string;
  isDeleted: boolean;
  actorId: string | null;
}

/** Semantic gate applied before any boosting (mem0's threshold discipline). */
const SEMANTIC_THRESHOLD = 0.3;
/** In degraded (no-embedder) mode the BM25 leg is the base signal; gate lightly. */
const DEGRADED_THRESHOLD = 0.01;

export class ArchivalMemory {
  private readonly entities: EntityIndex;

  constructor(
    private readonly db: Database,
    private readonly embedder: EmbeddingProvider | null,
  ) {
    this.entities = new EntityIndex(db);
  }

  contentHash(content: string): string {
    return Bun.hash.xxHash64(normalize(content)).toString(16);
  }

  /** Insert one memory. Dedupes by content hash within scope; audits the ADD. */
  async insert(args: InsertArgs): Promise<{ id: string; created: boolean; memory: MemoryRecord }> {
    const hash = this.contentHash(args.content);
    const scope = normalizeScope(args.scope);
    const existing = this.db
      .query("SELECT * FROM memories WHERE hash = ? AND user_id = ? AND agent_id = ? AND run_id = ?")
      .get(hash, scope.userId, scope.agentId, scope.runId) as RawRow | null;
    if (existing) {
      return { id: existing.id, created: false, memory: rowToRecord(existing) };
    }

    const id = Bun.randomUUIDv7();
    const now = nowIso();
    const metadata = stripIdentityKeys(args.metadata ?? {});
    let embedding: Float32Array | null = null;
    if (this.embedder) {
      try {
        embedding = await this.embedder.embed(args.content);
      } catch (err) {
        console.warn(`[engram] embedding failed, storing without vector: ${(err as Error).message}`);
      }
    }

    const write = this.db.transaction(() => {
      this.db
        .query(
          `INSERT INTO memories
             (id, content, hash, embedding, user_id, agent_id, run_id, memory_type,
              source_thread_id, source_event_seqs, created_at, updated_at, expiration_date, metadata)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          args.content,
          hash,
          embedding ? vecToBlob(embedding) : null,
          scope.userId,
          scope.agentId,
          scope.runId,
          args.memoryType ?? "fact",
          args.sourceThreadId ?? null,
          args.sourceEventSeqs ? JSON.stringify(args.sourceEventSeqs) : null,
          now,
          now,
          args.expirationDate ?? null,
          JSON.stringify(metadata),
        );
      this.db
        .query("INSERT INTO memories_fts (content, memory_id) VALUES (?, ?)")
        .run(args.content, id);
      this.addHistory(id, null, args.content, "ADD", false);
    });
    try {
      write.immediate();
    } catch (err) {
      // The dedup SELECT above ran before the embed await; a concurrent insert
      // of the same content can win that race. Honor the created:false
      // contract instead of surfacing the UNIQUE violation.
      if (String((err as Error).message).includes("UNIQUE")) {
        const winner = this.db
          .query("SELECT * FROM memories WHERE hash = ? AND user_id = ? AND agent_id = ? AND run_id = ?")
          .get(hash, scope.userId, scope.agentId, scope.runId) as RawRow | null;
        if (winner) return { id: winner.id, created: false, memory: rowToRecord(winner) };
      }
      throw err;
    }

    // Best-effort side index — never fails the write (constitution VII).
    this.entities.linkMemory(id, args.content, scope);

    const memory = this.getById(id);
    if (!memory) throw new Error("memory row vanished after insert");
    return { id, created: true, memory };
  }

  getById(id: string): MemoryRecord | null {
    const row = this.db.query("SELECT * FROM memories WHERE id = ?").get(id) as RawRow | null;
    return row ? rowToRecord(row) : null;
  }

  /** Hybrid search: cosine (when an embedder exists) + sigmoid-BM25 + entity boost. */
  async search(args: SearchArgs): Promise<ScoredMemory[]> {
    const scope = normalizeScope(args.scope);
    const topK = args.topK ?? 5;
    const rows = (
      this.db
        .query(
          `SELECT * FROM memories
           WHERE user_id = ? AND agent_id = ? AND run_id = ?
             AND (? = '' OR memory_type = ?)`,
        )
        .all(scope.userId, scope.agentId, scope.runId, args.memoryType ?? "", args.memoryType ?? "") as RawRow[]
    ).filter(row => args.showExpired || !isExpired(row));
    if (rows.length === 0) return [];

    const inScope = new Set(rows.map(r => r.id));
    const bm25Raw = filterKeys(this.bm25Scores(args.query, scope), inScope);
    const entityBoosts = filterKeys(this.entities.boostsForQuery(args.query, scope), inScope);
    const explain = args.explain ?? false;

    if (!this.embedder) {
      // Degraded mode: the normalized BM25 leg becomes the base signal.
      const byId = new Map(rows.map(r => [r.id, r]));
      const semantic = Object.entries(bm25Raw).map(([id, score]) => ({
        id,
        score,
        payload: rowToRecord(byId.get(id)!),
      }));
      return scoreAndRank(semantic, {}, entityBoosts, DEGRADED_THRESHOLD, topK, explain);
    }

    const queryVec = await this.embedder.embed(args.query);
    const withVec = rows.filter(r => r.embedding !== null);
    const withoutVec = rows.filter(r => r.embedding === null);
    warnOnDimsMismatch(queryVec, withVec);

    const semantic = withVec.map(r => ({
      id: r.id,
      score: cosineSimilarity(queryVec, blobToVec(r.embedding as Uint8Array)),
      payload: rowToRecord(r),
    }));
    const primary = scoreAndRank(semantic, bm25Raw, entityBoosts, SEMANTIC_THRESHOLD, topK, explain);

    // Rows stored without a vector (embedding outage, pre-embedder era) must
    // stay reachable: score them degraded-style on the BM25 leg and merge.
    const fallback = scoreAndRank(
      withoutVec
        .filter(r => (bm25Raw[r.id] ?? 0) > 0)
        .map(r => ({ id: r.id, score: bm25Raw[r.id]!, payload: rowToRecord(r) })),
      {},
      entityBoosts,
      DEGRADED_THRESHOLD,
      topK,
      explain,
    );

    return [...primary, ...fallback].sort((a, b) => b.score - a.score).slice(0, topK);
  }

  /** Rewrite a memory's content: audits before/after, rehashes, re-embeds, relinks entities. */
  async update(id: string, newContent: string, actorId?: string): Promise<{ ok: boolean; message: string }> {
    const row = this.db.query("SELECT * FROM memories WHERE id = ?").get(id) as RawRow | null;
    if (!row) return { ok: false, message: `no memory with id ${id}` };

    const newHash = this.contentHash(newContent);
    const collision = this.db
      .query("SELECT id FROM memories WHERE hash = ? AND user_id = ? AND agent_id = ? AND run_id = ? AND id != ?")
      .get(newHash, row.user_id, row.agent_id, row.run_id, id) as { id: string } | null;
    if (collision) {
      return {
        ok: false,
        message:
          "new content duplicates another existing memory in this scope — search for it and update that one, or delete this one instead",
      };
    }

    let embedding: Float32Array | null = null;
    if (this.embedder) {
      try {
        embedding = await this.embedder.embed(newContent);
      } catch (err) {
        console.warn(`[engram] re-embedding failed on update: ${(err as Error).message}`);
      }
    }
    const write = this.db.transaction(() => {
      this.addHistory(id, row.content, newContent, "UPDATE", false, actorId);
      this.db
        .query("UPDATE memories SET content = ?, hash = ?, embedding = ?, updated_at = ? WHERE id = ?")
        .run(newContent, newHash, embedding ? vecToBlob(embedding) : row.embedding, nowIso(), id);
      this.db.query("DELETE FROM memories_fts WHERE memory_id = ?").run(id);
      this.db.query("INSERT INTO memories_fts (content, memory_id) VALUES (?, ?)").run(newContent, id);
    });
    try {
      write.immediate();
    } catch (err) {
      // Same TOCTOU as insert(): the embed await sits between the collision
      // pre-check and the write — honor the readable-result contract.
      if (String((err as Error).message).includes("UNIQUE")) {
        return {
          ok: false,
          message:
            "new content duplicates another existing memory in this scope — search for it and update that one, or delete this one instead",
        };
      }
      throw err;
    }

    const scope = { userId: row.user_id, agentId: row.agent_id, runId: row.run_id };
    this.entities.unlinkMemory(id, scope);
    this.entities.linkMemory(id, newContent, scope);
    return { ok: true, message: "memory updated" };
  }

  /** Delete a memory. The history row survives with is_deleted = 1 (soft in audit). */
  delete(id: string, actorId?: string): { ok: boolean; message: string } {
    const row = this.db.query("SELECT * FROM memories WHERE id = ?").get(id) as RawRow | null;
    if (!row) return { ok: false, message: `no memory with id ${id}` };
    const write = this.db.transaction(() => {
      this.addHistory(id, row.content, null, "DELETE", true, actorId);
      this.db.query("DELETE FROM memories WHERE id = ?").run(id);
      this.db.query("DELETE FROM memories_fts WHERE memory_id = ?").run(id);
    });
    write.immediate();
    this.entities.unlinkMemory(id, { userId: row.user_id, agentId: row.agent_id, runId: row.run_id });
    return { ok: true, message: "memory deleted (audit retained)" };
  }

  history(memoryId: string): HistoryRow[] {
    const rows = this.db
      .query("SELECT * FROM memory_history WHERE memory_id = ? ORDER BY id ASC")
      .all(memoryId) as Array<{
      id: number;
      memory_id: string;
      previous_value: string | null;
      new_value: string | null;
      action: string;
      created_at: string;
      is_deleted: number;
      actor_id: string | null;
    }>;
    return rows.map(r => ({
      id: r.id,
      memoryId: r.memory_id,
      previousValue: r.previous_value,
      newValue: r.new_value,
      action: r.action as HistoryRow["action"],
      createdAt: r.created_at,
      isDeleted: r.is_deleted === 1,
      actorId: r.actor_id,
    }));
  }

  private bm25Scores(
    query: string,
    scope: { userId: string; agentId: string; runId: string },
  ): Record<string, number> {
    const match = ftsMatchExpr(query);
    if (!match) return {};
    const [midpoint, steepness] = getBm25Params(query);
    // Scope is filtered INSIDE the SQL, and candidates are rank-ordered before
    // the limit — a global unordered LIMIT would let other scopes starve this
    // one out of the candidate set entirely.
    const rows = this.db
      .query(
        `SELECT f.memory_id AS memory_id, bm25(memories_fts) AS raw
         FROM memories_fts f
         JOIN memories m ON m.id = f.memory_id
         WHERE memories_fts MATCH ?
           AND m.user_id = ? AND m.agent_id = ? AND m.run_id = ?
         ORDER BY rank
         LIMIT 200`,
      )
      .all(match, scope.userId, scope.agentId, scope.runId) as Array<{
      memory_id: string;
      raw: number;
    }>;
    const out: Record<string, number> = {};
    for (const row of rows) {
      // FTS5 bm25() returns negative values where lower = better; flip sign.
      out[row.memory_id] = normalizeBm25(-row.raw, midpoint, steepness);
    }
    return out;
  }

  private addHistory(
    memoryId: string,
    previous: string | null,
    next: string | null,
    action: HistoryRow["action"],
    isDeleted: boolean,
    actorId?: string,
  ): void {
    this.db
      .query(
        `INSERT INTO memory_history (memory_id, previous_value, new_value, action, created_at, is_deleted, actor_id)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(memoryId, previous, next, action, nowIso(), isDeleted ? 1 : 0, actorId ?? null);
  }
}

interface RawRow {
  id: string;
  content: string;
  hash: string;
  embedding: Uint8Array | null;
  user_id: string;
  agent_id: string;
  run_id: string;
  memory_type: string;
  source_thread_id: string | null;
  source_event_seqs: string | null;
  created_at: string;
  updated_at: string;
  expiration_date: string | null;
  metadata: string;
}

function rowToRecord(row: RawRow): MemoryRecord {
  return {
    id: row.id,
    content: row.content,
    hash: row.hash,
    userId: row.user_id,
    agentId: row.agent_id,
    runId: row.run_id,
    memoryType: row.memory_type as MemoryType,
    sourceThreadId: row.source_thread_id,
    sourceEventSeqs: row.source_event_seqs ? (JSON.parse(row.source_event_seqs) as number[]) : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    expirationDate: row.expiration_date,
    metadata: JSON.parse(row.metadata) as Record<string, string>,
  };
}

function normalize(content: string): string {
  return content.trim().replace(/\s+/g, " ").toLowerCase();
}

function normalizeScope(scope: Scope): { userId: string; agentId: string; runId: string } {
  return { userId: scope.userId ?? "", agentId: scope.agentId ?? "", runId: scope.runId ?? "" };
}

function isExpired(row: RawRow): boolean {
  if (!row.expiration_date) return false;
  return row.expiration_date < nowIso().slice(0, 10);
}

function filterKeys(map: Record<string, number>, allowed: Set<string>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(map)) {
    if (allowed.has(key)) out[key] = value;
  }
  return out;
}

let warnedDimsMismatch = false;

/**
 * A changed embedding model/dims makes every stored vector cosine to 0, which
 * the threshold gate then silently discards — surface it loudly, once.
 */
function warnOnDimsMismatch(queryVec: Float32Array, rows: RawRow[]): void {
  if (warnedDimsMismatch) return;
  for (const row of rows) {
    const stored = blobToVec(row.embedding as Uint8Array);
    if (stored.length !== queryVec.length) {
      warnedDimsMismatch = true;
      console.warn(
        `[engram] embedding dims mismatch: stored vectors have ${stored.length} dims but the ` +
          `configured embedder returns ${queryVec.length} — stored memories will score 0 semantically. ` +
          `Re-embed the store or restore the original ENGRAM_EMBEDDINGS_MODEL/_DIMS.`,
      );
      return;
    }
  }
}
