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
| BMAD-METHOD | Specialist agents as **data** `{id, persona, intentUnion subset}`; subagents run on fresh threads, write full output there, and return `{verdict, summary, ref}` (bounded to 500 chars); CAS state transitions (`UPDATE … WHERE <expected previous state>`); capsule compiler with per-section read envelopes and code-enforced write ownership, and asymmetric-context review fan-out |
| bun | `bun:sqlite` WAL + strict + prepared statements + immediate transactions; FTS5 for both Recall and Archival keyword legs; UUIDv7 PKs (sortable = free recency); xxHash64 content fingerprints; layered CLAUDE.md with enforced invariants; hermetic test harness. Platform caveats: FTS5 is guaranteed only where Bun statically links SQLite (Linux/Windows) — on macOS it dlopens the system libsqlite3, so `openDb` probes FTS5 at startup (constitution VII) and `closeDb` checkpoints the WAL, wired to SIGINT/SIGTERM in `src/index.ts` and to SIGINT in `src/cli.ts`; `Database.setCustomSQLite(path)` is the macOS remedy. `db.query()` caches at most 20 persistent prepared statements per Database, first-come-first-served with **no eviction** (`willCache = cachedQueriesKeys.length < 20`, /home/user/bun/src/js/bun/sqlite.ts:566) — so it is not that hot statements churn, it is that whichever 20 strings are seen FIRST are cached forever and every other string re-prepares on every call. The codebase routes 53 call sites / 47 distinct SQL strings through it, so which statements win would otherwise be an accident of startup order. `src/db/statements.ts` claims the cache for a named hot set at bootstrap, importing the same string constants the call sites use so the list cannot drift |

## 3. Storage schema (single SQLite file)

See `src/db/migrations/`: `001_init.sql`, `002_schedule_sleep_seq.sql`,
`003_schedule_lease.sql`, `004_extract_failures.sql`, `005_compactions.sql`.
Each is applied once, in order, recorded in a `migrations` table.

- `threads` — id (uuidv7), agent_id, scope_key, user/run ids, `status_hint` (display cache only — status is always derived), `extracted_seq` extraction watermark, `extract_failures` (004) bounding how long the watermark is held for retry.
- `events` — the Recall tier and reducer state; `UNIQUE(thread_id, seq)`; closed type enum `user_input | system_note | tool_call | tool_response | human_response | error | memory_write`; `events_fts` (FTS5) over a text projection.
- `core_blocks` — per-agent labeled blocks with `char_limit`, `read_only`, CAS `version`.
- `memories` — Archival tier: content, xxHash64 `hash` (UNIQUE per scope), embedding BLOB (nullable), scope columns, `memory_type` (fact|decision|procedural), provenance (`source_thread_id`, `source_event_seqs`), `expiration_date`, metadata JSON; `memories_fts` for the BM25 leg.
- `entities` — entity → `linked_memory_ids` inverted index (regex-extracted, best-effort).
  Note `memories.metadata.links` is a SEPARATE, currently **write-only** graph:
  extraction stores the ids of related existing memories it linked against, but
  no retrieval path reads them back yet (only the entity index boosts). Either
  consume it in retrieval or drop it; leaving it written-and-unread is the kind
  of half-feature that reads as working.
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
- `compactions` — distillate of a thread's pre-tail events, keyed
  `(thread_id, up_to_seq)` so compaction is idempotent per boundary (005). The
  summary lives here rather than in the event log (whose vocabulary is closed)
  or the archival store (which is cross-thread, where half a conversation could
  surface in an unrelated search).
- `artifacts` + `artifact_sections` — compiled capsules: one row per capsule, one row per section carrying its owner and version.

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

**Proposed in the research synthesis and deliberately NOT adopted**:
`constitution_amend` (an approval-gated amendment that bumps the constitution's
semver) — amending the rules from inside the loop the rules govern is a
capability this app should not hand an agent; edit `constitution.md` in a commit
where a human reviews the diff. `handoff` (a CAS pipeline-phase transition) —
Engram has no multi-phase pipeline to hand off between; `spawn_subagent` covers
delegation, and a phase machine would be machinery without a user.

## 5. Module breakdown

