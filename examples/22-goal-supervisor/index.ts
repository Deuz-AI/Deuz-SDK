/**
 * 22 — Goal supervisor: schedule → inbox → goal supervisor → V3 run (2.4).
 *
 * `@deuz-sdk/core/goal/runtime` makes goals durable. A `GoalRuntimeStore`
 * keeps the goal, its inbox, the supervisor's runtime state, the schedules
 * with their cursors and the run intents under one transaction boundary,
 * here in one SQLite file. The durable scheduler turns a cron schedule in a
 * time zone into inbox deliveries; the goal supervisor applies them and runs
 * the goal's V3 native runs with the existing executor; your `verify` hook
 * judges a completed run on evidence. Both are library loops in your process:
 * nothing runs unless you tick them (or `start()` them).
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentToolSet } from '@deuz-sdk/core/agent';
import {
  createDurableScheduler,
  createGoalSupervisor,
  createNativeRunLauncher,
  verifyGoalAcceptance,
} from '@deuz-sdk/core/goal/runtime';
import type {
  DurableScheduler,
  GoalArtifactResolver,
  GoalSupervisor,
  GoalSupervisorEvent,
  GoalVerifier,
} from '@deuz-sdk/core/goal/runtime';
import { createSqliteGoalRuntimeStore } from '@deuz-sdk/core/goal/runtime/sqlite';
import type { SqliteGoalRuntimeStore } from '@deuz-sdk/core/goal/runtime/sqlite';
import { createSqliteAgentRunStoreV3, createSqliteOpsStore } from '@deuz-sdk/core/ops/sqlite';
import { nextZonedOccurrence } from '@deuz-sdk/core/schedule';
import { createMockModel } from '@deuz-sdk/core/testing';

// --- MODEL ------------------------------------------------------------------
// Scripted, so this runs without an API key: one reply per model call, in
// order, across both legs of the run. REAL PROVIDER: replace it with
//   import { createAnthropic } from '@deuz-sdk/core/anthropic';
//   const model = createAnthropic({ apiKey: process.env.ANTHROPIC_API_KEY })('claude-opus-4-8');
const model = createMockModel({
  responses: [
    { toolCalls: [{ toolName: 'audit_dependencies', args: {} }] },
    {
      toolCalls: [
        {
          toolName: 'upgrade_packages',
          args: { packages: ['lodash@4.17.21', 'minimist@1.2.8'] },
        },
      ],
    },
    // after the approval
    { toolCalls: [{ toolName: 'audit_dependencies', args: {} }] },
    { text: 'lodash and minimist are upgraded; the audit finds no vulnerable dependency.' },
  ],
});

// --- THE REPOSITORY -----------------------------------------------------------
const SCOPE = 'acme';
const GOAL = 'deps-clean';
const SCHEDULE = 'weekly-audit';
const SPEC = { cron: '0 9 * * 1', timezone: 'Europe/Berlin' }; // Mondays 09:00, Berlin time
let vulnerable = ['lodash@4.17.20', 'minimist@1.2.5'];
/** Your artifact storage: ref → content. The verifier reads it back by ref. */
const artifacts = new Map<string, string>();
/** The latest audit report of each run: what the verifier checks. */
const reports = new Map<string, { ref: string; digest: `sha256:${string}` }>();
let audits = 0;

