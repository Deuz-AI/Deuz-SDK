<!-- verified: 2026-10-15 against @deuz-sdk/core@2.3.0 · api-contract sha256:99750a8aa5fa
     sources: packages/core/src/context/{index,types,compile,compiler,render,sources,count,defaults}.ts,
     packages/core/src/context/working-memory/{index,types,patch,tools}.ts, packages/core/src/internal/estimate-tokens.ts,
     packages/core/src/rag.ts, packages/core/src/plan.ts, packages/core/src/errors.ts,
     .changeset/{2-4-l2,2-4-l3a,2-4-l3b,2-4-fb}.md, docs/content/docs/modules/context.mdx (lane D1) -->

# Context compiler and working memory (2.4)

**Load when:** memory, RAG hits, past conversations and the skill catalog should share one token budget instead of each splicing text into the prompt; a long task must not lose its goal, constraints, active task, decisions and failed attempts across compaction or a restart; or you need to explain what context a step saw and why (the manifest), or count a request's tokens before sending it.

Everything is in `@deuz-sdk/core/context` (edge-safe, off unless configured). `compileContext`, the sources and working memory are stable; `createContextCompiler` is a preview. The restart guarantees (stored packages, restored compiler state, redaction after a forget) belong to the V3 native run: `references/v3-runs.md`. Docs: `/docs/modules/context` (2.4).

| Piece | What it does |
| --- | --- |
| `compileContext(input)` | Pure and deterministic: gathered source results + budget → a `ContextPackage` (blocks + `ContextManifest`) |
| `createContextCompiler({ sources, budget?, refresh?, scope?, estimator?, state?, deps?, onWarning? })` | Queries the sources when a refresh is due, then compiles; `beforeModelCall`, `onOverflow`, `requestRefresh()`, `state()` |
| `createMemoryContextSource`, `createRagContextSource`, `createTranscriptContextSource`, `createSkillsContextSource` | The built-in `ContextSource`s |
| `createWorkingMemory`, `applyWorkingMemoryPatch`, `workingMemoryTools` | Structured working memory: a plain-JSON snapshot, schema-checked patches, the model's tools |
| `createTokenEstimator`, `estimateTextTokens`, `estimateRequestTokens`, `estimateRequestOverhead`, `ANTHROPIC_TOOL_FRAMING_TOKENS` | The one token estimator (about 3.6 chars/token, calibrated by real usage, or your tokenizer) |
| `contextPackageBlob(pkg)`, `contextWarnings(manifest)` | The package's content-addressed blob for `AgentRunStoreV3.putBlob`; the manifest's `CallWarning`s |

## A compile

```ts
import {
  createContextCompiler,
  createMemoryContextSource,
  createRagContextSource,
  createWorkingMemory,
} from '@deuz-sdk/core/context';
import {
  createInMemoryVersionedMemoryStore,
  createMemorySession,
} from '@deuz-sdk/core/memory/versioned';

const memory = createMemorySession({
  store: createInMemoryVersionedMemoryStore(),
  scope: { userId: 'ada' },
});
await memory.remember({ text: 'Every deploy goes to eu-west.' });

const docs = [
  { text: 'Deploys need a green CI run.', index: 0, score: 0.9 },
  { text: 'Rollbacks use the previous image tag.', index: 1, score: 0.4 },
];

const compiler = createContextCompiler({
  scope: { userId: 'ada' }, // every source reads within this; a request may only narrow it
  sources: [
    createMemoryContextSource({ session: memory }),
    createRagContextSource({ retrieve: async (_query, topK) => docs.slice(0, topK) }),
  ],
});

const pkg = await compiler.beforeModelCall({
  runId: 'run-1',
  step: 0,
  messages: [{ role: 'user', content: 'How do I deploy?' }],
  model: { provider: 'anthropic', modelId: 'claude-opus-5-5', contextWindow: 200_000, maxOutputTokens: 8_000 },
  overheadTokens: 0, // tool schemas + output schema + framing: estimateRequestOverhead(...)
  workingMemory: createWorkingMemory({
    scope: 'acme',
    goal: 'Deploy the billing service.',
    constraints: ['No deploys on Friday.'],
    now: Date.now(),
  }),
});

for (const block of pkg.blocks) console.log(block.placement, block.messages[0]?.role);
// append user
// ephemeral-tail user
console.log(pkg.manifest.refresh, pkg.manifest.budget.contextTokens); // initial 8192
console.log(pkg.manifest.entries.map((e) => [e.source, e.selected, e.reason]));
// working-memory goal and constraint 'mandatory', then memory and rag 'ranked'
```

Outside a V3 run there is no `context` option: call `compileContext` or a compiler yourself (from `prepareStep`, say), place the blocks, and persist `compiler.state()` yourself.

