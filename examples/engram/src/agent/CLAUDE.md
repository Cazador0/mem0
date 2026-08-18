# Agent loop — invariants

- **Event vocabulary is closed** (`EVENT_TYPES` in `thread.ts`): `user_input | system_note | tool_call | tool_response | human_response | error | memory_write`. Adding a type means updating the derived-status predicates and `render.ts` in the same change — they are the only consumers allowed to interpret types.
- **Status is derived, never stored.** `threads.status_hint` is a display cache only; every decision routes through `deriveStatus`/`awaitingApproval`/`awaitingHumanResponse` over the log tail.
- **The tool_call event is persisted BEFORE execution.** This is what makes approval-replay work: the resume path re-executes `eventAsStep(lastEvent(thread))` verbatim. Never execute first and record after.
- **Two-switch split**: `routeIntent` (control-flow policy: sync/gated/break/terminal) and `executeStep` (pure execution) stay separate functions. Policy changes (e.g. gating a new intent) happen in `routeIntent` only.
- **`render.ts` is the single seam deciding what the model sees.** Compaction, redaction, error-hiding, and memory injection happen there, read-side only. The canonical log is never mutated by rendering.
- **Integer refs come only from `archival_search` tool responses** and are rebuilt from the log (`buildRefMap`) — never held in out-of-band state. Pre-fetched memories deliberately carry no refs.
- **LLM output is never trusted**: `llm.structured` Zod-validates with bounded retries; unknown intents/refs are dropped or answered with a readable error, not executed.
