<!-- Not part of the skill's guidance. This is the record of how the skill was
     tested and how to re-test it. Readers looking for the API want SKILL.md. -->

# How this skill was tested

Written test-first: nine build tasks were given to fresh agents **without** the skill and with no
repository access, and the failures were recorded before a line of guidance was written. The skill
then targets those failures specifically.

## The two automated gates

```bash
# names — sub-second, run after every edit
node .claude/skills/deuz-sdk/scripts/verify-skill.mjs

# shapes — extracts every fenced example and compiles it against the real built package
npm run build -w @deuz-sdk/core
node .claude/skills/deuz-sdk/scripts/extract-examples.mjs <scratch>/src
cd <scratch> && npx tsc -p tsconfig.json
```

`verify-skill.mjs` builds its symbol table exactly the way `packages/core/tooling/verify-docs.mjs`
does — tsup's `entry` map crossed with `package.json` `exports`, following `export *` through `src`
— so a name that passes here is a name the package really exports. It also fails if the freshness
footer in `SKILL.md` no longer matches the workspace version and the `api-contract.json` hash, which
is what stops this skill from drifting quietly after a release.

The scratch harness for the second gate is a plain npm project with `file:` installs of
`packages/core` and `packages/react`, `moduleResolution: "Bundler"`, `strict`, and a small
`shims.d.ts` declaring `next/server`'s `after`, `ExecutionContext` and `Env` — framework surface the
examples reference but the SDK does not own.

Authoring contract these gates impose: every fence tagged `ts`/`tsx` is a self-contained module with
its own imports and `declare const` placeholders. A fence that is a deliberate fragment, or that
shows another framework's code as the thing being replaced, is tagged `no-verify` and skipped by
both gates.

## Baseline (no skill, no repo access)

Nine tasks: stream text, Next.js chat route, tool loop, structured extraction, React approval UI,
fallback with injected keys, RAG with citations, durable agent with approvals, MCP over stdio.

**19 non-existent or wrong-subpath imports across 8 of the 9 answers.** Every agent invented an API
rather than declining, and several said so explicitly in their own notes.

| Failure | What agents actually did |
| --- | --- |
| Invented a client class | `new DeuzClient(...)`, `createDeuz(...)`, then `deuz.chat.stream(...)` / `deuz.chat(...)` |
| Invented type names | `TokenUsage`, `ChatMessage`, `DeuzMessage`, `DeuzToolCall`, `UIMessage` from the root |
| Invented function names | `defineTool` (three times), `extract`, `fallback`, `connectMcpServer` |
| Wrong subpath | `createAgent`, `anthropic`, `openai` imported from the root instead of `/agent`, `/anthropic`, `/openai` |
| Broke the never-throws contract | `await streamChat(...)` in 4 of 4 streaming answers — one noted it was a guess |
| Wrong call shape | `streamChat(client, options)` as two arguments |
| Wrong option names | `system:` instead of `instructions:`; a bare model-id string instead of a model descriptor |
| Hand-rolled the wire | a manual SSE `ReadableStream` in the route, and client instructions to parse `data:` frames by hand, instead of `toDeuzStreamResponse` + the hook |
| Invented a route helper | `result.toStreamResponse()` |
| Missed the loop entirely | one agent wrote its own dispatch loop with its own step counter, "not confident the SDK exposes a maxSteps option at all" |
| No request validation | every route destructured `messages` straight out of the request body |

Two agents flagged their own uncertainty in a way worth quoting, because it is the exact gap this
skill fills: *"I am not certain `streamChat` is actually async; if it returns the result object
synchronously the await is harmless, but I guessed here"* — it is not harmless, and the guess was
wrong.

## With the skill

The same nine tasks were rerun with only one change to the prompt: read `SKILL.md` first, then whichever
`references/` files its routing table points to. Each answer was then graded by an **independent judge
agent** working from a per-scenario rubric, told to be adversarial and to fail a criterion unless the
answer clearly satisfied it, with `references/api-index.md` available to check whether a name is real.

**9 of 9 scenarios passed every rubric criterion.** Zero invented exports, zero wrong subpaths, zero
awaited `streamChat` calls, `maxSteps` set explicitly wherever a loop was involved, `validateChatRequest`
and `toDeuzStreamResponse` on every route, and `generateObject` never handed `tools`.

The judges also surfaced something the rubric did not ask for: several answers stated true-sounding
details about option shapes that could not be confirmed from the two files the judge was allowed to read.
That is the limit of a name-level gate — it is why the compiler gate exists, and why every claim in the
reference files carries the source file it came from in its header.

## A correction this process caught

`skills/deuz-sdk/rules/pitfalls.md` #16 claimed that `warnings` is populated on `streamChat` only, that a
model-level warning raised inside a loop step never reaches the result, and that a dropped document is a
typed warning on the `chat_completions` wire only. All three were true in 1.9 and **false in 2.0**: every
chat path builds or receives a warning sink, both loops thread one sink through every step
(`stream-tool-loop.ts:849`, `tool-loop.ts:557`), and all three document-carrying adapters pass it.

What survived the audit is one real gap, narrower than the old claim: the **buffered** loop calls
`filterWireTools` and `applyPrepareStep` without the sink, so a typo'd `activeTools` name reaches
`deps.logger.warn` and never `GenerateTextResult.warnings`. The streaming loop records it.

The stale claim had propagated into 12 files — this skill, the shipped `deuz-sdk` and `migrate-from-ai-sdk`
product skills, and six documentation pages. All were corrected against the source. The lesson for
maintaining this skill: when a source-verified fact contradicts an inherited one, sweep for every copy of
the inherited claim rather than fixing only the one you noticed.

## Re-running the baseline

The nine prompts are in the workflow script under the session's `workflows/scripts/` directory as
`deuz-skill-red-baseline-*.js`. To grade any set of agent answers, dump each answer to a `.md` file
and point the name gate at the directory:

```bash
node .claude/skills/deuz-sdk/scripts/verify-skill.mjs <dir-of-answers>
```

A skilled run should report zero unresolved names. That is the machine half; the rubric half is
whether the answer uses the right mechanism — `toDeuzStreamResponse` for a route, an explicit
`maxSteps`, `validateChatRequest` in front of client history, `generateObject` without `tools`.