```
engram/
├── CLAUDE.md, AGENTS.md (byte-identical), constitution.md, README.md
├── .claude/{settings.json,hooks/*.js}           # CRITICAL rules enforced as PreToolUse denials
├── docs/{HANDOFF-SPEC,RETRIEVAL-NOTES}.md
├── evals/{fixtures.ts,recorded/*.txt,README.md}  # prompt-eval corpus (recorded mode)
├── scripts/{bench-entity-recall,bench-extraction-worker,record-evals,reconcile,review}.ts, verify-committed.sh
├── src/
│   ├── index.ts / cli.ts / bootstrap.ts / config.ts / deps.ts
│   ├── db/{database,statements}.ts + db/migrations/00{1..5}_*.sql
│   ├── memory/{core,recall,archival,scoring,entities,embeddings,extraction,prefetch,procedural,compaction,reconcile}.ts
│   ├── memory/reader-{client,worker,protocol}.ts  # opt-in read-only scan Worker
│   ├── prompts/{extraction,nextstep,reconcile}.ts # the multi-paragraph system prompts
│   ├── agent/{thread,intents,loop,execute,render,llm,approval,escape}.ts
│   ├── channels/cli-turn.ts                    # CLI channel core; src/cli.ts is I/O only
│   ├── evals/harness.ts                        # prompt evals: render + score via the loop's own path
│   ├── agents/registry.ts
│   ├── orchestration/{gates,scheduler,lock,capsule}.ts # lock = per-thread promise mutex
│   └── server/routes.ts                     # HTTP; the same turn streams as SSE on ?stream=1
└── test/{harness,preload}.ts + *.test.ts
```

Note that `prompts/` holds the two long system prompts, not literally every
model-facing string: `agent/intents.ts` INTENT_DOCS is rendered verbatim into
the system prompt, and `agent/llm.ts` composes the parse-retry feedback.

`server/routes.ts` serves one turn in two presentations. The JSON view awaits
the loop and returns `threadView`; `?stream=1` (or `Accept: text/event-stream`)
returns an async-generator Response that emits `thread` → one `event` frame per
committed log event → `done` carrying that same `threadView`. The frames come
from `RecallStore`'s **post-commit** subscription, so a client can never observe
an event that could still roll back, and the generator's `finally` releases the
subscription on client disconnect. `server.timeout(req, 0)` is required: a
multi-step turn outlives Bun's 10s default idle timeout. Streaming is strictly a
view — it adds no second write path, and a throwing subscriber cannot fail an
append.

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

### Offline reconciliation (`memory/reconcile.ts`)

The counterpart to ADD-only extraction, and the only path where a model decides
to rewrite or delete stored memory. Four rules make that safe enough to ship:

1. **Plan by default.** `reconcile()` returns the decision list; `apply: true`
   is what writes. `bun run reconcile` plans unless told otherwise.
2. **Deletes are gated by volume, not by item.** More than
   `DELETE_APPROVAL_THRESHOLD` (5) deletes in one pass applies *nothing* and
   returns `awaiting_approval`. Holding back only the deletes would apply the
   merges that justified them and leave the store duplicated, so the pass is
   withheld whole.
3. **A cluster is never emptied.** If every ref comes back DELETE the newest
   member is force-kept — a later memory is the current state of the fact.
4. **Mutations go through `ArchivalMemory`** with actor `reconcile`, so each one
   re-embeds, reindexes FTS, relinks entities and writes its `memory_history`
   row. This trades cross-decision atomicity (each mutation is its own
   transaction) for those side effects; the audit trail is what makes a partial
   pass reconstructible.

