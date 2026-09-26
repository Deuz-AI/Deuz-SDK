<!-- verified: 2026-09-26 against @deuz-sdk/core@2.1.0 + the 2.2 changesets · api-contract sha256:c025621e10fd
     sources: packages/core/src/{agent-run,execution-policy,budget-ledger,ops}.ts,
       src/types/{agent-run,execution,swarm,lease}.ts, src/inference/{agent-tools,loop-shared}.ts,
       src/swarm/{scheduler,store,spawn,blackboard,rounds}.ts, src/node/{swarm-sqlite,ops-sqlite}.ts,
       docs/content/docs/modules/{swarm,operations,native-agents}.mdx -->

# Native agents, shared execution policy and swarm

**Load when:** using the optional native engine for tools plus validated output, durable approval/resume, inherited restrictions, cumulative budgets, or a bounded swarm of agents and reducers — fixed or growing at runtime (2.2 `dynamic`), sharing notes on a blackboard, running in rounds, or moving between processes with leases, drain and recovery. Existing `generateText`, `streamChat`, `createAgent`, legacy sessions and the Deuz UI wire remain available; native results have a separate contract.

## Choose the entry point

| Need | Import and contract |
| --- | --- |
| Await an accepted agent outcome | `runAgent` from `@deuz-sdk/core/agent` → `Promise<AgentResult<T>>` |
| Observe drafts, tool results and the outcome | `streamAgent` → `AgentStream<T>`; access `result` or `consume()` to run without a stream reader |
| Resume the same scoped native session | `resumeAgent` / `resumeStreamAgent` with its `AgentRunSession` |
| Reusable legacy agent configuration | `createAgent`; its methods retain the existing loop contract |
| Agent/reducer dependency graph | `createSwarm` from `@deuz-sdk/core/swarm` |
| Tasks that create tasks at runtime (2.2) | `createSwarm({ dynamic: { maxTasks, maxSpawnDepth } })` + `context.spawn` / binding `spawn(output)` |
| Rounds of agents with a consolidator (2.2) | `createRounds` from `@deuz-sdk/core/swarm` |
| Several processes sharing runs (2.2) | `createSwarm({ lease })` + a `LeaseProvider` from `/ops`, `/ops/sqlite` or `/ops/postgres` |
| Persist swarm state on Node | `createSqliteSwarmStore` (`/swarm/sqlite`) or `createPostgresSwarmStore` (`/swarm/postgres`) |

The native default is `maxSteps: 20`, counting working, finalization and repair model steps. `maxOutputAttempts` defaults to 2; `maxVerifyAttempts` to 3. Resume cannot reset consumed steps or raise persisted attempt limits. Set explicit limits for application workloads.

## Tools plus runtime-validated output

```ts
import { createExecutionContext, runAgent } from '@deuz-sdk/core/agent';
import type { LanguageModel } from '@deuz-sdk/core';
import { z } from 'zod';

declare const model: LanguageModel;

const result = await runAgent({
  model,
  prompt: 'Look up the number and return an answer.',
  maxSteps: 6,
  tools: {
    lookup: {
      parameters: z.object({}),
      outputSchema: z.object({ value: z.number() }),
      execute: async () => ({ value: 42 }),
    },
  },
  output: { schema: z.object({ answer: z.number() }) },
  execution: createExecutionContext({
    policy: { allowedModels: [model.modelId], allowedTools: ['lookup'], maxDepth: 2 },
    budget: { tokens: 16_000 },
  }),
  verify: ({ output }) =>
    output.answer === 42
      ? { status: 'verified' }
      : { status: 'rejected', feedback: 'The lookup result was 42.' },
});

if (result.status === 'completed') console.log(result.output.answer);
else console.log(result.status); // suspended, stopped or failed; no accepted output
```

`output` accepts a Standard Schema or raw JSON Schema **with** a `validate(value)` function that returns the validated value or throws. Supplying a generic `T` or JSON Schema alone does not validate data. Draft `partialOutputStream` values are `unknown`; array elements need the independent `output.element` validator, and do not certify the entire array. Subscribe to needed streams before starting `result` if you require their complete history.

Native `AgentTool` also supports `contextSchema` / `validateContext`, `outputSchema` / `validateResult` and `toModelOutput`. Supply private context by tool name in `toolsContext`; a tool receives only its own validated `context`. Provider history gets `toModelOutput`'s projection, while `tool-output` events retain the raw result. Treat those events and durable receipts as sensitive application data. Legacy `Tool.outputSchema` alone is metadata; this validation behavior belongs to native tools.

