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
 *   artifact, and the goal never completes.
 *
 * Same stores, Docker and clients as composite-flow.test.ts; three rounds per
 * backend on clean stores, never retried.
 */
import { afterAll, describe, expect, it, vi } from 'vitest';
import {
  DOCKER_OPERATION,
  FINAL_FAILED,
  FINAL_OK,
  GOAL_ID,
  RUN_ID,
  WireClient,
  createFlowEnv,
  disposeFakeDocker,
  disposeFlowEnv,
  dockerHarness,
  flowBackends,
  recoverProcess,
  startToApproval,
  storedFrames,
  type FlowEnv,
  type HostProcess,
} from './harness';

vi.setConfig({ testTimeout: 600_000, hookTimeout: 120_000 });
afterAll(() => disposeFakeDocker());

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
      }));
  }
});