**Clustering is raw cosine over stored vectors** (`ENGRAM_RECONCILE_THRESHOLD`,
default 0.85 — between mem0's 0.95 entity upsert and its 0.5 read floor), seed-
centric rather than single-link so A~B~C chaining cannot hand the model a topic
instead of a duplicate. It is deliberately *not* `search()`: that score answers
"how well does this row match a short query", and its adaptive divisor and
boosts make it incomparable between two stored memories — on the test corpus a
genuine near-duplicate pair scored 0.45 while a memory scored 0.62 against
itself. The honest cost is that a memory with no vector cannot be clustered;
the pass reports `skippedNoVector` rather than falling back to token overlap,
which would cluster on shared stopwords.

**No ADD verb**, unlike mem0's `DEFAULT_UPDATE_MEMORY_PROMPT`. mem0's reconciler
runs against newly extracted facts, so ADD is how they enter the store; this one
runs over memories that are already stored, and a minted memory would carry no
`source_thread_id`/`source_event_seqs`. Consolidation is UPDATE on the keeper
plus DELETE on the rest, keeping extraction the single ADD path.

### Worker-isolated extraction reads (`memory/reader-*.ts`, opt-in)

`ENGRAM_EXTRACTION_WORKER=on` moves extraction's Phase-1 candidate scan — up to
`CANDIDATE_LIMIT` rows, every stored vector decoded and cosined — into a Worker.
Three rules make that safe:

1. **The Worker never writes.** It opens the database read-only, so WAL readers
   coexist with the main thread's single writer. Every write stays on the main
   thread under the `extract:<threadId>` lock. The spec's original "write batches
   back through a single-writer queue" is realized as "there are no writes to
   send back", which is the stronger version of the same invariant.
2. **The Worker never embeds.** The main thread computes the query vector (it had
   to embed anyway) and passes it; no API key, no network, no secret crosses the
   boundary. `ArchivalMemory.embedQuery` exists for exactly this.
3. **It is an optimization, never a dependency.** Spawn failure, an unopenable
   path, or a mid-scan death falls back to the in-thread scan with a warning —
   an extraction must not fail because a performance feature did.

`db.serialize()` is used only for `:memory:` databases, which no second
connection can reach; that copy is O(database size) *per scan*, so in-memory
stores are where this feature can cost more than it saves. Measured numbers, and
why it ships off by default, are in `docs/RETRIEVAL-NOTES.md`: the scan blocks
the event loop for essentially its whole duration in-thread (79ms at 3000
memories) versus ~1ms through the Worker. The gain is latency fairness, not
throughput — nothing gets faster, other work stops being blocked.

### Capsule compiler + review fan-out (`orchestration/capsule.ts`)

A capsule is a task brief compiled to be **self-contained**: an agent handed one
needs nothing else. Compilation is deterministic host code — it harvests BMAD's
Agent Records (the thread's stored distillate plus its recent turns) and the
archival memories matching the task, so the model is asked to judge, not to
gather. Memory content only, never ids (constitution IV), and all harvested text
is angle-bracket escaped like every other read-side injection.

It is stored as SECTIONS because both permissions are per section:

- **Read** — a reviewer's envelope is the set of sections it is handed, declared
  as data on the agent (`AgentDefinition.review.parts`). `reviewer-evidence` gets
  `task` + `memories`, `reviewer-risk` gets `task` + `history`, `reviewer-scope`
  gets `task` + `constitution`. That asymmetry is the feature: three reviewers on
  one identical envelope buy one opinion three times. Reviewers never see each
  other's sections, so a fan-out cannot converge by reading itself.
- **Write** — one owner per section, checked in `writeSection` rather than asked
  for in a prompt, with a compare-and-set on `version` (BMAD's CAS). Sections the
  host compiled have no owner and are immutable to every agent.

Reviewers are registry agents with two intents only — `complete_task` and
`needs_clarification`. A reviewer that could search would pull in the context its
envelope deliberately withheld; one that could not decline would fabricate rather
than admit a thin envelope. Each runs on its own fresh thread, concurrently,
under its own thread lock; the parent receives `{verdict, summary, ref}` and the
reasoning stays in the child thread. A reviewer that crashes records `failed` and
does not fail the fan-out.

Reviewers inform, they do not decide: `scripts/review.ts` prints verdicts and
applies nothing. Gating a change on an LLM panel would just move the approval
away from the human it belongs to.

## 7. Roadmap (specified, not yet built)

- **WebSocket topic fanout** of lifecycle events, so a client can watch threads
  it did not start. (Per-turn SSE streaming on `POST /threads` is built — §5;
  what remains is the many-threads, many-watchers fanout.)
- **CLAUDE.md generator** (`context/claudemd.ts`): marker-region upsert handling
  all four corruption states, manifest-hash ownership, pointer-not-copy content.

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