`verify` returns `verified`, `rejected` with repair feedback, or `inconclusive` with a reason. An inconclusive verdict is not accepted success. If a verifier makes another model call, pass its `context.execution` into that call so its cost and restrictions participate in the same run.

Native options deliberately exclude `chat`, `memory`, `fallbackModels`, `verifyStep`, `doneWhen` and `falseFinishGuard`. Use the existing loop for those options; do not cast unsupported fields into a native run.

## Persistence and approval recovery

`AgentRunSession` is `{ store, runId, scope }`. Its `AgentRunStore` saves versioned `AgentRunEnvelope` values and is separate from legacy `SessionStore` / `AgentCheckpoint` and background `RunStore`. `createInMemoryAgentRunStore()` is useful for tests and one process; it does not survive process loss. Application stores must commit durably before `save` resolves and reject failures.

```ts
import { runAgent, resumeAgent } from '@deuz-sdk/core/agent';
import type { AgentRunOptions, AgentRunSession } from '@deuz-sdk/core/agent';

declare const options: AgentRunOptions & { session: AgentRunSession };
const first = await runAgent(options);

if (first.status === 'suspended' && first.pendingApprovals.length > 0) {
  // Display the request and collect a real application verdict first.
  const stillPending = await resumeAgent({ ...options, approvalResponses: [] });
  console.log(stillPending.status); // missing verdicts remain suspended
}
```

Resume with the same `scope`, `runId`, compatible model/tools/output and `bindingId`; bump `bindingId` when tool implementation or verifier semantics change. Deliver actual user verdicts through `approvalResponses`, preserving each request's signed `token` when `approvalSigner` is configured. Subagent signatures bind the child run/path; do not flatten sibling approvals by provider call ID alone. Swarm verdicts are additionally keyed by task ID.

Persistence failures stop native execution, including failed reservation, tool receipt and terminal-result writes. Completed work is not automatically repeated on resume. A tool receipt interrupted in `executing` state needs application reconciliation before `retryToolCallIds` authorizes another execution. This cannot make an external service's side effect exactly once: use its idempotency key or reconcile its state. Resuming a completed run returns the persisted outcome.

**Idempotent tools (2.2).** A native tool marked `replay: 'idempotent'` runs again on resume after an interruption without `retryToolCallIds`; plain tools still stop for reconciliation. Every native tool receives `ctx.modelStep` (the root model turn that issued the call); with `ctx.toolCallId` it is stable across resume, so key the effect on both. Only mark a tool idempotent when repeating it truly has no further effect, and bump `bindingId` when you change the flag on a durable run.

**Revisions (2.2).** `AgentRunEnvelope.revision` increases on every save. The in-memory, SQLite (`createSqliteOpsStore(...).agentRuns`, `/ops/sqlite`) and Postgres (`/ops/postgres`) stores reject anything but stored + 1, so a stale second executor cannot overwrite the first; its run result reports the failed save. A custom store should enforce the same rule.

Native cancellation and tool timeout send an abort signal and drain active effects before releasing the run. Tools should honor `context.signal`. An effect that ignores abort can keep the run pending until it settles; use an external isolated executor when a hard kill is required.

## Mandatory restrictions and cumulative accounting

`createExecutionContext({ policy, budget, scopeId? })` provides a shared `NativeExecutionContext`. `execution.child({ scopeId, policy?, budget? })` keeps the ledger and only narrows constraints. `allowedTools` / `allowedModels` intersect, `maxDepth` and `deadlineAt` take the stricter limit, and `requireApproval` cannot be disabled by a child. An omitted allowlist is unrestricted; an empty one denies all. Depth starts at zero; deadlines are epoch milliseconds checked against `deps.clock`.

Use `execution` on model calls and the inherited context supplied to tools, children and verifiers. Legacy guardrail callbacks are separate from these mandatory restrictions; adding a child must not discard the execution context. `prepareStep` model changes, child calls, compaction and native finalization are charged to the actual model invoked.

Each potentially billable HTTP attempt reserves by a stable request ID before dispatch, then settles known usage. `executionEstimate: { tokens?, usd? }` overrides the estimate; conservative estimates and `maxOutputTokens` matter. Bounded USD admission requires known pricing or an explicit USD estimate; missing final pricing keeps that reservation. Unknown billing keeps reservations across recovery, including an uncertainty count when the estimate was zero. Confirmed unbilled attempts may be released. Actual usage can exceed an estimate and block later admissions; this is not a provider-enforced billing cap.

