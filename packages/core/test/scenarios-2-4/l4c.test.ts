/**
 * L4C acceptance scenarios (new.txt §3.5, §5.1 "Kabul kanıtı"): evidence bound
 * to its source, a spec generation change, and invalid evidence that never
 * completes a goal. Each scenario builds its own workspace, goal and store.
 */
import { expect } from 'vitest';
import {
  assessGoal,
  createGoal,
  createInMemoryGoalStore,
  parseGoal,
  serializeGoal,
  transitionGoal,
} from '../../src/goal';
import type { GoalCommand, GoalRecord } from '../../src/goal';
import { verifyGoalAcceptance } from '../../src/goal/runtime';
import type { GoalArtifactResolver, GoalVerifier } from '../../src/goal/runtime';
import { sha256Digest } from '../../src/internal/digest';
import { createInMemoryWorkspace, digestWorkspace } from '../../src/workspace';
import type { Workspace } from '../../src/workspace';
import { scenario } from './registry';

const T0 = Date.parse('2026-10-14T09:00:00Z');

/** The run's output: a report artifact and the source tree as a workspace. */
async function producedWorkspace(): Promise<Workspace> {
  const workspace = createInMemoryWorkspace();
  await workspace.write('reports/junit.xml', '<testsuite tests="12" failures="0"/>');
  await workspace.write('src/build.ts', 'export const fixed = true;\n');
  await workspace.write('CHANGELOG.md', '## 2.4.0\n- Fixed the nightly build.\n');
  return workspace;
}

/** Resolves `reports/*` as artifacts (file digest) and `src` as a workspace digest. */
function resolverFor(workspace: Workspace): GoalArtifactResolver {
  return {
    async resolve(ref) {
      if (ref === 'src')
        return {
          ref,
          kind: 'workspace',
          digest: await digestWorkspace(workspace, { include: ['src'] }),
        };
      if (!(await workspace.exists(ref))) return undefined;
      return { ref, kind: 'artifact', digest: await sha256Digest(await workspace.read(ref)) };
    },
  };
}

/** Host verifiers: JUnit has no failures; the source exports the fix. */
function verifiersFor(workspace: Workspace, version = '1.0.0'): Record<string, GoalVerifier> {
  return {
    tests: {
      id: 'junit',
      version,
      async verify() {
        const report = await workspace.read('reports/junit.xml');
        return /failures="0"/.test(report)
          ? { verdict: 'passed', summary: 'no failures' }
          : { verdict: 'failed', summary: 'failures' };
      },
    },
    fix: {
      id: 'source-check',
      version,
      async verify() {
        const source = await workspace.read('src/build.ts');
        return { verdict: source.includes('fixed = true') ? 'passed' : 'failed' };
      },
    },
  };
}

function newGoal(extra: Partial<Parameters<typeof createGoal>[0]> = {}): GoalRecord {
  return createGoal(
    {
      goalId: 'nightly',
      scope: 'tenant-a',
      objective: 'Make the nightly build green.',
      criteria: [
        { id: 'tests', description: 'The test suite passes.' },
        { id: 'fix', description: 'The fix is in the source.' },
      ],
      runId: 'run-1',
      specGeneration: 1,
      ...extra,
    },
    { now: T0 },
  );
}

const artifacts = { tests: { ref: 'reports/junit.xml' }, fix: { ref: 'src' } };

const apply = (goal: GoalRecord, command: GoalCommand, now: number) =>
  transitionGoal(goal, command, { now, expectedRevision: goal.revision });

