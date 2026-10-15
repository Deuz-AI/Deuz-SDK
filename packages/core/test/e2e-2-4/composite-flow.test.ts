/**
 * The composite flow of spec §5.1, end to end, offline:
 *
 *   schedule → inbox → goal → V3 context/memory → approved tool and Docker
 *   step → host crash → recovery → UI replay → host verification → skill
 *   proposal
 *
 * on real stores (one SQLite file; the local Postgres, and Redis for the
 * stream, when DEUZ_TEST_POSTGRES_URL / DEUZ_TEST_REDIS_URL are set), with the
 * real Docker engine when DEUZ_TEST_DOCKER=1 (the pinned alpine image) and the
 * fake CLI otherwise. The host dies at the dangerous points — right after a
 * memory commit (before its acknowledgment), while the outcome of the Docker
 * start is recorded, and between the Docker step's effect and its receipt —
 * and each recovery is a fresh set of instances on the same persisted data.
 * An operator forgets a record while the host is down; the resumed run
 * recompiles the redacted package.
 *
 * Along the way it checks the zero-tolerance list of §5.1: no false
 * completion, no repeated external effect, no lost accepted command, no scope
 * leak, no stale-writer data loss; ambiguous outcomes end contained. The
 * documented §3.6 spans must be emitted with no content in their attributes.
 * Each scenario runs three times on clean stores, never retried.
 */
import { afterAll, describe, expect, it, vi } from 'vitest';
import { RevisionConflictError } from '../../src/errors';
import { parseSkill } from '../../src/skills';
import { proposeSkillFromRun } from '../../src/skills/learning';
import type { LeaseProvider } from '../../src/types/lease';
import type { ObserveEvent } from '../../src/types/observe';
import { toDeuzStreamResponse } from '../../src/ui';
import { manualResult, textPart } from '../fixtures/manual-stream';
import {
  CHANNEL_FACT,
  DOCKER_OPERATION,
  FINAL_OK,
  GOAL_ID,
  OCCURRENCE_AT,
  OTHER_FACT,
  OTHER_MARK,
  REMEMBERED,
  REPORT_CONTENT,
  RUN_ID,
  SCHEDULE_ID,
  SECRET_MARK,
  WireClient,
  createFlowEnv,
  disposeFakeDocker,
  disposeFlowEnv,
  dockerHarness,
  flowBackends,
  proposalModel,
  reportJobResult,
  requestText,
  runMainFlow,
  storedFrames,
  type FlowClient,
  type FlowEnv,
  type MainFlowFacts,
  type WireRequest,
} from './harness';
import { createMemorySession } from '../../src/memory/versioned';

vi.setConfig({ testTimeout: 600_000, hookTimeout: 120_000 });
afterAll(() => disposeFakeDocker());

/** What a 2.4 client lists in the capability handshake. */
const CLIENT_CAPABILITIES = 'chat-snapshot-v1, durable-stream, message-ids';

/** The flow's client at wire level: every frame recorded as it arrives, nothing deduplicated. */
function wireClient(): FlowClient & { wire: WireClient } {
  const wire = new WireClient();
  return {
    wire,
    async approve(proc, pending) {
      const response = await proc.route.post(
        {
          runId: RUN_ID,
          approvalResponses: pending.map((request) => ({
            approvalId: request.approvalId,
            approved: true,
          })),
        },
        { 'x-deuz-capabilities': CLIENT_CAPABILITIES },
      );
      await wire.read(response);
    },
    async reconnect(proc) {
      await wire.read(
        proc.route.resume({ lastEventId: wire.cursor, capabilities: CLIENT_CAPABILITIES }),
      );
    },
  };
}

/** The 2.4 spans (spec §3.6) a flow emitted, by name. */
function spans(
  env: FlowEnv,
): Map<string, Extract<ObserveEvent, { type: 'operation.completed' }>[]> {
  const found = new Map<string, Extract<ObserveEvent, { type: 'operation.completed' }>[]>();
  for (const event of env.observer.events())
    if (event.type === 'operation.completed' && event.operation.startsWith('deuz.')) {
      const list = found.get(event.operation) ?? [];
      list.push(event);
      found.set(event.operation, list);
    }
  return found;
}