**Ledger slices and compaction (2.2).** A child scope's ID is a path (`root.child({ scopeId: 'a' }).scopeId === 'job/a'` under a root `'job'`). A native run given a child of a shared ledger checkpoints only its own slice (`ledger.subtree`): the parent persists the shared ledger, and the run must be resumed with the same `execution` — a slice cannot seed a new ledger. `ledger.compact(scopeId)` folds a **finished** scope's settled and unknown reservations into one aggregate per ancestor chain and drops released ones: global and ancestor totals are unchanged, the scope's per-request records are gone, and a later cap still fails closed for folded unestimated usage. Never compact a scope that may reserve again. Snapshots with aggregates, a slice or persistent admission are version 2, which 2.1 refuses. Persistent cross-run scopes (`admission: { store, scopes }`) are in `references/ops.md`.

Persist `execution.snapshot()` with run state. `createExecutionContext({ snapshot })` restores it; a fresh empty ledger cannot replace persisted accounting on resume. An already-shared live context may contain newer sibling reservations. Ledger mutations serialize within the process; failed persistence poisons that ledger, preventing later admissions. `ledger.addPersistence` callbacks may persist or read snapshots, but must not call or await ledger mutations from inside the callback.

## Bounded task graphs

```ts
import { createAgent } from '@deuz-sdk/core/agent';
import { createInMemorySwarmStore, createSwarm } from '@deuz-sdk/core/swarm';
import type { LanguageModel } from '@deuz-sdk/core';

declare const model: LanguageModel;

const swarm = createSwarm({
  agents: { researcher: createAgent({ model, instructions: 'Return a concise finding.' }) },
  reducers: {
    collect: {
      execute: (results) => Object.fromEntries(
        Object.entries(results).map(([id, result]) => [id, result.output]),
      ),
    },
  },
  store: createInMemorySwarmStore(),
  concurrency: 4,
  definitionVersion: 'research-v1',
  budget: { tokens: 40_000 },
});

const handle = await swarm.run({
  scope: 'tenant-a:research',
  runId: 'comparison-1',
  tasks: [
    { id: 'a', agent: 'researcher', prompt: 'Analyze approach A.' },
    { id: 'b', agent: 'researcher', prompt: 'Analyze approach B.' },
    { id: 'summary', reducer: 'collect', dependsOn: ['a', 'b'] },
  ],
});
const snapshot = await handle.result;
console.log(snapshot.run.status, snapshot.tasks.map((task) => [task.task.id, task.status]));
```

Tasks submitted at run creation form a DAG. Agent bindings can be a `DeuzAgent` or `{ agent, version, output, tools, toolsContext, verify, maxOutputAttempts, maxVerifyAttempts, policy, budget, spawn, onFailure, blackboard }`. Reducers receive successful dependencies' accepted outputs, not raw tool receipts; heterogeneous `output` values are `unknown` and need checking. Pass the reducer's `context.execution` into any model call it makes. The shared root budget covers all tasks; per-binding budgets can narrow it. The swarm compacts each task's reservations into ancestor aggregates when the task becomes terminal, so the run ledger grows with live work, not history; read a finished task's own cost from its agent result's `accounting`.

Concurrency defaults to 5 and bounds active tasks; a thousand logical tasks does not mean a thousand concurrent providers. Failed tasks block descendants while unrelated branches continue. Run statuses are `running`, `completed`, `partial`, `suspended`, `cancelled`; inspect task statuses for failures or `needs_reconciliation`. `handle.events({ afterSequence })` and `swarm.events(key, { afterSequence })` read durable sequence cursors, independently of `handle.result`. Task `timeoutMs` (2.2) bounds each attempt; expiry aborts it and fails the task as `SwarmTaskTimeout`.

Resume with `swarm.resume({ scope, runId, approvals?, clientToolResults?, retryTaskIds?, retryToolCallIds?, expectedRevision?, expectedStatus? })`. Approval/client results are keyed by task. Missing verdicts stay suspended. Interrupted tasks default to manual reconciliation; opt into `replay: 'safe'` only when the application establishes repeatability. Retrying interrupted native effects requires reconciled tool-call IDs keyed by task as well as that task's `retryTaskIds` entry. Change `definitionVersion` and binding versions when behavior changes; an incompatible recovery is rejected. `expectedRevision` / `expectedStatus` claim the run only in the state you inspected, otherwise `SwarmConflictError`.

