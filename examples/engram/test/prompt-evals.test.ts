import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { testWorld } from "./harness";
import { FIXTURES } from "../evals/fixtures";
import { renderFixture, scoreReply } from "../src/evals/harness";

/**
 * Recorded-mode prompt evals (roadmap item: "prompt evals"). These run in CI
 * with no API key: each fixture is rendered through the loop's own prompt
 * functions, then a stored reply is validated through the loop's own parse path.
 *
 * What this suite CAN fail on: the render seam dropping context a fixture needs,
 * the intent union changing shape, an agent's intent subset drifting, or the
 * salvage parser regressing. What it CANNOT tell you is whether the live model
 * still chooses these intents — see evals/README.md.
 */
const recorded = (name: string) =>
  readFileSync(new URL(`../evals/recorded/${name}.txt`, import.meta.url), "utf8");

describe("prompt evals (recorded)", () => {
  for (const fixture of FIXTURES) {
    test(`${fixture.name} -> ${fixture.expect.intent}`, async () => {
      const { deps } = testWorld();
      const prompt = await renderFixture(deps, fixture);
      const result = scoreReply(deps, fixture, prompt, recorded(fixture.name));
      expect(result.failures).toEqual([]);
      expect(result.pass).toBe(true);
    });
  }

  test("fixtures and recordings stay in one-to-one correspondence", () => {
    // An orphan in either direction is silent rot: a fixture with no recording
    // would be skipped, a recording with no fixture is dead weight nobody runs.
    const files = readdirSync(new URL("../evals/recorded/", import.meta.url))
      .filter(f => f.endsWith(".txt"))
      .map(f => f.replace(/\.txt$/, ""))
      .sort();
    expect(files).toEqual(FIXTURES.map(f => f.name).sort());
  });
});
