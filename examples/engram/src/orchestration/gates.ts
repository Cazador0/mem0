import { readFileSync } from "node:fs";
import { z } from "zod";

/**
 * Constitution loading and gate evaluation (spec-kit). The constitution is a
 * separate semver'd markdown file, referenced (version + digest) rather than
 * inlined. Planning output must carry structured gate results; an unjustified
 * failure is an ERROR — the escape hatch is an explicit justification, never a
 * diluted principle.
 */

export interface ConstitutionInfo {
  path: string;
  version: string;
  digest: string;
  content: string;
}

export function loadConstitution(path: string): ConstitutionInfo {
  const content = readFileSync(path, "utf8");
  const version = /\*\*Version\*\*:\s*(\d+\.\d+\.\d+)/.exec(content)?.[1] ?? "0.0.0";
  const digest = Bun.hash.xxHash64(content).toString(16);
  return { path, version, digest, content };
}

export const GateResultSchema = z.object({
  principle: z.string().min(1),
  pass: z.boolean(),
  justification: z.string().optional(),
});
export type GateResult = z.infer<typeof GateResultSchema>;

export function evaluateGateResults(results: GateResult[]): { ok: boolean; errors: string[] } {
  const errors: string[] = [];
  for (const result of results) {
    if (!result.pass && !result.justification?.trim()) {
      errors.push(
        `constitution gate failed for "${result.principle}" without justification — ` +
          `adjust the plan or justify explicitly; never dilute the principle`,
      );
    }
  }
  return { ok: errors.length === 0, errors };
}
