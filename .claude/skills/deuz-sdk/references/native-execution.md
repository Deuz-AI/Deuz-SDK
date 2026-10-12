<!-- verified: 2026-10-12 against @deuz-sdk/core@2.2.0 · api-contract sha256:3b9611faf697
     sources: packages/core/src/{agent-run,execution-policy,budget-ledger,ops}.ts,
       src/types/{agent-run,execution,swarm,lease}.ts, src/inference/{agent-tools,loop-shared,native-mcp}.ts,
       src/internal/{agent-run-lease,native-memory,native-chat,native-fallback,native-request,native-retry}.ts,
       src/swarm/{scheduler,store,spawn,blackboard,rounds}.ts, src/node/{swarm-sqlite,ops-sqlite,ops-redis,swarm-redis}.ts,
       docs/content/docs/modules/{swarm,operations,native-agents,native-mcp}.mdx -->

# Native agents, shared execution policy and swarm

**Load when:** using the optional native engine for tools plus validated output, durable approval/resume, inherited restrictions, cumulative budgets, MCP tools, memory, chat history or model fail-over inside a run (2.3), recovering a run after an interrupted effect or a transient failure (2.3), or a bounded swarm of agents and reducers — fixed or growing at runtime (2.2 `dynamic`), sharing notes on a blackboard, running in rounds, or moving between processes with leases, drain and recovery. Existing `generateText`, `streamChat`, `createAgent`, legacy sessions and the Deuz UI wire remain available; native results have a separate contract.

## Choose the entry point

| Need | Import and contract |
| --- | --- |
| Await an accepted agent outcome | `runAgent` from `@deuz-sdk/core/agent` → `Promise<AgentResult<T>>` |
| Observe drafts, tool results and the outcome | `streamAgent` → `AgentStream<T>`; access `result` or `consume()` to run without a stream reader |
| Resume the same scoped native session | `resumeAgent` / `resumeStreamAgent` with its `AgentRunSession` |
| Reusable legacy agent configuration | `createAgent`; its methods retain the existing loop contract |
| One native run driven by one process at a time (2.3) | `runAgent({ session, lease })` + a `LeaseProvider`; key `agentRunLeaseKey(session)` from `/ops` |
| Find native runs to resume after a crash (2.3) | `findStaleAgentRuns(store, { staleMs })` from `@deuz-sdk/core/ops` over `AgentRunStore.list` |
| Move a leased native run off a process for a deploy (2.3) | `leases.signal(agentRunLeaseKey(session), 'drain')` stops it at a step boundary (`'drained'`); `resumeAgent` elsewhere goes on |
| Settle a finished run's chat projection or memory extraction (2.3) | `reconcileAgentRun({ session, chat?, memory?, lease? })` |
| Agent/reducer dependency graph | `createSwarm` from `@deuz-sdk/core/swarm` |
| Tasks that create tasks at runtime (2.2) | `createSwarm({ dynamic: { maxTasks, maxSpawnDepth } })` + `context.spawn` / binding `spawn(output)` |
| Rounds of agents with a consolidator (2.2) | `createRounds` from `@deuz-sdk/core/swarm` |
| Several processes sharing runs (2.2) | `createSwarm({ lease })` + a `LeaseProvider` from `/ops`, `/ops/sqlite`, `/ops/postgres` or (2.3) `/ops/redis` |
| Persist swarm state on Node | `createSqliteSwarmStore` (`/swarm/sqlite`), `createPostgresSwarmStore` (`/swarm/postgres`) or (2.3) `createRedisSwarmStore` (`/swarm/redis`) |

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

`output` accepts a Standard Schema or raw JSON Schema **with** a `validate(value)` function that returns the validated value or throws. Supplying a generic `T` or JSON Schema alone does not validate data. Draft `partialOutputStream` values are `unknown`; for an array output, `elementStream` yields each completed top-level element (`{ attempt, index, value }`) only once the independent `output.element` validator accepts it (a rejected element is left out), and those elements do not certify the entire array. Subscribe to needed streams before starting `result` if you require their complete history.

