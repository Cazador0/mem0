# Handoff Prompt — Engram

*Paste everything below the line into a fresh Claude Code (Opus 5) session. It is
written to be read by an agent with no memory of the work, and every claim in it
was verified against the repos at handoff time rather than recalled.*

---

You are picking up a finished, pushed body of work and extending it. Read this
whole document before touching anything. It is long because the alternative is
you rediscovering the traps in §6 the expensive way — each one already cost a
session.

## 1. What exists

**Engram** is a local-first agentic application and memory layer living at
`examples/engram/` inside a fork of mem0. It is a stateless-reducer agent loop
(12-factor-agents) over an append-only event log, with MemGPT-style tiered memory
— **Core** (self-edited blocks always in the prompt), **Recall** (the event log +
FTS5), **Archival** (vector BLOBs + FTS5 + entity index, written by a mem0-V3
extraction pipeline) — all in ONE `bun:sqlite` file, driven by Claude through
`@anthropic-ai/sdk`.

It is a synthesis of five codebases, all of which are checked out on this machine
and all of which carry a research-notes commit on the same branch.

Scale: ~5,380 lines of TypeScript across 40 files under `src/`, plus 6 SQL
migrations. 170 tests across 14 files. 5 agents, 14 intents, 7 constitution
principles.

## 2. The five repositories — exact state at handoff

Every repo is on branch **`claude/agentic-framework-research-7yr94s`**, clean,
and pushed. Do not develop on any other branch.

