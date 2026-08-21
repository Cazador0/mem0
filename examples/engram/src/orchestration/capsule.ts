import { nowIso } from "../db/database";
import { escapeAngleBrackets } from "../agent/escape";
import { subagentSummary } from "../agent/execute";
import { latestCompaction } from "../memory/compaction";
import { withThreadLock } from "../orchestration/lock";
import type { Thread } from "../agent/thread";
import type { EngramDeps } from "../deps";

/**
 * Capsule compiler and review fan-out (BMAD).
 *
 * A capsule is a task brief compiled to be SELF-CONTAINED: an agent handed one
 * needs nothing else to do its job. Compilation is deterministic host code —
 * it harvests what already happened (the thread's distillate and recent turns,
 * i.e. BMAD's Agent Records) plus the archival memories that match the task —
 * so the model is asked to judge, not to gather (spec-kit's discipline).
 *
 * The capsule is stored in SECTIONS because both permissions are per section:
 *
 * - **Read** — a reviewer's envelope is the set of sections it is handed
 *   (`AgentDefinition.review.parts`). Handing three reviewers three different
 *   slices is what makes them independent; the same envelope three times buys
 *   one opinion, three times over.
 * - **Write** — each section has exactly one owner, enforced here in code
 *   rather than asked for in a prompt. Host-compiled sections have no owner and
 *   are immutable; a reviewer may write only its own section, and only from the
 *   version it last read (BMAD's compare-and-set).
 *
 * Reviewers never see each other's sections, so a fan-out cannot converge by
 * reading itself.
 */

/** Host-compiled parts of a brief. A reviewer's envelope is a subset of these. */
export const CAPSULE_PARTS = ["task", "history", "memories", "constitution"] as const;
export type CapsulePart = (typeof CAPSULE_PARTS)[number];

/** Sections with this owner are compiled by the host: nobody may write them. */
export const HOST_OWNER = "";
/** Memories harvested into the `memories` part. */
export const CAPSULE_MEMORY_TOP_K = 5;
/** Conversational turns harvested into the `history` part. */
export const CAPSULE_HISTORY_TURNS = 8;

export interface Capsule {
  id: string;
  threadId: string;
  title: string;
  reviewers: readonly string[];
}

export interface Section {
  name: string;
  ownerAgentId: string;
  content: string;
  version: number;
}

export interface ReviewVerdict {
  agentId: string;
  verdict: string;
  summary: string;
  /** The reviewer's own thread — where its full reasoning stayed. */
  ref: string;
}

/**
 * Compile a capsule from a thread. Every part is written as a section even when
 * empty, so an envelope that asks for `memories` on a store with none says
 * "(none)" rather than silently omitting a heading the reviewer was told about.
 */
export async function compileCapsule(
  deps: EngramDeps,
  spec: { threadId: string; title: string; task: string; reviewers: readonly string[] },
): Promise<Capsule> {
  const thread = deps.store.getThread(spec.threadId);
  for (const agentId of spec.reviewers) {
    const def = deps.registry.get(agentId);
    if (!def) throw new Error(`unknown reviewer "${agentId}"`);
    if (!def.review) throw new Error(`agent "${agentId}" is not a reviewer (no review lens declared)`);
  }

  const parts: Record<CapsulePart, string> = {
    task: escapeAngleBrackets(spec.task),
    history: compileHistory(deps, thread),
    memories: await compileMemories(deps, thread, spec.task),
    constitution:
      `Constitution v${deps.constitution.version} (digest ${deps.constitution.digest}). Principle titles:\n` +
      deps.constitution.principles.map(p => `- ${p.title}`).join("\n"),
  };

  const id = Bun.randomUUIDv7();
  const now = nowIso();
  const write = deps.db.transaction(() => {
    deps.db
      .query(
        `INSERT INTO artifacts (id, kind, content, status, created_at, updated_at, thread_id, title)
         VALUES (?, 'capsule', '', 'compiled', ?, ?, ?, ?)`,
      )
      .run(id, now, now, thread.id, spec.title);
    for (const name of CAPSULE_PARTS) {
      insertSection(deps, id, name, HOST_OWNER, parts[name], now);
    }
    // One empty, reviewer-owned section each: the fan-out fills them, and the
    // ownership rows exist before any agent runs so a write can be checked.
    for (const agentId of spec.reviewers) {
      insertSection(deps, id, reviewSection(agentId), agentId, "", now);
    }
  });
  write.immediate();

  return { id, threadId: thread.id, title: spec.title, reviewers: [...spec.reviewers] };
}

