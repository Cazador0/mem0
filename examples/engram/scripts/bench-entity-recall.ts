/**
 * Entity-recall bench: what does Engram's exact-match entity index actually
 * cost us, versus mem0's embedding-based entity matching (write-side upsert at
 * >=0.95 similarity, read-side floor 0.5)?
 *
 * Run: bun scripts/bench-entity-recall.ts
 *
 * HONEST SCOPE — read before quoting any number from this:
 * - The embedder here is the deterministic bag-of-words FakeEmbedder from the
 *   test harness, NOT a real embedding model. The *semantic* leg is therefore
 *   a token-overlap proxy: this bench cannot tell you what a real model would
 *   recover, and it deliberately does not try.
 * - What it DOES measure exactly is the entity leg, which is pure
 *   string-matching code and behaves identically here and in production: for a
 *   given query phrasing, does the entity fire, and what boost lands on the
 *   memory?
 * - So: treat "entity fired" as ground truth and "found/rank" as indicative of
 *   a weak-retriever floor, not of production recall.
 */
import { openDb } from "../src/db/database";
import { ArchivalMemory } from "../src/memory/archival";
import { EntityIndex, extractEntities } from "../src/memory/entities";
import { FakeEmbedder } from "../test/harness";

const SCOPE = { userId: "bench", agentId: "engram", runId: "" };

/** Memories whose recall we probe, each anchored on one entity. */
const CORPUS = [
  "User's dog is named Poppy and their morning walks together are the highlight of the day.",
  "User works as a platform engineer at Northwind Logistics, mostly on their billing service.",
  "User's partner Mei is finishing a PhD in marine biology at Kyoto University.",
  "User keeps their notes in a repository called field-notes.app and syncs it nightly.",
  "User is training for the Boston Marathon in April 2027 with a 3:30 goal.",
  "User's cat Whiskers refuses every brand of wet food except Sheba.",
];

/** Query phrasings per target memory: the exact mention, then harder variants. */
const PROBES: Array<{ target: number; label: string; query: string }> = [
  { target: 0, label: "exact", query: "Poppy" },
  { target: 0, label: "possessive", query: "Poppy's walk" },
  { target: 0, label: "lowercase", query: "poppy" },
  { target: 0, label: "paraphrase (no entity)", query: "the user's dog" },
  { target: 1, label: "exact (multiword)", query: "Northwind Logistics" },
  { target: 1, label: "partial (one token)", query: "Northwind" },
  { target: 1, label: "paraphrase (no entity)", query: "where does the user work" },
  { target: 2, label: "exact", query: "Mei" },
  { target: 2, label: "plural/possessive", query: "Mei's thesis" },
  { target: 3, label: "identifier exact", query: "field-notes.app" },
  { target: 3, label: "identifier partial", query: "field notes" },
  { target: 4, label: "exact (multiword)", query: "Boston Marathon" },
  { target: 4, label: "reordered", query: "marathon in Boston" },
  { target: 5, label: "exact", query: "Whiskers" },
  { target: 5, label: "plural", query: "Whiskers' food" },
];

const db = openDb(":memory:");
const embedder = new FakeEmbedder();
const archival = new ArchivalMemory(db, embedder);
const entities = new EntityIndex(db);

const ids: string[] = [];
for (const content of CORPUS) {
  const { id } = await archival.insert({ content, scope: SCOPE });
  ids.push(id);
}

interface Row {
  label: string;
  query: string;
  entityFired: boolean;
  boost: number;
  found: boolean;
  rank: number | null;
  semantic: number | null;
}

const rows: Row[] = [];
for (const probe of PROBES) {
  const targetId = ids[probe.target]!;
  const boosts = entities.boostsForQuery(probe.query, { userId: SCOPE.userId });
  const hits = await archival.search({
    query: probe.query,
    scope: { userId: SCOPE.userId },
    topK: 10,
    explain: true,
  });
  const at = hits.findIndex(h => h.id === targetId);
  rows.push({
    label: probe.label,
    query: probe.query,
    entityFired: (boosts[targetId] ?? 0) > 0,
    boost: Number((boosts[targetId] ?? 0).toFixed(3)),
    found: at >= 0,
    rank: at >= 0 ? at + 1 : null,
    semantic: at >= 0 ? Number((hits[at]!.scoreDetails?.semanticScore ?? 0).toFixed(3)) : null,
  });
}

const pad = (s: string, n: number) => s.padEnd(n);
console.log(
  `\n${pad("phrasing", 24)}${pad("query", 26)}${pad("entity", 8)}${pad("boost", 8)}${pad("found", 7)}${pad("rank", 6)}semantic`,
);
console.log("-".repeat(86));
for (const r of rows) {
  console.log(
    pad(r.label, 24) +
      pad(JSON.stringify(r.query).slice(0, 24), 26) +
      pad(r.entityFired ? "yes" : "NO", 8) +
      pad(String(r.boost), 8) +
      pad(r.found ? "yes" : "NO", 7) +
      pad(r.rank === null ? "-" : String(r.rank), 6) +
      (r.semantic === null ? "-" : String(r.semantic)),
  );
}

const exact = rows.filter(r => r.label.startsWith("exact") || r.label.startsWith("identifier exact"));
const variant = rows.filter(r => !exact.includes(r));
const pct = (n: number, d: number) => (d === 0 ? "n/a" : `${Math.round((n / d) * 100)}%`);

console.log("\nsummary");
console.log(`  exact mentions:      entity fired ${pct(exact.filter(r => r.entityFired).length, exact.length)} (${exact.filter(r => r.entityFired).length}/${exact.length}), target found ${pct(exact.filter(r => r.found).length, exact.length)}`);
console.log(`  variant phrasings:   entity fired ${pct(variant.filter(r => r.entityFired).length, variant.length)} (${variant.filter(r => r.entityFired).length}/${variant.length}), target found ${pct(variant.filter(r => r.found).length, variant.length)}`);
console.log(
  `\n  Every variant miss is a memory mem0's semantic entity matching (0.5 read floor)\n` +
    `  would likely still boost. That gap is the price of skipping the embedding\n` +
    `  round-trip on the entity path — see docs/RETRIEVAL-NOTES.md.\n`,
);