/** `sha256:<hex>` of a text. */
async function digest(text: string): Promise<`sha256:${string}`> {
  const bytes = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)),
  );
  return `sha256:${[...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

/** The run's tools. The supervisor names the run, so the audit can file its report under it. */
function toolsFor(runId: string): AgentToolSet {
  return {
    audit_dependencies: {
      description: 'Audit the dependencies of acme/api and report the vulnerable ones.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      execute: async () => {
        const content = JSON.stringify({ vulnerable });
        const ref = `reports/audit-${++audits}.json`;
        artifacts.set(ref, content);
        reports.set(runId, { ref, digest: await digest(content) });
        console.log(`   [tool] audit_dependencies: ${vulnerable.length} vulnerable (${ref})`);
        return { ref, vulnerable };
      },
    },
    upgrade_packages: {
      description: 'Upgrade packages of acme/api to the given versions.',
      parameters: {
        type: 'object',
        properties: { packages: { type: 'array', items: { type: 'string' } } },
        required: ['packages'],
        additionalProperties: false,
      },
      needsApproval: true, // a person approves every upgrade
      execute: ({ packages }: { packages: string[] }) => {
        console.log(`   [tool] upgrade_packages(${packages.join(', ')})`);
        vulnerable = [];
        return { upgraded: packages };
      },
    },
  };
}

// --- VERIFICATION -------------------------------------------------------------
// The goal completes on your verifier's verdict about the report the run
// left, bound to the report's digest: never on what the model says.
const auditVerifier: GoalVerifier = {
  id: 'dependency-audit',
  version: '1',
  async verify({ artifact }) {
    const report = JSON.parse(artifacts.get(artifact!.ref)!) as { vulnerable: string[] };
    return report.vulnerable.length === 0
      ? { verdict: 'passed', summary: 'no vulnerable dependency' }
      : { verdict: 'failed', summary: `vulnerable: ${report.vulnerable.join(', ')}` };
  },
};
const resolver: GoalArtifactResolver = {
  async resolve(ref) {
    const content = artifacts.get(ref);
    return content === undefined
      ? undefined
      : { ref, kind: 'artifact', digest: await digest(content) };
  },
};

// --- THE HOST ---------------------------------------------------------------
// One SQLite file holds the goal runtime, the V3 runs and the leases. Each
// boot opens its own connections, as a restarted process does.
const dir = mkdtempSync(join(tmpdir(), 'deuz-goal-supervisor-'));
const path = join(dir, 'deuz.sqlite');
// The hosts' clock, moved by hand here so the output is the same on every run.
let now = Date.parse('2026-10-15T16:00:00Z'); // Thursday 18:00 in Berlin
const clock = {
  now: () => now,
  setTimeout: (fn: () => void, ms: number) => {
    const timer = setTimeout(fn, ms);
    return () => clearTimeout(timer);
  },
};
const minute = (at: number) => `${new Date(at).toISOString().slice(0, 16).replace('T', ' ')}Z`;

interface Host {
  goals: SqliteGoalRuntimeStore;
  runs: ReturnType<typeof createSqliteAgentRunStoreV3>;
  scheduler: DurableScheduler;
  supervisor: GoalSupervisor;
  stop(): Promise<void>;
}

function describe(event: GoalSupervisorEvent): string {
  switch (event.type) {
    case 'claimed':
      return `claimed ${event.goalId} under its goal lease`;
    case 'inbox-applied': {
      // The entry id is `inbox:` and [scope, namespace, delivery id]; a schedule's delivery id is `<schedule>@<ms>`.
      const [, namespace, deliveryId] = JSON.parse(
        event.entryId.slice('inbox:'.length),
      ) as string[];
      const [scheduleId, at] = deliveryId!.split('@');
      return `inbox entry ${namespace} ${scheduleId}@${minute(Number(at))}: ${event.disposition}`;
    }
    case 'dispatched':
      return `${event.intent.kind} intent for run ${event.intent.runId}`;
    case 'run-ended':
      return `run ${event.runId} ${event.status}`;
    default:
      return event.type;
  }
}

function boot(name: string): Host {
  const ops = createSqliteOpsStore({ path });
  const goals = createSqliteGoalRuntimeStore({ path, clock });
  const runs = createSqliteAgentRunStoreV3({ path });
  const scheduler = createDurableScheduler({ store: goals, deps: { clock } });
  // Runs a goal's V3 runs (checkpointVersion: 3) with the native executor:
  // starts a run its store does not hold, resumes a stored one.
  const launcher = createNativeRunLauncher({
    store: runs,
    options: (request) => ({
      model,
      tools: toolsFor(request.runId),
      bindingId: 'deps-audit-v1',
      prompt: `${request.goal.objective} Audit the dependencies and upgrade what is vulnerable.`,
    }),
    lease: { provider: ops.leases },
  });
  const supervisor = createGoalSupervisor({
    store: goals,
    launcher,
    lease: { provider: ops.leases, owner: `host-${name}` },
    deps: { clock },
    // Asked once for each run leg that completed: the commands to apply.
    verify: async ({ goal, runId }) => {
      const report = reports.get(runId);
      if (!report) return { type: 'wait', wait: { reason: 'user', note: 'no audit report' } };
      const { command } = await verifyGoalAcceptance({
        goal,
        runId,
        now: clock.now(),
        verifiers: { 'no-vulnerable-deps': auditVerifier },
        artifacts: { 'no-vulnerable-deps': { ref: report.ref, expectedDigest: report.digest } },
        resolver,
      });
      for (const result of command.results)
        console.log(`   [verify] ${result.criterionId}: ${result.verdict} on ${report.ref}`);
      if (command.results.every((result) => result.verdict === 'passed')) return command;
      // Not there yet: record the verdict and wait for next week's audit.
      const wait = { reason: 'event', source: { type: 'schedule', id: SCHEDULE } } as const;
      return [command, { type: 'wait', wait }];
    },
  });
  const listening = new AbortController();
  const printing = (async () => {
    for await (const event of supervisor.events({ signal: listening.signal }))
      console.log(`   [supervisor] ${describe(event)}`);
  })();
  console.log(`   host ${name} opens deuz.sqlite`);
  return {
    goals,
    runs,
    scheduler,
    supervisor,
    async stop() {
      listening.abort();
      await printing;
      await runs.close();
      await goals.close();
      await ops.close();
    },
  };
}

let host: Host | undefined;
try {
  console.log('1) Thursday: a goal that waits for the weekly audit schedule');
  host = boot('A');
  const { goal } = await host.supervisor.submit({
    goalId: GOAL,
    scope: SCOPE,
    objective: 'No dependency of acme/api has a known vulnerability.',
    criteria: [
      {
        id: 'no-vulnerable-deps',
        description: 'The dependency audit lists no vulnerable package.',
      },
    ],
    budget: { tokens: 20_000 },
    start: false, // no run yet: the schedule starts the work
  });
  console.log(`   goal ${goal.goalId}: ${goal.status}, spec generation ${goal.specGeneration}`);
  const source = { type: 'schedule', id: SCHEDULE } as const;
  const waited = await host.supervisor.command(SCOPE, GOAL, {
    type: 'wait',
    wait: { reason: 'event', source },
  });
  console.log(`   goal ${waited.record.status} for schedule ${SCHEDULE}`);
  const schedule = await host.scheduler.put({
    scheduleId: SCHEDULE,
    scope: SCOPE,
    goalId: GOAL,
    spec: SPEC,
  });
  const first = nextZonedOccurrence(SPEC.cron, now, SPEC);
  const second = nextZonedOccurrence(SPEC.cron, first, SPEC);
  console.log(
    `   schedule ${schedule.scheduleId} r${schedule.revision}: Mondays 09:00 ${SPEC.timezone}, next ${minute(first)} and ${minute(second)}`,
  );
  const quiet = await host.scheduler.tick();
  const idle = await host.supervisor.tick();
  console.log(
    `   ticks: ${quiet.occurrences.length} occurrences due, ${idle.dispatched} runs dispatched`,
  );
  await host.stop();
  host = undefined;
  console.log('   host A shuts down for the weekend');

  console.log(
    '\n2) Monday 09:25 in Berlin: the host was down at 09:00, so its first tick catches up',
  );
  now = Date.parse('2026-10-19T07:25:00Z');
  host = boot('B');
  const caught = await host.scheduler.tick();
  for (const occurrence of caught.occurrences) {
    const why = occurrence.reason ? ` (${occurrence.reason})` : '';
    console.log(
      `   occurrence ${occurrence.occurrenceId.split('@')[0]} at ${minute(occurrence.at)}: ${occurrence.disposition}${why}`,
    );
  }
  const again = await host.scheduler.tick();
  console.log(
    `   a second tick: ${again.occurrences.length} occurrences (the cursor moved with the delivery)`,
  );
  const pass = await host.supervisor.tick();
  console.log(
    `   supervisor tick: ${pass.applied} inbox entry applied, ${pass.dispatched} run dispatched`,
  );
  const parked = (await host.supervisor.get(SCOPE, GOAL))!;
  const runId = parked.runtime.activeRun!.runId;
  console.log(
    `   goal ${parked.goal.status} (${parked.goal.waiting?.reason}: ${parked.goal.waiting?.note}), run ${runId} kept`,
  );
  const stored = await host.runs.load(runId);
  const result = stored?.result;
  if (result?.status !== 'suspended')
    throw new Error(`expected a suspended run, got ${result?.status}`);
  for (const request of result.pendingApprovals)
    console.log(`   waiting for approval: ${request.toolName}(${JSON.stringify(request.input)})`);

  console.log('\n3) Monday 09:40: the on-call engineer approves the upgrade');
  now = Date.parse('2026-10-19T07:40:00Z');
  await host.supervisor.resume(SCOPE, GOAL, {
    approvalResponses: result.pendingApprovals.map((request) => ({
      approvalId: request.approvalId,
      approved: true, // in production: the authenticated user's decision
      token: request.token,
    })),
  });
  const resumed = await host.supervisor.tick();
  console.log(`   supervisor tick: ${resumed.dispatched} run dispatched`);
  const done = (await host.supervisor.get(SCOPE, GOAL))!;
  console.log(
    `   goal ${done.goal.status} (${done.goal.outcome?.reason}), spent ${done.goal.spent.tokens} of ${done.goal.budget?.tokens} tokens`,
  );
  for (const item of done.goal.evidence)
    console.log(
      `   evidence ${item.source}: ${item.verifier?.id}@${item.verifier?.version}, ${item.ref}, generation ${item.specGeneration}, run ${item.runId}`,
    );
  const run = await host.runs.load(runId);
  console.log(`   run ${runId}: version ${run?.version}, ${run?.phase}, ${run?.result?.status}`);

  console.log(
    '\n4) the goal is done: the host cancels its schedule, and the next Monday delivers nothing',
  );
  const cancelled = await host.scheduler.cancel(SCOPE, SCHEDULE);
  console.log(
    `   schedule ${cancelled.scheduleId}: ${cancelled.status}, revision ${cancelled.revision}`,
  );
  now = Date.parse('2026-10-26T08:00:20Z'); // 09:00 in Berlin again, after the clocks went back
  const later = await host.scheduler.tick();
  console.log(`   tick at ${minute(now)}: ${later.occurrences.length} occurrences`);
  const recorded = await host.goals.schedules.occurrences({ scope: SCOPE, scheduleId: SCHEDULE });
  console.log(
    `   occurrence records: ${recorded.occurrences.map((r) => `${minute(r.at)} ${r.disposition}`).join(', ')}`,
  );
} finally {
  await host?.stop();
  rmSync(dir, { recursive: true, force: true });
}
