/**
 * 16 — Goals and wakeups: a goal that a schedule and a webhook wake, with one
 * claimed and leased native run per wake (2.3).
 *
 * `@deuz-sdk/core/goal` is a data contract. A goal is done only when its
 * acceptance criteria pass on evidence, it says what it waits for, and a
 * wakeup or an outside event moves it on through `transitionGoal`. Nothing in
 * it runs a timer or a model: your workers do. Here two workers share one
 * SQLite ops file. A schedule occurrence and a webhook delivery each have a key
 * in one key space, and the file's durable `claims` grants each key to one
 * worker only. A wake starts one native run, held by that worker's lease, so
 * no other worker drives the run while it works.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resumeAgent, streamAgent } from '@deuz-sdk/core/agent';
import type { AgentRunOptions, AgentToolSet } from '@deuz-sdk/core/agent';
import {
  GoalError,
  createGoal,
  createInMemoryGoalStore,
  goalEventFromOccurrence,
  goalEventFromSignal,
  transitionGoal,
} from '@deuz-sdk/core/goal';
import type { GoalCommand, GoalEvent, GoalTransition } from '@deuz-sdk/core/goal';
import { findStaleAgentRuns } from '@deuz-sdk/core/ops';
import { createSqliteOpsStore } from '@deuz-sdk/core/ops/sqlite';
import type { SqliteOpsStore } from '@deuz-sdk/core/ops/sqlite';
import { createScheduler, nextOccurrence } from '@deuz-sdk/core/schedule';
import type { Scheduler } from '@deuz-sdk/core/schedule';
import { createMockModel } from '@deuz-sdk/core/testing';

// --- MODEL ------------------------------------------------------------------
// Scripted, so this runs without an API key: one reply per model call, in
// order, across both runs. REAL PROVIDER: replace it with
//   import { createAnthropic } from '@deuz-sdk/core/anthropic';
//   const model = createAnthropic({ apiKey: process.env.ANTHROPIC_API_KEY })('claude-opus-4-8');
const model = createMockModel({
  responses: [
    // the run the nightly wakeup starts
    { toolCalls: [{ toolName: 'check_links', args: {} }] },
    { text: 'Three links are still broken: /guide/setup, /api/v1 and /blog/launch.' },
    // the run the deploy webhook starts
    { toolCalls: [{ toolName: 'check_links', args: {} }] },
    { text: 'Every link on the site resolves.' },
  ],
});

// --- THE SITE ---------------------------------------------------------------
// What the tool checks: three links stay broken until the fix is deployed.
type LinkReport = { id: string; ref: string; broken: string[] };
let brokenLinks = ['/guide/setup', '/api/v1', '/blog/launch'];
let checks = 0;
/** Runs in the middle of a link check: worker B's recovery sweep, on the first night. */
let whileChecking: (() => Promise<void>) | undefined;
const tools: AgentToolSet = {
  check_links: {
    description: 'Check every link on docs.acme.dev and report the broken ones.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    execute: async (): Promise<LinkReport> => {
      checks++;
      const report = {
        id: `link-check-${checks}`,
        ref: `reports/link-check-${checks}.json`,
        broken: [...brokenLinks],
      };
      console.log(`       [tool] check_links: ${report.broken.length} broken links`);
      await whileChecking?.();
      return report;
    },
  },
};

// --- THE GOAL ---------------------------------------------------------------
const GOAL = 'links-fixed';
const SCOPE = 'acme';
const NIGHTLY = '0 2 * * *'; // five-field cron, in UTC
// Goal records are yours to keep. This reference store stands in for a table
// both workers share; like it, a store of yours saves only the next revision.
const goals = createInMemoryGoalStore();
let now = Date.parse('2026-10-12T18:00:00Z'); // the workers' clock, moved by hand here
const minute = (at: number) => new Date(at).toISOString().slice(0, 16).replace('T', ' ');

/** Load, transition, save. On a revision conflict another writer saved first: load again. */
async function update(command: GoalCommand): Promise<GoalTransition> {
  for (let attempt = 0; ; attempt++) {
    const current = await goals.load(GOAL);
    if (!current) throw new Error(`Unknown goal ${GOAL}`);
    const next = transitionGoal(current, command, { now });
    if (!next.changed) return next;
    try {
      await goals.save(next.record);
      return next;
    } catch (error) {
      const conflict = error instanceof GoalError && error.code === 'revision_conflict';
      if (!conflict || attempt >= 3) throw error;
    }
  }
}