scenario('acceptance', 'source-binding', async () => {
  const workspace = await producedWorkspace();
  const store = createInMemoryGoalStore();
  const goal = newGoal();
  await store.save(goal);
  const verification = await verifyGoalAcceptance({
    goal,
    verifiers: verifiersFor(workspace),
    artifacts,
    resolver: resolverFor(workspace),
    now: T0 + 1_000,
  });
  const judged = apply(goal, verification.command, T0 + 1_001);
  expect(judged.acceptance?.verdict).toBe('passed');
  await store.save(judged.record);
  const done = apply(judged.record, { type: 'complete' }, T0 + 1_002);
  expect(done.record.outcome?.reason).toBe('accepted');
  await store.save(done.record);

  // What the stored goal says about each verdict's source.
  const stored = parseGoal(serializeGoal((await store.load('nightly'))!));
  const tests = stored.evidence.find((item) => item.criterionId === 'tests')!;
  const fix = stored.evidence.find((item) => item.criterionId === 'fix')!;
  expect(tests).toMatchObject({
    source: 'verifier',
    ref: 'reports/junit.xml',
    runId: 'run-1',
    verifier: { id: 'junit', version: '1.0.0' },
    specGeneration: 1,
    artifactDigest: await sha256Digest('<testsuite tests="12" failures="0"/>'),
  });
  expect(fix).toMatchObject({
    runId: 'run-1',
    verifier: { id: 'source-check', version: '1.0.0' },
    workspaceDigest: await digestWorkspace(workspace, { include: ['src'] }),
  });
  expect(stored.results.map((result) => result.evidence)).toEqual([[tests.id], [fix.id]]);

  // The same outputs checked for another scope, goal or run are other evidence.
  for (const other of [
    newGoal({ scope: 'tenant-b' }),
    newGoal({ goalId: 'other' }),
    newGoal({ runId: 'run-2' }),
  ]) {
    const elsewhere = await verifyGoalAcceptance({
      goal: other,
      verifiers: verifiersFor(workspace),
      artifacts,
      resolver: resolverFor(workspace),
      now: T0 + 1_000,
    });
    expect(elsewhere.evidence.map((item) => item.id)).not.toContain(tests.id);
  }
});

scenario('acceptance', 'spec-generation-change', async () => {
  const workspace = await producedWorkspace();
  const resolver = resolverFor(workspace);
  let goal = newGoal({ budget: { usd: 5 } });
  const verifyAt = (record: GoalRecord, version: string, now: number) =>
    verifyGoalAcceptance({
      goal: record,
      verifiers: verifiersFor(workspace, version),
      artifacts,
      resolver,
      now,
    });

  // Generation 1 passes; a charge and maintenance leave it passed.
  const first = await verifyAt(goal, '1.0.0', T0 + 1);
  goal = apply(goal, first.command, T0 + 2).record;
  goal = apply(goal, { type: 'charge', usd: 1, tokens: 900, key: 'run-1' }, T0 + 3).record;
  goal = apply(goal, { type: 'revise', meta: { owner: 'ops' } }, T0 + 4).record;
  expect(assessGoal(goal).verdict).toBe('passed');

  // A verification computed now, applied after the change below, is stale.
  const early = await verifyAt(goal, '1.0.0', T0 + 5);

  // The host ships a new verifier version: generation 2.
  const changed = apply(goal, { type: 'revise', nextSpecGeneration: true }, T0 + 6);
  goal = changed.record;
  expect(goal.specGeneration).toBe(2);
  expect(goal.results.map((result) => result.verdict)).toEqual(['inconclusive', 'inconclusive']);
  expect(apply(goal, { type: 'complete' }, T0 + 7)).toMatchObject({
    outcome: 'rejected',
    reason: 'acceptance-not-passed',
  });
  const stale = apply(goal, early.command, T0 + 8);
  expect(stale.acceptance?.verdict).toBe('inconclusive');

  // Verified again against generation 2, it completes.
  const second = await verifyAt(goal, '2.0.0', T0 + 9);
  expect(second.evidence.every((item) => item.specGeneration === 2)).toBe(true);
  goal = apply(goal, second.command, T0 + 10).record;
  expect(apply(goal, { type: 'complete' }, T0 + 11).record.status).toBe('completed');

  // A goal without spec generations keeps the 2.3 rules: a new objective keeps verdicts.
  let legacy = newGoal({ specGeneration: undefined });
  legacy = apply(legacy, (await verifyAt(legacy, '1.0.0', T0 + 1)).command, T0 + 2).record;
  legacy = apply(legacy, { type: 'revise', objective: 'Ship 2.4.' }, T0 + 3).record;
  expect(assessGoal(legacy).verdict).toBe('passed');
  expect(legacy).not.toHaveProperty('specGeneration');
});

