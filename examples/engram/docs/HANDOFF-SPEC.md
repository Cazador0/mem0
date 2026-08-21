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
| mem0 (V3 pipeline) | ADD-only extraction (one LLM call, per-message temporal grounding against each message's own date, integer-ID indirection, rich-not-atomic 15–80-word memories, no-fabrication/no-echo rules), xxHash64 code-side dedup, insert with per-item fallback, append-only history audit table, entity side-index with crowd-penalty boost, hybrid scoring with semantic-threshold gating *before* boosting, scope keys entering payloads in exactly one function, identity-key stripping at write entries, expiration filtered at read time, procedural memory via verbatim-preserving run summarization; ADD/UPDATE/DELETE/NONE reconciliation survives **only** as an offline, audited, approval-gated compaction job *(roadmap)*. **Deliberate simplification vs mem0**: entity matching is exact normalized-text with similarity fixed at 1 (no TOPIC type, no embedding round-trip) — mem0 upserts entities at ≥0.95 similarity and matches reads at a 0.5 floor, so plural/paraphrase mentions that mem0 would catch are missed here; the recall cost is measurable via `explain: true`, and semantic entity matching is an optional upgrade when an embedder is configured |
| spec-kit | `constitution.md` (semver + ratified/amended dates) rendered as a read-only core block — "rendered" per §8(d–e): the block holds version + digest + a pointer, never an inlined copy; structured gate results `{principle, pass, justification?}` — unjustified failure is an ERROR, and a gate naming a principle that is not in constitution.md is rejected too (the `propose_plan` intent carries them; evaluation runs in code, not in the prompt); `needs_clarification` intent with max-3 impact-ranked markers and recommended-option quick replies; deterministic code gathers facts before any LLM judgment; CLAUDE.md managed region between markers that points at live state |
| BMAD-METHOD | Specialist agents as **data** `{id, persona, intentUnion subset}`; subagents run on fresh threads, write full output there, and return `{verdict, topFindings, ref}`; CAS state transitions (`UPDATE … WHERE <expected previous state>`); capsule compiler and asymmetric-context review fan-out *(roadmap)* |
| bun | `bun:sqlite` WAL + strict + prepared statements + immediate transactions; FTS5 for both Recall and Archival keyword legs; UUIDv7 PKs (sortable = free recency); xxHash64 content fingerprints; layered CLAUDE.md with enforced invariants; hermetic test harness. Platform caveats: FTS5 is guaranteed only where Bun statically links SQLite (Linux/Windows) — on macOS it dlopens the system libsqlite3, so `openDb` probes FTS5 at startup (constitution VII) and `closeDb` checkpoints the WAL, wired to SIGINT/SIGTERM in `src/index.ts` and to SIGINT in `src/cli.ts`; `Database.setCustomSQLite(path)` is the macOS remedy. `db.query()` caches at most 20 persistent prepared statements per Database — the codebase currently routes ~38 distinct SQL strings through it, so hot statements churn through re-prepare *(trimming to a fixed hot set is roadmap)* |

## 3. Storage schema (single SQLite file)

See `src/db/migrations/` (`001_init.sql`, plus `002_schedule_sleep_seq.sql` —
schedules rows carry the creating `sleep_until` event's seq so a superseded
sleep's wake is consumed as stale instead of waking the newer sleep early):

- `threads` — id (uuidv7), agent_id, scope_key, user/run ids, `status_hint` (display cache only — status is always derived), `extracted_seq` extraction watermark, `extract_failures` (004) bounding how long the watermark is held for retry.
- `events` — the Recall tier and reducer state; `UNIQUE(thread_id, seq)`; closed type enum `user_input | system_note | tool_call | tool_response | human_response | error | memory_write`; `events_fts` (FTS5) over a text projection.
- `core_blocks` — per-agent labeled blocks with `char_limit`, `read_only`, CAS `version`.
- `memories` — Archival tier: content, xxHash64 `hash` (UNIQUE per scope), embedding BLOB (nullable), scope columns, `memory_type` (fact|decision|procedural), provenance (`source_thread_id`, `source_event_seqs`), `expiration_date`, metadata JSON; `memories_fts` for the BM25 leg.
- `entities` — entity → `linked_memory_ids` inverted index (regex-extracted, best-effort).
- `memory_history` — append-only audit of every ADD/UPDATE/DELETE with before/after values; deletes soft in history.
- `schedules` — durable sleep rows; `sleep_seq` links each row to its creating
  event (002), and `claimed_at` (003) makes the claim a **lease**. Delivery is
  **exactly-once for the observable wake event**: the lease only prevents two
  tickers racing, while `SET fired = 1 WHERE fired = 0` runs in the same
  transaction that appends the wake note, so a crash before that transaction
  loses nothing (the row is reclaimed once the lease expires, or immediately at
  startup) and a duplicate delivery appends nothing. A crash *after* the note
  but before the loop finishes is reconciled by `recoverPendingWakes` at
  startup.
- `artifacts` — registry for capsule/artifact handoffs *(roadmap: capsule compiler)*.

**Scope semantics** (mem0 parity): writes store the full thread identity
(`user_id`, `agent_id`, `run_id`, absent keys normalized to `""`), and write-side
dedup is exact on all three columns. **Reads filter only on the keys the caller
supplies** — `archival_search`, prefetch, and extraction Phase 1 pass
`{userId}` alone, so memories belong to the *user* and a curator thread sees
what engram threads wrote. A supplied `""` matches exactly; it never wildcards.

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
| `propose_plan` | sync | `{summary, steps[1..10], gate_results[{principle, pass, justification?}]}` — rejected back to the model if a failing gate lacks a justification or names an unknown principle |
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
│   ├── db/database.ts + db/migrations/{001_init,002_schedule_sleep_seq}.sql
│   ├── memory/{core,recall,archival,scoring,entities,embeddings,extraction,prefetch,procedural}.ts
│   ├── prompts/{extraction,nextstep}.ts        # every LLM-facing template in one place
│   ├── agent/{thread,intents,loop,execute,render,llm,approval}.ts
│   ├── channels/cli-turn.ts                    # CLI channel core; src/cli.ts is I/O only
│   ├── evals/harness.ts                        # prompt evals: render + score via the loop's own path
│   ├── agents/registry.ts
│   ├── orchestration/{gates,scheduler,lock}.ts # lock = per-thread promise mutex
│   └── server/routes.ts
├── evals/{fixtures.ts,recorded/*.txt,README.md}  # prompt-eval corpus (recorded mode)
└── test/{harness,preload}.ts + *.test.ts
```

`orchestration/lock.ts` is load-bearing: **every** loop entry (HTTP create and
resume, scheduler wakes, the CLI) runs under `withThreadLock(threadId, …)`, and
background extraction serializes under its own `extract:<threadId>` key. The
lock is in-process — exactly one Engram process may own a database file; a
second process would interleave loop entries (the seq UNIQUE constraint makes
losers fail loudly, but the log would still record a garbled conversation).

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
8. **Step budget & turn boundaries**: `maxSteps` (config default 20, per-agent
   override) bounds LLM steps per TURN, not per thread lifetime. Turn boundaries
   are `user_input`, `human_response`, `system_note` (scheduler wake), and
   `tool_response` events flagged `via_human: true`. Every channel that resumes a
   thread with a human approval/denial MUST set `via_human` on the appended
   `tool_response` — a channel that forgets it makes long approval chains exhaust
   the budget and brick the thread. (The CLI and HTTP resume paths both comply.)
9. **Constitution gates run in code.** `propose_plan` carries `gate_results`;
   `executeStep` evaluates them via `orchestration/gates.ts` and hands failures
   back as an `ok: false` tool_response. The system prompt lists principle
   TITLES only — the constitution itself stays a pointer (§8e), never inlined.
10. **Read vs write scope**: archival writes carry the full thread identity;
   archival reads are user-scoped subset filters (see §3 "Scope semantics").
   New read paths must not silently reintroduce exact three-column equality —
   that is the bug that made the curator agent blind to every user memory.

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
- **CLAUDE.md generator** (`context/claudemd.ts`): marker-region upsert handling
  all four corruption states, manifest-hash ownership, pointer-not-copy content.
- **Render-seam compaction**: today everything beyond the 50-event verbatim tail
  is elided behind a marker pointing at `recall_search`, which recovers keyword
  hits but not mid-thread commitments. 12-factor's stored-vs-rendered doctrine
  sanctions summarizing the elided region; BMAD's distillator supplies the
  contract (compression-not-summarization; never drop decisions, rejected
  alternatives, open questions, constraints; completeness checks). The obvious
  next feature for long-lived threads.

  **Open design question, to settle before building it.** Summarizing needs an
  LLM call, but `render.ts` is deliberately pure and synchronous — the seam must
  not acquire a network dependency, and rendering must never mutate the log
  (constitution I). The summary therefore has to be produced elsewhere and only
  READ at render time. Three candidate homes, none free:
  1. **An event** (a `compaction` type). Natural for an append-only log and it
     survives restarts, but the event vocabulary is closed: adding a type means
     updating every derived-status predicate and `render.ts` in the same change,
     and it must behave as an annotation (like `memory_write`) or it will change
     what threads appear to be waiting for.
  2. **An archival memory** (`memoryType: "procedural"`, metadata naming the
     thread and covered seq range) — reuses `procedural.ts` and its audit trail,
     but puts thread-local context into the cross-thread store, where a later
     `archival_search` could surface half a conversation to an unrelated thread.
  3. **A dedicated `compactions` table** keyed by `(thread_id, up_to_seq)` — the
     cleanest separation and the easiest to invalidate, at the cost of a fourth
     storage shape plus a migration.

  Whichever wins: compaction must be triggered from the loop (where awaits are
  allowed), be idempotent per `up_to_seq`, and leave the canonical events intact
  so `recall_search` still reaches the originals.
- **Statement-cache trim**: precompile the hot path (appendEvent, search) as a
  fixed set of ≤20 `db.query()` statements; move the long tail to `prepare()`.
- **Mechanical rule enforcement**: PreToolUse hooks that deny `bun test` against
  a real `.sqlite` path and raw INSERTs into `events`/`memories` in test code —
  bun's proven pattern, deriving the repo root rather than hardcoding it.

**Threat model note**: the HTTP server is unauthenticated by default (local-first
example); `ENGRAM_API_TOKEN` opts into bearer auth on every route except
`/health`. With no token set, anyone who can reach the port can resume threads
and approve gated deletes — the approval gate is a workflow control, not a
security boundary. There is still no per-user authorization: a valid token
grants access to every thread and every user scope.

## 8. CLAUDE.md generation guidelines

(a) Root order: identity ¶ → commands with CRITICAL invariants *and explicit
exceptions* → copy-pasteable test template → architecture map → Do NOT list →
Code Review Self-Check → honesty norms. (b) AGENTS.md byte-identical. (c)
Progressive disclosure by path (`src/memory/CLAUDE.md`, `src/agent/CLAUDE.md`).
(d) Managed regions fenced `<!-- ENGRAM:BEGIN/END -->` contain pointers to live
state, never synchronized copies. (e) The constitution is a separate semver'd
file, referenced not inlined. (f) Show ✅/❌ pairs wherever a format is specified.
