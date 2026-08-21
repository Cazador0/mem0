# Prompt evals

Fixture threads are rendered through the loop's own prompt functions
(`buildSystemPrompt` + `prefetchArchival` + `renderUserMessage`), and a reply is
scored through the loop's own parse path (`extractJson` + the agent's Zod intent
union). Run them with the rest of the suite:

```sh
bun test test/prompt-evals.test.ts
```

## What the checked-in recordings are — and are not

**The files in `recorded/` were written by hand, not captured from the model.**
No API key was available when they were authored, so they represent a *plausible*
well-formed reply for each fixture, deliberately varied in surface form (bare
JSON, fenced, prose-wrapped) to exercise the salvage parser.

That makes this suite a real test of:

- the render seam still putting the context a fixture depends on into the prompt
  (each fixture asserts `promptContains`),
- the intent union and each agent's intent subset not drifting,
- `extractJson` still salvaging fenced and prose-wrapped replies,
- the chosen step still satisfying the fixture's structural expectations.

It is **not** evidence that the live model chooses these intents. Nothing here
has been near the Anthropic API.

## Making it real evidence

```sh
ANTHROPIC_API_KEY=sk-ant-... bun scripts/record-evals.ts
```

That calls the live model once per fixture, overwrites the recordings with what
it actually said, and prints how many fixtures the model agreed with. Diff before
committing: a changed intent is a finding about the prompt, not a conflict to
resolve away. Until someone runs it, this README is the honest description of
what the green checkmarks mean.

## Adding a fixture

Append to `fixtures.ts` and add `recorded/<name>.txt`. The suite asserts the two
sets stay in one-to-one correspondence, so an orphan on either side fails.

Keep fixtures behavioral. An eval that pins prompt wording fails on every edit
and teaches the next maintainer to ignore the suite.