Native `AgentTool` also supports `contextSchema` / `validateContext`, `outputSchema` / `validateResult` and `toModelOutput`. Supply private context by tool name in `toolsContext`; a tool receives only its own validated `context`. Provider history gets `toModelOutput`'s projection, while `tool-output` events retain the raw result. Treat those events and durable receipts as sensitive application data. Legacy `Tool.outputSchema` alone is metadata; this validation behavior belongs to native tools.

`verify` returns `verified`, `rejected` with repair feedback, or `inconclusive` with a reason. An inconclusive verdict is not accepted success. A verifier that throws is inconclusive, unless the run was cancelled (it stops with reason `aborted`) or the execution deadline elapsed (it fails with `ExecutionPolicyError`); both are checked again after the verifier returns and outrank its verdict. If the write that follows a verdict fails, the run stays in `finalizing`, and a resume runs the verifier again on the same candidate without a model call, as a new attempt toward `maxVerifyAttempts` (with none left it stops with `verification-attempts-exhausted`). Make verifiers idempotent: key any side effect on the run and the candidate's `text`, not on `attempt`, which differs on the repeat. If a verifier makes another model call, pass its `context.execution` into that call so its cost and restrictions participate in the same run.

**Finalization (2.3).** With tools and `output`, the finalization request ends with a user turn instead of the loop's last assistant answer (a prefill that Claude 5.x rejects with 400), persisted once so the transcript stays append-only. A json-strategy finalization sends the loop's own tools with `tool_choice: 'none'` beside `output_config.format` / `response_format` / `text.format` on Anthropic, Chat Completions and Responses, so the request prefix stays the loop's for the prompt cache and preserved thinking; Gemini native sends the JSON schema alone, and the tool strategy sends only its forced output tool. After a handoff the target's model answers the finalization and any verifier re-drive. Not live-verified.

**Refusals (2.3).** A turn the provider refused (`content_filter`: Anthropic `stop_reason: 'refusal'`, an OpenAI refusal, a Gemini or Responses content filter) or cut off (`length`) never dispatches its tool calls. A native run that ends on a refusal stops with reason `'refusal'` (not the raw `'content_filter'`), and `AgentResult.stopDetails` carries the provider's explanation (Anthropic's category and text; an OpenAI refusal's text as `explanation`). A Gemini turn that stopped without a usable answer (`LANGUAGE`, `OTHER`, `MALFORMED_FUNCTION_CALL`, …) ends with `finishReason: 'error'`, and the run stops with reason `'error'` instead of completing with an empty answer (`references/providers.md`). Cancellation and the execution deadline are checked again after async output validation, guardrails and the verifier.

Native options deliberately exclude `verifyStep`, `doneWhen` and `falseFinishGuard` (a native run given them fails with a `TypeError`). Since 2.3 `memory`, `chat` and `fallbackModels` are native options with checkpoint-bound semantics (below), and `mcp` runs behind the native receipts.

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

Resume with the same `scope`, `runId`, compatible model/tools/output and `bindingId`; bump `bindingId` when tool implementation or verifier semantics change. Since 2.3 the binding also covers each handoff target's model, instructions and tool schemas (`binding.handoffs`), the MCP servers' tool catalog (`binding.mcp`), the memory scope, the chat and the `fallbackModels`: a resume that changed any of them fails before anything is written (`Native agent binding changed across resume.`). Deliver actual user verdicts through `approvalResponses`, preserving each request's signed `token` when `approvalSigner` is configured, and answer with the `approvalId` you were given: since 2.3 it binds the call (the tool call id plus a digest of the run, the step, the sub-agent path, the tool and the arguments), so a kept verdict never approves another call; the bare tool call id still counts when the run used that id once. Subagent signatures bind the child run/path; do not flatten sibling approvals by provider call ID alone. Swarm verdicts are additionally keyed by task ID.

