<!-- verified: 2026-09-26 against @deuz-sdk/core@2.1.0 + the 2.2 changesets · api-contract sha256:c025621e10fd
     sources: packages/core/src/{autonomy,plan,verify,workspace,compute,browser,runtime,evolve,schedule}.ts,
     packages/core/src/evolve/*.ts, packages/core/src/schedule/*.ts, docs/content/docs/modules/{evolve,schedule}.mdx,
     packages/core/src/node/{workspace,compute,browser,runtime}.ts, packages/core/src/inference/agent-tool.ts,
     packages/core/src/types/{config,workspace,compute,browser,runtime,stream,tool}.ts, docs/content/docs/modules/autonomy.mdx, docs/content/docs/cookbooks/{autonomous-agent,coding-agent}.mdx -->

# Autonomous agents: plan, act, verify

**Load when:** building an agent that runs for many steps without a human in the turn — it decomposes its own goal, executes code or drives a browser, decides whether it is finished, keeps state outside the context window, or runs in the background and needs to survive a crash. Also: evolutionary search over a program (`evolve`, 2.2) and starting runs from cron or webhooks (`/schedule`, 2.2).

## The shape

There is no agent class and no second runtime. An autonomous run is the ordinary agentic loop (`generateText` / `streamChat` + `tools` + `maxSteps`) with extra seams attached as call options and tool sets. Everything below composes with `session:`, `compaction:`, `stopWhen`, `budget` and `approveToolCall` exactly as a plain tool loop does.

| Concern | Primitive | Where |
| --- | --- | --- |
| Goal → an ordered to-do list | `planTasks`, `createTaskList` + pure reducers | `@deuz-sdk/core/autonomy` |
| "Is it actually finished?" | `doneWhen` + `falseFinishGuard` | call option |
| "Is the answer right?" | `verifyStep` + `maxVerifyAttempts`, `createVerifier` | call option, `/autonomy` |
| State that outlives the context window | `Workspace` + `createWorkspaceTools` | `/workspace`, `/workspace/node` |
| Acting by writing code | `codeActTool` / `shellTool` over a `ComputeSandbox` | `/compute`, `/compute/node` |
| Acting on the web | `createBrowserTools` over a `BrowserController` | `/browser`, `/browser/node` |
| Running while nobody is watching | `createRunManager` + `RunStore`, plus `session:` | `/runtime`, `/runtime/node`, `/durable` |
| Live to-do panel, activity feed, mid-run steering | `emitPlanUpdate`, `emitActivity`, `createSteeringController` | `/runtime` |
| Quality bought with tokens | `bestOfN`, `selfConsistency`, `parallelAgents` | `/autonomy` |
| Searching for a better program (2.2) | `evolve`, `resumeEvolve`, a `PopulationStore` | `/evolve`, `/evolve/sqlite` |
| Starting work from time or a webhook (2.2) | `createScheduler`, `handleSignal`, webhook verifiers | `/schedule` |

## Finishing: `doneWhen` runs before `verifyStep`

Both hooks fire at the same boundary — a **natural completion**: the model produced final text and requested no tools. A step that made tool calls never reaches them. Either option alone activates the agentic loop, with or without `tools`.

A **false finish** is the dominant long-horizon failure: the model writes "I've updated the config and the tests pass" having done neither, and the loop, seeing no tool call, accepts it. `doneWhen` is the primitive against that — a cheap local predicate over `text`/`messages` that returns `false` to reject the finish, upon which the loop injects a short "the task is not finished" user turn and re-drives. `verifyStep` answers the different, more expensive question of whether the produced answer is *correct*.

| Option | Type | Default | Contract |
| --- | --- | --- | --- |
| `doneWhen` | `(ctx: DoneWhenContext) => boolean \| Promise<boolean>` | — | `false` rejects the finish and re-drives |
| `falseFinishGuard` | `boolean \| { maxRetries?: number }` | 2 re-drives | `false` / `{ maxRetries: 0 }` = observation only |
| `verifyStep` | `(ctx: VerifyStepContext) => VerifyStepResult \| undefined \| Promise<…>` | — | `undefined` passes silently; `{ ok: false, feedback, retry? }` re-drives |
| `maxVerifyAttempts` | `number` | `3` | counts **attempts** (initial + retries) |

`DoneWhenContext` is `{ text, messages, usage, stepIndex, runtimeContext? }`. `VerifyStepContext` adds `attempt` (0-based, per leg). Sharp edges:

- **Order.** `doneWhen` is evaluated first, and a rejection that re-drives short-circuits `verifyStep` for that round — there is nothing worth paying a verifier for in an answer already called incomplete.
- **Different units.** `maxVerifyAttempts` counts attempts; `falseFinishGuard.maxRetries` counts retries. `maxVerifyAttempts: 3` is one answer plus two retries; `{ maxRetries: 3 }` is four answers.
- **Three separate budgets.** `maxSteps`, `maxVerifyAttempts` and `falseFinishGuard` never bleed into each other, and on a durable run both hook budgets are counted **per leg** (a resumed leg starts fresh). `stopWhen` / `budget` still bound the whole run at the loop's regular step boundaries.
- `falseFinishGuard` without `doneWhen` is inert and logs a warning — the guard is armed by the hook.
- A **throw from either hook fails the call**: buffered calls reject, streaming surfaces an `error` part with rejected `usage`/`finishReason`. They are your code, never swallowed.
- Read the outcome from `providerMetadata.deuz`: `verified` (boolean, the final `verifyStep` verdict) and `stoppedBy === 'false-finish'` (the guard's budget ran out and the answer stands over its objection).
- `generateObject` / `streamObject` reject loop options; these hooks belong to text calls.

```ts
import { generateText } from '@deuz-sdk/core';
import { createAnthropic } from '@deuz-sdk/core/anthropic';
import type { ToolSet } from '@deuz-sdk/core';

declare const tools: ToolSet;

const anthropic = createAnthropic({ apiKey: process.env.ANTHROPIC_API_KEY! });

const result = await generateText({
  model: anthropic('claude-opus-4-8'),
  messages: [{ role: 'user', content: 'Migrate the auth module to the new API and run the tests.' }],
  tools,
  maxSteps: 30,
  // Local, free, no model call: did it claim, or did it do?
  doneWhen: ({ text, messages }) =>
    !/\bi (will|would|plan to)\b/i.test(text) && messages.some((m) => m.role === 'tool'),
  falseFinishGuard: { maxRetries: 3 },
});

if (result.providerMetadata?.deuz?.stoppedBy === 'false-finish') {
  // The guard ran out of re-drives: this is the answer it stopped on, not one it accepted.
}
```

## `createVerifier` — the default `verifyStep`

`verifyStep` is a seam you implement. `createVerifier({ model, system?, maxChecks?, deps? })` is the ready implementation: it decomposes the goal into sub-checks, judges the answer against each, and derives `confidence` as the share that passed instead of asking the model to assert one. It fills three positions, and its `deps` (`onUsage`, `fetch`, `logger`, …) flow into its own call so its tokens land in your total.

| Member | Signature | Notes |
| --- | --- | --- |
| `verify` | `({ goal, answer, context? }) => Promise<VerifierResult>` | `{ ok, confidence?, feedback?, errorCategory?, checks? }` |
| `score` | `(candidate: string, goal: string) => Promise<number>` | 0..1 — the dense selector `bestOfN` wants |
| `asVerifyStep` | `(options?: { goal?: string }) => VerifyStep` | drops straight into the call option |

- **One `generateObject` call per `verify()`** — the whole decomposition and every verdict come back in one structured response. Point it at a cheap model; that is why it takes a `model` of its own. With `maxVerifyAttempts: 3` a run can pay it three times, and `bestOfN` pays it once per candidate.
- `maxChecks` (default 4) is a prompt budget, not a filter: extra checks the model returns are still honoured, because dropping a failed one would turn a rejection into a pass.
- **It never throws and fails open.** A verifier whose model call failed, or that returned nothing judgeable, degrades to a pass — logged via `deps.logger.warn` and structurally detectable as exactly `{ ok: true, errorCategory: 'other' }` with no `checks` and no `confidence`. A genuine pass never carries an `errorCategory`. Assert on that pair if a silent pass would hurt you, and wire a real logger — the default is a no-op.
- `VerifierErrorCategory` is a closed set: `'hallucination' | 'incomplete' | 'tool-mismatch' | 'format' | 'other'`.
- Combining it with `doneWhen`: pass `asVerifyStep({ goal })` an explicit goal. A re-drive leaves the injected nudge as the trailing user turn, which is not the task to infer a goal from.

```ts
import { generateText } from '@deuz-sdk/core';
import { bestOfN, createVerifier } from '@deuz-sdk/core/autonomy';
import { createAnthropic } from '@deuz-sdk/core/anthropic';

const anthropic = createAnthropic({ apiKey: process.env.ANTHROPIC_API_KEY! });
const goal = 'Summarise the incident: root cause, blast radius, and the fix that shipped.';

// One cheap judge, three positions.
const verifier = createVerifier({ model: anthropic('claude-haiku-4-5'), maxChecks: 4, deps: { logger: console } });

declare const draft: string;
const verdict = await verifier.verify({ goal, answer: draft });
const degraded = verdict.ok && verdict.errorCategory !== undefined; // fail-open pass, not a real one

// Dense scorer for best-of-N: ranks on the share of checks passed, not yes/no.
const { best, bestScore } = await bestOfN({
  n: 4,
  generate: async () => (await generateText({ model: anthropic('claude-opus-4-8'), prompt: goal })).text,
  verifier,
  goal,
});

// The loop hook — pin the goal explicitly.
const final = await generateText({
  model: anthropic('claude-opus-4-8'),
  prompt: goal,
  verifyStep: verifier.asVerifyStep({ goal }),
  maxVerifyAttempts: 3,
});
```

## The plan: a `TaskList` and pure reducers

`planTasks` is one `generateObject` call that returns plain data; everything after it is synchronous reducers over immutable values. Persist the list to a workspace so the plan survives compaction, a checkpoint, or a restart.

| Function | Returns | Notes |
| --- | --- | --- |
| `planTasks(goal, { model, system?, maxTasks?, signal?, deps? })` | `Promise<TaskList>` | ids `t1`, `t2`, …; `maxTasks` slices the model's plan |
| `createTaskList(goal, titles)` | `TaskList` | build one by hand, no model call |
| `updateTask(list, id, patch)` | `TaskList` | `patch: Partial<Omit<Task, 'id'>>`; unknown id is a no-op |
| `setTaskStatus(list, id, status, notes?)` | `TaskList` | sugar over `updateTask` |
| `nextPendingTask(list)` | `Task \| undefined` | first task still `'pending'` |
| `taskListProgress(list)` | `{ total, done, failed, pending, inProgress, ratio }` | drives a progress UI or a `stopWhen` |
| `allTasksSettled(list)` | `boolean` | every task `done` or `failed` |
| `serializeTaskList` / `parseTaskList` | `string` ⇄ `TaskList` | `{ version: 1, goal, tasks }`; parse throws on a shape/version mismatch |

`Task` is `{ id, title, status, notes? }`; `TaskStatus` is `'pending' | 'in_progress' | 'done' | 'failed'`. The reducers never mutate — always reassign (`plan = setTaskStatus(plan, …)`).

```ts
import { generateText } from '@deuz-sdk/core';
import { nextPendingTask, planTasks, serializeTaskList, setTaskStatus } from '@deuz-sdk/core/autonomy';
import { createFileWorkspace } from '@deuz-sdk/core/workspace/node';
import type { LanguageModel, Tool } from '@deuz-sdk/core';

declare const model: LanguageModel;
declare const executor: Tool; // an agentTool sub-agent — see the CodeAct section

const goal = 'Ship a CLI that lints the repo and prints a summary table.';
const workspace = createFileWorkspace({ root: './.agent-workspace' });

let plan = await planTasks(goal, { model, maxTasks: 8 });
await workspace.write('plan.json', serializeTaskList(plan));

let task = nextPendingTask(plan);
while (task) {
  const current = task;
  plan = setTaskStatus(plan, current.id, 'in_progress');
  const step = await generateText({
    model,
    instructions: 'Delegate the current sub-task to the executor tool, then report what it produced.',
    prompt: `Goal: ${goal}\nSub-task: ${current.title}`,
    tools: { executor },
    maxSteps: 8,
    compaction: 'auto',
  });
  const ok = step.providerMetadata?.deuz?.verified !== false;
  plan = setTaskStatus(plan, current.id, ok ? 'done' : 'failed', step.text.slice(0, 500));
  await workspace.write('plan.json', serializeTaskList(plan)); // the plan outlives the process
  task = nextPendingTask(plan);
}
```

## Workspace — externalized memory

**Write to a workspace instead of growing the context.** A long-horizon run's context is a lossy, expensive buffer: `compaction: 'auto'` prunes old tool results and reasoning, a checkpoint restores the effective history rather than everything the model once saw, and a resumed leg begins from that checkpoint. Anything the agent will need in twenty steps belongs in a file; only the **path** belongs in the context. The same rule bounds cost — a 40 KB scrape re-sent on every step is billed on every step.

`Workspace` is a small path-addressed store: `read`, `write`, `exists`, `list(prefix?)`, `delete`, plus optional `readBytes` / `writeBytes` for binaries. Three backends: `createInMemoryWorkspace({ now? })` (anywhere, edge-safe, deterministic — `modifiedAt` only when you pass `now`), `createFileWorkspace({ root })` (Node only, a sandboxed directory created on first write, throws on Edge), or your own — any KV/object store satisfies the six methods.

- `normalizeWorkspacePath(rel)` is the guard every backend shares: it folds backslashes, strips a leading `./`, and throws `InvalidRequestError` on an absolute path, a `..` segment, a Windows drive letter, a UNC path, or a NUL byte. Call it first if you write your own backend — the model supplies these paths.
- `createFileWorkspace` adds two more layers: lexical containment under `root`, and a `realpath` check so a symlink or NTFS junction inside the root cannot escape it.
- `read` / `readBytes` **throw** on a missing path (filesystem semantics) — guard with `exists`. `delete` on a missing path is a no-op. `write` overwrites; there is no append.
- `createWorkspaceTools(workspace, { readOnly?, approveWrites? })` returns `readFile`, `writeFile`, `listFiles`, `deleteFile`. `readOnly: true` returns only `readFile` + `listFiles` (a research agent that must not mutate); `approveWrites: true` marks `writeFile` and `deleteFile` `needsApproval`. Parameters are raw JSON Schema — no zod peer needed.

## Compute / CodeAct — acting by writing code

The reliable way to make an agent *act* rather than describe an action is to let it write code and read the real output. `ComputeSandbox` is the seam: `runCode(request)` is mandatory, `runShell(request)` optional. Both take `{ language|command, code?, cwd?, timeoutMs?, signal?, stdin?, env? }` and return `{ stdout, stderr, exitCode, timedOut?, artifacts?, durationMs? }`.

| Export | Purpose |
| --- | --- |
| `codeActTool(sandbox, options)` | `{ name = 'runCode', languages?, timeoutMs?, maxOutputChars = 10_000, needsApproval?, description? }` |
| `shellTool(sandbox, options)` | `{ name = 'runShell', timeoutMs?, maxOutputChars?, needsApproval?, description? }` |
| `codeActSystemPrompt()` | the system-prompt block that steers "write code, read stdout, self-correct" |
| `createNodeSandbox(options)` | `{ cwd?, defaultTimeoutMs = 30_000, maxOutputBytes = 1_000_000, interpreters?, allowedLanguages?, allowedCommands?, inheritEnv = false }` |

- A thrown sandbox becomes a self-healing `is_error` tool result the loop feeds back, so the model can switch strategy (Python missing → shell). Do not catch it yourself.
- Only artifact **metadata** (`path`, `mime`) reaches the model; raw bytes never enter context. `stdout`/`stderr` are capped at `maxOutputChars` each with a visible truncation marker.
- A sandbox without `runShell` makes `shellTool` report the limitation to the model as an error result rather than throwing out of the loop.
- `createNodeSandbox` built-ins: `python`/`python3` → `python3 -c`, `bash`/`sh`/`shell`, `javascript`/`js`/`node` → `node -e`. Override or extend via `interpreters`.

> **`createNodeSandbox` is a reference, not a security sandbox.** It spawns model-authored code as a child process of the host, with the host's permissions — whatever the model writes, your machine runs, including deleting files, reading credentials, and opening outbound connections. `inheritEnv: false` (the default) keeps your API keys out of the child, `allowedLanguages` and `allowedCommands` (matched on the first shell token) bound what it may start, and `maxOutputBytes` bounds what comes back — those shrink the blast radius, they are not isolation. `needsApproval` gates *whether* a call runs, never *what it can reach* once allowed. For untrusted input or production, implement `ComputeSandbox` against Docker, E2B, Daytona, a microVM or a remote runner: the same two methods, a different backend, no other code changes.

```ts
import { agentTool } from '@deuz-sdk/core';
import { codeActSystemPrompt, codeActTool, shellTool } from '@deuz-sdk/core/compute';
import { createNodeSandbox } from '@deuz-sdk/core/compute/node';
import { createWorkspaceTools } from '@deuz-sdk/core/workspace';
import { createFileWorkspace } from '@deuz-sdk/core/workspace/node';
import type { LanguageModel } from '@deuz-sdk/core';

declare const model: LanguageModel;

const workspace = createFileWorkspace({ root: './.agent-workspace' });
const sandbox = createNodeSandbox({
  cwd: './.agent-workspace',
  allowedLanguages: ['python', 'bash', 'javascript'],
  allowedCommands: ['git', 'node', 'npm', 'pytest'], // first shell token must match
  inheritEnv: false, // the child never sees your keys
});

// The executor the plan loop above delegates to.
const executor = agentTool({
  name: 'executor',
  description: 'Executes one sub-task by writing files and running code, then reports what it did.',
  model,
  system: codeActSystemPrompt(),
  tools: {
    ...createWorkspaceTools(workspace, { approveWrites: true }),
    ...codeActTool(sandbox, { languages: ['python', 'bash'], timeoutMs: 60_000 }),
    ...shellTool(sandbox, { needsApproval: true }),
  },
  maxSteps: 12, // sub-agents are inherently multi-step; the default is 10
});
```

## Browser control

`createBrowserTools(controller, { maxTextChars = 20_000, workspace?, screenshotDir = 'screenshots', needsApproval? })` wraps a `BrowserController` as `navigate`, `click`, `type`, `readText`, `screenshot`.

- `needsApproval` gates `navigate`, `click` and `type` only — `readText` and `screenshot` are always ungated.
- `screenshot` writes PNG bytes to `${screenshotDir}/shot-N.png` and returns `{ savedTo, bytes }` when a `workspace` with `writeBytes` is supplied; without one it returns only `{ bytes }` — a byte count, no image. Image bytes never enter context.
- `readText` is capped at `maxTextChars` with a truncation marker.
- `createPlaywrightBrowser({ headless = true, timeoutMs = 30_000 })` (Node only, optional peer `playwright`) launches one Chromium page lazily and reuses it; `readText` with no selector reads `body`, `type` uses `fill` (it **replaces** the field, not appends), and you must call `close()` yourself — nothing closes it for you.
- Security: a browser tool reaches arbitrary URLs and submits forms. Combined with private data and an outbound channel that is the exfiltration trifecta. Restrict origins **at the controller/backend**, not only in the prompt, and gate navigation with `approveToolCall`.

```ts
import { streamChat } from '@deuz-sdk/core';
import { createBrowserTools } from '@deuz-sdk/core/browser';
import { createPlaywrightBrowser } from '@deuz-sdk/core/browser/node';
import { createInMemoryWorkspace } from '@deuz-sdk/core/workspace';
import type { LanguageModel } from '@deuz-sdk/core';

declare const model: LanguageModel;
declare const allowedHosts: Set<string>;
const browser = createPlaywrightBrowser({ headless: true, timeoutMs: 20_000 });

const result = streamChat({
  model,
  prompt: 'Open the pricing page of example.com, read the table, and screenshot it.',
  // screenshots land in the workspace, never in the context
  tools: createBrowserTools(browser, { workspace: createInMemoryWorkspace(), needsApproval: true }),
  maxSteps: 12,
  approveToolCall: (call) =>
    call.toolName !== 'navigate' || allowedHosts.has(new URL(String((call.args as { url: string }).url)).host),
});

try {
  for await (const chunk of result.textStream) process.stdout.write(chunk);
} finally {
  await browser.close?.(); // the page is reused until you close it
}
```

## Background runs, live view, steering

`RunStore` is **metadata only** — it never drives the model. It records what a dashboard lists and what a worker must continue; the resumable state lives in the `SessionStore` under the *same* `runId` (see `references/persistence-durable.md`).

`createRunManager({ store, now? })` gives `startRun({ runId, goal?, meta? })`, `getRun`, `listRuns({ status? })`, `setStatus(runId, status, { error?, stepIndex? })` and `setPlan(runId, plan)` over a `RunStore` — `createInMemoryRunStore()` (single process) or `createFileRunStore({ dir })` (Node, one JSON file per run, temp + rename). `pollStaleRuns(store, { staleMs = 60_000, statuses = ['running','suspended'], now? })` (Node) returns the records whose `updatedAt` is older than `staleMs`.

`RunStatus` is `'queued' | 'running' | 'suspended' | 'completed' | 'failed'`. `RunRecord` carries `{ runId, status, goal?, stepIndex?, plan?, error?, meta?, createdAt, updatedAt }`. A `TaskList` satisfies `PlanSnapshotInput` (`{ goal?, tasks }`) directly, so `setPlan(runId, plan)` and `emitPlanUpdate(emit, plan)` both take one as-is. The worker loop is yours: `pollStaleRuns` finds the runs, `resumeFromCheckpoint` (`@deuz-sdk/core/durable`) continues each.

`emitPlanUpdate(emit, plan)` and `emitActivity(emit, message, { level?, data?, agentPath? })` take `ctx.emitPart` from inside a tool. **`emitPart` exists only in a streaming parent** — under `generateText` it is `undefined` and both calls are silent no-ops, which is the usual reason a live panel stays empty.

`createSteeringController()` gives `enqueue(text)` / `drain()` / `pending`. Drain it from `prepareStep` and append the texts as user turns: the injection lands at the next step boundary, so the in-flight step finishes first and the run is never interrupted mid-tool.

Four stream parts belong to this layer, all on `fullStream` and all on the Deuz UI wire:

| `part.type` | Fields | Emitted |
| --- | --- | --- |
| `verify` | `stepIndex, attempt, ok, willRetry, feedback?` | every `verifyStep` evaluation (streaming loop only) |
| `false-finish` | `stepIndex, attempt, willRetry` | one per `doneWhen` rejection, before the terminal `finish` |
| `plan-update` | `goal?, tasks` | you called `emitPlanUpdate` |
| `activity` | `message, level?, data?, agentPath?` | you called `emitActivity` |

`useChat` from `@deuz-sdk/react` surfaces them as turn-scoped `plan`, `activity`, `verifications` and `falseFinishes`. `StreamPart` is an open union — keep a `default` case in any switch over it.

```ts
import { streamChat } from '@deuz-sdk/core';
import { createRunManager, createSteeringController, emitActivity, emitPlanUpdate } from '@deuz-sdk/core/runtime';
import { createFileRunStore } from '@deuz-sdk/core/runtime/node';
import { createInMemorySessionStore } from '@deuz-sdk/core/durable';
import type { LanguageModel, Tool } from '@deuz-sdk/core';
import type { TaskList } from '@deuz-sdk/core/autonomy';

declare const model: LanguageModel;
declare const plan: TaskList;
declare function renderTodo(tasks: unknown): void;
const runId = 'run-4821';
const runs = createRunManager({ store: createFileRunStore({ dir: './.runs' }) });
const steering = createSteeringController();

await runs.startRun({ runId, goal: plan.goal, meta: { userId: 'u_1' } });
await runs.setPlan(runId, plan); // a TaskList IS a PlanSnapshotInput

const progress: Tool = {
  parameters: { type: 'object', properties: { note: { type: 'string' } }, required: ['note'] },
  execute: async (args, ctx) => {
    emitPlanUpdate(ctx.emitPart, plan); // no-op unless the parent is streaming
    emitActivity(ctx.emitPart, (args as { note: string }).note, { level: 'info' });
    return { ok: true };
  },
};

const result = streamChat({
  model,
  messages: [{ role: 'user', content: plan.goal }],
  tools: { progress },
  maxSteps: 40,
  compaction: 'auto',
  session: { store: createInMemorySessionStore(), runId }, // swap for a durable store pack
  prepareStep: ({ messages }) => {
    const injected = steering.drain(); // elsewhere: steering.enqueue('focus on pricing')
    return injected.length > 0
      ? { messages: [...messages, ...injected.map((content) => ({ role: 'user' as const, content }))] }
      : undefined;
  },
});

for await (const part of result.fullStream) {
  if (part.type === 'plan-update') renderTodo(part.tasks);
  else if (part.type === 'activity') console.log(`[${part.level ?? 'info'}] ${part.message}`);
  else if (part.type === 'false-finish') console.warn(`step ${part.stepIndex}: not done`);
}
await runs.setStatus(runId, 'completed');
```

## Ensembles: pay tokens for quality

All three are `Promise` fan-out with the sharp edges named — none retries, dedupes, or caches for you.

| Strategy | Cost | Worth it when |
| --- | --- | --- |
| `bestOfN({ n, generate, score? \| verifier + goal, concurrency? })` | `n` generations (+ `n` verifier calls when verifier-scored) | one artifact, a cheap objective scorer exists (tests pass, a rubric, a verifier), latency is negotiable |
| `selfConsistency({ n, generate, key?, concurrency? })` | `n` generations | a short comparable answer — a number, a label, a JSON verdict — where agreement is evidence |
| `parallelAgents({ model, tasks, system?, tools?, maxSteps?, concurrency?, signal?, deps?, onUsage? })` | `n` independent loops | `n` genuinely independent jobs (summarise 200 URLs) — fan-out, not quality |

- `bestOfN`: `score` is higher-is-better and **wins over `verifier`** when both are given; supplying neither throws *before* any generation is paid for. Ties go to the first-highest (deterministic). `concurrency` defaults to `n`. Returns `{ best, bestScore, candidates }` with index-stable candidates.
- `selfConsistency`: groups by `key` (default `JSON.stringify`), ties broken by first-seen. Returns `{ answer, votes, total, tally }`. **Useless on free prose** — two correct paragraphs never stringify equal. Give it a `key` that projects the decision, or make `generate` return a small object.
- `parallelAgents`: `maxSteps` defaults to **1** per sub-agent (raise it whenever the tasks use `tools`), `concurrency` defaults to 5, `results` are in task order and carry `{ label?, prompt, text, usage, finishReason }`, and `usage` is summed across every sub-agent. A bare string task is shorthand for `{ prompt }`.

```ts
import { generateObject } from '@deuz-sdk/core';
import { parallelAgents, selfConsistency } from '@deuz-sdk/core/autonomy';
import { createOpenAI } from '@deuz-sdk/core/openai';

const model = createOpenAI({ apiKey: process.env.OPENAI_API_KEY! })('gpt-5.2');
declare const schema: Record<string, unknown>; // { verdict: 'approve' | 'reject', reason }
declare const urls: string[];

// Vote on the decision, never on the wording — `key` projects what is comparable.
const { answer, votes } = await selfConsistency({
  n: 5,
  generate: async () =>
    (await generateObject<{ verdict: 'approve' | 'reject' }>({ model, schema, prompt: 'Refund #4821?' })).object,
  key: (o) => o.verdict,
});

// Wide fan-out: one independent agent per task, results in task order.
const { results } = await parallelAgents({ model, tasks: urls.map((u) => `Summarise ${u}.`), concurrency: 10 });
```

## Evolve: search over programs (2.2)

`evolve` from `@deuz-sdk/core/evolve` (edge-safe) improves a program the way AlphaEvolve / OpenEvolve do: a model proposes a change to the code between `EVOLVE-BLOCK-START` / `EVOLVE-BLOCK-END` lines, a cascade of **your** evaluators scores it, and the best programs parent the next generation. It is a standalone controller, not a swarm and not the tool loop.

```ts
import { createInMemoryPopulationStore, evolve } from '@deuz-sdk/core/evolve';
import { createMockModel } from '@deuz-sdk/core/testing';

const initial = 'def f(x):\n    # EVOLVE-BLOCK-START\n    return x\n    # EVOLVE-BLOCK-END\n';
const diff = '<<<<<<< SEARCH\n    return x\n=======\n    x = x + 1\n    return x\n>>>>>>> REPLACE';

const handle = evolve({
  scope: 'tenant-a',
  runId: 'grow-1',
  initial,
  instructions: 'Make f return as large a value as possible.',
  stages: [
    { name: 'parses', threshold: 1, evaluate: (program) => ({ score: program.includes('return') ? 1 : 0 }) },
    { name: 'count', evaluate: (program) => ({ score: program.split('x = x + 1').length - 1 }) },
  ],
  models: [{ model: createMockModel({ responses: [{ text: diff }] }) }],
  store: createInMemoryPopulationStore(), // createSqlitePopulationStore from /evolve/sqlite on Node
  generations: 3,
  mutationsPerGeneration: 2,
  patch: { diff: 1 },
  budget: { tokens: 200_000 }, // REQUIRED: tokens or usd
  seed: 'demo',
});
const result = await handle.result;
console.log(result.status, result.reason, result.best?.id, result.best?.score); // completed generations g3-i0-s0 3
```

- **Patches.** Per slot a type is drawn from `patch` (default `diff` 0.6 / `full` 0.3 / `cross` 0.1; passing `patch` zeroes omitted types). Each SEARCH must match exactly once inside an evolve block; otherwise the candidate is rejected (`rejection.kind: 'patch'`, `EvolvePatchError` codes `not_found`, `outside_evolve_block`, `ambiguous`, `marker_in_replace`, `frozen_changed`) and the run goes on. `parseEvolveBlocks`, `applySearchReplace`, `extractFullRewrite` and `buildMutationPrompt` are exported pure helpers.
- **Cascade.** `stages` run in order and stop at the first score under its `threshold` or `passed: false`; put cheap checks first. Only candidates passing every stage are `accepted`. A throw or `timeoutMs` rejects with `rejection.kind: 'evaluation'`. Returned `artifacts` (stderr…) and `features` (in `[0, 1]`, for the MAP-Elites grid) feed the next prompt and the elite archive.
- **Search.** `selection` (`'weighted'` default, `'power-law'`, `'beam'`, `{ boltzmann }`), `population` (`size`, `archiveSize`, `eliteRatio`, `exploreRatio`), `islands` (`{ count, migrationEvery, migrationRate, resetWeakestEvery? }`, ring migration), `novelty` (`{ embed, maxCosine = 0.99, judge? }`), `concurrency` (default 4). Several `models` are picked by a UCB1 bandit; `weight: 0` never picks one. Every draw is seeded: same `seed` + store + evaluators replays identically.
- **Stops.** `budget` → `reason: 'budget'` (each mutation runs under a child execution scope named after its candidate, compacted per generation), `stopWhen.targetScore` → `'target'`, `stopWhen.plateau` → `'plateau'`, `handle.drain()` → `'drained'`, `handle.cancel()` / `signal` → `'cancelled'`, else `'generations'`.
- **Resume.** Candidate IDs are `g{generation}-i{island}-s{slot}`, writes are idempotent and generations commit with a compare-and-set, so `resumeEvolve(sameOptions)` replays stored slots with **zero model calls** (`result.modelCalls`), and can extend a finished run with more `generations`. Resume refuses a changed `initial`, island count, `mutationsPerGeneration` or model count, and can only tighten the budget.
- **Leases.** `lease: { provider, owner?, ttlMs? }` (a `LeaseProvider` from `/ops` or `/ops/sqlite`) keeps a second process off a run: it fails with `EvolveLeaseError` `code: 'held'`; an executor that loses its lease stops before its next write (`code: 'lost'`) without marking the run failed. Provider `cancel`/`drain` signals act like `handle.cancel()`/`drain()`.
- **Safety.** The controller never executes a candidate; your evaluators do. Sandbox them (worker, container, remote runtime) — the code is model-written.

## Schedules and signals: starting work without a user (2.2)

`@deuz-sdk/core/schedule` is edge-safe and never reads the host clock on its own. `parseCron` reads five-field **UTC** cron (lists, ranges, steps, names, macros; both day fields restricted means either matches). `createScheduler({ schedules, claim?, catchUp?, lookbackMs? })` runs due occurrences: call `tick(now)` from a platform cron trigger (Vercel cron, a Workers `scheduled` handler), or `start({ intervalMs, signal })` in a Node worker on `deps.clock`.

```ts
import { generateText } from '@deuz-sdk/core';
import { createScheduler, handleSignal, verifyGitHubWebhook } from '@deuz-sdk/core/schedule';
import { createMockModel } from '@deuz-sdk/core/testing';

const model = createMockModel({ responses: [{ text: 'Three PRs merged overnight.' }] });

const scheduler = createScheduler({
  schedules: [
    {
      id: 'morning-digest',
      cron: '0 9 * * MON-FRI',
      run: async (occurrence) => {
        const { text } = await generateText({ model, prompt: 'Summarise the night.' });
        console.log(occurrence.key, text); // key = `${id}@${at}`
      },
    },
  ],
});
const tick = await scheduler.tick(Date.parse('2026-01-05T09:00:20Z'));
console.log(tick.occurrences.map((o) => o.status)); // ['ran']

// Webhooks: verify, dedupe, dispatch — 401 rejected, 200 duplicate, 202 dispatched, 500 threw.
export async function POST(request: Request): Promise<Response> {
  return handleSignal(request, {
    verify: (r) => verifyGitHubWebhook(r, 'webhook-secret'),
    key: ({ request: r }) => r.headers.get('x-github-delivery') ?? undefined,
    dispatch: async ({ body, key }) => console.log('start run', key, body.length),
  });
}
```

- `tick` never throws for your code: a failing `run` / `claim` is `{ status: 'failed', phase }` for that occurrence; a claim answering `false` is `'duplicate'`.
- **Dedupe across processes needs a durable `claim`.** The default is an in-memory set (one process only). `createSqliteOpsStore(...).claims` and `createPostgresOpsStore(...).claims` are durable claims (a unique-insert table whose keys accumulate). A durable run store also works: use `occurrence.key` as the swarm `runId` and treat `SwarmConflictError` as "already claimed", with `claim: () => true`. A claim may carry `release(key)`: `handleSignal` calls it when `dispatch` throws, so the sender's retry is dispatched instead of dropped; the scheduler keeps a failed occurrence's claim (call `claim.release(occurrence.key)` in `run`'s catch to allow a retry).
- `catchUp`: `'latest'` (default, newest due only), `'all'` (oldest first, capped by `maxCatchUp` = 100), `'none'` (newest only if within `graceMs`). A restarted process only sees `lookbackMs` (default 60 000); raise it together with a durable claim to recover missed occurrences.
- Verifiers (`verifyGitHubWebhook`, `verifySlackRequest(req, secret, { now, toleranceSeconds })`, `verifyHmacSignature`) read the body once, use WebCrypto and constant-time comparison, and answer `{ ok: true, body }` or `{ ok: false, reason }`. `handleSignal` claims the key **before** dispatch: keep `dispatch` short (enqueue, or start a run whose `runId` is the key).

## How the two cookbooks compose this

The **coding agent** is the skeleton: an orchestrator `generateText`/`streamChat` whose only tool is `agentTool({ name: 'coder', … })`, one shared `approveToolCall` that inherits into the sub-agent at every depth, `stopWhen: [totalTokensExceed(…), costExceeds(…)]` with `deps.priceProvider`, `compaction: 'auto'`, and `session: { store, runId }` so a killed process resumes with `resumeFromCheckpoint`. Sub-agent usage folds into the parent total, tagged by `meta.agentPath` in `onUsage`.

The **autonomous agent** keeps that skeleton and swaps in the autonomy seams: `planTasks` writes `plan.json` into a `Workspace`; the executor's hand-written file/shell tools become `createWorkspaceTools` + `codeActTool` + `shellTool` over a `ComputeSandbox`; `doneWhen`/`verifyStep` decide whether each sub-task is actually finished; and `createRunManager` + `emitPlanUpdate`/`emitActivity` make the run listable, watchable and continuable. Same loop, same call options — only the tool set and the finishing hooks change.

## Deep dive

- [/docs/modules/autonomy](/docs/modules/autonomy) — every seam in this file, in prose.
- [/docs/cookbooks/autonomous-agent](/docs/cookbooks/autonomous-agent) — plan → CodeAct executor → verifier → durable run, composed end to end.
- [/docs/cookbooks/coding-agent](/docs/cookbooks/coding-agent) — the orchestrator/sub-agent skeleton, approval gates, budgets, restarts.
- [/docs/agents/tool-loop](/docs/agents/tool-loop) — the per-step anatomy, including where `doneWhen` and `verifyStep` sit.
- [/docs/agents/subagents](/docs/agents/subagents) — `agentTool`, `agentPath`, approval inheritance, usage attribution.
- [/docs/agents/durable-runtime](/docs/agents/durable-runtime) — checkpoints, resume semantics, signed approvals.
- [/docs/modules/compaction](/docs/modules/compaction) — what automatic compaction prunes, i.e. why a workspace beats a bigger context.
- [/docs/reference/stream-protocol](/docs/reference/stream-protocol) — the wire encoding of `verify`, `false-finish`, `plan-update`, `activity`.
- [/docs/modules/react-hooks](/docs/modules/react-hooks) — `plan`, `activity`, `verifications` and `falseFinishes` in `useChat`.
- [/docs/modules/evolve](/docs/modules/evolve) — patches, the evaluation cascade, islands, novelty, budget, durable resume.
- [/docs/modules/schedule](/docs/modules/schedule) — cron syntax, catch-up, durable dedupe with a swarm run, webhook verification.