## Budget, selection and placement

- **Budget** (`DEFAULT_CONTEXT_BUDGET`): the added context gets `ratio` 0.2 of what the request leaves free (`inputTokens − usedTokens`), at most `maxTokens` 8192. The working memory is placed first, up to `workingMemoryTokens` 1024. The rest is shared by source kind, `shares` memory 2 : rag 2 : skills 1, plus transcript 1 when a transcript source returns candidates; a share left unused goes to the others (manifest reason `'reallocated'`). Each source offers at most `candidatesPerSource` 20, by score.
- **Mandatory content is never cut**: the working memory's goal, constraints and active task, and skill bodies the model already loaded with `load_skill`. It may exceed the added-context budget but must fit `inputTokens − usedTokens`, else `ContextBudgetExceededError` (`code: 'context_budget_exceeded'`, `requiredTokens`, `availableTokens`, `phase: 'compile' | 'overflow-retry'`).
- **Manifest** (`ContextManifest`, version 1): per candidate its source, record id, revision, digest, query, tokens, `selected` and a reason (`ranked`, `reallocated`, `mandatory`, `already-placed`, `over-budget`, `duplicate`, `redacted`), plus per-source status, the budget arithmetic, the `estimator` kind, `refresh` reason, `pass`, `fallback` (`'pass-limit'`, `'source-failed'`) and `cachePrefixChanged`. It carries ids, digests and counts, never content.
- **Placement keeps the prompt cache.** Retrieval is one appended `user` message `<deuz_context pass step>` holding escaped `<record source kind id revision origin source_kinds>` entries behind a data-not-instructions preamble; an entry already placed at the same revision (or digest, without a revision) is not written again. The working memory is one `user` message `<deuz_working_memory revision>` after the last message of the request, never stored in history. No system message and no tool schema is ever added or changed, so a refresh keeps the cached prefix and Claude 5.x preserved thinking.
- **Compaction.** When a compaction removes an earlier `<deuz_context>` block, its entries are placed again in the next package (also on an overflow retry); only a record's latest revision comes back. A compiler restored from a checkpoint asks a mandatory entry's source again (past `maxPasses`, spending no pass); optional entries wait for the next refresh.

## Refresh and sources

- **Refresh** (`DEFAULT_CONTEXT_REFRESH`): on the first call, when the active task changes (at least `refresh.minSteps` 2 model steps after the last retrieval), and when the host asks (`requestRefresh()` or `ContextStepInput.refresh`, not bound by `minSteps`). At most `refresh.maxPasses` 4 retrieval passes per run; then the last package is reused with `fallback: 'pass-limit'`. `ContextStepInput.redacted` forces a fresh retrieval (refresh `'redacted'`). The query is the active task's title plus the latest user text (the compiler's own blocks skipped), at most 2000 characters; an empty query skips the sources without spending a pass. No model rewrites it unless you pass `refresh.rewriteQuery`.
- **Failures.** An optional source that fails gives a `context-source-failed` `CallWarning` (to `onWarning` and `contextWarnings(manifest)`) and `fallback: 'source-failed'`; the step goes on. A source with `required: true` that fails rejects `beforeModelCall` with its own error. Two sources with one `id` throw a `TypeError`.

| Source | Options | Candidates |
| --- | --- | --- |
| `createMemoryContextSource` | `{ session }` (versioned: revisions, origin labels, `recordedAsOf`) or `{ store, scope, embedder?, clock? }` (legacy `MemoryStore`) | Active, unexpired records; with this source the native loop's legacy recall must be off |
| `createRagContextSource` | `{ retrieve(query, topK, signal) }`, e.g. `(q, k) => hybridRetrieve(q, deps, { topK: k })` | Record id is `meta.id` when it is a string, else the chunk index |
| `createTranscriptContextSource` | `{ index, scope, chatIds?, around? = 0, refs? }` | `role: text` lines from a `TranscriptIndex`; `refs()` (e.g. the messages recalled memories cite) resolved first, match `'source-ref'`. Off unless configured |
| `createSkillsContextSource` | `{ registry, loaded? }` | Catalog lines `name (id): description` from `registry.match`; each `loaded()` skill as a mandatory `<id>/SKILL.md` body. A body is never injected because retrieval matched it |

Every source takes `id?` (default its kind) and `required?` (default false). A request scope may only narrow a source's pinned scope; a widening throws a `TypeError`. A custom source implements `ContextSource` (`id`, `kind`, `required?`, `query(request)`), returning `ContextCandidate`s with a `sha256:` `digest` of their text.

## Working memory

