# Engram

Engram is a local-first agentic application and memory layer: a stateless-reducer agent loop (12-factor-agents) over an append-only event log, paired with OS-inspired tiered memory — **Core** (self-edited blocks always in the prompt), **Recall** (the event log + FTS5), **Archival** (vector BLOBs + FTS5 + entity index, written by a mem0-V3-style extraction pipeline) — all persisted in ONE `bun:sqlite` file and driven by Claude through `@anthropic-ai/sdk`. It is a self-contained example inside the mem0 repo; nothing outside this directory depends on it, and it uses Bun (not pnpm) because `bun:sqlite` IS the storage engine — this is an explicit, deliberate exception to the repo-root "pnpm only" rule, in the same spirit as `.opencode-plugin/`.

## Commands

```sh
bun install
bun test              # all tests: in-memory DB + ScriptedLLM, no network, no API key
bun run typecheck     # tsc --noEmit
bun run dev           # HTTP server on :7749 (needs ANTHROPIC_API_KEY)
bun run chat          # local REPL   (needs ANTHROPIC_API_KEY)
bun run bench:entities # entity-recall bench; results in docs/RETRIEVAL-NOTES.md
bun run verify:committed # run the suite against what git actually committed
```

- **CRITICAL: a green `bun test` proves nothing about what you shipped.** The repo-root `.gitignore` has a bare `db` pattern that once silently excluded this app's entire `src/db/` layer from every commit while local runs stayed green. Before pushing, run `bun run verify:committed` — it extracts `HEAD` and runs the suite there.
- These CRITICAL rules are not prose-only: `.claude/hooks/` denies the violating tool call and re-states the correct command (bun's pattern, deriving the app root rather than hardcoding a cwd). `test/hooks.test.ts` pins both directions — the violation refused, the legitimate neighbours allowed.
- **CRITICAL: tests must stay offline and hermetic.** Every test builds its world through `test/harness.ts` (`testWorld()` = in-memory DB + `ScriptedLLM` + `FakeEmbedder`). Never instantiate `AnthropicLLM` in a test, never point a test at a real `.sqlite` file.
  - *Exception*: WAL sidecar behavior is invisible in `:memory:`, so the `closeDb` checkpoint test may create a throwaway DB under `mkdtempSync(tmpdir())` and must `rmSync` it in a `finally`. Never a path a human would recognize as theirs.
- **CRITICAL: never write to the `events` or `memories` tables directly.** Events go through `RecallStore.appendEvent` (seq allocation + FTS projection + immediate transaction); archival mutations go through `ArchivalMemory` (hash dedup + history audit + entity relink). A raw `INSERT`/`UPDATE`/`DELETE` bypasses the audit trail and corrupts derived state.
  - *Exception*: migrations in `src/db/migrations/` define the tables — schema DDL obviously doesn't go through the facades.
  - *Exception*: tests may READ tables directly to assert storage effects.
- **CRITICAL: no `setTimeout` waits in tests.** Await the condition. The scheduler is testable by calling `tickScheduler(deps, runLoop, futureDate)` with an explicit clock.

## Test template

```typescript
import { expect, test } from "bun:test";
import { step, testWorld } from "./harness";
import { agentLoop } from "../src/agent/loop";

test("my scenario", async () => {
  const { deps } = testWorld({
    script: [step({ intent: "done_for_now", message: "hi" })], // consumed in call order
  });
  const thread = deps.store.createThread("engram", { userId: "u1", agentId: "engram" });
  deps.store.appendEvent(thread.id, "user_input", "hello");
  const finished = await agentLoop(thread.id, deps);
  expect(finished.events.filter(e => e.type === "error")).toEqual([]); // loop swallows LLM errors — assert none
  expect(finished.events.map(e => e.type)).toEqual(["user_input", "tool_call"]); // content before status
});
```

The `ScriptedLLM` validates every scripted item against the schema the caller requested. A `{ __throw: "msg" }` item makes the next call throw an `LLMError`. **Caveat**: inside `agentLoop`, LLM failures become `error` events by design — so a drifted fixture in a loop-driven test surfaces as a swallowed error event, not a test failure. Loop-driven happy-path tests must therefore also assert `finished.events.filter(e => e.type === "error")` is empty and (where fixture order matters) that `llm.calls` consumed what the comment claims.

## Architecture map

| Path | Responsibility |
|---|---|
| `src/db/` | open/migrate the single SQLite file (WAL, strict); all DDL in `migrations/` |
| `src/memory/core.ts` | Core tier: budgeted self-editable blocks, CAS versioning |
| `src/memory/recall.ts` | Recall tier: event log (only writer), scope keys, FTS search, rolling window |
| `src/memory/archival.ts` | Archival tier facade: insert/search/update/delete + history audit |
| `src/memory/scoring.ts` | Hybrid scoring (mem0 port): cosine, sigmoid-BM25, entity boost, adaptive divisor |
| `src/memory/entities.ts` | Best-effort entity→memories inverted index (regex extractor, no NLP dep) |
| `src/memory/extraction.ts` | mem0-V3 phased ADD-only pipeline; only its LLM phase throws; serialized per thread (`extract:` lock), monotonic watermark, bounded retry on partial insert failure |
| `src/memory/prefetch.ts` | Deterministic memory injection at loop entry (12-factor appendix 13) |
| `src/agent/thread.ts` | Thread/Event types, derived-status predicates, ref-map reconstruction |
| `src/agent/intents.ts` | The Zod intent union + routing table + per-agent subsetting |
| `src/agent/loop.ts` | The stateless reducer; persists tool_call BEFORE execution |
| `src/agent/execute.ts` | Pure execution switch; approval replay entry point |
| `src/agent/render.ts` | THE context seam: only place deciding what the model sees |
| `src/agent/llm.ts` | Anthropic wrapper: schema-validated output, refusal handling, retries |
| `src/agents/registry.ts` | Specialist agents as data (persona + intent subset) |
| `src/orchestration/` | Constitution loading + gate evaluation (wired: `propose_plan` gates run in `executeStep`); durable-sleep scheduler (lease + startup recovery, exactly-once wakes); per-thread promise mutex (`lock.ts`) every loop entry and extraction must hold |
| `src/evals/harness.ts` | Prompt evals: renders fixtures through the loop's own prompt path, scores replies through its own parser |
| `src/channels/cli-turn.ts` | CLI channel core: free text + derived status -> one action (`src/cli.ts` is I/O only) |
| `src/server/routes.ts` | Launch/pause/resume over HTTP; resume validated against derived status |

## Do NOT

- Mutate or delete an event row — the log is append-only (constitution I).
- Put real memory UUIDs in a prompt — integer-ref indirection only (constitution IV).
- Let scope (`user_id`/`agent_id`/`run_id`) enter payloads anywhere except `RecallStore`/`ArchivalMemory` internals; caller metadata is stripped of identity keys.
- Reintroduce exact three-column scope equality on an archival READ path — reads filter only on supplied keys (user-scoped sharing across agents); writes keep the full thread identity. Exact-match reads are the bug that made the curator agent blind to every user memory.
- Make the entity index load-bearing — it is best-effort by design; its failures warn and continue.
- Execute a gated intent inline — record it, break, and let the resume path replay it after approval.
- Use `require()` — ES module imports only (repo-wide rule).

## Code Review Self-Check

- Before a non-obvious choice, ask "why this and not the alternative?" — research until you can answer.
- If neighboring code does something differently than you're about to, find out why before deviating; its choices are often load-bearing (e.g. threshold-gating BEFORE boost in scoring is mem0's deliberate design, not an accident).
- The scoring constants (sigmoid midpoints, entity crowd penalty, divisors) are ported from mem0 — don't "tune" them casually; use `explain: true` output to justify changes.
- NEVER overstate what you got done or what actually works — in commits, PRs, or messages.

## Deeper context

- `src/memory/CLAUDE.md` — tier invariants and the write-path contract.
- `src/agent/CLAUDE.md` — event vocabulary, the render seam, and loop routing rules.

<!-- ENGRAM:BEGIN -->
Managed pointers (do not inline-copy this state elsewhere):
- Constitution: `constitution.md` (semver'd; non-negotiable — adjust work, never dilute principles).
- Architecture hand-off spec: `docs/HANDOFF-SPEC.md` (the source design this scaffold implements).
<!-- ENGRAM:END -->
