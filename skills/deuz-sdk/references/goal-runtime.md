<!-- verified: 2026-10-16 against @deuz-sdk/core@2.4.0 · api-contract sha256:da3643f44edc
     sources: packages/core/src/goal/runtime/{index,supervisor,supervisor-drive,supervisor-native,supervisor-shared,
     store,store-types,scheduler,webhook,delivery,verify-acceptance}.ts, packages/core/src/goal/{types,transition,acceptance,errors}.ts,
     packages/core/src/node/{goal-runtime-sqlite,goal-runtime-postgres}.ts, packages/core/src/schedule/*.ts,
     packages/core/src/workspace.ts, .changeset/{2-4-l4a,2-4-l4b,2-4-l4c,2-4-l5,2-4-fa}.md,
     docs/content/docs/modules/goal-runtime.mdx (lane D1) -->

# Goal runtime: supervisor, durable scheduler, webhooks, acceptance (2.4)

**Load when:** a goal (`references/autonomy-workspace.md`, `/goal`) must be driven to completion without a person ticking it — claimed by one process at a time, started and resumed as V3 native runs, retried on transient failures, woken by a durable cron schedule (with a time zone) or a verified webhook, charged exactly once for what its runs spent, and completed only on evidence your verifiers produced.

`@deuz-sdk/core/goal/runtime` is edge-safe and stable; the stores at `@deuz-sdk/core/goal/runtime/sqlite` and `@deuz-sdk/core/goal/runtime/postgres` are Node-only. Everything is a library loop or handler in your process: there is no service, daemon or control server, and nothing runs until you create one. Docs: [/docs/modules/goal-runtime](/docs/modules/goal-runtime) (2.4).

| Piece | What it is |
| --- | --- |
| `createGoalSupervisor({ store, launcher, lease, ... })` | Claims goals, applies their inbox, records run intents, launches/resumes/retries/cancels/drains runs, charges ledgers above a watermark |
| `createNativeRunLauncher({ store, options, lease? })` | A `RunLauncher` that starts and resumes V3 runs (`references/v3-runs.md`) |
| `createInMemoryGoalRuntimeStore`, `createSqliteGoalRuntimeStore`, `createPostgresGoalRuntimeStore` | `GoalRuntimeStore`: goals (the first durable `GoalStore`s), inbox, runtime state, schedules, run intents, ledger watermarks under one transaction boundary |
| `createDurableScheduler({ store, ... })` | Cron schedules with an IANA zone and DST policies whose occurrences enter a goal's inbox in the same write as the cursor |
| `createWebhookHandler({ store, verify, target, namespace })`, `toNodeHandler` | A Fetch API handler that verifies a webhook and queues it into a goal's inbox |
| `verifyGoalAcceptance(input)` | Runs your `GoalVerifier`s against resolved artifacts and returns the `evaluate` command to apply |
| `goalDeliveryDigest`, `settleGoalEvent`, `goalDependencyEvents` | The inbox's event rules, pure |

## Schedule → inbox → supervisor → V3 run

```ts
import { createInMemoryAgentRunStoreV3 } from '@deuz-sdk/core/agent';
import {
  createDurableScheduler,
  createGoalSupervisor,
  createInMemoryGoalRuntimeStore,
  createNativeRunLauncher,
} from '@deuz-sdk/core/goal/runtime';
import { createInMemoryLeaseProvider } from '@deuz-sdk/core/ops';
import { createMockModel } from '@deuz-sdk/core/testing';

let now = Date.parse('2026-03-07T12:00:00Z');
const clock = {
  now: () => now,
  setTimeout: (fn: () => void, ms: number) => {
    const handle = setTimeout(fn, ms);
    return () => clearTimeout(handle);
  },
};

const nightly = { reason: 'event', source: { type: 'schedule', id: 'nightly' } } as const;
const store = createInMemoryGoalRuntimeStore({ deps: { clock } }); // createSqliteGoalRuntimeStore({ path }) on Node
const scheduler = createDurableScheduler({ store, deps: { clock } });
const supervisor = createGoalSupervisor({
  store,
  lease: { provider: createInMemoryLeaseProvider({ clock }) },
  launcher: createNativeRunLauncher({
    store: createInMemoryAgentRunStoreV3(),
    options: ({ goal }) => ({
      model: createMockModel({ responses: [{ text: 'Report sent.' }] }),
      prompt: goal.objective,
    }),
  }),
  // A recurring goal: after each run it waits for the next occurrence again.
  verify: () => ({ type: 'wait', wait: nightly }),
  deps: { clock },
});

await supervisor.submit({ goalId: 'report', scope: 'acme', objective: 'Send the report.', start: false });
await supervisor.command('acme', 'report', { type: 'wait', wait: nightly }); // idle until the schedule fires

// 02:30 New York time; on 2026-03-08 the clocks jump from 02:00 to 03:00 (dstGap 'shift').
await scheduler.put({
  scheduleId: 'nightly',
  scope: 'acme',
  goalId: 'report',
  spec: { cron: '30 2 * * *', timezone: 'America/New_York' },
});

now = Date.parse('2026-03-08T07:00:10Z');
const ticked = await scheduler.tick();
console.log(ticked.occurrences.map((o) => [o.occurrenceId, o.disposition])); // [['nightly@1772953200000', 'delivered']]
console.log(await supervisor.tick()); // { applied: 1, dispatched: 1, cancelled: 0, skipped: 0 }
console.log((await supervisor.get('acme', 'report'))?.goal.status); // waiting (for the next night)
```

In production run both loops with `start()` (`{ stop() }` waits for the tick in flight) on a SQLite or PostgreSQL store shared by every process.

## The supervisor

| Option | Default | Meaning |
| --- | --- | --- |
| `store`, `launcher` | required | A `GoalRuntimeStore`; a `RunLauncher` (usually `createNativeRunLauncher`) |
| `lease` | required | `{ provider, owner?, ttlMs? = 30000 }`: the goal lease `goalLeaseKey(scope, goalId)` on your `LeaseProvider` |
| `scopes`, `concurrency`, `pollMs` | every scope, `1`, `1000` | Which goals; how many at once (one executor per goal); `start()` cadence (`DEFAULT_GOAL_SUPERVISOR`) |
| `policy` | `DEFAULT_GOAL_RUNTIME_POLICY` | `maxRuns` 10, `maxRetries` 3, `retryDelaysMs` [1000, 5000, 30000], `retainPayloadMs` 7 days; merged with `submit({ policy })` |
| `verify` | none | Your judgement of a completed run: commands to apply, usually `verifyGoalAcceptance(...).command`; then `complete` is tried |
| `runFinished` | none | Whether a run a dependency wait names has finished |
| `deps` | host defaults | Clock, ids, logger, observer (`deuz.goal.*` spans) |

- **Surface.** `submit(input)` creates the goal (with `specGeneration: 1` unless given), its runtime state and a start intent `<goalId>#1` for run `<goalId>:run:1` in one write; `start: false` skips only that intent (an active goal still runs at the next tick — give it a wait to keep it idle); a goal id that exists in any scope throws `GoalError('revision_conflict')`. `get(scope, goalId)` → `{ goal, runtime }`; `list({ scope, ... })` never crosses scopes. `dispatch(event, { namespace = 'host', deliveryId = event.key, payload? })` queues your own event (`'enqueued'` / `'duplicate'`; other content under the id throws `GoalError('delivery_conflict')`). `command(scope, goalId, cmd, { expectedRevision? })` applies a `transitionGoal` command fenced by the runtime state. `resume(scope, goalId, { approvalResponses?, clientToolResults? })` answers a suspended run. `updatePolicy(scope, goalId, partial, { expectedRevision: runtime.revision })` is the only way to raise limits. `events({ signal })` streams `claimed`, `lease-lost`, `inbox-applied`, `dispatched`, `retry-scheduled`, `cancel-requested`, `cancel-applied`, `drained`, `generation-changed`, `run-ended`, `policy-limit`. `tick()` returns `{ applied, dispatched, cancelled, skipped }` and waits for the legs it starts; `drain()` stops new work for good and brings running runs to their next safe checkpoint (resumable).
- **Only an active goal runs.** A goal waiting for a person, an event, budget or a dependency launches nothing and schedules no retry. Every launch is preceded by a recorded run intent claimed with the lease token; every write is a revision compare-and-set — the lease alone authorizes nothing. A supervisor that loses a goal lease (renew `held: false`, or renewals failing for a whole `ttlMs`) drains its run, writes nothing more and starts nothing; the next holder takes the intent over and resumes the same run, never starting it twice (while the old executor still holds the run, the new leg reports `heldElsewhere` and is tried again each tick until it drains). After a lease provider restart or prune, a holder whose own renewal confirms its lease takes over intents claimed under higher tokens (applies a cancel, or resumes the run under a fresh intent); a durable lease provider is still recommended. An unscoped supervisor learns scopes from the goals it sees: pass `scopes` to cover every tenant deterministically.
- **Leg outcomes.** Completed: `verify` commands, then `complete`; a goal that stays active gets another automatic run up to `maxRuns`. Suspended: the goal waits for `'user'` (note `'approval'` / `'client-tools'`) until `resume`. Stopped `drained`: resumable. `heldElsewhere` (another executor still holds the run): the intent and active run stay, phase `dispatching`, no retry spent. Stopped `cancelled`: the cancel is applied. Other stops and non-retryable failures park the goal in a `'user'` wait (`'run-stopped:<reason>'`, `'run-failed:<code>'`) and start no new run, because a new run could repeat an outside effect. A retryable failure (or a thrown launch) resumes the same run after the next delay, passing stored approval verdicts again; past `maxRetries` one `policy-limit` event is reported. A `verify` hook that throws or returns a malformed command parks the goal (`'verify-failed'`).
- **Cancel is recorded, then applied.** `command(scope, goalId, { type: 'cancel' })` returns the goal unchanged (`changed: false`, outcome `'applied'`; a repeat is `'ignored'`), asks `launcher.cancel` and signals the goal lease; the goal turns `cancelled` at its next claim or when the run stops (`runtime.cancel.appliedAt`). A cancel for an idle run, or one before the run's first checkpoint, is never lost, and no later runtime save can withdraw it.
- **Accounting.** After every leg the run's durable ledger totals above its watermark are charged once (key `ledger:["<runId>",<revision>]`), the watermark and the charged goal in one write; reservations are held on the watermark, never charged; a late charge raises `spent` without reopening a completed goal. A verified goal completes while its run's memory extraction is still pending: every completed run with pending maintenance keeps its intent launched and is listed in `runtime.maintenanceRuns` until it settles (also when the goal stayed active and a later run completed it), late charges included; `runtime.maintenance` shows the oldest pending run until none is. Entries queued for an ended goal (webhook deliveries, schedule occurrences) settle as `'terminal'` and age out through `prunePayloads`. A host `complete` or `fail` on a goal whose run is suspended or waiting for its retry leaves phase `done` and no active run.
- **Working memory.** Each leg's snapshot is kept in `runtime.workingMemory`, stamped with the generation the run first launched under (`activeRun.specGeneration`, kept by its resume and retry legs); only a new run receives it, and only when scope and `goalRef.specGeneration` match the goal's. Hypotheses keep their status.
- **`createNativeRunLauncher({ store, options: (request) => runOptions, lease? })`** fills in `session` and `checkpointVersion: 3`, starts a run its V3 store lacks and resumes a stored one, uses `retryFailed` only for a `'retry'` of a transient failure, and gives inherited working memory to new runs only. Its `cancel` / `drain` signal the native run's lease (`agentRunLeaseKey`); without `lease` it takes the lease provider and TTL of the first supervisor it is given to (only a launcher used on its own has none), and it answers `false` without a lease or a holder (the cancel then waits for the next claim). Both the 2.3 `memory` extraction and the 2.4 `versionedMemory.extract` extraction are maintenance: the leg returns once the outcome is committed, maintenance `'pending'`; a versioned extraction reports `'complete'` once its intent is acknowledged and `'failed'` when the run's own pass failed (`AgentRunMemoryIntentV3.error` is set; the intent stays for `reconcileAgentRun`, which clears it). A model tool's memory write is never maintenance. A leg another executor refused (`lease_held`, `lease_lost`, an executor in the same process) is reported as `heldElsewhere`. A custom `RunLauncher` must be idempotent per `runId` and may set `heldElsewhere` on its result.

## Stores

| Factory | Import | Notes |
| --- | --- | --- |
| `createInMemoryGoalRuntimeStore({ deps? })` | `@deuz-sdk/core/goal/runtime` | Reference; times from `deps.clock` |
| `createSqliteGoalRuntimeStore({ path, wal?, clock? } \| { database, clock? })` | `@deuz-sdk/core/goal/runtime/sqlite` | Each write one `BEGIN IMMEDIATE` transaction; processes can share the file |
| `createPostgresGoalRuntimeStore({ pool \| connectionString, schema?, clock? })` | `@deuz-sdk/core/goal/runtime/postgres` | Pool with `connect()` required; one pinned connection per write, retried on serialization failure; `migrate()`, `close()` |

New `deuz_goal_runtime_*` tables with their own `deuz_goal_runtime_schema` version table; no 2.3 table or schema version changes. `load(goalId, { scope })` reads another scope's goal as undefined, and a goal never changes scope (`createInMemoryGoalStore` from `/goal` gains the same option). Every runtime state, inbox entry, schedule, intent and watermark must name a goal of its own scope. The inbox entry id is `goalInboxKey(scope, namespace, deliveryId)`: the same digest is a `duplicate`, another digest or target a `conflict` that writes nothing. `schedules.put` takes only the definition (`scheduleId`, `scope`, `goalId`, `spec`, `event`); status, cursor and times are always the store's.

## The durable scheduler

`createDurableScheduler({ store, graceMs = 60_000, maxDeliveriesPerTick = 100, maxScanMinutes = 10_000, pollMs = 1_000, deps })` (`DEFAULT_DURABLE_SCHEDULER`). `put(schedule, { expectedRevision? })`, `pause`, `resume`, `cancel`, `get`, `list`, `tick({ now? })` → `{ occurrences, duplicates, backlog, errors }`, `start()`.

- A schedule targets one **existing** goal in its scope (`GoalError('scope_mismatch')` otherwise); the scheduler never creates goals. The stored `spec` spells out every default: `timezone: 'UTC'`, `dstGap: 'shift'`, `dstOverlap: 'first'`, `catchUp: 'latest'`. A malformed cron, zone or policy throws a `TypeError` before anything is written; a stale `expectedRevision` throws `GoalError('revision_conflict')`.
- **Changes have a UTC boundary.** A `put` that changes the goal, spec or event (or a `resume`) is a new revision whose `effectiveFrom` is the time of the call; nothing of either revision before it is delivered. A `put` of the stored definition changes nothing, so ensuring schedules at every boot is safe and keeps catch-up. Pausing skips (does not record) occurrences inside the pause; `cancel` is final and disposes deliveries not yet applied as `'cancelled'`.
- **Deliveries.** Namespace `schedule:<scheduleId>`, delivery id = occurrence id `<scheduleId>@<UTC ms>`; the event comes from `goalEventFromOccurrence` (`source: { type: 'schedule', id }`, `at` / `notBefore` the instant it runs, `correlationId` and `expiresAt = at + expiresAfterMs` from `schedule.event`). The cursor moves only with its deliveries, so a crash mid-backlog neither loses nor repeats an occurrence, also across several schedulers on one store.
- **Catch-up.** An occurrence found within `graceMs` is on time under any mode. After downtime a window up to now is stored as `scanTo`: `'latest'` delivers only its newest occurrence (others recorded skipped, `'catch-up-latest'`), `'all'` every one oldest first, `'none'` only those within `graceMs` of its end. Schedules take turns per tick so one backlog never starves the others. A failing schedule is logged and retried next tick; `tick` rejects only when listing fails.
- **Time zones and DST** (`Intl`, no dependency, the same on any host zone): `dstGap: 'shift'` runs a skipped local time once at the first valid instant after the gap (`'skip'` drops it); `dstOverlap: 'first'` runs a repeated local time once (`'both'` at both instants, distinct ids). The same reading is available alone from `@deuz-sdk/core/schedule`: `zonedOccurrencesBetween(cron, fromMs, toMs, { timezone, dstGap, dstOverlap })`, `nextZonedOccurrence`, `timeZoneOffset(zone, atMs)`, `assertTimeZone(zone)`.
- **Which scheduler.** The 2.2 `createScheduler` (`/schedule`) stays as it is: UTC only, cursor in memory, calls your `run` after a `claim`, no retry. Use `createDurableScheduler` when the work is a goal that must survive restarts, never run twice, and be retried.

## Webhooks

```ts
import { createWebhookHandler } from '@deuz-sdk/core/goal/runtime';
import type { GoalRuntimeStore } from '@deuz-sdk/core/goal/runtime';

declare const store: GoalRuntimeStore; // the goal 'triage' exists in scope 'acme'

// app/api/webhooks/github/route.ts — the scope and goal come from config, never from the request.
export const POST = createWebhookHandler({
  store,
  verify: { kind: 'github', secret: process.env.GITHUB_WEBHOOK_SECRET! },
  target: { scope: 'acme', goalId: 'triage' },
  namespace: 'webhook:github',
});
```

- `verify`: `{ kind: 'hmac', secret, header, algorithm?, encoding?, prefix? }`, `{ kind: 'github', secret }`, `{ kind: 'slack', signingSecret, toleranceSeconds? }` or `{ kind: 'custom', verify(request) }`. `target` is a fixed `{ scope, goalId }` or `({ request, body }) => target | undefined`. `deliveryId` (a header name or a function; default `X-GitHub-Delivery` for GitHub, else `sha256:` of the body), `event` (extra fields from the verified body; never scope, goal or key), `maxBodyBytes` (1 MiB).
- Answers: `202 { ok: true, deliveryId }` only after the delivery is durably in the inbox; `200 { ok: true, duplicate: true }` for a recorded duplicate with the same payload and target; `409 'delivery_conflict'` for the same id with another payload or target (nothing recorded); `401` (signature), `404 'unknown-target'` (no goal in that scope; another scope's goal is not disclosed), `405`, `413 'payload-too-large'`; a failure on your side is `500`, never `202`, so the sender retries.
- `toNodeHandler(handler, { origin? })` serves it from `node:http` or Express without importing `node:http`; with Express mount it before body-parsing middleware. The raw body is kept as the inbox payload until `store.prunePayloads` (keep secrets out of payloads you do not want stored).

## Acceptance on evidence

`verifyGoalAcceptance({ goal, criteria?, verifiers, artifacts?, resolver?, runId?, now, signal? })` resolves each criterion's artifact or workspace before and after its verifier runs and returns `{ command, results, evidence }` — it writes nothing; apply `command` with `transitionGoal` or return it from the supervisor's `verify` hook.

```ts
import type { GoalVerifier } from '@deuz-sdk/core/goal/runtime';
import { verifyGoalAcceptance } from '@deuz-sdk/core/goal/runtime';
import type { GoalRecord } from '@deuz-sdk/core/goal';
import { createInMemoryWorkspace, digestWorkspace } from '@deuz-sdk/core/workspace';

declare const goal: GoalRecord; // criteria [{ id: 'tests', ... }], runId set
const workspace = createInMemoryWorkspace();

const tests: GoalVerifier = {
  id: 'unit-tests',
  version: '1.0.0',
  async verify() {
    return { verdict: 'passed', summary: '12 tests passed.' }; // your real check, e.g. a sandboxed test run
  },
};

const checked = await verifyGoalAcceptance({
  goal,
  verifiers: { tests },
  artifacts: { tests: { ref: 'workspace:main' } },
  resolver: {
    async resolve(ref) {
      if (ref !== 'workspace:main') return undefined;
      return { ref, kind: 'workspace', digest: await digestWorkspace(workspace, { exclude: ['node_modules'] }) };
    },
  },
  now: Date.now(),
});
console.log(checked.results.map((r) => r.verdict)); // ['passed'] — or 'inconclusive' with a note
```

- A verdict is `'inconclusive'` with a note and no evidence when there is no verifier with an `id` and `version`, no producing run, no artifact entry or resolver, a ref that resolves to nothing or to a malformed digest, a digest that differs from `expectedDigest` (or the digest the run recorded for that ref), an artifact that changed while it was verified, or a verifier that throws. Otherwise the evidence (`source: 'verifier'`) binds scope, goal, `criterionId`, run, `artifactDigest` / `workspaceDigest`, `verifier: { id, version }` and `specGeneration`, under an id derived from them, so verifying the same state again adds nothing. Remembered facts, model claims and working-memory hypotheses are never evidence.
- **Evidence binding (2.4 `GoalEvidence` fields, all optional):** evidence naming a `criterionId` supports a pass on that criterion only. 2.3 records carry none of the fields and read as before.
- **Spec generations (opt-in).** On a goal with `specGeneration`, a new objective, any criterion change or `revise({ nextSpecGeneration: true })` starts the next generation and turns every earlier verdict `inconclusive` (removed criteria dropped); only evidence of the current generation supports a pass. Supervised goals start at 1. Goals without the field keep the 2.3 rules exactly.
- **`digestWorkspace(workspace, { include?, exclude? })`** (`@deuz-sdk/core/workspace`, edge-safe) is the `deuz-workspace-v1` digest: SHA-256 of the canonical JSON of `{ path, size, digest }` entries sorted by UTF-8 path; anchored globs (`*`, `?`, `**`; a directory covers everything below), `exclude` wins. Docker runner artifacts use the same per-file digest.

## Retention and telemetry

Nothing is deleted in the background. `store.prunePayloads({ before, scope? })` replaces settled payloads with content-free tombstones (`payloadPruned`; ids stay, so dedupe holds — pass `now - policy.retainPayloadMs`); `pruneInbox` deletes settled entries ids included (only for a dedupe window you choose); `pruneOccurrences` (by `recordedAt`) and `pruneIntents` (finished intents by `updatedAt`) take the same `{ before, scope? }`; `pruneOccurrences` also accepts `{ olderThan, scope? }` with the same meaning, exactly one of the two (`GoalRuntimeOccurrencePruneOptions`; both or neither is a `TypeError`). Spans: `deuz.goal.claim`, `deuz.goal.dispatch` (covers the leg), `deuz.goal.retry`, `deuz.goal.cancel_requested`, `deuz.goal.cancel_applied`, `deuz.goal.drain`, `deuz.goal.generation`, and one `deuz.schedule.delivery` per occurrence — ids, revisions and counts only (`references/observability-retention.md`).

Limits: retries cover only failures the native run marks retryable; there is no exactly-once model call (a run that crashes before its checkpoint can call the model again); a schedule targets one existing goal (no templates). Not live-verified against real providers: the samples run on mock models.

## Deep dive

- [/docs/modules/goal-runtime](/docs/modules/goal-runtime) (2.4) — the supervisor's drive order, every option, stores, scheduler, webhooks, acceptance.
- [/docs/modules/goals](/docs/modules/goals) — the goal records and transitions this runtime drives.
- [/docs/modules/schedule](/docs/modules/schedule) — cron syntax, the in-process scheduler, signature verifiers.
