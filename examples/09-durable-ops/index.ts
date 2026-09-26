/**
 * 09 — Durable operations: leases, crash takeover, cross-process cancel, drain (2.2).
 *
 * Three swarm executors share one SQLite file, each through its own
 * connections, standing in for three processes. Worker A crashes mid-task and
 * stops renewing its lease; once the lease lapses, `recover()` on worker B takes
 * the run over and finishes it, and the revision fence rejects A's late write.
 * Then worker C cancels a run that B drives (`requestCancel`), and B drains a
 * run for a deploy, which C resumes.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Clock } from '@deuz-sdk/core';
import { createAgent } from '@deuz-sdk/core/agent';
import { createSqliteOpsStore } from '@deuz-sdk/core/ops/sqlite';
import { createSwarm, SwarmLeaseError } from '@deuz-sdk/core/swarm';
import type { SwarmHandle, SwarmOutcome, SwarmTask } from '@deuz-sdk/core/swarm';
import { createSqliteSwarmStore } from '@deuz-sdk/core/swarm/sqlite';
import { createMockModel } from '@deuz-sdk/core/testing';

const dir = mkdtempSync(join(tmpdir(), 'deuz-ops-'));
const path = join(dir, 'runs.sqlite');
const TTL = 1_000; // lease ttl in ms, renewed every ttl / 3 (default 30 000)
const key = (runId: string) => ({ scope: 'tenant-a', runId });
const statuses = (outcome: SwarmOutcome) =>
  outcome.tasks.map((task) => `${task.task.id}=${task.status}`).join(' ');
const firstTaskStarted = async (handle: SwarmHandle) => {
  for await (const event of handle.events()) if (event.type === 'task.started') return;
};

// Work that honours the run's abort signal, so a cancel can stop it.
const WORK_MS: Record<string, number> = { crunch: 300, scan: 60_000, build: 300 };
const work = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(signal.reason);
    });
  });

/** One "process": its own connections to the shared file, the same swarm definition. */
function worker(owner: string, crashIn?: string) {
  let dead = false;
  let crash = () => {};
  let wake = () => {};
  const crashed = new Promise<void>((resolve) => (crash = resolve));
  // A crashed process fires no more timers, so its heartbeat stops renewing the lease.
  const clock: Clock = {
    now: () => Date.now(),
    setTimeout(fn, ms) {
      const timer = setTimeout(() => dead || fn(), ms);
      return () => clearTimeout(timer);
    },
  };
  const store = createSqliteSwarmStore({ path });
  const ops = createSqliteOpsStore({ path });
  // MODEL: scripted, so no API key is needed. REAL PROVIDER: use
  //   createAnthropic({ apiKey: process.env.ANTHROPIC_API_KEY })('claude-opus-4-8')
  // from '@deuz-sdk/core/anthropic' instead of createMockModel(...).
  const model = createMockModel({ responses: [{ text: `Nightly report, by ${owner}.` }] });
  const swarm = createSwarm({
    store,
    definitionVersion: 'jobs-v1', // every process runs the same definition
    lease: { provider: ops.leases, owner, ttlMs: TTL },
    deps: { clock },
    agents: { writer: createAgent({ model }) },
    reducers: {
      step: {
        async execute(_results, context) {
          console.log(`   [${owner}] runs ${context.taskId}`);
          if (context.taskId === crashIn) {
            dead = true;
            console.log(`   [${owner}] crashes in the middle of ${context.taskId}`);
            crash();
            await new Promise<void>((resolve) => (wake = resolve)); // until the demo wakes it
          }
          await work(WORK_MS[context.taskId] ?? 0, context.signal);
          return `${context.taskId} by ${owner}`;
        },
      },
    },
  });
  const close = async () => {
    await store.close();
    await ops.close();
  };
  return { swarm, crashed, wake: () => wake(), close };
}

const nightly: SwarmTask[] = [
  { id: 'fetch', reducer: 'step' },
  // Safe to repeat, so the next executor may replay it after a crash. Without
  // `replay: 'safe'` an interrupted task waits in needs_reconciliation.
  { id: 'crunch', reducer: 'step', dependsOn: ['fetch'], replay: 'safe' },
  { id: 'report', agent: 'writer', prompt: 'Write the nightly report.', dependsOn: ['crunch'] },
];

const a = worker('worker-a', 'crunch');
const b = worker('worker-b');
const c = worker('worker-c');
try {
  console.log('1) worker-a starts "nightly" and crashes mid-task');
  const zombie = await a.swarm.run({ ...key('nightly'), tasks: nightly });
  await a.crashed;
  const early = await b.swarm.recover({ scope: 'tenant-a' });
  console.log(`   worker-b recover(): ${early.handles.length} taken over, the lease is still live`);

  console.log(`\n2) after ${TTL} ms the lease has lapsed; worker-b recovers the run`);
  await new Promise((resolve) => setTimeout(resolve, TTL + 200));
  const { handles, failed } = await b.swarm.recover({ scope: 'tenant-a' });
  console.log(`   recover(): ${handles.length} taken over, ${failed.length} failed`);
  const recovered = await handles[0]!.result;
  console.log(`   nightly: ${recovered.run.status} (${statuses(recovered)})`);
  console.log(`   report: ${recovered.tasks.at(-1)?.result?.output}`);

  console.log('\n3) worker-a wakes up; the revision fence rejects its stale write');
  a.wake();
  const verdict = await zombie.result.catch((error: unknown) => error);
  const lost = verdict instanceof SwarmLeaseError ? `SwarmLeaseError '${verdict.code}'` : verdict;
  console.log(`   worker-a's result rejects: ${lost}`);
  const stored = (await c.swarm.get(key('nightly')))?.tasks.find((t) => t.task.id === 'crunch');
  console.log(`   the stored crunch result is still ${JSON.stringify(stored?.result?.output)}`);

  console.log('\n4) worker-c cancels a run that worker-b drives');
  const backfill = await b.swarm.run({
    ...key('backfill'),
    tasks: [{ id: 'scan', reducer: 'step' }],
  });
  await firstTaskStarted(backfill);
  console.log(`   requestCancel(backfill): ${await c.swarm.requestCancel(key('backfill'))}`);
  const cancelled = await backfill.result; // worker-b applies it on its next heartbeat
  console.log(`   backfill: ${cancelled.run.status} (${statuses(cancelled)})`);
  console.log(`   requestCancel(nightly): ${await c.swarm.requestCancel(key('nightly'))}`);

  console.log('\n5) a deploy: worker-b drains, worker-c resumes');
  const deploy = await b.swarm.run({
    ...key('deploy'),
    tasks: [
      { id: 'build', reducer: 'step' },
      { id: 'ship', reducer: 'step', dependsOn: ['build'] },
    ],
  });
  await firstTaskStarted(deploy);
  const drained = await deploy.drain(); // in-flight work finishes, nothing new starts
  console.log(`   drained on worker-b: ${drained.run.status} (${statuses(drained)})`);
  const resumed = await (await c.swarm.resume(key('deploy'))).result;
  console.log(`   resumed on worker-c: ${resumed.run.status} (${statuses(resumed)})`);
} finally {
  for (const executor of [a, b, c]) await executor.close();
  rmSync(dir, { recursive: true, force: true });
}
