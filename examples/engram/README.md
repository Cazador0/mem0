# Engram

**A local-first agentic application and memory layer** — the "best of" synthesis of five codebases, built as a Bun + TypeScript example app:

- **[12-factor-agents]** — the agent is a *stateless reducer* over an append-only event log; one Claude call per step returns one **intent** from a Zod discriminated union; a routing switch decides execute-and-continue vs persist-and-break; approvals replay the recorded step verbatim.
- **[mem0]** — the archival write path is the V3 phased, **ADD-only extraction pipeline** (temporal grounding, integer-ref indirection, hash dedup in code, append-only history audit, best-effort entity index) and hybrid retrieval scoring (cosine + sigmoid-BM25 + entity boost with crowd penalty).
- **MemGPT-style tiers, stored the mem0 way** — **Core** blocks the agent self-edits live in every prompt with visible budget pressure; **Recall** is the event log + FTS5; **Archival** is vector BLOBs + FTS5 in the same SQLite file.
- **[spec-kit]** — a semver'd `constitution.md` referenced (never inlined); constitution gates evaluated in code on every `propose_plan` (`{principle, pass, justification?}` — justify or be sent back); bounded clarification markers; deterministic code gathers facts before LLM judgment; CLAUDE.md managed regions hold pointers, not copies.
- **[BMAD-METHOD]** — specialist agents as data with scoped intent unions; subagents run on fresh threads and return only `{verdict, summary, ref}` while full output stays in the child thread.
- **[bun]** — `bun:sqlite` (WAL, FTS5, transactions), UUIDv7 sortable ids, xxHash64 content fingerprints, and the layered CLAUDE.md/AGENTS.md context-engineering shape.

Everything persistent lives in **one SQLite file**. A thread can pause for human input or approval, sleep durably, and be resumed by id from any channel.

## Quickstart

```sh
bun install
bun test                      # hermetic: in-memory DB + scripted LLM, no API key needed

export ANTHROPIC_API_KEY=sk-ant-...
bun run chat                  # local REPL
bun run dev                   # HTTP API on :7749
bun run bench:entities        # entity-recall measurement (docs/RETRIEVAL-NOTES.md)
bun run bench:worker          # extraction-worker measurement (same file)
bun run reconcile --user you  # offline consolidation pass; plans, applies only when asked
bun run review --thread <id> --task "..."   # capsule + independent reviewer fan-out
bun run evals                 # prompt evals, recorded mode (see evals/README.md)
```

Try in chat: *"My dog is named Poppy and we walk every morning"*. The intended
path is that the agent updates its `human` core block and archives the fact, and
that a later thread has it re-injected by prefetch. The *mechanisms* are tested
(prefetch injection, core edits, extraction); whether the live model chooses
them for this sentence is not — see `evals/README.md`.

### HTTP API

```sh
curl -X POST :7749/threads -d '{"message":"remember that I prefer window seats","user_id":"hunter"}'
curl :7749/threads/<id>                        # observability = dump the log
curl -X POST :7749/threads/<id>/response \
     -d '{"type":"response","response":"yes please"}'      # resume a paused (or sleeping) thread
curl -X POST :7749/threads/<id>/response \
     -d '{"type":"approval","approved":true}'              # approve a gated memory_delete

curl -N -X POST ':7749/threads?stream=1' \
     -d '{"message":"hello","user_id":"hunter"}'           # same turn, streamed as SSE
```

`?stream=1` (or `Accept: text/event-stream`) returns the turn as Server-Sent
Events instead of one JSON blob: a `thread` frame with the id, an `event` frame
for each event as it is committed to the log, then a `done` frame carrying the
same view the JSON route returns. Frames are published *after* the append
commits, so a client never sees an event that could still roll back.

`user_id` is required — memories are scoped per user, and a shared anonymous
scope would silently merge every caller's memory. A `response` also wakes a
sleeping thread early; its pending scheduled wake is then consumed as stale.

> **Threat model**: the HTTP server is **unauthenticated by default** — it is a
> local-first example. Set `ENGRAM_API_TOKEN` to require a bearer token on every
> route except `/health`. Without it, anyone who can reach the port can resume
> threads and approve gated deletes, so the approval gate is a workflow control,
> not a security boundary.

### Offline reconciliation

Extraction is ADD-only on purpose. Consolidating what has accumulated is a
separate, explicitly-run job:

```sh
bun run reconcile --user hunter                            # plan only (default)
bun run reconcile --user hunter --apply                    # write the plan
bun run reconcile --user hunter --apply --approve-deletes  # ...including a large delete batch
```

It clusters near-duplicates by cosine (`ENGRAM_RECONCILE_THRESHOLD`), asks the
model for UPDATE/DELETE/NONE per cluster, and applies the result through the
archival facade so every mutation is audited with actor `reconcile`. A pass that
wants to delete more than five memories applies **nothing** and reports
`awaiting_approval`; a cluster is never emptied. Memories stored without a
vector cannot be clustered and are reported, not guessed at.