/** Every span event's attributes, as one string: they must never carry content. */
function spanAttributes(env: FlowEnv): string {
  return JSON.stringify(
    env.observer
      .events()
      .filter((event) => event.type.startsWith('operation.'))
      .map((event) => (event as { attributes?: unknown }).attributes ?? null),
  );
}

async function assertMainFlow(env: FlowEnv, facts: MainFlowFacts, wire: WireClient) {
  const proc = facts.last;
  const { scope } = env;

  // --- every crash happened where it was armed -------------------------------
  expect(facts.crashes).toMatchObject({
    p1: 'memory-commit',
    p2: 'docker-start-outcome',
    p3: 'docker-artifact',
  });
  expect(facts.crashes.p4).toBeUndefined();

  // --- schedule → inbox: one occurrence, applied once, in the cursor's write --
  const occurrenceId = `${SCHEDULE_ID}@${OCCURRENCE_AT}`;
  expect(facts.scheduleTick.occurrences).toEqual([
    expect.objectContaining({ occurrenceId, disposition: 'delivered', goalId: GOAL_ID, scope }),
  ]);
  expect(facts.repeatTick.occurrences).toEqual([]);
  const inbox = await proc.goals.inbox.list({
    scope,
    goalId: GOAL_ID,
    dispositions: [
      'pending',
      'applied',
      'duplicate',
      'unmatched',
      'stale',
      'expired',
      'terminal',
      'cancelled',
    ],
  });
  // One entry ever, applied, with the start intent recorded in the same write.
  expect(inbox.entries).toEqual([
    expect.objectContaining({
      id: facts.scheduleTick.occurrences[0]!.inboxEntryId,
      deliveryId: occurrenceId,
      disposition: 'applied',
      intentId: expect.any(String),
    }),
  ]);
  expect(facts.firstTick).toMatchObject({ applied: 1, dispatched: 1 });
  expect(facts.recoveryTick).toMatchObject({ applied: 0, dispatched: 1 });

  // --- no lost accepted command: the verdict's resume intent ran, every intent ended
  const intents = await proc.goals.intents.list({
    scope,
    goalId: GOAL_ID,
    statuses: ['pending', 'claimed', 'launched', 'completed', 'failed', 'cancelled'],
  });
  expect(intents.intents.map((intent) => [intent.kind, intent.status])).toEqual([
    ['start', 'completed'],
    ['resume', 'completed'],
  ]);
  const [start, resume] = intents.intents;
  // The start intent was taken over after the crash, under a higher lease token.
  expect(start!.claim!.owner).toBe('p2');
  expect(resume).toMatchObject({
    runId: RUN_ID,
    approvalResponses: [{ approvalId: facts.pendingApprovals[0]!.approvalId, approved: true }],
    outcome: { status: 'completed' },
  });
  expect(facts.finalTick).toMatchObject({ dispatched: 1 });

  // --- no false completion: completed only once the host verified the artifact
  expect(facts.statusBeforeVerify).toBe('active');
  const supervised = (await proc.supervisor.get(scope, GOAL_ID))!;
  expect(supervised.goal).toMatchObject({ status: 'completed', runId: RUN_ID });
  expect(supervised.runtime.phase).toBe('done');
  const envelope = (await proc.runs.load(RUN_ID))!;
  const job = reportJobResult(envelope.messages)!;
  expect(job).toMatchObject({ ok: true, operationId: DOCKER_OPERATION, path: 'report.txt' });
  expect(supervised.goal.results).toEqual([
    expect.objectContaining({ criterionId: 'artifact', verdict: 'passed', source: 'verifier' }),
  ]);
  expect(supervised.goal.evidence).toEqual([
    expect.objectContaining({
      source: 'verifier',
      criterionId: 'artifact',
      runId: RUN_ID,
      artifactDigest: job.digest,
      verifier: { id: 'nightly-report-verifier', version: '1' },
      specGeneration: 1,
    }),
  ]);

  // --- the run: V3, completed and verified by its own verifier ----------------
  expect(envelope).toMatchObject({
    version: 3,
    phase: 'terminal',
    verification: 'verified',
    result: { status: 'completed', output: FINAL_OK },
  });
  expect(
    Object.values(envelope.toolResults ?? {})
      .map((receipt) => `${receipt.toolCallId}:${receipt.stage}`)
      .sort(),
  ).toEqual(['job-1:completed', 'mem-1:completed', 'pub-1:completed']);
  // The lost acknowledgment was settled from the memory receipt.
  expect(envelope.memoryIntents?.map((intent) => [intent.toolCallId, intent.status])).toEqual([
    ['mem-1', 'acknowledged'],
  ]);
  // One model call per step: none repeated a step whose answer was saved, and
  // the supervisor's final leg found a terminal run (no call at all).
  expect(env.requests).toHaveLength(4);

  // --- forget, then resume: the redacted package is recompiled ---------------
  expect(facts.forget).toMatchObject({ redaction: 'complete', operationId: 'forget-secret' });
  const steps = envelope.context!.steps;
  expect(steps[0]!.manifest).toMatchObject({ refresh: 'initial', redacted: true });
  expect(steps.at(-1)!.manifest).toMatchObject({ refresh: 'redacted', redacted: true });
  expect(requestText(env.requests[0]!)).toContain(SECRET_MARK);
  for (const request of env.requests.slice(facts.requestsBeforeForget))
    expect(requestText(request)).not.toContain(SECRET_MARK);
  expect(JSON.stringify(envelope.messages)).not.toContain(SECRET_MARK);
  expect(await proc.memory.history(facts.ids.secret)).toEqual([]);
  expect(await proc.memory.recall({ text: 'webhook token' })).toEqual([]);

  // --- no repeated external effect --------------------------------------------
  // The approved post landed once, by the process that ran it.
  expect(env.outbox).toEqual([
    expect.objectContaining({ channel: 'ops', toolCallId: 'pub-1', runId: RUN_ID, by: 'p2' }),
  ]);
  // The model's memory write committed once, although its acknowledgment was lost.
  const remembered = await proc.memory.recall({ text: REMEMBERED });
  const writes = remembered.filter((hit) => hit.record.text === REMEMBERED);
  expect(writes).toHaveLength(1);
  expect(writes[0]!.record).toMatchObject({ origin: 'inferred', revision: 1 });
  // seed ×2, the model's write, the forget: every operation applied once.
  expect(await proc.vmem.scopeRevision(env.memoryScope)).toBe(4);
  // The container was created and started once over three hosts.
  const container = env.docker.facts(scope, DOCKER_OPERATION);
  expect(container).toMatchObject({ containers: 1, starts: 1 });
  if (env.docker.kind === 'real') {
    expect(container.restartCount).toBe(0);
    expect(container.startedAt).toBe(facts.containerAfterStartCrash.startedAt);
  }
  expect(await proc.operations.get(scope, DOCKER_OPERATION)).toMatchObject({
    state: 'exited',
    exitCode: 0,
  });
  const artifact = await proc.runner.readArtifact(scope, DOCKER_OPERATION, 'report.txt');
  expect(new TextDecoder().decode(artifact.bytes)).toBe(REPORT_CONTENT);
  expect(artifact.digest).toBe(job.digest);

  // --- the UI replay: every committed frame reached the client exactly once ---
  expect(wire.endings).toEqual(['dropped', 'dropped', 'done']);
  const stored = await storedFrames(proc);
  const committed = stored.filter((record) => record.part.type !== 'done').map((r) => r.seq);
  const received = wire.frames.map((frame) => frame.id);
  expect(received).toEqual(committed);
  expect(new Set(received).size).toBe(received.length);
  // Three producers, one journal: the legs continue each other's seqs.
  expect(stored.at(-1)!.part.type).toBe('done');
  const results = wire.frames.filter((frame) => frame.part.type === 'tool-result');
  expect(results.map((frame) => frame.part.toolCallId)).toEqual(['pub-1', 'job-1']);
  const verdict = wire.frames.filter(
    (frame) =>
      frame.part.type === 'data-agent' &&
      (frame.part.payload as { kind?: string }).kind === 'result',
  );
  expect(verdict.map((frame) => (frame.part.payload as { status: string }).status)).toEqual([
    'completed',
  ]);
  // A durable response announces itself; a fail-closed leg ends with a redacted error.
  expect(wire.transient).toContainEqual({ type: 'capabilities', capabilities: ['durable-stream'] });
  const wireText = JSON.stringify(wire.frames);
  for (const hidden of [
    SECRET_MARK,
    OTHER_MARK,
    CHANNEL_FACT,
    '<deuz_context',
    'deuz_working_memory',
  ])
    expect(wireText).not.toContain(hidden);

  // --- no scope leak -------------------------------------------------------------
  for (const request of env.requests) expect(requestText(request)).not.toContain(OTHER_MARK);
  expect(await proc.supervisor.get(env.otherScope, GOAL_ID)).toBeUndefined();
  const other = (await proc.supervisor.get(env.otherScope, `${GOAL_ID}-other`))!;
  expect(other.goal).toMatchObject({ status: 'waiting', revision: 2 });
  expect(other.runtime).toMatchObject({ phase: 'idle', runs: 0 });
  const otherMemory = createMemorySession({ store: proc.vmem, scope: env.otherMemoryScope });
  expect((await otherMemory.history(facts.ids.other)).map((record) => record.text)).toEqual([
    OTHER_FACT,
  ]);
  expect(await proc.memory.recall({ text: 'escalation list' })).toEqual([]);

  // --- no stale-writer data loss: every stale write is refused, nothing changes
  const terminal = await proc.runs.load(RUN_ID);
  await expect(
    proc.runs.save({ ...facts.stale.envelope, revision: facts.stale.envelope.revision! + 1 }),
  ).rejects.toBeInstanceOf(RevisionConflictError);
  expect(await proc.runs.load(RUN_ID)).toEqual(terminal);
  const runtime = await proc.goals.runtime.get(scope, GOAL_ID);
  expect(
    (
      await proc.goals.runtime.save({
        ...facts.stale.runtime,
        revision: facts.stale.runtime.revision + 1,
        phase: 'running',
      })
    ).status,
  ).toBe('conflict');
  expect(await proc.goals.runtime.get(scope, GOAL_ID)).toEqual(runtime);
  expect(
    (
      await proc.operations.update(
        scope,
        DOCKER_OPERATION,
        { state: 'running' },
        { expectedRevision: facts.stale.operation.revision },
      )
    ).status,
  ).toBe('conflict');
  expect(await proc.operations.get(scope, DOCKER_OPERATION)).toMatchObject({ state: 'exited' });
  // The producer of leg B (lease token 2) writes after leg C's producer (token 3).
  const lastSeq = stored.at(-1)!.seq;
  expect(
    await proc.streams.commit({
      streamId: RUN_ID,
      token: 2,
      records: [{ seq: lastSeq + 1, part: { type: 'text-delta', text: 'stale' } as never }],
    }),
  ).toMatchObject({ status: 'fenced' });
  expect((await storedFrames(proc)).length).toBe(stored.length);
  // A stale producer still believing it holds token 2 opens a leg through the
  // serializer: the stream holds a higher token and the lease is not its own
  // any more, so it is refused (`deuz.stream.fenced`), its client gets only a
  // redacted error, and nothing reaches the journal.
  const zombie: LeaseProvider = {
    acquire: async (request) => ({
      key: request.key,
      owner: 'p3',
      token: 2,
      expiresAt: env.clock.now() + 30_000,
    }),
    renew: async () => ({ held: false }),
    release: async () => {},
    signal: async () => false,
  };
  const late = manualResult();
  late.push(textPart('stale words'));
  late.end();
  const zombieClient = new WireClient();
  await zombieClient.read(
    toDeuzStreamResponse(late.result, {
      streamId: RUN_ID,
      durable: { store: proc.streams, lease: { provider: zombie }, deps: proc.deps },
    }),
  );
  expect(zombieClient.frames).toEqual([]);
  expect(zombieClient.transient).toEqual([{ type: 'error', message: expect.any(String) }]);
  expect((await storedFrames(proc)).length).toBe(stored.length);

  // --- the documented spans, with no content in their attributes --------------
  const found = spans(env);
  for (const name of [
    'deuz.schedule.delivery',
    'deuz.goal.claim',
    'deuz.goal.dispatch',
    'deuz.context.compile',
    'deuz.memory.op',
    'deuz.process.start',
    'deuz.process.poll',
    'deuz.process.exit',
    'deuz.process.reconcile',
    'deuz.stream.batch',
    'deuz.stream.fenced',
  ])
    expect(found.get(name)?.length ?? 0, name).toBeGreaterThan(0);
  expect(facts.reconcile).toMatchObject({ orphans: [], lost: [], removed: [] });
  expect(facts.reconcile.matched.map((session) => [session.operationId, session.state])).toEqual([
    [DOCKER_OPERATION, 'exited'],
  ]);
  expect(found.get('deuz.schedule.delivery')![0]!.attributes).toMatchObject({
    'deuz.schedule.id': SCHEDULE_ID,
    'deuz.schedule.occurrence_id': occurrenceId,
  });
  const attributes = spanAttributes(env);
  for (const content of [SECRET_MARK, OTHER_MARK, REMEMBERED, CHANNEL_FACT, REPORT_CONTENT])
    expect(attributes).not.toContain(content);
}