Persistence failures stop native execution, including failed reservation, tool receipt and terminal-result writes. Completed work is not automatically repeated on resume. A tool receipt interrupted in `executing` state is an effect of unknown outcome: the resume stops with `tool-reconciliation-required` until you reconcile it (below). This cannot make an external service's side effect exactly once: use its idempotency key or reconcile its state. Resuming a completed run returns the persisted outcome. A receipt whose `execute` threw is `'failed'` (2.3): the model already got the error, so a resume replays it and never runs the call again. A tool is admitted (policy, deadline, cancellation) before its `executing` receipt is written, so a call refused up front never reads as an unknown effect.

**Answered from the receipt (2.3).** A receipt is saved before the step checkpoint that answers its call, so a run can stop in between (the process dies during the next model call, a store write fails, a sub-agent called in the same step suspends), and the next resume finds the call unanswered. A pending call whose receipt records an outcome (`executed`, `completed`, `failed`, `validation-failed`, `projection-failed`, an outcome recorded with `reconciledToolResults` included) is answered from that receipt like a call that needs no approval: the execution policy and `onToolCall` still judge it, the tool does not run again, and the approval gate does not hold it again, whether `needsApproval` or the policy's `requireApproval` gated it, so the resume needs no verdict for it. A verdict passed for it anyway is ignored, with a `warning` part (`setting: 'approvalResponses'`) that names the call. Only a call without a recorded outcome needs its verdict again: one that never started, one in `executing` that `retryToolCallIds` runs again, a sub-agent call in `suspended`. A client tool's call is not answered from a receipt: it has no executor to replay one.

**Idempotent tools (2.2).** A native tool marked `replay: 'idempotent'` runs again on resume after an interruption without `retryToolCallIds`; plain tools still stop for reconciliation. Every native tool receives `ctx.modelStep` (the root model turn that issued the call); with `ctx.toolCallId` it is stable across resume, so key the effect on both. Since 2.3 each receipt records its tool's flag (`AgentToolReceipt.idempotent`), so an interrupted handoff-target call is judged by its own tool, never by a root tool of the same name. Only mark a tool idempotent when repeating it truly has no further effect, and bump `bindingId` when you change the flag on a durable run.

**Revisions (2.2).** `AgentRunEnvelope.revision` increases on every save. The in-memory, SQLite (`createSqliteOpsStore(...).agentRuns`, `/ops/sqlite`), Postgres (`/ops/postgres`) and Redis (`createRedisOpsStore(...).agentRuns`, `/ops/redis`, 2.3) stores reject anything but stored + 1, so a stale second executor cannot overwrite the first; its run result reports the failed save. A custom store should enforce the same rule. An envelope that records memory, a transcript, a chat projection or fail-over state is written as `version: 2` (2.3), which a 2.2 reader refuses instead of resuming without that state; every other envelope stays version 1, and resume reads both. `resumeAgent` refuses an envelope holding a checkpoint whose `version` is not 1 with `CheckpointVersionError` before it writes anything.

### Recovering a stopped or failed run (2.3)

Every way a tool call can end is distinguishable: `ToolCallOutcome` (`'tool-error'`, `'permission-denied'`, `'approval-denied'`, `'approval-pending'`, `'unknown-effect'`; a success carries none) rides `ToolResult.outcome` and the `tool-result` / `tool-state` parts. A resume that stops with `'tool-reconciliation-required'` lists the receipts of the unknown effects in `AgentResult.unknownEffects` (every one the store still holds, so settle them all in one resume) and streams a `tool-state` part for each. Three opt-in ways go on, none of them a default:

- `retryToolCallIds` runs exactly the listed calls once more, under the same `[modelStep, toolCallId]` identity.
- `reconciledToolResults: [{ toolCallId, output, isError? }]` records an effect that did land, from what you found in the system it touched: the receipt takes `output` as the raw result (marked `reconciled`), the step goes on from it through `outputSchema`, `validateResult` and `toModelOutput`, and the call never runs again. Only the run's unknown effects are accepted, each once and never also in `retryToolCallIds`; on a run that has not ended, anything else fails the resume with a `TypeError` before anything is written (a run that ended returns its stored result). A call that waited for an approval needs no verdict again: its recorded outcome answers it (above).
- `retryFailed: true` re-enters a run that failed in transit, from its last checkpoint and in the phase it failed in. Only a failure whose envelope records a transient cause qualifies (`AgentRunEnvelope.retry`: a model call that failed with a retryable transport or provider error or whose stream broke off, or a budget admission refused with 40001 / 40P01); never a cancel, a lost lease or an elapsed deadline. The failed call stays counted as a model step and, while its outcome is unknown, at its estimate. Any other failure fails the resume with a `TypeError`; a run that did not fail ignores the option.

