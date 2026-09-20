<!-- verified: 2026-09-20 against @deuz-sdk/core@2.1.0 · api-contract sha256:c301da6ab500
     sources: packages/core/src/{agent-run,execution-policy,budget-ledger}.ts,
       src/types/{agent-run,execution,swarm}.ts, src/inference/{agent-tools,loop-shared}.ts,
       src/swarm/scheduler.ts, src/node/swarm-sqlite.ts -->

# Native agents, shared execution policy and swarm

**Load when:** using the optional 2.1 native engine for tools plus validated output, durable approval/resume, inherited restrictions, cumulative budgets, or a bounded fixed task DAG. Existing `generateText`, `streamChat`, `createAgent`, legacy sessions and the Deuz UI wire remain available; native results have a separate contract.

## Choose the entry point

| Need | Import and contract |
| --- | --- |
| Await an accepted agent outcome | `runAgent` from `@deuz-sdk/core/agent` → `Promise<AgentResult<T>>` |
| Observe drafts, tool results and the outcome | `streamAgent` → `AgentStream<T>`; access `result` or `consume()` to run without a stream reader |
| Resume the same scoped native session | `resumeAgent` / `resumeStreamAgent` with its `AgentRunSession` |
| Reusable legacy agent configuration | `createAgent`; its methods retain the existing loop contract |
| Fixed agent/reducer dependency graph | `createSwarm` from `@deuz-sdk/core/swarm` |
| Persist swarm state in SQLite on Node | `createSqliteSwarmStore` from `@deuz-sdk/core/swarm/sqlite` |

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

Native cancellation and tool timeout send an abort signal and drain active effects before releasing the run. Tools should honor `context.signal`. An effect that ignores abort can keep the run pending until it settles; use an external isolated executor when a hard kill is required.

## Mandatory restrictions and cumulative accounting

`createExecutionContext({ policy, budget, scopeId? })` provides a shared `NativeExecutionContext`. `execution.child({ scopeId, policy?, budget? })` keeps the ledger and only narrows constraints. `allowedTools` / `allowedModels` intersect, `maxDepth` and `deadlineAt` take the stricter limit, and `requireApproval` cannot be disabled by a child. An omitted allowlist is unrestricted; an empty one denies all. Depth starts at zero; deadlines are epoch milliseconds checked against `deps.clock`.

Use `execution` on model calls and the inherited context supplied to tools, children and verifiers. Legacy guardrail callbacks are separate from these mandatory restrictions; adding a child must not discard the execution context. `prepareStep` model changes, child calls, compaction and native finalization are charged to the actual model invoked.

Each potentially billable HTTP attempt reserves by a stable request ID before dispatch, then settles known usage. `executionEstimate: { tokens?, usd? }` overrides the estimate; conservative estimates and `maxOutputTokens` matter. Bounded USD admission requires known pricing or an explicit USD estimate; missing final pricing keeps that reservation. Unknown billing keeps reservations across recovery, including an uncertainty count when the estimate was zero. Confirmed unbilled attempts may be released. Actual usage can exceed an estimate and block later admissions; this is not a provider-enforced billing cap.

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

Tasks form a fixed DAG submitted at run creation. Agent bindings can be a `DeuzAgent` or `{ agent, version, output, tools, toolsContext, verify, maxOutputAttempts, maxVerifyAttempts, policy, budget }`. Reducers receive successful dependencies' accepted outputs, not raw tool receipts; heterogeneous `output` values are `unknown` and need checking. Pass the reducer's `context.execution` into any model call it makes. The shared root budget covers all tasks; per-binding budgets can narrow it.

Concurrency defaults to 5 and bounds active tasks; a thousand logical tasks does not mean a thousand concurrent providers. Failed tasks block descendants while unrelated branches continue. Run statuses are `running`, `completed`, `partial`, `suspended`, `cancelled`; inspect task statuses for failures or `needs_reconciliation`. `handle.events({ afterSequence })` and `swarm.events(key, { afterSequence })` read durable sequence cursors, independently of `handle.result`.

Resume with `swarm.resume({ scope, runId, approvals?, clientToolResults?, retryTaskIds?, retryToolCallIds? })`. Approval/client results are keyed by task. Missing verdicts stay suspended. Interrupted tasks default to manual reconciliation; opt into `replay: 'safe'` only when the application establishes repeatability. Retrying interrupted native effects requires reconciled tool-call IDs keyed by task as well as that task's `retryTaskIds` entry. Change `definitionVersion` and binding versions when behavior changes; an incompatible recovery is rejected.

For Node persistence, substitute `createSqliteSwarmStore({ path: './swarm.db' })` and await `store.close()` after active handles settle. The store commits snapshots and event rows atomically; it is separate from `createSqliteStores()`'s legacy store pack. `/agent` and `/swarm` are web-safe; `/swarm/sqlite` is Node-only.

The scheduler coordinates one JavaScript process. Persistent CAS and SQLite do not supply distributed worker leases, cross-process ownership, automatic task generation or exactly-once external effects. Deploy one executor per run, or supply application-level ownership and transactional admission when crossing process boundaries.
