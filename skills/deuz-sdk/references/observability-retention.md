<!-- verified: 2026-10-16 against @deuz-sdk/core@2.4.0 · api-contract sha256:da3643f44edc
     sources: packages/core/src/internal/telemetry.ts, packages/core/src/types/{observe,methods,stream-durable,agent-run-v3,chat-conditional}.ts,
     packages/core/src/{otel,observe}.ts, packages/core/src/memory/versioned/types.ts, packages/core/src/goal/runtime/store-types.ts,
     packages/core/src/compute/docker/types.ts, packages/core/src/context/compiler.ts,
     .changeset/{2-4-w0d,2-4-w0e,2-4-l1b,2-4-l3a,2-4-l4a,2-4-l6,2-4-l7a,2-4-l7b}.md,
     docs/content/docs/modules/{retention,observability}.mdx (lane D1) -->

# 2.4 observability, retention and forget

**Load when:** you trace the 2.4 subsystems (context compiles, versioned memory operations, goal supervision, schedule deliveries, Docker processes, durable stream commits), handle the new warning types, or plan cleanup for the 2.4 stores — the SDK never deletes anything in the background — including what a versioned-memory `forget` reaches. The 2.3 event protocol, observers and OTel bridge are in `references/ops.md`.

## 2.4 spans

Every 2.4 subsystem reports through `deps.observer` as the existing `operation.started` / `operation.completed` / `operation.failed` events, named by the span (`operation`), with `subsystem` widened by `'context'`, `'goal'`, `'schedule'`, `'process'` and `'stream'` (switch statements over `ObservedSubsystem` need a default branch) and a new optional `attributes` field: scalar counts, ids, digests, token values and small enums under `deuz.<subsystem>.*`, **never content**. `createOtelObserver` copies `attributes` onto the operation's span; inside a run leg the span shares the run's ids (a context compile is a child of the step span). Since 2.4 a run whose built-in `memory` recall reports an operation keeps its `invoke_agent` span and the parents of its later spans.

| Span | Reported by | Attributes |
| --- | --- | --- |
| `deuz.context.compile` | the context compiler, also the overflow recompile | `deuz.context.selected`, `excluded`, `tokens`, `estimator`, `refresh_reason`, `fallback`, `cache_prefix_changed`, `manifest_digest`, `deuz.context.source.<id>.selected\|excluded\|tokens` |
| `deuz.memory.op` | a versioned memory session (remember, extract, revise, retract, forget, reembed, import) and the SQL stores' prunes | `deuz.memory.operation`, `record_count`, `conflict_retries`, `embedding_generation` |
| `deuz.goal.claim`, `deuz.goal.dispatch` (covers the leg), `deuz.goal.retry`, `deuz.goal.cancel_requested`, `deuz.goal.cancel_applied`, `deuz.goal.drain`, `deuz.goal.generation` | the goal supervisor | `deuz.goal.id`, `revision`, `spec_generation`, `run_id`, `attempt` |
| `deuz.schedule.delivery` (one per occurrence) | the durable scheduler | `deuz.schedule.id`, `occurrence_id`, `disposition` (`delivered` \| `skipped`), `catch_up`, `deuz.goal.id`, `deuz.schedule.reason` when skipped |
| `deuz.process.start`, `poll`, `cancel`, `exit`, `reconcile` | the Docker process runner | operation id and state; `exit_code` and `truncated` on exit; matched, orphans, lost, removed and `reconcile_result` (`clean` \| `drift`) on reconcile |
| `deuz.stream.batch`, `deuz.stream.fenced` | a durable stream response (`durable.deps.observer`) | `deuz.stream.batch_frames`, `batch_bytes`, `commit_ms`; `fencing_token` |

No span is emitted for conditional chat writes, transcript search or the skill proposal (whose model call shows up as an ordinary run).

