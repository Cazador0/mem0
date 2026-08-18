# Engram Constitution

**Version**: 1.0.0 | **Ratified**: 2026-08-18 | **Last Amended**: 2026-08-18

Non-negotiable principles for this codebase. Conflicts require adjusting the work,
never diluting the principle. Amendments only through the amendment flow below.

## Principles

### I. The event log is canonical and append-only

A thread's `events` rows are the single source of truth for both execution state
and business state. Nothing mutates or deletes an event. Status is *derived* from
the tail of the log, never stored as authoritative flags. Rendering for the LLM
may summarize, hide, or redact — it must never write back.

### II. Every memory mutation is audited

Every ADD, UPDATE, and DELETE on the archival tier writes a `memory_history` row
with before/after values. Deletes are soft in history even when the memory row is
removed. Core-block edits bump a version and are compare-and-swap guarded.

### III. Scope is structural, not conventional

`user_id` / `agent_id` / `run_id` enter payloads in exactly one function.
Identity keys found in caller metadata are stripped with a warning at every write
entry point. All reads filter by scope.

### IV. The LLM proposes, code disposes

Every LLM output is validated against a Zod schema before use; IDs shown to the
model are small integers mapped host-side; unknown IDs are dropped. Destructive
operations (memory deletion) are approval-gated: recorded as an event, executed
only after a human approves, and the approved event is replayed verbatim.

### V. Local-first, one artifact

All persistent state lives in a single WAL-mode SQLite file. No external database
services. Capabilities that need external services (embeddings) degrade
gracefully and honestly when absent.

### VI. Temporal grounding at write time

Extracted memories resolve relative time ("last week") into absolute dates using
the conversation's observation date — never the current date — so memories stay
meaningful forever.

### VII. Honest degradation and honest reporting

Missing capabilities are detected at startup and warned about once. Auxiliary
subsystems (entity index) are best-effort: warn and continue, never fail the
write. Never claim a result that was not verified.

## Governance

Amendments bump the version by semver: **MAJOR** = principle removal or
redefinition, **MINOR** = new principle or materially expanded guidance,
**PATCH** = wording clarifications. Each amendment prepends a Sync Impact Report
as an HTML comment (old→new version, changed principles, affected prompts) and
propagates to dependent prompt templates in the same change.