A `WorkingMemorySnapshot` (version 1, plain JSON) holds the goal and constraints (host only), a copy of the planner's `TaskList` with `listRevision` and `activeTaskId`, and lists of observations, hypotheses, decisions, questions and attempts, each item with its writer, revision, sources and time. It changes only through `applyWorkingMemoryPatch(snapshot, { operationId, expectedRevision, writer, operations }, { now })`, which is pure and returns:

| Status | Meaning |
| --- | --- |
| `'applied'` | All operations applied; revision + 1 |
| `'duplicate'` | This `operationId` was applied before (last 64 remembered); nothing changed |
| `'conflict'` | `expectedRevision` is stale |
| `'rejected'` | `reason` `forbidden`, `unknown-id`, `duplicate-id` or `invalid`, and `operation` (the index); nothing applied |

```ts
import { createTaskList } from '@deuz-sdk/core/autonomy';
import { applyWorkingMemoryPatch, createWorkingMemory } from '@deuz-sdk/core/context';

const now = Date.now();
let snapshot = createWorkingMemory({
  scope: 'acme',
  goal: 'Ship the billing fix.',
  constraints: ['No schema changes.'],
  tasks: { list: createTaskList('Ship the billing fix.', ['Reproduce', 'Fix', 'Verify']), activeTaskId: 't1' },
  now,
});

const proposed = applyWorkingMemoryPatch(
  snapshot,
  {
    operationId: 'model-step-3-call-1',
    expectedRevision: snapshot.revision,
    writer: 'model',
    operations: [{ op: 'add-hypothesis', text: 'The rounding happens before tax.' }],
  },
  { now },
);
if (proposed.status === 'applied') snapshot = proposed.snapshot; // the hypothesis is 'proposed'

const forbidden = applyWorkingMemoryPatch(
  snapshot,
  { operationId: 'model-step-4', expectedRevision: snapshot.revision, writer: 'model', operations: [{ op: 'set-goal', text: 'Rewrite billing.' }] },
  { now },
);
console.log(forbidden.status, forbidden.status === 'rejected' && forbidden.reason); // rejected forbidden
```

- **Host only:** `set-goal`, `add-constraint`, `remove-constraint`, `set-tasks` (bumps `listRevision`), `set-hypothesis-status`, `set-decision-status`. A model's hypothesis or decision enters as `'proposed'` and is never a verified fact; a model may answer, drop, update or remove only items it wrote, and may not cite a `host` source. `set-active-task` takes a task id or `null` from any writer.
- **Critical fields** — goal, constraints, active task — are always placed by the compiler. The rest is chosen by priority within the working memory share: task list, decisions (accepted > proposed > reverted), questions (open > answered; dropped omitted), attempts (in-progress > failed > abandoned > succeeded), hypotheses (confirmed > proposed > rejected), observations.
- **`workingMemoryTools({ memory, prefix = 'working_memory', agentPath = [] })`** gives the model `working_memory_read`, `working_memory_add` (1–16 items: observation, hypothesis, decision, question, attempt, with `evidence` as tool call ids) and `working_memory_update` (answer, drop, attempt, remove). Each write is one model patch with operation id from the model step and tool call id (`replay: 'idempotent'`); a refusal is a tool error; a write from another `agentPath` (a sub-agent) is refused, reads are allowed. The tools persist nothing: a V3 run checkpoints the snapshot with the tool's receipt (`workingMemory: { tools: true }`).

## Counting tokens

`estimateTextTokens(text, estimator?)`, `estimateRequestOverhead({ tools?, outputSchema?, provider?, framingTokens? }, estimator?)` and `estimateRequestTokens({ messages, ...overhead }, estimator?)` count through the shared estimator; `ANTHROPIC_TOOL_FRAMING_TOKENS` (346) is added only for provider `'anthropic'` when tools are present. These are estimates and the manifest records which estimator was used; there is no claim to match a provider's count. `/rag` keeps 4 chars/token unless you pass `ChunkOptions.estimator` (`references/rag-and-skills.md`), so 2.3 chunk boundaries do not move.

## Telemetry and limits

- Each compile reports `deuz.context.compile` (subsystem `'context'`; in a native run a child of the step span) with `deuz.context.selected`, `excluded`, `tokens`, `estimator`, `refresh_reason`, `fallback`, `cache_prefix_changed`, `manifest_digest`, and `deuz.context.source.<id>.selected|excluded|tokens` (id lower-cased, other characters `_`). No content.
- No tool discovery or automatic tool selection; the compiler only counts the schemas your step sends. No savings claim on real models: the repository's retrieval figures come from an offline fixture with a deterministic embedder.

## Deep dive

- `/docs/modules/context` (2.4) — the full budget, refresh, placement and working memory rules.
- `/docs/modules/transcript-search` (2.4) — the `TranscriptIndex` behind the transcript source.
- [/docs/modules/compaction](/docs/modules/compaction) — what compaction removes, and the V3 recompile on overflow.
