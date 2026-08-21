# Retrieval notes — what the entity index actually recovers

Engram ports mem0's hybrid scoring constant-for-constant but **deliberately
simplifies the entity leg**: mem0 matches entities by embedding (write-side
upsert at ≥0.95 similarity, read-side top-500 with a 0.5 floor, boost =
similarity × 0.5 × damping), while Engram matches normalized text exactly with
similarity fixed at 1. Until now that trade-off was asserted in the spec and
never measured. This file is the measurement.

Reproduce with:

```sh
bun scripts/bench-entity-recall.ts
```

## Read this before quoting a number

The bench runs on the deterministic bag-of-words `FakeEmbedder` from the test
harness, not a real embedding model, because the suite is hermetic and offline.
That splits the results into two very different grades of evidence:

- **`entity` / `boost` columns are ground truth.** The entity index is pure
  string matching; it behaves identically here and in production.
- **`found` / `rank` / `semantic` columns are a weak-retriever floor, not
  production recall.** A token-overlap proxy scores a one-word query against a
  20-word memory far below what a real model would, and the 0.3 semantic
  threshold gates candidates *before* boosts are applied (mem0's deliberate
  ordering — boosts must never resurrect a gated-out candidate). So a row can
  show `entity: yes, found: NO`: the boost was earned but never got to apply.

## Results

| phrasing | query | entity fired | boost | found | rank |
|---|---|---|---|---|---|
| exact | `Poppy` | yes | 0.5 | no¹ | – |
| possessive | `Poppy's walk` | yes | 0.5 | yes | 1 |
| lowercase | `poppy` | **no** | 0 | no | – |
| paraphrase (no entity) | `the user's dog` | no | 0 | yes | 1 |
| exact (multiword) | `Northwind Logistics` | yes | 0.5 | yes | 1 |
| partial (one token) | `Northwind` | **no** | 0 | no | – |
| paraphrase (no entity) | `where does the user work` | no | 0 | no | – |
| exact | `Mei` | yes | 0.5 | yes | 1 |
| plural/possessive | `Mei's thesis` | yes | 0.5 | yes | 1 |
| identifier exact | `field-notes.app` | yes | 0.5 | yes | 1 |
| identifier partial | `field notes` | **no** | 0 | yes | 1 |
| exact (multiword) | `Boston Marathon` | yes | 0.5 | yes | 1 |
| reordered | `marathon in Boston` | **no** | 0 | yes | 1 |
| exact | `Whiskers` | yes | 0.5 | no¹ | – |
| plural | `Whiskers' food` | yes | 0.5 | yes | 1 |

¹ boost earned, but the proxy embedder's cosine fell under the 0.3 gate first.

**Exact mentions: entity fires 6/6. Variant phrasings: 3/9.**

## What the measurement changed

The first run scored **3/6 on exact mentions** — a bare `Poppy` fired nothing
while `Northwind Logistics` worked. Cause: `extractEntities` skipped
line-initial proper nouns (`(?<!^)`) and its line-start pattern required *two*
capitalized words, so a query that is exactly one name — the most natural query
a human types — extracted no entity at all. Every existing test happened to ask
"Tell me about Poppy" (mid-sentence), which is why four review rounds missed it.

Fixed by splitting the heuristic: indexing stays conservative (a line-initial
single capital is usually a sentence starter — "Also…", "Yesterday…" — and
indexing those fills the index with junk), while queries opt into
`lineInitialSingles`. A spurious query entity matches no indexed row and costs
nothing; a missed one costs the entire boost. Pinned by *"a bare entity name —
the most natural query there is — fires the boost"* in `test/memory.test.ts`.

## The semantic gate is NOT upstream's value

The scoring constants are a faithful constant-for-constant port, but the
threshold is not, and an earlier version of this file implied otherwise.
Upstream mem0 defaults to **0.1** (`mem0/memory/main.py:1385, 1628`); Engram
uses **0.3** — three times stricter. That buys precision (one shared token
cannot drag an unrelated memory into context) and costs recall, and it is the
single constant most likely to explain a "why didn't it remember that?" report.
`ENGRAM_SEMANTIC_THRESHOLD` overrides it; compare with `explain: true` before
changing it permanently.

Two related sharpnesses in the degraded (no-embedder / embed-outage) path, both
pre-existing: it is really *BM25 candidates, entity-reranked* — a memory with an
entity match but no FTS token match cannot enter the candidate set at all — and
the BM25-derived value is reported in the `semanticScore` field of `explain`
output, which reads misleadingly.

## Residual gaps (real, unfixed, deliberate)

These are the recall cost of skipping the embedding round-trip:

1. **Case sensitivity** — `poppy` does not match indexed `Poppy`. The index key
   is already lowercased; the *extractor* requires an initial capital to call
   something a proper noun, so a lowercase query never produces the candidate.
2. **Partial multiword** — `Northwind` does not match `Northwind Logistics`.
   Only whole normalized phrases are keys.
3. **Reordering / tokenization variants** — `marathon in Boston`, `field notes`.
4. **Synonyms and paraphrase** — never matched by design; that is the semantic
   leg's job, and it works (the paraphrase rows are found at rank 1 without any
   entity boost at all).

Cases 1–3 are what mem0's 0.5-similarity read floor would still catch. Closing
them means an embedding round-trip per query entity — the exact cost this design
declined to pay. If entity ranking is ever trusted for something load-bearing,
re-measure with a real embedder first; the entity index is best-effort by design
(constitution VII) and nothing should depend on it firing.