### Review fan-out

A capsule is a task brief compiled to be self-contained — the thread's own
history, the archival memories that match the task, and the constitution's
principle titles — so a reviewer needs nothing else:

```sh
bun run review --thread <thread_id> --task "delete the six duplicate flight memories"
```

Each reviewer gets a **different slice** of that capsule (evidence sees the
memories, risk sees the history, scope sees the constitution) and cannot see the
others' findings, so three reviewers are three opinions rather than one opinion
three times. Each writes only its own section — enforced in code, with a
compare-and-set on the section version — and returns one bounded verdict while
its full reasoning stays in its own thread. Reviewers inform; they never apply
anything.

## Configuration

| Env var | Default | Meaning |
|---|---|---|
| `ANTHROPIC_API_KEY` | — | required for `dev`/`chat` (tests never need it) |
| `ENGRAM_MODEL` | `claude-opus-5` | Claude model for every call |
| `ENGRAM_FALLBACKS` | `on` | server-side refusal fallbacks (beta) — set `off` to disable |
| `ENGRAM_DB` | `engram.sqlite` | SQLite path (`:memory:` for ephemeral) |
| `ENGRAM_EMBEDDINGS_URL` | — | OpenAI-compatible embeddings base URL; unset = degraded FTS+entity search |
| `ENGRAM_EMBEDDINGS_MODEL` / `_DIMS` | `text-embedding-3-small` / `1536` | embedding config |
| `ENGRAM_EMBEDDINGS_API_KEY` | — | bearer token for the embeddings endpoint (omit for keyless local servers) |
| `ENGRAM_MAX_STEPS` | `20` | LLM steps per turn (12-factor factor 10) |
| `ENGRAM_SEMANTIC_THRESHOLD` | `0.3` | semantic gate before boosting; upstream mem0 defaults to `0.1` (see `docs/RETRIEVAL-NOTES.md`) |
| `ENGRAM_RECONCILE_THRESHOLD` | `0.85` | cosine at which two stored memories are clustered as near-duplicates by `bun run reconcile` |
| `ENGRAM_EXTRACTION_WORKER` | `off` | `on` runs extraction's candidate scan in a read-only Worker; keeps the event loop free during a scan (measured in `docs/RETRIEVAL-NOTES.md`) |
| `ENGRAM_USER` | `$USER`, else `local` | memory scope for `bun run chat`; warns when neither is set (all sessions would share one scope) |
| `ENGRAM_API_TOKEN` | — | when set, every route except `/health` requires `Authorization: Bearer <token>` |
| `PORT` | `7749` | HTTP port |

## What's here vs. what's next

Implemented and tested: the reducer loop with routing/gating/escalation, all three memory tiers with audit history, cross-agent user-scoped retrieval, the extraction pipeline (per-thread serialized, monotonic watermark, bounded retry of failed inserts) with provenance + linking, exactly-once durable wake delivery (lease + startup recovery), constitution-gated planning, opt-in bearer auth, SSE streaming of a turn, the offline reconciliation job (cosine clustering, audited UPDATE/DELETE, volume-gated deletes), opt-in Worker-isolated extraction reads, the capsule compiler with asymmetric reviewer envelopes and code-enforced section ownership, hybrid scoring, entity index, recorded-mode prompt evals, render-seam compaction of long threads, a pinned prepared-statement cache, two of the four CLAUDE.md CRITICAL rules enforced by PreToolUse hooks, durable sleep + scheduler, subagent spawn, HTTP pause/resume including approval and early-wake happy paths. The CLI's turn dispatch (`src/channels/cli-turn.ts`) is tested end-to-end — approve, deny, ambiguous re-prompt, early wake, LLM failure — leaving only the terminal I/O shell in `src/cli.ts` manual.

Honest roadmap (designed in `docs/HANDOFF-SPEC.md`, not yet built): WebSocket topic fanout of lifecycle events, and the CLAUDE.md marker-region generator.

Known constraints (deliberate for a local-first example): the per-thread lock is in-process, so exactly one Engram process may own a database file; entity matching is exact normalized-text (no embedding round-trip) — plural/paraphrase mentions miss where mem0's semantic matching would hit, measurable via `explain: true`.

## Architecture

See `CLAUDE.md` for the module map and invariants, `constitution.md` for the seven non-negotiable principles, and `docs/HANDOFF-SPEC.md` for the full architecture hand-off specification this scaffold implements.

[12-factor-agents]: https://github.com/humanlayer/12-factor-agents
[mem0]: https://github.com/mem0ai/mem0
[spec-kit]: https://github.com/github/spec-kit
[BMAD-METHOD]: https://github.com/bmad-code-org/BMAD-METHOD
[bun]: https://github.com/oven-sh/bun