For Node persistence, substitute `createSqliteSwarmStore({ path: './swarm.db' })` and await `store.close()` after active handles settle. The store commits snapshots and event rows atomically; it is separate from `createSqliteStores()`'s legacy store pack. 2.2 upgrades a 2.1 SQLite swarm file to schema 2 on first open, and 2.1 then refuses it — back the file up first. `/agent`, `/swarm` and `/ops` are web-safe; `/swarm/sqlite`, `/swarm/postgres`, `/ops/sqlite` and `/ops/postgres` are Node-only.

## Dynamic swarms (2.2)

With `dynamic: { maxTasks, maxSpawnDepth, maxSpawnPerTask? }`, a finished task can create tasks. A reducer queues requests through `context.spawn(requests)` (discarded if it throws); an agent binding maps its accepted output through `spawn(output, context)`. A request is `{ key, agent, prompt }` or `{ key, reducer }` plus optional `dependsOn`, `after`, `group`, `replay`, `timeoutMs`. The spawned ID is `parentId/key`, and `dependsOn` names full IDs of existing tasks or of tasks in the same request.

```ts
import { createInMemorySwarmStore, createSwarm } from '@deuz-sdk/core/swarm';

const swarm = createSwarm({
  agents: {},
  store: createInMemorySwarmStore(),
  dynamic: { maxTasks: 50, maxSpawnDepth: 2 },
  reducers: {
    plan: {
      execute(_results, context) {
        const shards = ['north', 'south'];
        context.spawn([
          ...shards.map((key) => ({ key, reducer: 'count' })),
          { key: 'total', reducer: 'sum', dependsOn: shards.map((key) => `${context.taskId}/${key}`) },
        ]);
        return shards.length;
      },
    },
    count: { execute: (_results, context) => context.taskId.length },
    sum: {
      execute: (results) => Object.values(results).reduce((total, r) => total + Number(r.output), 0),
    },
  },
});

const outcome = await (await swarm.run({ scope: 'tenant-a', tasks: [{ id: 'plan', reducer: 'plan' }] })).result;
console.log(outcome.tasks.map((t) => t.task.id)); // plan, plan/north, plan/south, plan/total
```

- **Atomic.** Children commit in the same commit as the parent's terminal state: a crash never duplicates or loses them. Every request is validated first; an unknown binding, a key with `/`, a missing dependency, a cycle or an exceeded limit fails the spawning task and creates nothing.
- **Limits.** `maxTasks` (at most 10 000) bounds the run, `maxSpawnDepth` (at most 64) the generations below a root, `maxSpawnPerTask` one parent. They are stored with the run; resume can only tighten them.
- **Compensation.** `onFailure(context)` on an agent or reducer binding returns tasks that commit with the failure; they cannot depend on the failed task.
- **Compatibility.** Dynamic runs are version 2 (2.1 refuses them) and need a store whose `capabilities` include `'spawn'` — memory, SQLite and Postgres do. `createSwarm` throws for a store without it rather than silently dropping spawned tasks. The journal records `task.spawned` per child.

## Groups, blackboards, soft dependencies and rounds (2.2)

