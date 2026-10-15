/**
 * The composite flow's ambiguous outcomes (spec §5.1: "Belirsiz sonuçlarda
 * doğru containment başarılı davranış sayılacak"). Where the host cannot
 * know whether an effect happened, the right answer is to stop and hand it
 * to the host, never to repeat it and never to complete:
 *
 * - the approved post landed but the host died before its receipt: the
 *   resumed run stops for reconciliation, the supervisor parks the goal, and
 *   only the host's reconciliation (from the outbox it can check) moves on —
 *   one post in the end;
 * - the Docker start was dispatched durably but the host died before the
 *   start command: the container is never started (its start is unconfirmed,
 *   `needs-reconcile`, later failed by `reconcile`), the run cannot verify an
 *   artifact, and the goal never completes;
 * - the documented spans the main flow does not pass through (spec §3.6,
 *   §5.1): a provider outage the supervisor retries (`deuz.goal.retry`), a
 *   spec change (`deuz.goal.generation`), a host shutdown that drains the
 *   working run (`deuz.goal.drain`) while the host stops its sandbox job
 *   (`deuz.process.cancel`); the goal is then cancelled, never completed.
 *
 * Same stores, Docker and clients as composite-flow.test.ts; three rounds per
 * backend on clean stores, never retried.
 */
import { readFile } from 'node:fs/promises';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { DEUZ_SPAN } from '../../src/internal/telemetry';
import type { ObserveEvent } from '../../src/types/observe';
import {
  CHANNEL_FACT,
  DOCKER_OPERATION,
  FINAL_FAILED,
  FINAL_OK,
  GOAL_ID,
  OCCURRENCE_AT,
  OTHER_MARK,
  REMEMBERED,
  REPORT_CONTENT,
  RUN_ID,
  SECRET_MARK,
  WireClient,
  createFlowEnv,
  disposeFakeDocker,
  disposeFlowEnv,
  dockerHarness,
  flowBackends,
  openProcess,
  putSchedule,
  recoverProcess,
  seedMemory,
  startToApproval,
  storedFrames,
  submitGoal,
  type FlowEnv,
  type HostProcess,
} from './harness';

vi.setConfig({ testTimeout: 600_000, hookTimeout: 120_000 });
afterAll(() => disposeFakeDocker());

it('asserts every documented span somewhere in the composite suite (spec §3.6, §5.1)', async () => {
  const suite = (
    await Promise.all(
      ['composite-flow.test.ts', 'composite-containment.test.ts'].map((file) =>
        readFile(new URL(file, import.meta.url), 'utf8'),
      ),
    )
  ).join('\n');
  for (const name of Object.values(DEUZ_SPAN)) expect(suite, name).toContain(`'${name}'`);
});

const approveAll = (pending: { approvalId: string }[]) =>
  pending.map((request) => ({ approvalId: request.approvalId, approved: true }));

/** Every frame the client got, once each, is the journal's committed frames. */
async function expectReplayedOnce(proc: HostProcess, wire: WireClient) {
  const stored = await storedFrames(proc);
  const committed = stored.filter((record) => record.part.type !== 'done').map((r) => r.seq);
  expect(wire.frames.map((frame) => frame.id)).toEqual(committed);
}

const runResults = (wire: WireClient) =>
  wire.frames
    .filter(
      (frame) =>
        frame.part.type === 'data-agent' &&
        (frame.part.payload as { kind?: string }).kind === 'result',
    )
    .map((frame) => {
      const payload = frame.part.payload as { status: string; reason?: string };
      return payload.reason ? `${payload.status}:${payload.reason}` : payload.status;
    });

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Waits until `check` holds (polling), failing after `ms`. */
async function until(check: () => Promise<boolean>, what: string, ms = 60_000): Promise<void> {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(25)) if (await check()) return;
  throw new Error(`Timed out waiting for ${what}`);
}

/** The 2.4 spans (spec §3.6) a flow completed, by name. */
function completedSpans(
  env: FlowEnv,
): Map<string, Extract<ObserveEvent, { type: 'operation.completed' }>[]> {
  const found = new Map<string, Extract<ObserveEvent, { type: 'operation.completed' }>[]>();
  for (const event of env.observer.events())
    if (event.type === 'operation.completed' && event.operation.startsWith('deuz.'))
      found.set(event.operation, [...(found.get(event.operation) ?? []), event]);
  return found;
}

async function withFlow(backend: 'sqlite' | 'postgres', body: (env: FlowEnv) => Promise<void>) {
  const docker = await dockerHarness();
  const env = await createFlowEnv(backend, docker);
  try {
    await body(env);
  } finally {
    await disposeFlowEnv(env);
    await docker.dispose();
  }
}

