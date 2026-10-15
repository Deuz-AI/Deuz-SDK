<!-- verified: 2026-10-15 against @deuz-sdk/core@2.3.0 · api-contract sha256:e126e881213b
     sources: packages/core/src/types/agent-run-v3.ts, packages/core/src/types/agent-run.ts,
     packages/core/src/{agent-run,agent-run-v3,agent-run-v3-run,agent-run-v3-context,agent-run-v3-store}.ts,
     packages/core/src/node/{runs-v3-sqlite,runs-v3-postgres,headless}.ts, packages/core/src/agent.ts,
     .changeset/{2-4-l3a,2-4-l3b,2-4-w0e,2-4-fb}.md, docs/content/docs/modules/native-agents.mdx (lane D1) -->

# V3 native runs: `checkpointVersion: 3` (2.4)

**Load when:** a native run (`runAgent` / `streamAgent` / `resumeAgent` / `resumeStreamAgent` / `reconcileAgentRun`) should carry compiled context, working memory or versioned-memory writes across checkpoints and restarts; or you must know what a 2.3 process does with a database that 2.4 V3 runs share. The 2.3 native contract (validated output, receipts, approvals, leases, fail-over) is in `references/native-execution.md` and holds unchanged on V3.

V3 is chosen per run: `checkpointVersion: 3` plus a session on an `AgentRunStoreV3`. Without it nothing changes, and a run with none of the 2.4 options sends provider requests byte-identical to 2.3's. Version 1 and 2 records are never converted: existing runs finish on the 2.3 path. Docs: [/docs/modules/native-agents#v3-runs-checkpointversion-3](/docs/modules/native-agents#v3-runs-checkpointversion-3) (2.4).

```ts
import { createInMemoryAgentRunStoreV3, streamAgent } from '@deuz-sdk/core/agent';
import { createRagContextSource } from '@deuz-sdk/core/context';
import { createMockModel } from '@deuz-sdk/core/testing';

const runs = createInMemoryAgentRunStoreV3(); // createSqliteAgentRunStoreV3 / createPostgresAgentRunStoreV3 in production
const stream = streamAgent({
  checkpointVersion: 3,
  session: { store: runs, runId: 'deploy-1', scope: 'acme' },
  model: createMockModel({ responses: [{ text: 'Run CI, then deploy to eu-west.' }] }),
  prompt: 'How do I deploy?',
  context: {
    sources: [
      createRagContextSource({
        retrieve: async () => [{ text: 'Deploys need a green CI run.', index: 0, score: 0.9 }],
      }),
    ],
  },
  workingMemory: { create: { scope: 'acme', goal: 'Deploy the billing service.', now: Date.now() }, tools: true },
});

for await (const event of stream.eventsV3) {
  if (event.type === 'context') console.log('context', event.step, event.manifest.refresh); // context 0 initial
}
const result = await stream.result;
const record = await runs.load('deploy-1');
console.log(result.status, record?.version, record?.context?.steps.length); // completed 3 1
```

## Stores

| Store | Import | Notes |
| --- | --- | --- |
| `createInMemoryAgentRunStoreV3({ deps? })` | `@deuz-sdk/core/agent` | Tests and one process; times from `deps.clock` |
| `createSqliteAgentRunStoreV3({ path, wal?, clock? } \| { database, clock? })` | `@deuz-sdk/core/ops/sqlite` | A `path` is opened and closed by the store; a `database` handle is borrowed and left open |
| `createPostgresAgentRunStoreV3({ pool \| connectionString, schema? })` | `@deuz-sdk/core/ops/postgres` | Needs a pool with `connect()`; every write one SERIALIZABLE transaction; `migrate()`; `close()` ends only its own pool; database clock |

- V3 runs live in their own tables (`deuz_runs_v3`, `_blobs`, `_blob_records`, `_blob_refs`, `_forgotten`) with their own `deuz_runs_v3_schema` version table. The 2.3 run tables and `deuz_ops_schema` are untouched, so a 2.3 process still opens the database; its listing and pruning never see a V3 run, and its `resumeAgent` / `reconcileAgentRun` refuse a V3 record (`Native checkpoint version, identity, or scope mismatch.`) without calling a model or a tool. Rolling back means stopping V3 workers and keeping the tables: V3 runs wait until a 2.4 worker returns.
- `save(envelope)` takes version 3 only and only the stored revision plus one, else `RevisionConflictError` (`code: 'revision_conflict'`, `subsystem: 'run'`, `expectedRevision`, `actualRevision`). A V3 run is never written back as version 1 or 2, terminal and bookkeeping saves included. `list(query)` pages like `AgentRunStore.list`.
- **Blobs.** Each compiled context package is stored once by digest (`putBlob({ digest, content, records })`, idempotent; content that does not hash to its digest is rejected). `getBlob(digest)` answers `{ status: 'found', content }`, `{ status: 'redacted' }` or `{ status: 'missing' }`.
- **Redis has no V3 store in 2.4**: a Redis `AgentRunStore` with `checkpointVersion: 3` is refused at configuration time with `UnsupportedStoreError` (`code: 'unsupported_store'`, feature `'agent-run-v3'`).
- `inspectRun` from `@deuz-sdk/core/headless` reads a V3 store too.

## What a V3 run refuses (before anything is read or written)

`runAgent` / `streamAgent` return a `failed` result; `reconcileAgentRun` rejects.

