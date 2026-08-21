/**
 * Re-record the prompt-eval replies from the LIVE model.
 *
 *   ANTHROPIC_API_KEY=sk-ant-... bun scripts/record-evals.ts [fixture-name ...]
 *
 * This is the ONLY way a recording becomes evidence about model behavior. The
 * recordings checked into evals/recorded/ were authored by hand (see
 * evals/README.md) and prove the prompt/parse contract, not the model's choices.
 *
 * Costs real tokens: one call per fixture. Diff the result before committing —
 * a changed intent is a finding, not a merge conflict.
 */
import { writeFileSync } from "node:fs";
import { bootstrap } from "../src/bootstrap";
import { loadConfig } from "../src/config";
import { FIXTURES } from "../evals/fixtures";
import { askModel, renderFixture, scoreReply } from "../src/evals/harness";

if (!process.env.ANTHROPIC_API_KEY) {
  console.error("ANTHROPIC_API_KEY is not set — refusing to pretend this recorded anything.");
  process.exit(1);
}

const only = new Set(process.argv.slice(2));
const selected = only.size > 0 ? FIXTURES.filter(f => only.has(f.name)) : FIXTURES;
if (selected.length === 0) {
  console.error(`no fixture matched ${[...only].join(", ")}`);
  process.exit(1);
}

// Evals must never touch a real memory database.
const config = { ...loadConfig(), dbPath: ":memory:" };
const deps = bootstrap(config);

let agreed = 0;
for (const fixture of selected) {
  const prompt = await renderFixture(deps, fixture);
  let raw: string;
  try {
    raw = await askModel(deps, fixture, prompt, deps.llm);
  } catch (err) {
    console.error(`✗ ${fixture.name}: live call failed — ${(err as Error).message}`);
    continue;
  }
  const path = new URL(`../evals/recorded/${fixture.name}.txt`, import.meta.url).pathname;
  writeFileSync(path, `${raw}\n`);

  const scored = scoreReply(deps, fixture, prompt, raw);
  if (scored.pass) {
    agreed++;
    console.log(`✓ ${fixture.name}: model chose ${scored.step?.intent} (as expected)`);
  } else {
    console.log(`✗ ${fixture.name}: ${scored.failures.join("; ")}`);
  }
}
console.log(`\n${agreed}/${selected.length} fixtures matched their expected intent against the live model.`);
