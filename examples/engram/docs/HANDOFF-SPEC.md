# ENGRAM — Architecture Hand-Off Specification

> The master architecture synthesized from a verified deep-read of five repositories
> (mem0, 12-factor-agents, spec-kit, BMAD-METHOD, bun). This document is the design
> the scaffold in this directory implements; sections marked *(roadmap)* are specified
> here but not yet built.

## 1. Definition of the application

Engram is a persistent agent you can talk to across sessions that never forgets what
matters. Every conversation is an append-only **Thread** of events (the reducer's
state). While it runs, it self-edits a small set of **Core memory blocks** that are
always in its prompt; after each turn, a **mem0-V3-style extraction pipeline**
distills durable facts into an **Archival tier** (vectors as BLOBs + FTS5 + entity
side-index, hybrid-scored); everything ever said stays queryable in the **Recall
tier** (the event log + FTS5). The loop can pause for human approval, sleep on a
schedule, spawn scoped specialist agents, and resume from nothing but the database —
merging dynamic graph-state workflows with persistent, tiered core/archival memory.

## 2. Architecture — who contributes what

| Source | Pattern adopted |
|---|---|
| 12-factor-agents | Stateless reducer `agentLoop(thread) → thread'`; append-only Event log unifying execution+business state; one LLM call → one intent from a Zod discriminated union; two-switch split (route vs execute); derived-status predicates over the log tail; compact errors with counter-gated escalation (3 consecutive → human); pre-fetch memory deterministically instead of offering a fetch tool; pause/resume by thread id from any channel |
| MemGPT concept, stored the mem0 way | Core tier: named, char-budgeted, self-editable blocks rendered into every system prompt with visible budget pressure; memory edits are sync intents so the loop chains them without a human turn (heartbeat) |
| mem0 (V3 pipeline) | ADD-only extraction (one LLM call, Observation-Date temporal grounding, integer-ID indirection, rich-not-atomic 15–80-word memories, no-fabrication/no-echo rules), xxHash64 code-side dedup, insert with per-item fallback, append-only history audit table, entity side-index with crowd-penalty boost, hybrid scoring with semantic-threshold gating *before* boosting, scope keys entering payloads in exactly one function, identity-key stripping at write entries, expiration filtered at read time, procedural memory via verbatim-preserving run summarization; ADD/UPDATE/DELETE/NONE reconciliation survives **only** as an offline, audited, approval-gated compaction job *(roadmap)* |
| spec-kit | `constitution.md` (semver + ratified/amended dates) rendered as a read-only core block; structured gate results `{principle, pass, justification?}` — unjustified failure is an ERROR; `needs_clarification` intent with max-3 impact-ranked markers and recommended-option quick replies; deterministic code gathers facts before any LLM judgment; CLAUDE.md managed region between markers that points at live state |
| BMAD-METHOD | Specialist agents as **data** `{id, persona, intentUnion subset}`; subagents run on fresh threads, write full output there, and return `{verdict, topFindings, ref}`; CAS state transitions (`UPDATE … WHERE <expected previous state>`); capsule compiler and asymmetric-context review fan-out *(roadmap)* |
| bun | `bun:sqlite` WAL + strict + prepared statements + immediate transactions; FTS5 for both Recall and Archival keyword legs; UUIDv7 PKs (sortable = free recency); xxHash64 content fingerprints; layered CLAUDE.md with enforced invariants; hermetic test harness |

## 3. Storage schema (single SQLite file)

See `src/db/migrations/001_init.sql`:

- `threads` — id (uuidv7), agent_id, scope_key, user/run ids, `status_hint` (display cache only — status is always derived), `extracted_seq` extraction watermark.
- `events` — the Recall tier and reducer state; `UNIQUE(thread_id, seq)`; closed type enum `user_input | system_note | tool_call | tool_response | human_response | error | memory_write`; `events_fts` (FTS5) over a text projection.
- `core_blocks` — per-agent labeled blocks with `char_limit`, `read_only`, CAS `version`.
- `memories` — Archival tier: content, xxHash64 `hash` (UNIQUE per scope), embedding BLOB (nullable), scope columns, `memory_type` (fact|decision|procedural), provenance (`source_thread_id`, `source_event_seqs`), `expiration_date`, metadata JSON; `memories_fts` for the BM25 leg.
- `entities` — entity → `linked_memory_ids` inverted index (regex-extracted, best-effort).
- `memory_history` — append-only audit of every ADD/UPDATE/DELETE with before/after values; deletes soft in history.
- `schedules` — durable sleep rows claimed by CAS on wake.
- `artifacts` — registry for capsule/artifact handoffs *(roadmap: capsule compiler)*.

## 4. Tool-calling schemas (the intent union)

One structured output per step: `{ next_step: <discriminated union on "intent"> }`.
Per-agent capability = presence in that agent's union subset. Routing classes:
**sync** (execute, append `tool_response`, continue — the heartbeat), **gated**
(record, break for approval; approval replays verbatim; denial becomes a readable
`tool_response`), **break** (persist & wait), **terminal**.

