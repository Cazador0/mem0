import type { Database } from "bun:sqlite";
import { crowdPenalty, ENTITY_BOOST_WEIGHT } from "./scoring";
import type { Scope } from "./recall";

/**
 * Entity side-index: mem0's lightweight graph substitute. A deterministic
 * (regex/heuristic, no NLP runtime) extractor populates an entity -> memory-ids
 * inverted index; at search time matched entities boost their linked memories
 * with a crowd penalty. The whole subsystem is best-effort: failures warn and
 * continue, never break a memory write (constitution principle VII).
 */

export type EntityType = "PROPER" | "QUOTED" | "IDENTIFIER";

export interface ExtractedEntity {
  data: string;
  entityType: EntityType;
}

const STOPWORDS = new Set([
  "the", "a", "an", "i", "we", "you", "he", "she", "it", "they", "my", "our",
  "your", "his", "her", "its", "their", "this", "that", "these", "those",
  "user", "agent", "assistant", "when", "what", "where", "who", "why", "how",
]);

export function extractEntities(text: string): ExtractedEntity[] {
  const seen = new Map<string, ExtractedEntity>();
  const add = (raw: string, entityType: EntityType) => {
    const data = raw.trim().replace(/\s+/g, " ");
    const key = data.toLowerCase();
    if (data.length < 2 || data.length > 80 || STOPWORDS.has(key)) return;
    if (!seen.has(key)) seen.set(key, { data, entityType });
  };

  // Quoted phrases: "..." or '...'
  for (const m of text.matchAll(/"([^"]{2,60})"|'([^']{2,60})'/g)) {
    add(m[1] ?? m[2] ?? "", "QUOTED");
  }
  // Proper-noun runs: consecutive Capitalized words (skips lone sentence-starters
  // by requiring either a multi-word run or a non-sentence-initial position).
  for (const m of text.matchAll(/(?<![.!?]\s)(?<!^)\b(\p{Lu}[\p{L}\p{N}]+(?:\s+\p{Lu}[\p{L}\p{N}]+)*)\b/gmu)) {
    add(m[1] ?? "", "PROPER");
  }
  for (const m of text.matchAll(/^\b(\p{Lu}[\p{L}\p{N}]+\s+\p{Lu}[\p{L}\p{N}]+(?:\s+\p{Lu}[\p{L}\p{N}]+)*)\b/gmu)) {
    add(m[1] ?? "", "PROPER");
  }
  // Technical identifiers: snake_case, kebab-case, dotted.paths, camelCase.
  for (const m of text.matchAll(/\b([\p{L}\p{N}]+(?:[._-][\p{L}\p{N}]+)+|\b\p{Ll}+\p{Lu}[\p{L}\p{N}]*)\b/gu)) {
    add(m[1] ?? "", "IDENTIFIER");
  }
  return [...seen.values()];
}

interface EntityRow {
  id: string;
  data: string;
  entity_type: string;
  linked_memory_ids: string;
}

export class EntityIndex {
  constructor(private readonly db: Database) {}

  /** Link a memory to every entity in its content. Best-effort: warns, never throws. */
  linkMemory(memoryId: string, content: string, scope: Scope): void {
    try {
      for (const entity of extractEntities(content)) {
        const key = entity.data.toLowerCase();
        const existing = this.findByData(key, scope);
        if (existing) {
          const ids = new Set<string>(JSON.parse(existing.linked_memory_ids) as string[]);
          ids.add(memoryId);
          this.db
            .query("UPDATE entities SET linked_memory_ids = ? WHERE id = ?")
            .run(JSON.stringify([...ids]), existing.id);
        } else {
          this.db
            .query(
              `INSERT INTO entities (id, data, entity_type, linked_memory_ids, user_id, agent_id, run_id)
               VALUES (?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT (data, user_id, agent_id, run_id) DO NOTHING`,
            )
            .run(
              Bun.randomUUIDv7(),
              key,
              entity.entityType,
              JSON.stringify([memoryId]),
              scope.userId ?? "",
              scope.agentId ?? "",
              scope.runId ?? "",
            );
        }
      }
    } catch (err) {
      console.warn(`[engram] entity linking failed (non-fatal): ${(err as Error).message}`);
    }
  }

  /** Remove a memory id from every entity that links it; drop entities left empty. */
  unlinkMemory(memoryId: string, scope: Scope): void {
    try {
      const rows = this.rowsInScope(scope);
      for (const row of rows) {
        const ids = (JSON.parse(row.linked_memory_ids) as string[]).filter(id => id !== memoryId);
        if (ids.length === 0) {
          this.db.query("DELETE FROM entities WHERE id = ?").run(row.id);
        } else {
          this.db
            .query("UPDATE entities SET linked_memory_ids = ? WHERE id = ?")
            .run(JSON.stringify(ids), row.id);
        }
      }
    } catch (err) {
      console.warn(`[engram] entity unlink failed (non-fatal): ${(err as Error).message}`);
    }
  }

  /**
   * Entity boosts for a query: exact-match query entities against the index,
   * boost each linked memory by ENTITY_BOOST_WEIGHT * crowdPenalty(nLinked),
   * capped at ENTITY_BOOST_WEIGHT (mem0's formula with similarity = 1 for
   * exact matches — no embedding round-trip needed).
   */
  boostsForQuery(query: string, scope: Scope): Record<string, number> {
    const boosts: Record<string, number> = {};
    try {
      for (const entity of extractEntities(query).slice(0, 8)) {
        const row = this.findByData(entity.data.toLowerCase(), scope);
        if (!row) continue;
        const linked = JSON.parse(row.linked_memory_ids) as string[];
        const boost = ENTITY_BOOST_WEIGHT * crowdPenalty(linked.length);
        for (const memoryId of linked) {
          boosts[memoryId] = Math.min(
            ENTITY_BOOST_WEIGHT,
            Math.max(boosts[memoryId] ?? 0, boost),
          );
        }
      }
    } catch (err) {
      console.warn(`[engram] entity boost failed (non-fatal): ${(err as Error).message}`);
    }
    return boosts;
  }

  private findByData(dataLower: string, scope: Scope): EntityRow | null {
    return this.db
      .query(
        "SELECT id, data, entity_type, linked_memory_ids FROM entities WHERE data = ? AND user_id = ? AND agent_id = ? AND run_id = ?",
      )
      .get(dataLower, scope.userId ?? "", scope.agentId ?? "", scope.runId ?? "") as EntityRow | null;
  }

  private rowsInScope(scope: Scope): EntityRow[] {
    return this.db
      .query(
        "SELECT id, data, entity_type, linked_memory_ids FROM entities WHERE user_id = ? AND agent_id = ? AND run_id = ?",
      )
      .all(scope.userId ?? "", scope.agentId ?? "", scope.runId ?? "") as EntityRow[];
  }
}