```ts
import { createInMemoryGoalRuntimeStore, createDurableScheduler } from '@deuz-sdk/core/goal/runtime';
import { createMemoryObserver } from '@deuz-sdk/core/observe';

const observer = createMemoryObserver();
const scheduler = createDurableScheduler({ store: createInMemoryGoalRuntimeStore(), deps: { observer } });
await scheduler.tick();

const deliveries = observer
  .events()
  .filter((e) => e.type === 'operation.completed' && e.subsystem === 'schedule')
  .map((e) => (e.type === 'operation.completed' ? e.attributes : undefined));
console.log(deliveries); // [] until a schedule has a due occurrence
```

## New warning types

`CallWarning['type']` gains five members (keep a default branch): `'embedding-mismatch'` (a legacy recall left out records whose vector has another model or size; `recall(query, seams, { onWarning })`, `RememberOptions.onWarning`), `'unaccounted-usage'` (a memory LLM or embedder callback reported no usage under an execution context), `'context-source-failed'` (an optional context source failed; `contextWarnings(manifest)`), `'stream-store-error'` (a legacy `StreamStateStore` failed; the response is not resumable), and `'memory-extraction-partial'` (an interrupted native extraction wrote only part of its plan; `AgentRunReconciliation.warnings`). Native runs put them on the stream as `warning` parts; `generateText` / `streamChat` in `warnings`.

## Retention: every cleanup is a call you schedule

| Store | Call | Removes | Keeps |
| --- | --- | --- | --- |
| Versioned memory | `pruneHistory({ olderThan, scope? })` | Past revisions of records currently retracted or expired | Current revisions, receipts |
| Versioned memory | `pruneOperations({ olderThan })` | Receipts (warns: those operation ids no longer dedupe) | — |
| Goal runtime | `prunePayloads({ before, scope? })` | Settled inbox payloads → content-free tombstones (`payloadPruned`) | Entry ids, so dedupe holds |
| Goal runtime | `pruneInbox`, `pruneOccurrences`, `pruneIntents` (`{ before, scope? }`) | Settled entries ids included; occurrence records; finished intents | Schedules and cursors; open intents |
| Durable streams | `prune({ terminalBefore })` | Finished streams (last record the `done` sentinel) | Active streams (a pruned one forgets its fence) |
| Process operations | `prune({ terminalBefore })`; `dispose`; `reconcile({ removeOrphans: true })` | Terminal records; a container; orphan containers and dangling volumes | — |
| V3 runs | `prune({ terminalBefore })` | Terminal runs and blobs only they used | Running and suspended runs; a blob put again since |
| Conditional chats | `pruneTombstones(before)` | Old tombstones (the id can be reused) | Live chats |

Each returns how many it removed; times are epoch ms on the store's clock (the injected clock for in-memory and SQLite, the database clock for the PostgreSQL V3 run and stream stores, the server `TIME` for Redis, the `clock` option for the other PostgreSQL stores). Every cutoff is exclusive (a record stamped exactly at it stays). A malformed cutoff is refused before anything is deleted: `ProcessOperationStore.prune` throws `TypeError`, `pruneTombstones` throws `InvalidRequestError`. Every versioned memory store (in-memory, SQLite, PostgreSQL) logs the same `pruneOperations` warning with `{ count, olderThan }` through its logger (silent by default). `prunePayloads` cuts per store or per scope, not per goal: with differing per-goal `retainPayloadMs`, pass the largest window in the scope. Two windows are SDK defaults: `DEFAULT_GOAL_RUNTIME_POLICY.retainPayloadMs` (7 days) and `DEFAULT_DURABLE_STREAM_RETAIN_MS` (24 h, from `/ui`) for finished durable streams. Suggested starting points: terminal process records a few days; V3 runs and memory history your audit window; keep memory receipts and inbox ids longer than any retry or redelivery (pruning them trades dedupe for space).