| Intent | Class | Params |
|---|---|---|
| `core_append` | sync | `{block, content}` — budget overflow returns a readable error |
| `core_replace` | sync | `{block, old_text, new_text}` — exact match; constitution block rejects |
| `archival_insert` | sync | `{content (15–80 words, absolute dates), memory_type?, metadata?}` |
| `archival_search` | sync | `{query, top_k?, memory_type?, explain?}` — results carry integer refs |
| `recall_search` | sync | `{query, after?, before?, limit?}` |
| `memory_update` | sync | `{ref, new_content, reason}` — refs validated host-side |
| `memory_delete` | **gated** | `{ref, reason}` |
| `request_human_input` | break | `{question, context?, urgency?}` |
| `needs_clarification` | break | `{markers[≤3]: {question, options[2..5], recommended, impact}}` |
| `sleep_until` | break | `{wake_at? \| delay_minutes?, reason}` |
| `spawn_subagent` | sync | `{agent_id, task}` → `{verdict, summary, ref}` |
| `done_for_now` | break | `{message}` |
| `complete_task` | terminal | `{outcome: success\|partial\|blocked, summary}` → procedural summarization |

## 5. Module breakdown

```
engram/
├── CLAUDE.md, AGENTS.md (byte-identical), constitution.md, README.md
├── docs/HANDOFF-SPEC.md
├── src/
│   ├── index.ts / cli.ts / bootstrap.ts / config.ts / deps.ts
│   ├── db/database.ts + db/migrations/001_init.sql
│   ├── memory/{core,recall,archival,scoring,entities,embeddings,extraction,prefetch,procedural}.ts
│   ├── agent/{thread,intents,loop,execute,render,llm}.ts
│   ├── agents/registry.ts
│   ├── orchestration/{gates,scheduler}.ts
│   └── server/routes.ts
└── test/{harness,preload}.ts + *.test.ts
```

## 6. Implementation rules (non-negotiable; see constitution.md)

1. **LLM contract**: default model `claude-opus-5` (env-overridable); adaptive
   thinking; schema-validated structured output (Zod, salvage parse, bounded
   retries with error feedback) — never trust raw model output; handle
   `stop_reason: "refusal"` as a typed error that escalates; server-side refusal
   fallbacks on by default behind config; stable system-prefix ordering for prompt
   caching. The LLM is an injected interface (`LLMClient`) — tests use `ScriptedLLM`.
2. Canonical event log is never mutated by rendering; `render.ts` is the only seam
   deciding what the model sees (compaction, redaction, error-hiding, injection).
3. Every memory mutation writes a history row in the same transaction.
4. Scope enters payloads in exactly one function per store; identity keys stripped
   from metadata everywhere.
5. The extraction pipeline's LLM phase is the only phase that throws; all other
   phases degrade per-item with warnings. The entity index is never load-bearing.
6. tool_call events are persisted before execution; gated intents execute only via
   approval replay of the recorded event.
7. Tests are hermetic (in-memory DB, scripted LLM, no timers-as-waits) and must be
   green before any commit.

## 7. Roadmap (specified, not yet built)

- **Offline reconciliation** (`memory/reconcile.ts`): cluster near-duplicates by
  cosine within scope, integer-ID map, ADD/UPDATE/DELETE/NONE prompt (mem0's
  legacy `DEFAULT_UPDATE_MEMORY_PROMPT` design), validate returned IDs, apply in
  one transaction with full audit; LLM-decided deletes above a batch threshold
  pause as an approval gate.
- **SSE token streaming** on `POST /threads` (async-generator Response +
  `server.timeout(req, 0)`), WebSocket topic fanout of lifecycle events.
- **Worker-isolated extraction**: `db.serialize()` snapshot → Worker → write
  batches back through a single-writer queue.
- **Capsule compiler + review fan-out** (BMAD): compile self-contained task
  capsules harvesting prior Agent Records + archival memory; parallel reviewers
  with asymmetric context envelopes; section-level write permissions enforced in code.
- **Prompt evals**: fixture threads (same serialization as `render.ts`) run against
  the live model asserting chosen intents — recorded-response mode for CI.
- **CLAUDE.md generator** (`context/claudemd.ts`): marker-region upsert handling
  all four corruption states, manifest-hash ownership, pointer-not-copy content.

## 8. CLAUDE.md generation guidelines

(a) Root order: identity ¶ → commands with CRITICAL invariants *and explicit
exceptions* → copy-pasteable test template → architecture map → Do NOT list →
Code Review Self-Check → honesty norms. (b) AGENTS.md byte-identical. (c)
Progressive disclosure by path (`src/memory/CLAUDE.md`, `src/agent/CLAUDE.md`).
(d) Managed regions fenced `<!-- ENGRAM:BEGIN/END -->` contain pointers to live
state, never synchronized copies. (e) The constitution is a separate semver'd
file, referenced not inlined. (f) Show ✅/❌ pairs wherever a format is specified.