async function assertSkillProposal(facts: MainFlowFacts) {
  const envelope = (await facts.last.runs.load(RUN_ID))!;
  const requests: WireRequest[] = [];
  const proposal = await proposeSkillFromRun({
    run: envelope,
    model: proposalModel(requests),
    budget: { tokens: 20_000 },
    toolSummaries: { 'job-1': 'The report artifact was built and its digest recorded.' },
    deps: facts.last.deps,
  });
  expect(proposal).toMatchObject({
    kind: 'deuz-skill-proposal',
    status: 'proposed',
    evaluation: 'not-evaluated',
    allowedTools: ['run_report_job'],
    source: { runId: RUN_ID, scope: facts.last.env.scope, revision: envelope.revision },
  });
  expect(parseSkill(proposal.skillMd).manifest.name).toBe('nightly-ops-report');
  for (const step of proposal.steps) {
    expect(step.sources.length).toBeGreaterThan(0);
    for (const source of step.sources) expect(source.runId).toBe(RUN_ID);
  }
  // One model call; the forgotten secret and the raw tool results never reach it.
  expect(requests).toHaveLength(1);
  const sent = requestText(requests[0]!);
  expect(sent).not.toContain(SECRET_MARK);
  expect(sent).not.toContain(REPORT_CONTENT);
  expect(sent).not.toContain('postId');
}

describe.each(flowBackends())('the composite flow (%s)', (backend) => {
  for (const round of [1, 2, 3])
    it(`round ${round}: recovers from three host crashes and verifies the goal on clean stores`, async () => {
      const docker = await dockerHarness();
      const env = await createFlowEnv(backend, docker);
      try {
        const client = wireClient();
        const facts = await runMainFlow(env, client);
        await assertMainFlow(env, facts, client.wire);
        await assertSkillProposal(facts);
      } finally {
        await disposeFlowEnv(env);
        await docker.dispose();
      }
    });
});