export function reviewSection(agentId: string): string {
  return `review:${agentId}`;
}

export function readSection(deps: EngramDeps, capsuleId: string, name: string): Section | null {
  const row = deps.db
    .query("SELECT name, owner_agent_id, content, version FROM artifact_sections WHERE artifact_id = ? AND name = ?")
    .get(capsuleId, name) as
    | { name: string; owner_agent_id: string; content: string; version: number }
    | null;
  return row ? { name: row.name, ownerAgentId: row.owner_agent_id, content: row.content, version: row.version } : null;
}

export function listSections(deps: EngramDeps, capsuleId: string): Section[] {
  return (
    deps.db
      .query(
        "SELECT name, owner_agent_id, content, version FROM artifact_sections WHERE artifact_id = ? ORDER BY name",
      )
      .all(capsuleId) as Array<{ name: string; owner_agent_id: string; content: string; version: number }>
  ).map(row => ({
    name: row.name,
    ownerAgentId: row.owner_agent_id,
    content: row.content,
    version: row.version,
  }));
}

/**
 * Write one section. Ownership is enforced HERE — an agent asking to write a
 * section it does not own is refused in code, not reminded in a prompt.
 * `expectedVersion` makes the write a compare-and-set: two agents that read the
 * same version cannot both land.
 */
export function writeSection(
  deps: EngramDeps,
  args: { capsuleId: string; name: string; agentId: string; content: string; expectedVersion?: number },
): { ok: boolean; message: string } {
  const section = readSection(deps, args.capsuleId, args.name);
  if (!section) return { ok: false, message: `no section "${args.name}" in this capsule` };
  if (section.ownerAgentId === HOST_OWNER) {
    return { ok: false, message: `section "${args.name}" is compiled by the host and is not writable` };
  }
  if (section.ownerAgentId !== args.agentId) {
    return {
      ok: false,
      message: `section "${args.name}" belongs to "${section.ownerAgentId}" — "${args.agentId}" may not write it`,
    };
  }
  const expected = args.expectedVersion ?? section.version;
  const result = deps.db
    .query(
      `UPDATE artifact_sections SET content = ?, version = version + 1, updated_at = ?
       WHERE artifact_id = ? AND name = ? AND version = ?`,
    )
    .run(args.content, nowIso(), args.capsuleId, args.name, expected);
  if (result.changes === 0) {
    return { ok: false, message: `section "${args.name}" changed since you read it (expected v${expected})` };
  }
  return { ok: true, message: `section "${args.name}" written` };
}

/**
 * The text a reviewer is handed: the parts its definition declares, plus its
 * own section. Anything else in the capsule — including every other reviewer's
 * findings — is deliberately absent.
 */