- **Blackboard.** Give a task a `group` (letters, digits, `_`) and its agent binding `blackboard: { read?: 'group' | string[], post?: boolean }`. The agent gets `blackboard_post` (to its group's channel; ungrouped tasks share `main`) and `blackboard_read`. Posts are durable, ordered per channel, journaled as `channel.posted`, and keyed by task, model step and tool call, so a resumed post never adds a second note. Reducers page channels with `context.readChannel(channel, afterSequence?, limit?)`. Needs the `'channels'` capability.
- **Soft dependencies.** `after: [...]` waits for tasks to settle in **any** terminal state; only completed results arrive, and a reducer reads every listed status in `context.settled`. Use it for joins that must run when some work fails; `dependsOn` still blocks on failure.
- **Rounds.** `createRounds({ id, initial, consolidate, maxRounds, agents?, replay?, timeoutMs? })` returns `{ tasks, reducers }`. Each round's agents run in blackboard groups; the consolidator (joined with `after`) gets `{ round, groups, settled, readChannel, execution, signal }` and returns `{ stop?, groups?: { [group]: { agent, count, prompt } }, summary? }`. No groups, `stop`, or `maxRounds` ends the chain. A decision may only schedule bindings in `agents` (default: those in `initial`) — a guard for model-chosen plans.

```ts
import { createAgent } from '@deuz-sdk/core/agent';
import { createMockModel } from '@deuz-sdk/core/testing';
import { createInMemorySwarmStore, createRounds, createSwarm } from '@deuz-sdk/core/swarm';

const model = createMockModel({
  responses: [{ text: 'The simpler case breaks at t=1.' }, { text: 'Attempt A.' }, { text: 'Attempt B.' }],
});

const rounds = createRounds({
  id: 'search',
  maxRounds: 3,
  initial: { warmup: { agent: 'solver', count: 1, prompt: 'Solve the simpler case.' } },
  consolidate({ round, groups }) {
    if (round === 1) {
      const lead = String(groups.warmup?.[0]?.output);
      return { groups: { main: { agent: 'solver', count: 2, prompt: `Build on: ${lead}` } } };
    }
    return { stop: true, summary: groups.main?.map((result) => result.output) };
  },
});

const swarm = createSwarm({
  store: createInMemorySwarmStore(),
  dynamic: { maxTasks: 100, maxSpawnDepth: 4 }, // spawn depth must be at least maxRounds
  agents: { solver: { agent: createAgent({ model }), blackboard: { read: 'group', post: true } } },
  reducers: rounds.reducers,
});
const outcome = await (await swarm.run({ scope: 'lab', tasks: rounds.tasks })).result;
console.log(outcome.tasks.at(-1)?.result?.output);
```

## Several processes: leases, drain, recovery, cancellation (2.2)

A **lease** is liveness: the executor holding `swarm:<scope, runId>` drives the run and renews every `ttlMs / 3` on `deps.clock`. The store's **revision** check is the fence: a paused "zombie" executor's commit after a takeover is rejected even before its heartbeat notices.

```ts
import { createAgent } from '@deuz-sdk/core/agent';
import { createMockModel } from '@deuz-sdk/core/testing';
import { createInMemoryLeaseProvider } from '@deuz-sdk/core/ops';
import { createInMemorySwarmStore, createSwarm, SwarmLeaseError } from '@deuz-sdk/core/swarm';

const model = createMockModel({ responses: [{ text: 'done' }] });

const swarm = createSwarm({
  agents: { worker: createAgent({ model }) },
  store: createInMemorySwarmStore(), // the SQLite or Postgres store when processes share runs
  lease: { provider: createInMemoryLeaseProvider(), owner: 'worker-1', ttlMs: 30_000 },
});

const handle = await swarm.run({
  scope: 'tenant-a',
  runId: 'nightly',
  tasks: [{ id: 'answer', agent: 'worker', prompt: 'Answer.' }],
});
try {
  const drained = await handle.drain(); // deploy: finish in-flight tasks, settle 'suspended', release the lease
  console.log(drained.run.status);
} catch (error) {
  if (!(error instanceof SwarmLeaseError)) throw error;
  console.log(error.code); // 'held' (another executor drives it) or 'lost' (taken over; this one stopped writing)
}
```

- `run` / `resume` reject with `SwarmLeaseError` `'held'` while another executor holds the run. A renewal reporting the lease gone aborts the tasks and rejects `handle.result` with `'lost'` (also when a stale write meets the revision check first); task records stay, and the next executor reconciles them as after a crash. A renewal that throws counts as lost only once the lease could have expired.
- `handle.drain()` stops dispatch and waits for in-flight tasks; the run settles `'suspended'` (or terminal if nothing remains) after a `run.drained` event. A `'drain'` lease signal does the same from another process.
- `swarm.recover({ scope?, limit? })` resumes `'running'` runs without a live lease holder, with `expectedRevision`; it needs the `lease` option and a store with `'list'` (`SwarmStore.listRuns`, paged with an `after` cursor). It pages past live runs (up to 10 000 per call), takes over at most `limit` (1..1000), and resolves to `{ handles, failed }`: a run it cannot resume (for example an older `definitionVersion`) lands in `failed` while the others are recovered. Call it at startup and on a timer.
- `swarm.requestCancel(key)` returns `'signalled'` (this process or the lease holder cancels), `'recorded'` (nobody drives it: a compare-and-set commit stores the request; the next executor cancels), or `'settled'`. A signalled cancel stays queued on the lease until an executor collects it, so a crashed holder's successor or the next resume applies it before dispatching; a custom `LeaseProvider` must keep a queued `'cancel'` across `acquire` and `release`.
- Clocks: SQLite leases use the host clock (synchronise processes sharing a file); Postgres leases use the database clock. Without a lease provider, drive a run from one process only.

Leases do not make external effects exactly-once. A task interrupted by a takeover follows the same `replay` rules as one interrupted by a crash; use the service's idempotency key or reconcile. Cancellation and drain are cooperative: tools and reducers must honor their signal.