scenario('acceptance', 'invalid-evidence-rejected', async () => {
  const workspace = await producedWorkspace();
  const resolver = resolverFor(workspace);
  let goal = newGoal();
  let now = T0;
  const step = (command: GoalCommand) => {
    const next = apply(goal, command, ++now);
    goal = next.record;
    return next;
  };

  // The model's claim, however confident, is no evidence.
  step({
    type: 'evaluate',
    evidence: [{ id: 'claim', source: 'model', ref: 'transcript', runId: 'run-1' }],
    results: [
      { criterionId: 'tests', verdict: 'passed', source: 'model', evidence: ['claim'] },
      { criterionId: 'fix', verdict: 'passed', source: 'verifier', evidence: ['claim'] },
    ],
  });
  expect(assessGoal(goal).verdict).toBe('inconclusive');

  // Evidence for another criterion, or of another generation, supports nothing here.
  step({
    type: 'evaluate',
    evidence: [
      { id: 'lint', source: 'tool', ref: 'lint.txt', criterionId: 'style' },
      { id: 'old', source: 'test', ref: 'ci/0', specGeneration: 7 },
    ],
    results: [
      { criterionId: 'tests', verdict: 'passed', source: 'test', evidence: ['old'] },
      { criterionId: 'fix', verdict: 'passed', source: 'tool', evidence: ['lint'] },
    ],
  });
  expect(goal.results.map((result) => result.verdict)).toEqual(['inconclusive', 'inconclusive']);

  // Malformed evidence is refused outright.
  expect(() =>
    step({
      type: 'evidence',
      evidence: [{ id: 'bad', source: 'tool', ref: 'x', artifactDigest: 'sha256:1234' as never }],
    }),
  ).toThrow(expect.objectContaining({ code: 'invalid_command' }) as unknown as Error);

  // The run recorded the report it produced; then the report was rewritten.
  const produced = await sha256Digest(await workspace.read('reports/junit.xml'));
  step({
    type: 'evidence',
    evidence: [
      {
        id: 'produced',
        source: 'tool',
        ref: 'reports/junit.xml',
        runId: 'run-1',
        artifactDigest: produced,
      },
    ],
  });
  await workspace.write('reports/junit.xml', '<testsuite tests="12" failures="0"/><!-- edited -->');
  const tampered = await verifyGoalAcceptance({
    goal,
    verifiers: verifiersFor(workspace),
    artifacts: { ...artifacts, fix: { ref: 'src', expectedDigest: `sha256:${'0'.repeat(64)}` } },
    resolver,
    now: ++now,
  });
  expect(tampered.results.map((result) => [result.verdict, result.evidence])).toEqual([
    ['inconclusive', []],
    ['inconclusive', []],
  ]);
  expect(step(tampered.command).acceptance?.verdict).toBe('inconclusive');
  expect(step({ type: 'complete' })).toMatchObject({ outcome: 'rejected' });

  // Restored to what the run produced, the outputs verify and the goal completes.
  await workspace.write('reports/junit.xml', '<testsuite tests="12" failures="0"/>');
  const valid = await verifyGoalAcceptance({
    goal,
    verifiers: verifiersFor(workspace),
    artifacts,
    resolver,
    now: ++now,
  });
  expect(step(valid.command).acceptance?.verdict).toBe('passed');
  expect(step({ type: 'complete' }).record.status).toBe('completed');
});