| Configuration | Error |
| --- | --- |
| `checkpointVersion: 3` without a session, or with a 2.3 `AgentRunStore` | `TypeError` |
| A `checkpointVersion` other than 3 | `TypeError` |
| `context`, `workingMemory`, `versionedMemory` or a V3 store **without** `checkpointVersion: 3` | `TypeError` (2.3 silently ignored them) |
| A Redis run store | `UnsupportedStoreError` |
| A compiler with a memory source **and** `memory` with recall on | `TypeError` ('Memory would be injected twice'): set `memory.recall: false` |
| A working-memory `snapshot` / `create` for another scope than the session's, or a host tool named like a working-memory tool | `TypeError` |

## Context in the loop

`context` takes a `ContextCompiler` or `CreateContextCompilerOptions` (`references/context-working-memory.md`). Per model step: compaction, then your `prepareStep`, then the step's real model and active tools, then a source refresh when due, then the compile with the final budget check (tool schemas, the final answer's output schema and provider framing counted), then the blob and manifest are saved with the run — all before the model call. Retrieval enters the history append-only after the call succeeded and never reaches the chat transcript; the working memory is the request's last message and is never stored. A native final-answer call is compiled too, so a structured-output run without tools gets its context. `deuz.context.compile` nests under the step span. A host `context.estimator` is calibrated with each call's input + cache-read + cache-write tokens.

- **Overflow.** On a provider overflow the loop compacts again (without re-running `prepareStep`) and the compiler places the step again for just under the size that overflowed (refresh `'overflow-retry'`); mandatory content that cannot fit fails the run with `ContextBudgetExceededError`. A package that placed nothing, with nothing compacted, keeps the provider's `context_overflow` as in 2.3.
- **Restart.** A resumed run restores the compiler state from the record (a compiler you built yourself resumes only if its `state()` equals the stored state). A step reopened with the same messages (its answer never saved) reuses its stored package without asking the sources (`AgentRunContextStepV3.input`).
- **Forget.** Wire the memory session's `onForget` to `runs.redactForgotten(event)`: every package holding a forgotten record revision is redacted (also one written after the forget), the manifests that point to it read `redacted: true`, and that step is compiled again (refresh `'redacted'`) — the one documented exception to reusing a stored package. On resume the retrieval blocks of redacted packages are removed from the run's history and checkpoints, and the manifest records `cachePrefixChanged: true`.

## Working memory and versioned memory

- **`workingMemory: { snapshot? | create?, tools? }`** keeps the `WorkingMemorySnapshot` (with the task list and active task) in `AgentRunEnvelopeV3.workingMemory`; a resume keeps the stored one. Without a compiler the tail is still placed. `tools: true` offers `working_memory_read` / `_add` / `_update`; a model patch is saved in the same save as its tool receipt, so a call replayed after a crash applies once.
- **`versionedMemory: { session, tools?, extract? }`** writes through a durable protocol, recorded in `envelope.memoryIntents`: intent → plan → atomic memory commit with its receipt → acknowledgment (`status`: `intended`, `planned`, `committed`, `acknowledged`). There is no transaction across the two stores: a lost acknowledgment is settled from the receipt by `operationId`, and a change already applied is never applied again, even when the model call before it repeats. `tools: true` offers the session's `memory_*` tools, each write's intent moving with its tool receipt. `extract` (off by default; `true` or extraction options without `messages`) extracts the completed run's turns (ids `<runId>#<index>`) after the outcome is durable.
- **`reconcileAgentRun({ checkpointVersion: 3, session, versionedMemory: { session } })`** settles lost acknowledgments from the session's receipts and returns their operation ids in `memoryIntents`, alongside the 2.3 `{ runId, chat?, memory?, warnings? }`.
- **Legacy `memory` on V3.** An extraction that wrote only part of its plan is stored as `'partial'` with a `memory-extraction-partial` warning; `reconcileAgentRun` reports it as `memory: 'failed'` plus that warning (the 2.3 answer shape). On 2.3 and V3 alike, native `memory` now reports `embedding-mismatch` and `unaccounted-usage` warnings on the run's stream and charges memory LLM / embedder calls to the run's execution context unless `seams.execution` is set.

## Events and the stream

`streamAgent` / `resumeStreamAgent` with V3 options return an `AgentStreamV3`: still an `AgentStream` (so `toDeuzAgentStreamResponse` serializes it unchanged and none of the compiled context reaches the wire), plus `eventsV3` with every 2.3 event and `{ type: 'context', step, manifest }`, `{ type: 'working-memory', revision }`, `{ type: 'memory-intent', operationId, status }`. `AgentEvent` itself stays closed.

## Retention

`runs.prune({ terminalBefore })` deletes terminal runs last saved before the cutoff and the blobs only they used; a package put again after the last save of every run that used it is kept (another run is writing it). Nothing is deleted in the background (`references/observability-retention.md`). A goal supervisor drives V3 runs through `createNativeRunLauncher` (`references/goal-runtime.md`).

## Deep dive

- [/docs/modules/native-agents#v3-runs-checkpointversion-3](/docs/modules/native-agents#v3-runs-checkpointversion-3) (2.4) — stores, refusals, record fields, intents.
- [/docs/modules/context](/docs/modules/context) and [/docs/modules/retention](/docs/modules/retention) (2.4) — compile rules, forget redaction.
- [/docs/modules/native-agents](/docs/modules/native-agents) — the 2.3 native contract V3 builds on.