```ts
import { resumeAgent } from '@deuz-sdk/core/agent';
import type { AgentRunOptions, AgentRunSession } from '@deuz-sdk/core/agent';

declare const options: AgentRunOptions & { session: AgentRunSession };
declare function lookUpEffect(toolCallId: string): Promise<{ landed: boolean; output?: unknown }>;

const result = await resumeAgent(options);
if (result.status === 'stopped' && result.reason === 'tool-reconciliation-required') {
  const retryToolCallIds: string[] = [];
  const reconciledToolResults: { toolCallId: string; output: unknown }[] = [];
  for (const receipt of result.unknownEffects ?? []) {
    const effect = await lookUpEffect(receipt.toolCallId); // check the system the call touched
    if (effect.landed) reconciledToolResults.push({ toolCallId: receipt.toolCallId, output: effect.output });
    else retryToolCallIds.push(receipt.toolCallId);
  }
  console.log((await resumeAgent({ ...options, retryToolCallIds, reconciledToolResults })).status);
} else if (result.status === 'failed') {
  const stored = await options.session.store.load(options.session.runId);
  if (stored?.retry) console.log((await resumeAgent({ ...options, retryFailed: true })).status);
}
```

## MCP tools in native runs (2.3)

`AgentRunOptions.mcp` takes the same entries as the loop's `mcp` (`references/mcp.md`), and MCP calls take the native dispatch path: the same receipts, reconciliation and `tool-output` events as local tools, also for tools a `tools/list_changed` refresh brings in. A resume of a terminal run returns its result without connecting; otherwise the servers are connected before anything is persisted, so an unreachable server fails a fresh run before its first checkpoint or model call.

- **The catalog is bound.** The servers' tool catalog is pinned in `binding.mcp` (the `fingerprintTools` JSON). A mid-run change is governed by `onCatalogChange` (`AgentMcpCatalogChange`): `'stop'`, the native default, ends the run with reason `'mcp-catalog-changed'` before the model is offered the new catalog; `'accept'` records the new catalog in the binding and carries on. Both report the change as a `warning` part with `setting: 'mcp'`; an announcement that changed nothing does neither.
- **On resume** a catalog that drifted from the recorded one fails the resume (`MCP tool catalog changed across resume (...)`) and leaves the stored run untouched. With `onCatalogChange: 'accept'` the resume treats it like the hot refresh it missed: its first write records the new catalog, before any model call, with the same warning. It still fails while a call the model made against the recorded catalog is in flight (an MCP receipt in `'executing'`, or a call of the last turn waiting for its verdict or never started), and when the resume dropped the `mcp` entries.
- **Replay.** An `mcp` entry may declare `replay: 'idempotent'` for the whole server, or `replay: { toolName: 'idempotent' }` per tool by the server's own tool name (`AgentMcpEntry`, `AgentMcpReplay`), so an interrupted call of that tool runs again on resume. The declaration never enters the connection pool key. A raw JSON Schema `outputSchema` stays metadata (the MCP client validates structured results).
- **Collisions** (a local tool shadowing an MCP tool, two servers exposing one name) are reported as `CallWarning { type: 'unsupported-tool', setting: 'mcp' }` and `warning` parts.

## Memory, chat and model fail-over in native runs (2.3)

`memory`, `chat` and `fallbackModels` are bound to the run's checkpoint instead of running as best-effort side effects, and each is part of the resume binding.

