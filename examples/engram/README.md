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
bun run evals                 # prompt evals, recorded mode (see evals/README.md)
```

Try in chat: *"My dog is named Poppy and we walk every morning"* → the agent updates its `human` core block and archives the fact; in a later thread, prefetch injects it back into context.

### HTTP API

```sh
curl -X POST :7749/threads -d '{"message":"remember that I prefer window seats","user_id":"hunter"}'
curl :7749/threads/<id>                        # observability = dump the log
curl -X POST :7749/threads/<id>/response \
     -d '{"type":"response","response":"yes please"}'      # resume a paused (or sleeping) thread
curl -X POST :7749/threads/<id>/response \
     -d '{"type":"approval","approved":true}'              # approve a gated memory_delete
```

`user_id` is required — memories are scoped per user, and a shared anonymous
scope would silently merge every caller's memory. A `response` also wakes a
sleeping thread early; its pending scheduled wake is then consumed as stale.

> **Threat model**: the HTTP server is **unauthenticated by default** — it is a
> local-first example. Set `ENGRAM_API_TOKEN` to require a bearer token on every
> route except `/health`. Without it, anyone who can reach the port can resume
> threads and approve gated deletes, so the approval gate is a workflow control,
> not a security boundary.

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
| `ENGRAM_USER` | `$USER`, else `local` | memory scope for `bun run chat`; warns when neither is set (all sessions would share one scope) |
| `ENGRAM_API_TOKEN` | — | when set, every route except `/health` requires `Authorization: Bearer <token>` |
| `PORT` | `7749` | HTTP port |

## What's here vs. what's next

Implemented and tested: the reducer loop with routing/gating/escalation, all three memory tiers with audit history, cross-agent user-scoped retrieval, the extraction pipeline (per-thread serialized, monotonic watermark, bounded retry of failed inserts) with provenance + linking, exactly-once durable wake delivery (lease + startup recovery), constitution-gated planning, opt-in bearer auth, hybrid scoring, entity index, recorded-mode prompt evals, durable sleep + scheduler, subagent spawn, HTTP pause/resume including approval and early-wake happy paths. The CLI's turn dispatch (`src/channels/cli-turn.ts`) is tested end-to-end — approve, deny, ambiguous re-prompt, early wake, LLM failure — leaving only the terminal I/O shell in `src/cli.ts` manual.

Honest roadmap (designed in `docs/HANDOFF-SPEC.md`, not yet built): offline LLM reconciliation job (ADD/UPDATE/DELETE/NONE as an audited, approval-gated compaction pass), compaction/distillation of the elided event region at the render seam, trimming the hot path to bun:sqlite's 20-statement `db.query()` cache, PreToolUse hooks that mechanically enforce the CLAUDE.md CRITICAL rules, SSE token streaming, Worker-isolated extraction via `db.serialize()`, BMAD-style capsule compiler + asymmetric review fan-out.

Known constraints (deliberate for a local-first example): the per-thread lock is in-process, so exactly one Engram process may own a database file; entity matching is exact normalized-text (no embedding round-trip) — plural/paraphrase mentions miss where mem0's semantic matching would hit, measurable via `explain: true`.

## Architecture

See `CLAUDE.md` for the module map and invariants, `constitution.md` for the seven non-negotiable principles, and `docs/HANDOFF-SPEC.md` for the full architecture hand-off specification this scaffold implements.

[12-factor-agents]: https://github.com/humanlayer/12-factor-agents
[mem0]: https://github.com/mem0ai/mem0
[spec-kit]: https://github.com/github/spec-kit
[BMAD-METHOD]: https://github.com/bmad-code-org/BMAD-METHOD
[bun]: https://github.com/oven-sh/bun