export function renderEnvelope(deps: EngramDeps, capsuleId: string, agentId: string): string {
  const def = deps.registry.get(agentId);
  if (!def?.review) throw new Error(`agent "${agentId}" is not a reviewer`);
  const capsule = deps.db.query("SELECT title FROM artifacts WHERE id = ?").get(capsuleId) as
    | { title: string }
    | null;
  if (!capsule) throw new Error(`no capsule ${capsuleId}`);

  const blocks = def.review.parts.map(part => {
    const section = readSection(deps, capsuleId, part);
    return `## ${part}\n${section?.content.trim() || "(none)"}`;
  });
  const own = readSection(deps, capsuleId, reviewSection(agentId));
  if (own?.content.trim()) blocks.push(`## your previous notes\n${own.content.trim()}`);

  return [
    `# Review capsule: ${escapeAngleBrackets(capsule.title)}`,
    ``,
    `You are one of several independent reviewers. You cannot see the others' `
      + `sections and they cannot see yours — do not guess what they will say, and `
      + `do not soften a finding because you assume someone else will raise it.`,
    ``,
    `Your lens: ${def.review.lens}`,
    ``,
    `Everything you need is below. If it genuinely is not enough, say so with `
      + `needs_clarification rather than filling the gap from your own knowledge.`,
    ``,
    ...blocks,
    ``,
    `Answer with complete_task: outcome = your verdict, summary = your finding.`,
  ].join("\n");
}

/**
 * Run every reviewer on the capsule, concurrently, each on its own fresh thread.
 *
 * Each reviewer's full reasoning stays in its own thread (BMAD: the artifact is
 * the thread); what comes back here is a bounded `{verdict, summary, ref}`
 * written into that reviewer's own section. A reviewer that fails does not
 * fail the fan-out — its verdict records the failure.
 */
export async function reviewFanOut(
  deps: EngramDeps,
  args: { capsule: Capsule; runLoop: (threadId: string) => Promise<Thread> },
): Promise<ReviewVerdict[]> {
  const parent = deps.store.getThread(args.capsule.threadId);
  return Promise.all(
    args.capsule.reviewers.map(async agentId => {
      let result: ReviewVerdict;
      try {
        const child = deps.store.createThread(agentId, { userId: parent.userId, runId: parent.id });
        deps.store.appendEvent(child.id, "user_input", renderEnvelope(deps, args.capsule.id, agentId));
        const finished = await withThreadLock(child.id, () => args.runLoop(child.id));
        result = { agentId, ...subagentSummary(finished), ref: child.id };
      } catch (err) {
        result = { agentId, verdict: "failed", summary: (err as Error).message, ref: "" };
      }
      // Recorded through the same ownership check any other writer faces.
      const written = writeSection(deps, {
        capsuleId: args.capsule.id,
        name: reviewSection(agentId),
        agentId,
        content: `${result.verdict}: ${result.summary}`,
      });
      if (!written.ok) console.warn(`[engram] could not record ${agentId}'s review: ${written.message}`);
      return result;
    }),
  );
}

function insertSection(
  deps: EngramDeps,
  capsuleId: string,
  name: string,
  owner: string,
  content: string,
  now: string,
): void {
  deps.db
    .query(
      `INSERT INTO artifact_sections (artifact_id, name, owner_agent_id, content, version, updated_at)
       VALUES (?, ?, ?, ?, 0, ?)`,
    )
    .run(capsuleId, name, owner, content, now);
}

/** BMAD's Agent Records: what already happened, distillate first. */
function compileHistory(deps: EngramDeps, thread: Thread): string {
  const distillate = latestCompaction(deps, thread.id);
  const window = deps.store
    .recentWindow(thread, CAPSULE_HISTORY_TURNS)
    .map(line => `${line.role}: ${line.text}`);
  const blocks: string[] = [];
  if (distillate) blocks.push(`Earlier in this thread (compacted):\n${distillate.summary}`);
  if (window.length > 0) blocks.push(`Most recent turns:\n${window.join("\n")}`);
  return escapeAngleBrackets(blocks.join("\n\n"));
}

/** Archival memories that match the task — content only, never ids (constitution IV). */
async function compileMemories(deps: EngramDeps, thread: Thread, task: string): Promise<string> {
  const hits = await deps.archival
    .search({ query: task, scope: { userId: thread.userId }, topK: CAPSULE_MEMORY_TOP_K })
    .catch(err => {
      console.warn(`[engram] capsule memory harvest failed (continuing): ${(err as Error).message}`);
      return [];
    });
  return escapeAngleBrackets(hits.map(hit => `- ${hit.payload.content}`).join("\n"));
}