- **Memory.** A new run recalls once, before its first model call, and the memories enter its history as one appended `role: 'system'` message (`providerMetadata.deuz.memoryRecall`), so every step and every resume sends the same prefix; a resume never recalls again. Extraction runs only for a run that completed: the terminal commit records it as pending under an operation id before anything is written to memory, its outcome follows in a later save (`AgentRunEnvelope.memory`), and every record it writes carries `metadata.deuz = { runId, operationId }` (`RememberOptions.metadata`, 2.3). A terminal resume never extracts again. `recall: false`, `extract: false`, `writePolicy` and `sweep` behave as in the legacy loops. A run under another native run's execution may only narrow that run's memory scope.
- **Chat projection.** The run keeps an append-only transcript of its turns, raw (before compaction or a `prepareStep` history, reasoning blocks byte for byte), and writes it to `chat.store` after its own checkpoint at every suspension and at the end, as a whole record with stable `ChatRecord.messageIds` (`<runId>:<n>`). A chat store failure never fails the run: it is a `warning` part, repaired by the next save, a terminal resume or `reconcileAgentRun`, and never appends a message twice. A stored chat of another scope is never overwritten; a chat another writer changed since the failed write is left alone and recorded as `'superseded'`.
- **Model fail-over.** A model call that fails with a retryable error before its first content (network, transport timeout, 5xx, 429/529 after its own retries, an open breaker) is repeated on the next candidate of `[that model, ...fallbackModels]` inside the same run, budget and checkpoint; a tool-loop step runs again from the last checkpoint, so completed tool effects never repeat. A refusal, a policy, budget or validation rejection, a cancel, an elapsed deadline or an error after content never fails over. The failed model is skipped for the rest of the run, also after a resume, and `AgentRunEnvelope.models` records each hop. Each candidate gets the call's `capabilities` override and its own request profile; Claude thinking blocks reach another Claude model unchanged and never another provider.
- **`reconcileAgentRun({ session, chat?, memory?, lease? })`** settles what a run that ended or is suspended left behind: it rewrites a chat projection that is behind or failed, and settles a pending or failed extraction (one whose records already exist under its operation id is recorded completed without another memory LLM call). It resolves `{ runId, chat?, memory? }` and rejects for an unknown, still-running or differently bound run. Call it only when no executor drives the run, or pass `lease` (the `runAgent` shape): it then claims the run first and rejects with `'lease_held'` while an executor holds it.

Native cancellation and tool timeout send an abort signal and drain active effects before releasing the run. Tools should honor `context.signal`. An effect that ignores abort can keep the run pending until it settles; use an external isolated executor when a hard kill is required.

## Mandatory restrictions and cumulative accounting

`createExecutionContext({ policy, budget, scopeId? })` provides a shared `NativeExecutionContext`. `execution.child({ scopeId, policy?, budget? })` keeps the ledger and only narrows constraints. `allowedTools` / `allowedModels` intersect, `maxDepth` and `deadlineAt` take the stricter limit, and `requireApproval` cannot be disabled by a child. An omitted allowlist is unrestricted; an empty one denies all. Depth starts at zero; deadlines are epoch milliseconds checked against `deps.clock`.

Use `execution` on model calls and the inherited context supplied to tools, children and verifiers. Legacy guardrail callbacks are separate from these mandatory restrictions; adding a child must not discard the execution context. `prepareStep` model changes, child calls, compaction and native finalization are charged to the actual model invoked.

**One dispatch path (2.3).** Every tool call takes the same order: the finish-reason gate, the execution policy, the approval gate, admission, the effect receipt, execution, `onToolResult` and the step checkpoint, for local tools, MCP tools, handoff transfers, swarm blackboard tools, spawned tasks and sub-agents alike. **Behaviour change:** the policy is decided for the whole batch before the guardrails and the approval gate, so a call it forbids fails the run with `ExecutionPolicyError` (which names `toolCallId`) without asking anyone to approve it, starting a sibling or writing a receipt. Handoff transfers are gated like any call (`requireApproval`, `needsApproval`, an `allowedTools` allowlist). A sub-agent inherits the parent's `onToolCall` and `onToolResult` guardrails (`ToolExecuteContext.guardrails`); a sub-agent, a handoff target and a spawned swarm task only narrow the run's tool and model allowlists, deadline, cancellation and budget. MCP sampling requests (`McpSamplingOptions.execution`) check the policy before `approve` and reserve on the ledger like the run's own model calls.