```ts
import { createInMemoryAgentRunStoreV3 } from '@deuz-sdk/core/agent';
import { createInMemoryConditionalChatStore } from '@deuz-sdk/core/chat';
import { createInMemoryProcessOperationStore } from '@deuz-sdk/core/compute/docker';
import { DEFAULT_GOAL_RUNTIME_POLICY, createInMemoryGoalRuntimeStore } from '@deuz-sdk/core/goal/runtime';
import { createInMemoryVersionedMemoryStore } from '@deuz-sdk/core/memory/versioned';
import { DEFAULT_DURABLE_STREAM_RETAIN_MS, createInMemoryDurableStreamStateStore } from '@deuz-sdk/core/ui';

const DAY = 86_400_000;
const memory = createInMemoryVersionedMemoryStore();
const goals = createInMemoryGoalRuntimeStore();
const streams = createInMemoryDurableStreamStateStore();
const processes = createInMemoryProcessOperationStore();
const runs = createInMemoryAgentRunStoreV3();
const chats = createInMemoryConditionalChatStore();

/** One retention pass (examples, not defaults); leaves pruneOperations and pruneInbox out on purpose. */
export async function prune(now: number) {
  return {
    memoryHistory: await memory.pruneHistory({ olderThan: now - 90 * DAY }),
    inboxPayloads: await goals.prunePayloads({ before: now - DEFAULT_GOAL_RUNTIME_POLICY.retainPayloadMs }),
    occurrences: await goals.pruneOccurrences({ before: now - 30 * DAY }),
    intents: await goals.pruneIntents({ before: now - 30 * DAY }),
    streams: await streams.prune({ terminalBefore: now - DEFAULT_DURABLE_STREAM_RETAIN_MS }),
    processes: await processes.prune({ terminalBefore: now - 7 * DAY }),
    runs: await runs.prune({ terminalBefore: now - 30 * DAY }),
    tombstones: await chats.pruneTombstones(now - 365 * DAY),
  };
}
```

Run it from a cron trigger (`createScheduler` from `/schedule` in one process, or with a durable claim), or as a goal on a durable schedule.

## What a forget reaches

`session.forget(id)` (`references/versioned-memory.md`) deletes the record's content, revisions and vectors and leaves content-free receipts. Wired as `onForget: async (event) => { await runs.redactForgotten(event); }`, it also redacts every V3 context package blob holding a forgotten revision (`getBlob` → `{ status: 'redacted' }`, manifests `redacted: true`, the step compiled again on resume — `references/v3-runs.md`); the run store remembers the forget (`deuz_runs_v3_forgotten`, ids and revisions only), so a package written later is stored redacted too. The same call rewrites, in place (same revision and last-save time), every stored copy of a redacted package's retrieval block that holds a forgotten record, in the runs that point to it (history, checkpoints, `result.messages`, a terminal run included), into a stand-in that keeps the `<deuz_context pass="P" step="S">` marker and no record; a later save of such a run is stored the same way, and a resume drops the stand-ins and any block that held a forgotten record and recompiles. Only the exact blocks the compiler appended are replaced: a user's message that only opens with a marker stays, and so does an overflow retry's block that dropped the forgotten record. A failed listener leaves `redaction: 'failed'`: forget again, or call `redactForgotten` with the event.

A forget does **not** reach chat records and the transcript index (tombstone the chat), the legacy `MemoryStore`, goal inbox payloads, durable stream logs and process output tails (prune or delete them), text the model wrote from a block (assistant turns, `result.text`, a compaction summary), memory tool results (`memory_recall` output in tool messages, the run transcript, a chat store), the in-memory history of a leg running at forget time (until it ends or is resumed), run stores not subscribed through `onForget`, a retrieval block a run received in its input messages (a previous run's `result.messages` passed to `runAgent({ messages })`; continue from the chat projection or the transcript instead), your own logs, or files and provider logs outside the SDK. On SQLite the versioned FTS5 index drops forgotten tokens at once (secure-delete); freed pages and PostgreSQL dead tuples keep bytes until `VACUUM` (or `PRAGMA secure_delete`).

## Deep dive

- [/docs/modules/retention](/docs/modules/retention) (2.4) — the retention table, windows, forget and V3 packages.
- [/docs/modules/observability](/docs/modules/observability) and [/docs/reference/observe-events](/docs/reference/observe-events) — the event protocol and the 2.4 span table.