// --- WORKERS ----------------------------------------------------------------
// Two processes (or serverless isolates), each with its own connection to one file.
const dir = mkdtempSync(join(tmpdir(), 'deuz-goals-'));
const path = join(dir, 'ops.sqlite');
type Worker = { name: string; ops: SqliteOpsStore; scheduler: Scheduler };

function startWorker(name: string): Worker {
  const ops = createSqliteOpsStore({ path });
  const worker: Worker = {
    name,
    ops,
    scheduler: createScheduler({
      schedules: [
        {
          id: 'nightly-links',
          cron: NIGHTLY,
          // The occurrence's event carries the key `claims` granted: `nightly-links@<at>`.
          run: (occurrence) =>
            wake(worker, goalEventFromOccurrence(occurrence, { scope: SCOPE, goalId: GOAL })),
        },
      ],
      claim: ops.claims, // durable: each occurrence runs on one worker only
    }),
  };
  return worker;
}

/** The same run options on every worker: a resume must find the binding unchanged. */
const runOptions = (worker: Worker, runId: string) =>
  ({
    model,
    tools,
    bindingId: 'link-check-v1',
    session: { store: worker.ops.agentRuns, runId, scope: SCOPE },
    // The worker holds the run's lease while it drives the run: another worker
    // that tries to resume the run meanwhile is refused with 'lease_held'.
    lease: { provider: worker.ops.leases, owner: `worker-${worker.name}` },
  }) satisfies AgentRunOptions;

/** Apply a claimed event to the goal; when it woke the goal, work on it once. */
async function wake(worker: Worker, event: GoalEvent): Promise<void> {
  const woke = await update({ type: 'event', event });
  const why = woke.reason ? ` (${woke.reason})` : '';
  console.log(`     event ${event.key}: ${woke.outcome}${why}, goal ${woke.record.status}`);
  if (woke.outcome === 'applied' && woke.record.status === 'active')
    await work(worker, `check-${event.key}`);
}

/** One native run on the goal. Its usage is a charge; its tool's report is the evidence. */
async function work(worker: Worker, runId: string): Promise<void> {
  await update({ type: 'link-run', runId });
  console.log(`     run ${runId} on worker ${worker.name}, which holds its lease`);
  const stream = streamAgent({
    ...runOptions(worker, runId),
    prompt: 'Check the links on docs.acme.dev and report the broken ones.',
  });
  // The `tool-output` event carries the tool's raw result: the checker's report.
  let report: LinkReport | undefined;
  for await (const event of stream.events)
    if (event.type === 'tool-output' && event.toolName === 'check_links')
      report = event.rawResult as LinkReport;
  const result = await stream.result;
  console.log(`     run ${result.status}: "${result.text}"`);
  // Keyed by the run, so a repeated charge counts once.
  await update({ type: 'charge', tokens: result.usage.totalTokens, key: runId });
  if (!report) {
    await update({ type: 'wait', wait: { reason: 'user', note: 'The run checked no links.' } });
    return;
  }
  // Acceptance rests on the checker's report (source 'tool'). The model saying
  // "fixed" is only the model's claim, which never passes a criterion.
  const verdict = report.broken.length === 0 ? 'passed' : 'failed';
  const summary = `${report.broken.length} broken links`;
  const judged = await update({
    type: 'evaluate',
    evidence: [{ id: report.id, source: 'tool', ref: report.ref, runId, summary }],
    results: [{ criterionId: 'no-broken-links', verdict, source: 'tool', evidence: [report.id] }],
  });
  console.log(`     no-broken-links: ${verdict} (tool evidence ${report.id})`);
  if (judged.acceptance?.verdict === 'passed') {
    const { record } = await update({ type: 'complete' });
    const spent = `spent ${record.spent.tokens} of ${record.budget?.tokens} tokens`;
    console.log(`     goal ${record.status} (${record.outcome?.reason}), ${spent}`);
  } else {
    // Another check finds the same links until the fix is deployed: wait for the deploy.
    const source = { type: 'signal', id: 'docs-deploy' } as const;
    const { record } = await update({ type: 'wait', wait: { reason: 'event', source } });
    console.log(`     goal ${record.status} for signal ${source.id} (revision ${record.revision})`);
  }
}