Each potentially billable HTTP attempt reserves by a stable request ID before dispatch, then settles known usage. `executionEstimate: { tokens?, usd? }` overrides the estimate. Since 2.3 the estimate prices the output cap the wire actually sends (Anthropic's raise to the thinking budget included), and a prompt the call caches at the cache-write rate on Anthropic; a row with no documented output limit sends its 4096 placeholder as `maxOutputTokens` under a token or USD bound (with a `clamped-setting` warning) so the reservation stays a bound. A call without `maxOutputTokens` on a large-output model can therefore be refused (`budget_exceeded`) under a small USD budget: set `maxOutputTokens` to fit it. **A model with no price (2.3)** is admitted under a USD bound with its tokens reserved and no USD held, reported once per model as `unpriced-model` (`totals().unpriced` counts these calls); `unknownPrice: 'reject'` on any intersecting `BudgetLimits` refuses it before sending with `BudgetLedgerError` code `unpriced_model`. A price lookup that throws still fails a USD bound closed. Unknown billing keeps reservations across recovery, including an uncertainty count when the estimate was zero. Confirmed unbilled attempts may be released. A settlement the store failed is retried, and the final `admission_failed` error carries `requestId` and `settlement` for `ledger.settle(error.settlement)`. Actual usage can exceed an estimate and block later admissions; this is not a provider-enforced billing cap.

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

For Node persistence, substitute `createSqliteSwarmStore({ path: './swarm.db' })` and await `store.close()` after active handles settle. The store commits snapshots and event rows atomically; it is separate from `createSqliteStores()`'s legacy store pack. 2.2 upgrades a 2.1 SQLite swarm file to schema 2 on first open, and 2.1 then refuses it — back the file up first. `createRedisSwarmStore({ client | url, prefix? })` (2.3, `/swarm/redis`, Redis 7+) has the `'spawn'`, `'channels'` and `'list'` capabilities: every commit is one Lua script that validates at the run's revision and writes only while the run is still at that revision and generation, so a concurrent writer gets `SwarmConflictError`. It needs a server that never evicts its keys (`maxmemory-policy noeviction` or a `volatile-*` policy). `SwarmStore.prune({ before, scope?, limit? })` (2.3; memory, SQLite, Postgres and Redis) deletes settled runs with their tasks, events and blackboard notes. `/agent`, `/swarm` and `/ops` are web-safe; `/swarm/sqlite`, `/swarm/postgres`, `/swarm/redis`, `/ops/sqlite`, `/ops/postgres` and `/ops/redis` are Node-only.

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
- **Compatibility.** Dynamic runs are version 2 (2.1 refuses them) and need a store whose `capabilities` include `'spawn'` — memory, SQLite, Postgres and (2.3) Redis do. `createSwarm` throws for a store without it rather than silently dropping spawned tasks. The journal records `task.spawned` per child.

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
- **Acknowledged cancels (2.3).** `LeaseProvider.renew(lease, ttlMs, { acknowledge: true })` keeps a delivered `'cancel'` queued (reported again in `LeaseRenewal.queued` and handed to the next holder) until `LeaseProvider.ack(lease, 'cancel')` removes it; swarm, evolve and native executors acknowledge only once the run durably recorded it. Without the option a renewal behaves as in 2.2, and the stored signals keep their 2.2 format. The memory, SQLite, Postgres and Redis providers implement both.
- Clocks: SQLite leases use the host clock (synchronise processes sharing a file); Postgres leases use the database clock; Redis leases (2.3) use the server's `TIME`. Without a lease provider, drive a run from one process only.
- **Retention (2.3).** `LeaseProvider.prune(before)` deletes keys nobody holds that queue no cancel; the ops stores add `agentRuns.prune(before)` (terminal native runs) and `claims.prune(before)` (old claim keys, claimable again). Postgres writes retry a serialization failure or deadlock (40001 / 40P01) up to five times; a swarm write that runs out rejects with `SwarmConflictError` carrying the driver error as `cause`. A `run` / `resume` whose start-up commit fails now gives back its ownership, lease and heartbeat before it rethrows.

Leases do not make external effects exactly-once. A task interrupted by a takeover follows the same `replay` rules as one interrupted by a crash; use the service's idempotency key or reconcile. Cancellation and drain are cooperative: tools and reducers must honor their signal.

### Native runs across processes (2.3)

`runAgent`, `streamAgent`, `resumeAgent` and `resumeStreamAgent` take `lease: { provider, owner?, ttlMs? }` (requires `session`). The executor holds the run's key, `agentRunLeaseKey({ scope, runId })` from `@deuz-sdk/core/ops`, from before it reads the run until it returns, renewing it at once after the claim and then every `ttlMs / 3`.

```ts
import { createInMemoryAgentRunStore, runAgent } from '@deuz-sdk/core/agent';
import { createInMemoryLeaseProvider, findStaleAgentRuns } from '@deuz-sdk/core/ops';
import { createMockModel } from '@deuz-sdk/core/testing';

const model = createMockModel({ responses: [{ text: 'done' }] });
const store = createInMemoryAgentRunStore(); // createSqliteOpsStore / Postgres / Redis `.agentRuns` across processes
const leases = createInMemoryLeaseProvider(); // the same store's `.leases`

const result = await runAgent({
  model,
  prompt: 'Summarise the queue.',
  session: { store, runId: 'nightly-1', scope: 'tenant-a' },
  lease: { provider: leases, owner: 'worker-1', ttlMs: 30_000 },
});
if (result.status === 'failed') console.log(result.error.code); // 'lease_held' | 'lease_lost' | …

// At startup and on a timer: runs still running or finalizing whose last save is old.
for (const run of await findStaleAgentRuns(store, { staleMs: 60_000, scope: 'tenant-a' })) {
  console.log('resume', run.runId, run.phase); // resumeAgent with the same session and lease
}
```

- While another executor holds the key the run fails with code `'lease_held'` before anything is read or written; an executor that loses the lease aborts, writes nothing more and fails with `'lease_lost'`, leaving the run as its last save had it for the next executor.
- A `'cancel'` signalled to the key stops the run with the stop reason `'cancelled'`. With a provider that acknowledges cancels it stays queued until the stopped run is saved, so an executor that dies in between cannot lose it, and the next executor applies a cancel still queued before any model call. A cancel queued before the claim's first renewal does not stop a new run (it starts clean of it); one signalled after that renewal stops a new run too. A `runAgent` on an existing run ID leaves an older cancel queued, and a key queues one cancel at a time.
- A `'drain'` signalled to the key (`leases.signal(agentRunLeaseKey({ scope, runId }), 'drain')`, e.g. to move runs off a process during a deploy) stops a leased run at its next model-step boundary with `{ status: 'stopped', reason: 'drained' }`: the step's model call and tool calls finish and no model call follows; a new run stops before its first model call, a run with `output` before a final-answer call. No outcome is committed: the run keeps its phase and its last save, as if its executor had died after that save, so a resume on any executor goes on from there and nothing that ran runs again (`findStaleAgentRuns` finds it once `staleMs` has passed). A resume the drain reaches before it takes the run up stops before its first write: resume it again with the same answers. Any other stop at the same point comes first, and a cancel or an abort outranks a drain. Unlike a drained swarm, which settles `'suspended'`, a drained native run stays `'running'` or `'finalizing'`.
- `AgentRunStore.list({ phases?, updatedBefore?, scope?, limit?, cursor? })` (optional; the memory, SQLite, Postgres and Redis stores have it) pages run summaries `{ runId, scope, phase, revision, updatedAt, status? }`, newest save first, with a `cursor` while more follow; `status: 'suspended'` tells a run waiting on approvals apart from one in progress. `findStaleAgentRuns(store, { staleMs?, scope?, includeSuspended?, limit?, clock? })` returns the running or finalizing runs whose last save is older than `staleMs` (default 60 000), for a worker to resume with the `lease` option so a run another process still drives is refused instead of driven twice. `createInMemoryAgentRunStore({ clock? })` takes a clock for that.
