# Memory tiers — invariants

- **All writes go through the tier facades, never raw SQL**: events via `RecallStore.appendEvent`, archival via `ArchivalMemory.insert/update/delete`, core blocks via `CoreMemory.append/replace`. Each facade owns its side effects (FTS projection, history audit, entity relink, CAS version bump); bypassing one silently corrupts derived state.
- **Scope enters payloads in exactly one place per store.** Callers pass a `Scope`; identity keys found in metadata are stripped with a warning (`stripIdentityKeys`). Never add a second path.
- **Every archival mutation writes a `memory_history` row** with before/after values; deletes keep their history (`is_deleted = 1`). If you add a mutation, add its audit row in the same transaction.
- **The extraction pipeline is phased and ADD-only** (`extraction.ts`): only Phase 2 (the LLM call) may throw; every other phase degrades per-item with a warning. Reconciliation (UPDATE/DELETE decisions by an LLM) belongs in a future *offline* job, never in this hot path.
- **Temporal grounding**: extracted memories resolve relative time against the conversation's observation date. If you touch the extraction prompt, keep the Observation Date vs Current Date separation.
- **Embeddings are optional.** `embedder === null` is a supported mode (FTS + entity only). Any new retrieval feature must work — perhaps worse, but honestly — without vectors.
- **Search order is fixed**: expiration filter → semantic threshold gate → THEN keyword/entity boosts → adaptive divisor. Boosts must never resurrect a semantically gated-out candidate (mem0's deliberate design).