/**
 * A recovery sweep: resume the runs that look abandoned, under this worker's
 * lease. A native run saves at every step, not on a heartbeat, so a run in a
 * long tool call looks stale too; the lease refuses it while its executor lives.
 */
async function sweep(worker: Worker): Promise<void> {
  // Five minutes into the link check: this clock is moved ahead instead of waiting.
  const later = {
    now: () => Date.now() + 5 * 60_000,
    setTimeout: (fn: () => void, ms: number) => {
      const timer = setTimeout(fn, ms);
      return () => clearTimeout(timer);
    },
  };
  const stale = await findStaleAgentRuns(worker.ops.agentRuns, {
    scope: SCOPE,
    staleMs: 60_000,
    clock: later,
  });
  for (const run of stale) {
    const result = await resumeAgent(runOptions(worker, run.runId));
    const outcome =
      result.status === 'failed' ? `resume refused: ${result.error.code}` : result.status;
    console.log(`       worker ${worker.name}'s sweep: ${run.runId} looks stale; ${outcome}`);
  }
}

/** One cron trigger of a worker's scheduler; prints each occurrence. */
async function tick(worker: Worker, iso: string): Promise<void> {
  now = Date.parse(iso);
  console.log(`   worker ${worker.name} ticks at ${iso.slice(11, 19)}`);
  const { occurrences } = await worker.scheduler.tick(now);
  for (const occurrence of occurrences) {
    const failure = occurrence.status === 'failed' ? `: ${String(occurrence.error)}` : '';
    const at = `${occurrence.key} (${minute(occurrence.at)})`;
    console.log(`   worker ${worker.name}: ${at} ${occurrence.status}${failure}`);
  }
}

/**
 * The docs deploy webhook, after its signature was verified (`handleSignal` in
 * example 11). Like `handleSignal` with `dedupe: ops.claims`, it claims the
 * delivery id before it dispatches, with the same durable claim the schedule
 * uses: occurrence keys and delivery ids share one key space.
 */
async function deliver(worker: Worker, deliveryId: string): Promise<void> {
  if (!(await worker.ops.claims(deliveryId))) {
    console.log(`   worker ${worker.name}: delivery ${deliveryId} duplicate, nothing dispatched`);
    return;
  }
  console.log(`   worker ${worker.name}: delivery ${deliveryId} claimed`);
  const target = { scope: SCOPE, goalId: GOAL, name: 'docs-deploy', at: now };
  await wake(worker, goalEventFromSignal({ key: deliveryId }, target));
}

const A = startWorker('A');
const B = startWorker('B');
try {
  console.log('1) a goal that the nightly link check wakes');
  const created = createGoal(
    {
      goalId: GOAL,
      scope: SCOPE,
      objective: 'No broken links on docs.acme.dev.',
      criteria: [{ id: 'no-broken-links', description: 'The link checker finds no broken link.' }],
      budget: { tokens: 500 },
    },
    { now },
  );
  await goals.save(created);
  console.log(`   goal ${GOAL}: ${created.status}, revision ${created.revision}`);
  const at = nextOccurrence(NIGHTLY, now);
  const wait = { reason: 'wakeup', at, schedule: 'nightly-links' } as const;
  const { record } = await update({ type: 'wait', wait });
  console.log(
    `   goal ${record.status} for a wakeup at ${minute(at)} (schedule nightly-links), revision ${record.revision}`,
  );

  console.log('\n2) Tue 02:00: both workers tick the same minute; the claim gives it to one');
  whileChecking = () => sweep(B); // B's recovery sweep runs during A's link check
  await tick(A, '2026-10-13T02:00:20Z');
  whileChecking = undefined;
  await tick(B, '2026-10-13T02:00:25Z');

  console.log('\n3) Tue 11:30: the fix is deployed, and the deploy webhook wakes the goal');
  brokenLinks = [];
  now = Date.parse('2026-10-13T11:30:00Z');
  await deliver(B, 'deploy-812');
  await deliver(A, 'deploy-812'); // the sender retries the delivery at the other worker

  console.log('\n4) Wed 02:00: the schedule fires again, but the goal has ended');
  await tick(A, '2026-10-14T02:00:15Z');
} finally {
  await A.ops.close();
  await B.ops.close();
  rmSync(dir, { recursive: true, force: true });
}