describe.each(flowBackends())('composite containment (%s)', (backend) => {
  for (const round of [1, 2, 3]) {
    it(`round ${round}: a post whose receipt was lost is reconciled by the host, never repeated`, () =>
      withFlow(backend, async (env) => {
        const { scope } = env;
        const wire = new WireClient();
        const { proc: p1, pending } = await startToApproval(env, 'p1');
        p1.arm('publish-effect');
        await wire.read(
          await p1.route.post({ runId: RUN_ID, approvalResponses: approveAll(pending) }),
        );
        expect(p1.crashedAt()).toBe('publish-effect');
        expect(env.outbox).toHaveLength(1);

        // The client comes back: the run cannot know whether the post landed.
        const p2 = await recoverProcess(p1, 'p2');
        await wire.read(p2.route.resume({ lastEventId: wire.cursor }));
        expect(runResults(wire)).toEqual(['stopped:tool-reconciliation-required']);
        expect(env.outbox).toHaveLength(1);
        const stopped = (await p2.runs.load(RUN_ID))!;
        expect(
          Object.values(stopped.toolResults ?? {}).map((r) => `${r.toolCallId}:${r.stage}`),
        ).toContain('pub-1:executing');

        // The supervisor's resume intent (the accepted verdict) runs: the same
        // stop, and the goal waits for the host instead of completing.
        const tick = await p2.supervisor.tick();
        expect(tick).toMatchObject({ dispatched: 1 });
        const parked = (await p2.supervisor.get(scope, GOAL_ID))!;
        expect(parked.goal).toMatchObject({
          status: 'waiting',
          waiting: { reason: 'user', note: 'run-stopped:tool-reconciliation-required' },
        });
        expect(parked.runtime.activeRun).toBeUndefined();
        // Parked means parked: no automatic run starts while the host decides.
        expect(await p2.supervisor.tick()).toMatchObject({ dispatched: 0 });
        expect(env.outbox).toHaveLength(1);
        expect(env.docker.facts(scope, DOCKER_OPERATION).containers).toBe(0);

        // The host checks its outbox, finds the post, and reconciles the run with it.
        const post = env.outbox.find((entry) => entry.toolCallId === 'pub-1')!;
        await p2.reconcileRun([
          { toolCallId: 'pub-1', output: { published: true, postId: post.id } },
        ]);
        await wire.read(p2.route.resume({ lastEventId: wire.cursor }));
        const done = (await p2.runs.load(RUN_ID))!;
        expect(done).toMatchObject({
          phase: 'terminal',
          verification: 'verified',
          result: { status: 'completed', output: FINAL_OK },
        });
        expect(env.outbox).toHaveLength(1);
        expect(env.docker.facts(scope, DOCKER_OPERATION)).toMatchObject({
          containers: 1,
          starts: 1,
        });

        // The goal completes only on the host's acceptance evidence.
        const goal = (await p2.supervisor.get(scope, GOAL_ID))!.goal;
        await p2.supervisor.command(scope, GOAL_ID, await p2.verifyGoal(goal, RUN_ID));
        await p2.supervisor.command(scope, GOAL_ID, { type: 'complete' });
        expect((await p2.supervisor.get(scope, GOAL_ID))!.goal).toMatchObject({
          status: 'completed',
          results: [expect.objectContaining({ criterionId: 'artifact', verdict: 'passed' })],
        });
        expect(runResults(wire)).toEqual(['stopped:tool-reconciliation-required', 'completed']);
        await expectReplayedOnce(p2, wire);
        expect(env.outbox).toHaveLength(1);
      }));

    it(`round ${round}: a Docker start dispatched but never issued is never started, and the goal never completes`, () =>
      withFlow(backend, async (env) => {
        const { scope } = env;
        const wire = new WireClient();
        const { proc: p1, pending } = await startToApproval(env, 'p1');
        p1.arm('docker-start-dispatched');
        await wire.read(
          await p1.route.post({ runId: RUN_ID, approvalResponses: approveAll(pending) }),
        );
        expect(p1.crashedAt()).toBe('docker-start-dispatched');
        expect(env.docker.facts(scope, DOCKER_OPERATION)).toMatchObject({
          containers: 1,
          starts: 0,
        });

        // The client comes back; the tool replays and reconnects to its
        // operation: whether the start ran is unknown, so it is not started.
        const p2 = await recoverProcess(p1, 'p2');
        await wire.read(p2.route.resume({ lastEventId: wire.cursor }));
        expect(await p2.operations.get(scope, DOCKER_OPERATION)).toMatchObject({
          state: 'needs-reconcile',
          error: { code: 'start_unconfirmed' },
        });
        expect(env.docker.facts(scope, DOCKER_OPERATION)).toMatchObject({ starts: 0 });
        // The run reports the failure and cannot verify an artifact: it stops.
        const stopped = (await p2.runs.load(RUN_ID))!;
        expect(stopped.result).toMatchObject({
          status: 'stopped',
          reason: 'verification-inconclusive',
        });
        expect(stopped.verification).toBe('inconclusive');
        expect(JSON.stringify(stopped.messages)).toContain(FINAL_FAILED);
        expect(runResults(wire)).toEqual(['stopped:verification-inconclusive']);

        // The supervisor's resume intent finds the stopped run: the goal waits for the host.
        await p2.supervisor.tick();
        const parked = (await p2.supervisor.get(scope, GOAL_ID))!;
        expect(parked.goal).toMatchObject({
          status: 'waiting',
          waiting: { note: 'run-stopped:verification-inconclusive' },
        });
        expect(parked.goal.results ?? []).toEqual([]);
        expect(await p2.supervisor.tick()).toMatchObject({ dispatched: 0 });

        // Past the settle time, reconcile fails the unconfirmed start, still without starting it.
        env.clock.advance(31_000);
        const report = await p2.runner.reconcile({ scope });
        expect(report.orphans).toEqual([]);
        expect(await p2.operations.get(scope, DOCKER_OPERATION)).toMatchObject({
          state: 'failed',
          error: { code: 'start_unconfirmed' },
        });
        expect(env.docker.facts(scope, DOCKER_OPERATION)).toMatchObject({ starts: 0 });
        expect((await p2.supervisor.get(scope, GOAL_ID))!.goal.status).toBe('waiting');
        expect(env.outbox).toHaveLength(1);
        await expectReplayedOnce(p2, wire);

        // The host gives up on tonight's report: the cancel is recorded, then applied.
        await p2.supervisor.command(scope, GOAL_ID, {
          type: 'cancel',
          reason: 'no report tonight',
        });
        expect(await p2.supervisor.tick()).toMatchObject({ cancelled: 1 });
        const cancelled = (await p2.supervisor.get(scope, GOAL_ID))!;
        expect(cancelled.goal.status).toBe('cancelled');
        expect(cancelled.runtime).toMatchObject({
          phase: 'done',
          cancel: { appliedAt: expect.any(Number) },
        });
        const spans = env.observer
          .events()
          .flatMap((event) => (event.type === 'operation.completed' ? [event.operation] : []));
        for (const name of [
          'deuz.goal.cancel_requested',
          'deuz.goal.cancel_applied',
          'deuz.process.reconcile',
        ])
          expect(spans).toContain(name);
      }));

    it(`round ${round}: a retried outage, a revised spec, a host drain and a stopped sandbox job end contained, with their spans`, () =>
      withFlow(backend, async (env) => {
        const { scope } = env;
        const p1 = openProcess(env, 'p1');
        await seedMemory(p1);
        await submitGoal(p1);
        await putSchedule(p1);
        env.clock.advance(OCCURRENCE_AT + 30_000 - env.clock.now());
        await p1.scheduler.tick();

        // The provider is down for the run's first model call: a transient
        // failure of the same run, which the supervisor retries after its wait.
        env.modelFaults.push(503);
        expect(await p1.supervisor.tick()).toMatchObject({ applied: 1, dispatched: 1 });
        expect(env.modelFaults).toEqual([]);
        expect((await p1.runs.load(RUN_ID))!).toMatchObject({
          result: { status: 'failed' },
          retry: { cause: 'model-call' },
        });
        const retrying = (await p1.supervisor.get(scope, GOAL_ID))!;
        expect(retrying.goal.status).toBe('active');
        expect(retrying.runtime).toMatchObject({ phase: 'retrying', retryAt: expect.any(Number) });
        env.clock.advance(retrying.runtime.retryAt! - env.clock.now());
        expect(await p1.supervisor.tick()).toMatchObject({ dispatched: 1 });
        const suspended = (await p1.runs.load(RUN_ID))!;
        expect(suspended.result?.status).toBe('suspended');
        const pending =
          suspended.result?.status === 'suspended' ? suspended.result.pendingApprovals : [];
        expect(pending).toHaveLength(1);
        // Only the retried leg reached the model: no step ran twice.
        expect(env.requests).toHaveLength(2);

        // A verifier changed while the run waits: the goal's next spec generation.
        await p1.supervisor.command(scope, GOAL_ID, { type: 'revise', nextSpecGeneration: true });
        expect((await p1.supervisor.get(scope, GOAL_ID))!.goal.specGeneration).toBe(2);

        // The reviewer approves through the supervisor; the sandbox job runs on.
        env.slowJob = true;
        await p1.supervisor.resume(scope, GOAL_ID, { approvalResponses: approveAll(pending) });
        const ticking = p1.supervisor.tick();
        await until(
          async () => (await p1.operations.get(scope, DOCKER_OPERATION))?.state === 'running',
          'the sandbox job to run',
        );
        // The host shuts down: the supervisor drains the working run, and the
        // host stops the sandbox job it no longer waits for.
        const draining = p1.supervisor.drain();
        const stopped = await p1.runner.cancel(scope, DOCKER_OPERATION);
        expect(stopped.state).toBe('cancelled');
        await draining;
        await ticking;
        expect(env.outbox).toHaveLength(1);
        expect(env.docker.facts(scope, DOCKER_OPERATION)).toMatchObject({
          containers: 1,
          starts: 1,
        });
        // No false completion. Whether the run heard the drain first (resumable)
        // or went on to the stopped job (inconclusive) depends on when its lease
        // renews; it never completes either way.
        const halted = (await p1.runs.load(RUN_ID))!;
        expect(halted.result?.status ?? 'drained').not.toBe('completed');
        const parked = (await p1.supervisor.get(scope, GOAL_ID))!;
        expect(parked.goal.status).not.toBe('completed');
        expect(parked.goal.results ?? []).toEqual([]);

        // The host gives up on tonight's report: recorded, then applied by the next host.
        const p2 = await recoverProcess(p1, 'p2');
        await p2.supervisor.command(scope, GOAL_ID, {
          type: 'cancel',
          reason: 'no report tonight',
        });
        for (let tick = 0; tick < 3; tick++) {
          if ((await p2.supervisor.get(scope, GOAL_ID))!.goal.status === 'cancelled') break;
          await p2.supervisor.tick();
        }
        const cancelled = (await p2.supervisor.get(scope, GOAL_ID))!;
        expect(cancelled.goal.status).toBe('cancelled');
        expect(cancelled.runtime).toMatchObject({
          phase: 'done',
          cancel: { appliedAt: expect.any(Number) },
        });
        expect(env.outbox).toHaveLength(1);
        expect(await p2.operations.get(scope, DOCKER_OPERATION)).toMatchObject({
          state: 'cancelled',
        });
        expect(env.docker.facts(scope, DOCKER_OPERATION)).toMatchObject({ starts: 1 });

        // The documented spans this flow passes through, with no content in
        // their attributes.
        const found = completedSpans(env);
        for (const name of [
          'deuz.goal.retry',
          'deuz.goal.generation',
          'deuz.goal.drain',
          'deuz.process.cancel',
          'deuz.goal.cancel_requested',
          'deuz.goal.cancel_applied',
        ])
          expect(found.get(name)?.length ?? 0, name).toBeGreaterThan(0);
        expect(found.get('deuz.goal.retry')![0]!.attributes).toMatchObject({
          'deuz.goal.id': GOAL_ID,
          'deuz.goal.run_id': RUN_ID,
          'deuz.goal.attempt': 2,
        });
        expect(found.get('deuz.goal.generation')![0]!.attributes).toMatchObject({
          'deuz.goal.id': GOAL_ID,
          'deuz.goal.spec_generation': 2,
        });
        expect(found.get('deuz.goal.drain')![0]!.attributes).toMatchObject({
          'deuz.goal.id': GOAL_ID,
          'deuz.goal.run_id': RUN_ID,
        });
        // A span's start carries what it is about, its end what came of it.
        expect(
          env.observer
            .events()
            .find(
              (event) =>
                event.type === 'operation.started' && event.operation === 'deuz.process.cancel',
            ),
        ).toMatchObject({ attributes: { 'deuz.process.operation_id': DOCKER_OPERATION } });
        expect(found.get('deuz.process.cancel')![0]!.attributes).toMatchObject({
          'deuz.process.state': 'cancelled',
        });
        const attributes = JSON.stringify(
          env.observer
            .events()
            .filter((event) => event.type.startsWith('operation.'))
            .map((event) => (event as { attributes?: unknown }).attributes ?? null),
        );
        for (const content of [SECRET_MARK, OTHER_MARK, REMEMBERED, CHANNEL_FACT, REPORT_CONTENT])
          expect(attributes).not.toContain(content);
      }));
  }
});
