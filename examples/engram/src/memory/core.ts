import type { Database } from "bun:sqlite";
import { nowIso } from "../db/database";
import { escapeAngleBrackets, unescapeAngleBrackets } from "../agent/escape";

/**
 * Core tier: MemGPT-style named, char-budgeted, self-editable blocks that are
 * rendered into EVERY system prompt. The agent edits them via core_append /
 * core_replace intents; edits are compare-and-swap guarded on `version` so a
 * stale concurrent session fails loudly (constitution II). The `constitution`
 * block is read-only to edit intents.
 */

export interface CoreBlock {
  agentId: string;
  label: string;
  content: string;
  charLimit: number;
  readOnly: boolean;
  version: number;
  updatedAt: string;
}

export interface CoreEditResult {
  ok: boolean;
  message: string;
}

export const DEFAULT_BLOCKS: Array<{ label: string; charLimit: number }> = [
  { label: "persona", charLimit: 2000 },
  { label: "human", charLimit: 2000 },
  { label: "project", charLimit: 3000 },
  { label: "scratchpad", charLimit: 2000 },
];

interface CoreBlockRow {
  agent_id: string;
  label: string;
  content: string;
  char_limit: number;
  read_only: number;
  version: number;
  updated_at: string;
}

/** Hot path: rendered into every single system prompt. */
export const CORE_SQL = {
  getBlock: "SELECT * FROM core_blocks WHERE agent_id = ? AND label = ?",
  listBlocks: "SELECT * FROM core_blocks WHERE agent_id = ? ORDER BY label",
} as const;

export class CoreMemory {
  constructor(private readonly db: Database) {}

  /** Idempotently create the standard blocks plus the read-only constitution pointer. */
  seed(agentId: string, persona: string, constitutionPointer: string): void {
    const now = nowIso();
    const insert = this.db.query(
      `INSERT INTO core_blocks (agent_id, label, content, char_limit, read_only, version, updated_at)
       VALUES (?, ?, ?, ?, ?, 1, ?)
       ON CONFLICT (agent_id, label) DO NOTHING`,
    );
    for (const block of DEFAULT_BLOCKS) {
      const content = block.label === "persona" ? persona : "";
      insert.run(agentId, block.label, content, block.charLimit, 0, now);
    }
    insert.run(agentId, "constitution", constitutionPointer, 4000, 1, now);
  }

  get(agentId: string, label: string): CoreBlock | null {
    const row = this.db
      .query(CORE_SQL.getBlock)
      .get(agentId, label) as CoreBlockRow | null;
    return row ? rowToBlock(row) : null;
  }

  list(agentId: string): CoreBlock[] {
    const rows = this.db
      .query(CORE_SQL.listBlocks)
      .all(agentId) as CoreBlockRow[];
    return rows.map(rowToBlock);
  }

  /**
   * Render all blocks for the system prompt, each showing its own budget
   * pressure so the model can manage its context (the MemGPT idea).
   *
   * Block content derives from user text (the agent records facts the human
   * states), so angle brackets are neutralized at render time — read-side
   * only, same rule as render.ts — so pasted text can never forge a
   * core_block or close this one and inject system-level instructions.
   */
  render(agentId: string): string {
    return this.list(agentId)
      .map(
        b =>
          `<core_block label="${b.label}" chars="${b.content.length}/${b.charLimit}"${b.readOnly ? ' read_only="true"' : ""}>\n${escapeAngleBrackets(b.content)}\n</core_block>`,
      )
      .join("\n");
  }

  append(agentId: string, label: string, content: string): CoreEditResult {
    const block = this.get(agentId, label);
    if (!block) return { ok: false, message: `no core block "${label}"` };
    if (block.readOnly) return { ok: false, message: `core block "${label}" is read-only` };
    const next = block.content ? `${block.content}\n${content}` : content;
    if (next.length > block.charLimit) {
      return {
        ok: false,
        message: `budget exceeded: "${label}" would be ${next.length}/${block.charLimit} chars — compress it first with core_replace`,
      };
    }
    return this.write(block, next);
  }

  replace(agentId: string, label: string, oldText: string, newText: string): CoreEditResult {
    // oldText is reassigned below when the escaped form is what matched.
    const block = this.get(agentId, label);
    if (!block) return { ok: false, message: `no core block "${label}"` };
    if (block.readOnly) return { ok: false, message: `core block "${label}" is read-only` };
    let at = block.content.indexOf(oldText);
    if (at === -1) {
      // The model reads the ESCAPED block but storage is raw, so text copied
      // out of its own context ("&lt;foo&gt;") would never match. Retry with
      // the escaping undone before calling it a miss.
      const unescaped = unescapeAngleBrackets(oldText);
      if (unescaped !== oldText) at = block.content.indexOf(unescaped);
      if (at !== -1) oldText = unescaped;
    }
    if (at === -1) {
      return { ok: false, message: `old_text not found in "${label}" — it must match exactly` };
    }
    // Manual splice: String.replace would interpret $&/$'/$` patterns in
    // agent-authored new_text as replacement directives.
    const next = block.content.slice(0, at) + newText + block.content.slice(at + oldText.length);
    if (next.length > block.charLimit) {
      return {
        ok: false,
        message: `budget exceeded: "${label}" would be ${next.length}/${block.charLimit} chars`,
      };
    }
    return this.write(block, next);
  }

  /** CAS write: bumps version only if nobody else wrote since we read. */
  private write(block: CoreBlock, content: string): CoreEditResult {
    const res = this.db
      .query(
        `UPDATE core_blocks SET content = ?, version = version + 1, updated_at = ?
         WHERE agent_id = ? AND label = ? AND version = ?`,
      )
      .run(content, nowIso(), block.agentId, block.label, block.version);
    if (res.changes === 0) {
      return { ok: false, message: `concurrent edit on "${block.label}" — re-read and retry` };
    }
    return { ok: true, message: `updated "${block.label}" (${content.length}/${block.charLimit} chars)` };
  }
}

function rowToBlock(row: CoreBlockRow): CoreBlock {
  return {
    agentId: row.agent_id,
    label: row.label,
    content: row.content,
    charLimit: row.char_limit,
    readOnly: row.read_only === 1,
    version: row.version,
    updatedAt: row.updated_at,
  };
}
