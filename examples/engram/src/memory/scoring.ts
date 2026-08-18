/**
 * Hybrid retrieval scoring, ported from mem0-ts (src/oss/src/utils/scoring.ts):
 * sigmoid-normalized BM25 with query-length-adaptive parameters, entity boost
 * with a crowd penalty, semantic-threshold gating BEFORE combination, and an
 * adaptive max-possible divisor depending on which signals are active.
 */

export const ENTITY_BOOST_WEIGHT = 0.5;

/** Longer queries yield higher raw BM25 scores; adapt the sigmoid accordingly. */
export function getBm25Params(query: string): [midpoint: number, steepness: number] {
  const numTerms = query.trim().split(/\s+/).filter(Boolean).length || 1;
  if (numTerms <= 3) return [5.0, 0.7];
  if (numTerms <= 6) return [7.0, 0.6];
  if (numTerms <= 9) return [9.0, 0.5];
  if (numTerms <= 15) return [10.0, 0.5];
  return [12.0, 0.5];
}

export function normalizeBm25(rawScore: number, midpoint: number, steepness: number): number {
  return 1.0 / (1.0 + Math.exp(-steepness * (rawScore - midpoint)));
}

/** Hub entities linked to many memories should not dominate: 1/(1+0.001*(n-1)^2). */
export function crowdPenalty(nLinked: number): number {
  return 1.0 / (1.0 + 0.001 * (nLinked - 1) ** 2);
}

export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

export interface ScoreDetails {
  semanticScore: number;
  bm25Score: number;
  entityBoost: number;
  rawScore: number;
  maxPossibleScore: number;
  finalScore: number;
  threshold: number;
}

export interface ScoredCandidate<P> {
  id: string;
  score: number;
  payload: P;
  scoreDetails?: ScoreDetails;
}

/**
 * combined = (semantic + bm25 + entityBoost) / maxPossible, where the semantic
 * threshold gates candidates before boosting (keyword/entity signals can never
 * resurrect a semantically irrelevant result), and maxPossible adapts:
 * semantic only = 1.0, +bm25 = 2.0, +entity = 2.5, semantic+entity = 1.5.
 */
export function scoreAndRank<P>(
  semanticResults: Array<{ id: string; score: number; payload: P }>,
  bm25Scores: Record<string, number>,
  entityBoosts: Record<string, number>,
  threshold: number,
  topK: number,
  explain = false,
): Array<ScoredCandidate<P>> {
  const hasBm25 = Object.keys(bm25Scores).length > 0;
  const hasEntity = Object.keys(entityBoosts).length > 0;

  let maxPossible = 1.0;
  if (hasBm25) maxPossible += 1.0;
  if (hasEntity) maxPossible += ENTITY_BOOST_WEIGHT;

  const scored: Array<ScoredCandidate<P>> = [];
  for (const result of semanticResults) {
    const semanticScore = result.score ?? 0;
    if (semanticScore < threshold) continue;
    const bm25Score = bm25Scores[result.id] ?? 0;
    const entityBoost = entityBoosts[result.id] ?? 0;
    const raw = semanticScore + bm25Score + entityBoost;
    const combined = Math.min(raw / maxPossible, 1.0);
    const entry: ScoredCandidate<P> = { id: result.id, score: combined, payload: result.payload };
    if (explain) {
      entry.scoreDetails = {
        semanticScore,
        bm25Score,
        entityBoost,
        rawScore: raw,
        maxPossibleScore: maxPossible,
        finalScore: combined,
        threshold,
      };
    }
    scored.push(entry);
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topK);
}

/** Build a safe FTS5 MATCH expression: quote each token, OR-join. */
export function ftsMatchExpr(query: string): string {
  const tokens = query
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(t => t.length > 1);
  if (tokens.length === 0) return "";
  return tokens.map(t => `"${t}"`).join(" OR ");
}
