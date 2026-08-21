import { readFileSync } from "node:fs";
import { z } from "zod";

/**
 * Constitution loading and gate evaluation (spec-kit). The constitution is a
 * separate semver'd markdown file, referenced (version + digest) rather than
 * inlined. Planning output must carry structured gate results; an unjustified
 * failure is an ERROR — the escape hatch is an explicit justification, never a
 * diluted principle.
 */

export interface ConstitutionPrinciple {
  /** Roman numeral as written in the file, e.g. "IV". */
  id: string;
  /** Heading text without the numeral, e.g. "The LLM proposes, code disposes". */
  title: string;
}

export interface ConstitutionInfo {
  path: string;
  version: string;
  digest: string;
  content: string;
  /** Parsed `### <numeral>. <title>` headings — the gate vocabulary. */
  principles: ConstitutionPrinciple[];
}

export function loadConstitution(path: string): ConstitutionInfo {
  const content = readFileSync(path, "utf8");
  const version = /\*\*Version\*\*:\s*(\d+\.\d+\.\d+)/.exec(content)?.[1] ?? "0.0.0";
  const digest = Bun.hash.xxHash64(content).toString(16);
  const principles: ConstitutionPrinciple[] = [];
  for (const m of content.matchAll(/^###\s+([IVXLC]+)\.\s+(.+?)\s*$/gm)) {
    principles.push({ id: m[1]!, title: m[2]! });
  }
  return { path, version, digest, content, principles };
}

export const GateResultSchema = z.object({
  principle: z.string().min(1),
  pass: z.boolean(),
  justification: z.string().optional(),
});
export type GateResult = z.infer<typeof GateResultSchema>;

/**
 * Justify-or-ERROR (spec-kit). Optionally also checks that every gate names a
 * principle that actually exists: a gate against an invented principle is not
 * a passing gate, it is the model grading itself on a rule nobody wrote.
 */
export function evaluateGateResults(
  results: GateResult[],
  knownPrinciples?: readonly string[],
): { ok: boolean; errors: string[] } {
  const errors: string[] = [];
  const known = knownPrinciples?.map(p => p.toLowerCase());
  for (const result of results) {
    if (known && !known.some(p => p === result.principle.toLowerCase())) {
      errors.push(
        `unknown constitution principle "${result.principle}" — gate results must name ` +
          `a principle from constitution.md, verbatim`,
      );
      continue;
    }
    if (!result.pass && !result.justification?.trim()) {
      errors.push(
        `constitution gate failed for "${result.principle}" without justification — ` +
          `adjust the plan or justify explicitly; never dilute the principle`,
      );
    }
  }
  return { ok: errors.length === 0, errors };
}