| Repo | Head | Role | PR |
|---|---|---|---|
| `Cazador0/mem0` | `0e35757` | **The application.** 20 commits, all confined to `examples/engram/` | [#1](https://github.com/Cazador0/mem0/pull/1) — open |
| `Cazador0/bun` | `e54ff51` | Research input. Adds `ENGRAM-RESEARCH-NOTES.md` only | [#1](https://github.com/Cazador0/bun/pull/1) — open |
| `Cazador0/BMAD-METHOD` | `787f283` | Research input. Notes only | none |
| `Cazador0/spec-kit` | `7be15cd` | Research input. Notes only | none |
| `Cazador0/12-factor-agents` | `bfd3093` | Research input. Notes only | none |

Neither fork has GitHub Actions enabled: **0 check runs and 0 statuses is the
resting state, not a pending or failing run.** Do not wait for CI that will never
arrive, and do not report "CI pending" as a blocker.

Both PRs are subscribed for activity. An hourly self check-in
(`trig_01N6oPBDWSfNEbqT7iUEnby5`) re-checks both and re-arms silently when
nothing changed.

The four research-notes files are cross-repo claims about a codebase that kept
moving, so **every shipped roadmap item silently invalidates a row in one of
them.** Two have already been corrected for exactly this. If you build the
WebSocket fanout, fix `bun`'s WebSocket row; if you build the CLAUDE.md
generator, fix `spec-kit`'s hash-manifest row.

## 3. Where everything is

| Path | Responsibility |
|---|---|
| `src/db/` | Open/migrate the one SQLite file (WAL, strict). All DDL in `migrations/`. `statements.ts` claims bun's 20-slot query cache for the hot set |
| `src/memory/core.ts` | Core tier: budgeted self-editable blocks, CAS versioning |
| `src/memory/recall.ts` | Recall tier: the event log (**only writer**), scope keys, FTS search, rolling window, post-commit subscriptions |
| `src/memory/archival.ts` | Archival facade: insert/search/update/delete + history audit |
| `src/memory/scoring.ts` | Hybrid scoring ported from mem0: cosine, sigmoid-BM25, entity boost, adaptive divisor |
| `src/memory/entities.ts` | Best-effort entity→memory inverted index (regex, no NLP dep) |
| `src/memory/extraction.ts` | mem0-V3 phased ADD-only pipeline; per-thread `extract:` lock, monotonic watermark, bounded retry |
| `src/memory/reconcile.ts` | Offline consolidation — the ONLY model-driven mutation path |
| `src/memory/compaction.ts` | Distils pre-tail events into a stored summary for the render seam |
| `src/memory/prefetch.ts` | Deterministic memory injection at loop entry |
| `src/memory/reader-{client,worker,protocol}.ts` | Opt-in read-only Worker for the candidate scan |
| `src/agent/thread.ts` | Thread/Event types, derived-status predicates, ref-map reconstruction |
| `src/agent/intents.ts` | The Zod intent union + routing table + per-agent subsetting |
| `src/agent/loop.ts` | The stateless reducer; persists `tool_call` BEFORE execution |
| `src/agent/execute.ts` | Pure execution switch; approval replay entry point |
| `src/agent/render.ts` | **THE context seam** — the only place deciding what the model sees |
| `src/orchestration/capsule.ts` | Capsule compiler + review fan-out; per-section read envelopes and write ownership |
| `src/orchestration/{gates,scheduler,lock}.ts` | Constitution gates; durable-sleep scheduler with lease; per-thread promise mutex |
| `src/server/routes.ts` | HTTP launch/pause/resume; `?stream=1` serves the same turn as SSE |
| `docs/HANDOFF-SPEC.md` | **The architecture spec.** Read §2 (attribution), §3 (scope semantics), §6 (implementation rules) |
| `docs/RETRIEVAL-NOTES.md` | Two measurements, each stating its own limits |

## 4. Git history — what happened and why

Read as four eras. `git log --oneline origin/main..HEAD` in `mem0`.

**Era 1 — scaffold (`113b1e6` … `474ff7a`, `c83c007`, `f18ab20`).** Three-phase
build: research five repos, synthesize `HANDOFF-SPEC.md`, scaffold. Then three
adversarial review rounds against the scaffold.

**Era 2 — the ultra review (`0c81ade` … `df83410`).** Two large fan-out
workflows re-researched and re-reviewed everything. Four dual-confirmed defects
were fixed, the biggest being **cross-agent memory invisibility**: reads required
exact equality on all three scope columns, so a curator thread
(`agent_id='curator'`) saw zero of the user's memories written as
`agent_id='engram'`. Fixed by adopting mem0's subset read semantics.
`4618cec` added exactly-once wake delivery, bounded extraction retry, gated
planning, and opt-in bearer auth.

**Era 3 — the honesty correction (`64aeb29`, `067e120`, `3c7a5bb`, `998b181`).**
`64aeb29` is the most important commit in the history. See §6.1.

**Era 4 — the eight roadmap items (`1162110` … `0e35757`).** Recorded-mode prompt
evals, PreToolUse hooks, render-seam compaction, statement-cache pinning, SSE
streaming, offline reconciliation, the extraction Worker, the capsule compiler.
All eight are built, tested, mutation-verified, and documented.

## 5. Non-negotiables

**Git.** Develop only on `claude/agentic-framework-research-7yr94s`. Push with
`git push -u origin <branch>`, retrying 4× with exponential backoff (2s/4s/8s/16s)
**on network errors only**. Never push to another branch. Never commit `.env`,
keys, or credentials. Never touch `.github/workflows/`. Conventional Commits.
Every commit ends with:

```
Co-Authored-By: Claude <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_014ga2D4wdzeNLpUJtCrXG65
```

**Never put a model identifier** in a commit message, PR, code comment, or any
other pushed artifact. Chat replies only.

**Code.** ES imports only — no `require()`. Bun, not pnpm, in `examples/engram/`
(an explicit documented exception to the repo-root rule, because `bun:sqlite` IS
the storage engine). No new dependencies without a reason you can defend.

**The four CRITICAL rules** in `examples/engram/CLAUDE.md`. Two are enforced by
PreToolUse hooks in `.claude/hooks/`; two are on you.

**Honesty.** Never overstate what works. If a test is skipped, say so. If a
number is a single run on one machine, say that. This codebase has an
anti-slop policy and the history contains a commit whose entire purpose was
correcting overclaims the author had written an hour earlier.

## 6. The traps — each of these already cost a session

### 6.1 A green `bun test` proves nothing about what you shipped

The repo-root `.gitignore` has a bare `db` pattern that silently excluded
`examples/engram/src/db/` from **every commit** since the scaffold. Local runs
stayed green for many commits while `git archive HEAD` gave 0 pass / 6 fail.
Fixed with a negation in `examples/engram/.gitignore` plus a guard script.

**Before every push: `bun run verify:committed`.** It extracts `HEAD` and runs
the suite there. This is not optional and it is not paranoia.

### 6.2 A benchmark probe that never fires reports zero, not "unknown"

The first extraction-Worker benchmark reported **0.0ms of event-loop lag** for a
scan that actually blocked for 38ms — `clearInterval` ran on the microtask
continuation before the 1ms timer had ever fired. The fix yields one macrotask
before reading the probe, and prints the tick count so a starved probe is
visible. **Any timing harness you write must be validated against a known
block** before you publish a number from it.

### 6.3 `CREATE TABLE IF NOT EXISTS` is a silent no-op against a different shape

Migration 006 first failed with `no such column: thread_id` because `artifacts`
already existed as a placeholder from `001_init.sql`. The `CREATE TABLE IF NOT
EXISTS` did nothing and the index on the new column then failed. **Grep
`001_init.sql` for your table name before writing a migration.** Extend with
`ALTER TABLE ... ADD COLUMN ... DEFAULT` (see `004`, `006`).

### 6.4 A test that pins nothing passes just as loudly

Mutation-test every guard you add: delete it, run the suite, and keep the test
only if something fails. Four separate guards in this codebase were found to be
freely deletable with CI green. One finding (`escalateIfStuck`) turned out to be
**unreachable** — the change was kept for consistency and the test relabelled to
say plainly that reverting it does not fail.

### 6.5 `ScriptedLLM` consumes in call order — which is not deterministic

Fixtures keyed on call order break the moment work runs concurrently (the review
fan-out) or refs are positional (reconciliation clusters, where two memories
inserted in the same millisecond can order either way). **Write a content-aware
stand-in that parses the real prompt and answers from it** — see `ClusterLLM` in
`test/reconcile.test.ts` and `EnvelopeLLM` in `test/capsule.test.ts`. It also
means a change to the prompt builder breaks the test loudly.

### 6.6 `step()` already returns the envelope

`step({...})` from the harness returns `{ next_step: {...} }`. A custom LLM that
also wraps in `next_step` double-wraps, the schema rejects it, the loop converts
the failure into `error` events and escalates — and you see `needs_human` instead
of a parse error. **In a loop-driven test, always assert
`finished.events.filter(e => e.type === "error")` is empty**, or LLM failures
hide as swallowed events.

### 6.7 Small things that will bite

- `envelopeForIntents` throws below **two** intents — a one-intent agent is impossible.
- `complete_task.outcome` is the enum `success | partial | blocked`. Not "ok".
- `needs_clarification` takes `markers` (1–3, each with 2–5 options), not a question.
- `Server` is generic over WebSocket data; this app opens none — use `Server<undefined>`.
- `lib` is `ESNext` only, so worker globals aren't typed. Declare what you use.
- The hook denies `bun test` pointed at a real `.sqlite`. It splits on shell separators **first**, then strips redirects per segment — an earlier version was evadable with `&&`.

## 7. The verification ritual

```sh
cd /home/user/mem0/examples/engram
bun test                  # 170 tests, hermetic: in-memory DB + scripted LLM, no network, no key
bun run typecheck         # tsc --noEmit
cp CLAUDE.md AGENTS.md && cmp CLAUDE.md AGENTS.md   # must stay byte-identical
bun run verify:committed  # THE gate: the suite against `git archive HEAD`
```

Only then commit and push. Benches (`bench:entities`, `bench:worker`) and
operator scripts (`reconcile`, `review`, `evals`) are separate.

**What a green suite does NOT prove:** whether the live model picks the right
intent for a given sentence (that is what `evals/` is for, in recorded mode), and
the terminal I/O shell in `src/cli.ts` (its turn dispatch is extracted into
`src/channels/cli-turn.ts` and tested; the I/O around it is not).

## 8. What is deliberately not built

**Roadmap** (specified in `HANDOFF-SPEC.md` §7, not built): WebSocket topic
fanout of lifecycle events; the CLAUDE.md marker-region generator with
hash-manifest ownership.

**Known constraints, deliberate:** the per-thread lock is in-process, so exactly
one Engram process may own a database file. Entity matching is exact normalized
text — plural and paraphrase mentions miss where mem0's semantic matching would
hit, measured in `RETRIEVAL-NOTES.md`. The extraction Worker ships **off** by
default because the measurement says the gain is latency fairness, not
throughput. There is no per-user authorization: a valid bearer token reaches
every thread and every user scope.

**Explicitly rejected, with reasons in the spec:** `constitution_amend` (never
let the loop amend the rules that govern it), `handoff` (no multi-phase pipeline
to hand off between), an ADD verb in reconciliation (a minted memory would carry
no provenance), and a lexical fallback for clustering (token overlap would
cluster on shared stopwords and hand a model two unrelated facts to "merge",
which is worse than doing nothing and saying so).

---

# 9. OPTIMAL instructions: building something new

This is the method that produced the work above. It is not ceremony — each step
exists because skipping it produced a defect that a later step caught.

## 9.1 The loop

**1. Research before designing.** Find the codebase that already solved this and
read its *implementation*, not its README. Every strong decision here traces to
a specific file and line — the scoring constants, the 20-slot cache, the
`server.timeout(req, 0)` requirement. When you adopt a pattern, record where it
came from. When you decline one, record why: the "considered and not adopted"
lists are worth as much as the adopted ones.

**2. Ask "why this and not the alternative?" before writing.** If you cannot
answer, research until you can. If neighbouring code does it differently, find
out why first — its choices are usually load-bearing. (Threshold-gating *before*
boosting in `scoring.ts` looks like an ordering accident and is a deliberate mem0
invariant: boosts must never resurrect a semantically gated-out candidate.)

**3. Measure the assumption that motivates the feature.** The Worker was built on
"the candidate scan blocks the event loop." That was true — 79ms of an 80ms scan
— but the *first* measurement of it was an artifact, and the honest finding
(latency fairness, not throughput) is why the feature ships off by default. A
feature justified by an unmeasured claim is a feature you cannot defend.

**4. Write the test that fails first, then the code.**

**5. Mutation-test every guard.** Delete it, run the suite. If nothing fails,
either the test is wrong or the guard is unreachable — find out which and say so
in the test's comment.

**6. Update every document the change touches, in the same commit.** `README.md`,
`CLAUDE.md` (+ `AGENTS.md`), the nearest `src/*/CLAUDE.md`, `docs/HANDOFF-SPEC.md`,
and any research-notes row in the other four repos that just went stale.

**7. Verify against the committed tree, then push.**

## 9.2 Recipes

**Adding an intent.** Schema in `src/agent/intents.ts` → add to `INTENT_SCHEMAS`
and `NextStepSchema` → classify in `routeIntent` (`sync`/`gated`/`break`/
`terminal`) → implement in `execute.ts` → add to the agents that should have it
in `registry.ts` (capability *is* presence in the subset) → document in
`INTENT_DOCS` → test both that an agent with it can call it and that an agent
without it is rejected at parse time.

**Adding a memory feature.** It must work — worse, but honestly — with
`embedder === null`. It must go through a tier facade, never raw SQL. If it
mutates archival state it writes a `memory_history` row in the same transaction.
Reads filter only on supplied scope keys; writes keep the exact three-column
identity. Never reintroduce exact-match reads.

**Adding an offline job.** Follow `reconcile.ts`: plan before writing, gate
destructive volume rather than individual items, never let a batch empty its own
subject, mutate only through facades with a named `actorId`, and give it an
operator script that defaults to a dry run.

**Adding a channel.** Put the decision logic in a pure, testable core (see
`channels/cli-turn.ts`) and keep I/O in a thin shell. Validate resume payloads
against the thread's *derived* status, never against a stored flag.

## 9.3 The four best next projects

Ranked by value per unit of risk. Each is a genuine gap, not busywork.

**A. Semantic entity matching (highest value).** `RETRIEVAL-NOTES.md` measures
exactly what the exact-match entity index costs: `poppy` misses indexed `Poppy`,
`Northwind` misses `Northwind Logistics`, reordering and plurals miss. mem0
upserts entities at ≥0.95 similarity and matches reads at a 0.5 floor. Build it
behind a flag, keep exact-match as the no-embedder path, and **re-run
`bun run bench:entities` before and after** — the bench's `found`/`rank` columns
run on a bag-of-words stand-in, so upgrade the bench to a real embedder before
quoting any improvement. The residual-gaps section names the four cases to close.

**B. Multi-process safety.** The in-process lock is the single constraint that
most limits what Engram can be. A second process would interleave loop entries;
the `UNIQUE(thread_id, seq)` constraint makes the loser fail loudly, but the log
would still record a garbled conversation. A SQLite-backed advisory lock table
with lease + expiry (the scheduler's lease in `003_schedule_lease.sql` is the
pattern to copy) would lift it. Test with two real processes, not two promises.

**C. WebSocket topic fanout.** The remaining half of the streaming roadmap item.
SSE covers one watcher on one turn; this is many watchers on many threads.
`RecallStore.subscribe` already exists and is already post-commit — the work is
topic routing and subscription lifecycle, not plumbing. Bun's `docs/runtime/http/
websockets.mdx` is the reference, and `bun`'s research-notes row says this was
declined for lack of a live UI: correct that row if you build it.

**D. Per-user authorization.** Today a valid bearer token reaches every thread
and every user scope, which the threat-model note states plainly. Scoping a token
to a `user_id` and checking it on every thread-addressed route is small, closes
the honest gap in the note, and makes the approval gate mean something on an
exposed port.

## 9.4 If you build something genuinely new

Start it the way this was started: read the sources, write the spec first
(`HANDOFF-SPEC.md` is the model — attribution table, module breakdown, numbered
implementation rules, an explicit "proposed and NOT adopted" section), scaffold
against the spec, then review the scaffold adversarially before adding features.
The constitution earns its keep here: seven principles, each one enforceable in
code, each one the reason a specific class of bug cannot happen. Write yours
before the code, not after.

And keep the honesty discipline. The most valuable artifacts in this repository
are not the features — they are `RETRIEVAL-NOTES.md`, which measures what the
design costs and states the limits of its own evidence, and the roadmap section
that says plainly what is not built. Those are what make everything else
believable.
