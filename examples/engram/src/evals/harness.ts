import { envelopeForIntents, type IntentName, type NextStep } from "../agent/intents";
import { renderUserMessage } from "../agent/render";
import { buildSystemPrompt } from "../prompts/nextstep";
import { prefetchArchival } from "../memory/prefetch";
import { extractJson, type LLMClient } from "../agent/llm";
import type { EventType } from "../agent/thread";
import type { EngramDeps } from "../deps";

/**
 * Prompt evals (12-factor factor 2: own your prompts, and treat serialized
 * threads as test fixtures).
 *
 * A fixture is a thread shape plus the intent the model SHOULD choose from it.
 * The harness renders the prompt through exactly the same functions the loop
 * uses — `buildSystemPrompt` + `prefetchArchival` + `renderUserMessage` — so a
 * change to the render seam or the intent union shows up here, and then runs a
 * reply through the same salvage-parse + Zod validation the real client applies.
 *
 * Two modes, one code path:
 * - **recorded** (CI): replay a stored raw model reply. No network, no key.
 * - **live** (`scripts/record-evals.ts`): call the real model and store what it
 *   said. This is the only way a recording becomes real evidence about model
 *   behavior — see `evals/README.md` for what the checked-in ones are today.
 */

export interface EvalFixture {
  name: string;
  /** Registry agent whose persona and intent subset to render. */
  agent: string;
  /** Seed core-block content, so a fixture can exercise remembered context. */
  core?: Array<{ label: string; content: string }>;
  /** Archival memories to insert before rendering (exercises prefetch). */
  memories?: string[];
  events: Array<{ type: EventType; data: unknown }>;
  expect: {
    /** The intent the model is supposed to choose. */
    intent: IntentName;
    /** Substrings the rendered PROMPT must contain (context-coverage checks). */
    promptContains?: string[];
    /** Substrings the chosen step, JSON-stringified, must contain. */
    stepContains?: string[];
  };
}

export interface RenderedPrompt {
  system: string;
  user: string;
  threadId: string;
}

/** Build the fixture's thread and render it exactly as the loop would. */
export async function renderFixture(deps: EngramDeps, fixture: EvalFixture): Promise<RenderedPrompt> {
  const agent = deps.registry.get(fixture.agent);
  if (!agent) throw new Error(`eval "${fixture.name}": unknown agent "${fixture.agent}"`);

  const thread = deps.store.createThread(fixture.agent, {
    userId: `eval-${fixture.name}`,
    agentId: fixture.agent,
  });
  for (const block of fixture.core ?? []) {
    const result = deps.core.append(fixture.agent, block.label, block.content);
    if (!result.ok) throw new Error(`eval "${fixture.name}": core seed failed — ${result.message}`);
  }
  for (const content of fixture.memories ?? []) {
    await deps.archival.insert({ content, scope: { userId: `eval-${fixture.name}`, agentId: fixture.agent } });
  }
  for (const event of fixture.events) {
    deps.store.appendEvent(thread.id, event.type, event.data);
  }

  const loaded = deps.store.getThread(thread.id);
  const prefetched = await prefetchArchival(deps, loaded).catch(() => null);
  return {
    system: buildSystemPrompt({
      agentPersona: agent.persona,
      constitutionVersion: deps.constitution.version,
      constitutionDigest: deps.constitution.digest,
      intents: agent.intents,
      principles: deps.constitution.principles.map(p => p.title),
      coreBlocks: deps.core.render(fixture.agent),
    }),
    user: renderUserMessage(loaded, prefetched?.block ?? null),
    threadId: thread.id,
  };
}

export interface EvalResult {
  name: string;
  pass: boolean;
  /** Empty when pass is true. */
  failures: string[];
  step?: NextStep;
}

/**
 * Score one fixture against a raw model reply — the same salvage-parse and Zod
 * validation `AnthropicLLM.structured` applies, so a reply that the real client
 * would reject fails here too.
 */
export function scoreReply(
  deps: EngramDeps,
  fixture: EvalFixture,
  prompt: RenderedPrompt,
  rawReply: string,
): EvalResult {
  const agent = deps.registry.get(fixture.agent)!;
  const failures: string[] = [];

  for (const needle of fixture.expect.promptContains ?? []) {
    const inPrompt = prompt.system.includes(needle) || prompt.user.includes(needle);
    if (!inPrompt) failures.push(`prompt is missing required context: ${JSON.stringify(needle)}`);
  }

  let step: NextStep | undefined;
  try {
    const envelope = envelopeForIntents(agent.intents).parse(extractJson(rawReply));
    step = envelope.next_step;
  } catch (err) {
    failures.push(`reply did not validate against the agent's intent union: ${(err as Error).message}`);
    return { name: fixture.name, pass: false, failures };
  }

  if (step.intent !== fixture.expect.intent) {
    failures.push(`chose "${step.intent}", expected "${fixture.expect.intent}"`);
  }
  const serialized = JSON.stringify(step);
  for (const needle of fixture.expect.stepContains ?? []) {
    if (!serialized.includes(needle)) {
      failures.push(`chosen step is missing ${JSON.stringify(needle)} — got ${serialized}`);
    }
  }
  return { name: fixture.name, pass: failures.length === 0, failures, step };
}

/** Live mode: ask a real client for the reply. Used by the recorder script. */
export async function askModel(
  deps: EngramDeps,
  fixture: EvalFixture,
  prompt: RenderedPrompt,
  llm: LLMClient,
): Promise<string> {
  const agent = deps.registry.get(fixture.agent)!;
  const envelope = await llm.structured({
    system: prompt.system,
    user: prompt.user,
    schema: envelopeForIntents(agent.intents),
    schemaName: "next_step_envelope",
  });
  // Store the validated object as canonical JSON: recordings stay replayable
  // even if the model's surrounding prose changes.
  return JSON.stringify(envelope, null, 2);
}
