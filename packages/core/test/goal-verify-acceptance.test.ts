/**
 * goal-verify-acceptance.test.ts (2.4, spec §3.5) — `verifyGoalAcceptance`
 * runs the host's verifiers against the artifacts or workspace a run left and
 * returns the `evaluate` command for `transitionGoal`. Its evidence binds the
 * scope, goal, criterion, producing run, digest, verifier id and version and
 * spec generation; anything missing, changed or mismatched gives
 * `'inconclusive'`, never `'passed'`. Remembered facts and model claims are
 * never evidence by themselves.
 */
import { describe, expect, it } from 'vitest';
import { assessGoal, createGoal, transitionGoal } from '../src/goal';
import type { GoalCriterion, GoalRecord } from '../src/goal';
import { verifyGoalAcceptance } from '../src/goal/runtime';
import type {
  GoalArtifactResolver,
  GoalVerifier,
  ResolvedGoalArtifact,
  VerifyGoalAcceptanceInput,
} from '../src/goal/runtime';
import { sha256Digest, type Sha256Digest } from '../src/internal/digest';

const T0 = Date.parse('2026-10-10T10:00:00Z');

function newGoal(extra: Partial<Parameters<typeof createGoal>[0]> = {}): GoalRecord {
  return createGoal(
    {
      goalId: 'g',
      scope: 'tenant',
      objective: 'Make the nightly build green.',
      criteria: [
        { id: 'build', description: 'The nightly build passes.' },
        { id: 'docs', description: 'The fix is documented.' },
        { id: 'style', description: 'Lint is clean.', required: false },
      ],
      runId: 'run-1',
      specGeneration: 1,
      ...extra,
    },
    { now: T0 },
  );
}

/** A resolver over a mutable map of ref → content; `kind` per ref. */
function resolverOver(
  files: Map<string, string>,
  kinds: Record<string, 'artifact' | 'workspace'> = {},
): GoalArtifactResolver & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async resolve(ref) {
      calls.push(ref);
      const content = files.get(ref);
      if (content === undefined) return undefined;
      return { ref, kind: kinds[ref] ?? 'artifact', digest: await sha256Digest(content) };
    },
  };
}

/** A verifier passing when the artifact's content digest is `good`. */
function verifierFor(
  id: string,
  good: Sha256Digest,
  seen: { criterion: GoalCriterion; artifact?: ResolvedGoalArtifact; runId?: string }[] = [],
): GoalVerifier {
  return {
    id,
    version: '1.0.0',
    async verify({ criterion, artifact, runId }) {
      seen.push({ criterion, ...(artifact ? { artifact } : {}), ...(runId ? { runId } : {}) });
      return artifact?.digest === good
        ? { verdict: 'passed', summary: `${criterion.id} ok` }
        : { verdict: 'failed', summary: `${criterion.id} broken` };
    },
  };
}

async function setup() {
  const files = new Map([
    ['reports/junit.xml', '<testsuite failures="0"/>'],
    ['docs/CHANGELOG.md', '## Fixed the build'],
  ]);
  const resolver = resolverOver(files, { 'docs/CHANGELOG.md': 'workspace' });
  const junit = await sha256Digest('<testsuite failures="0"/>');
  const changelog = await sha256Digest('## Fixed the build');
  const input: VerifyGoalAcceptanceInput = {
    goal: newGoal(),
    verifiers: {
      build: verifierFor('junit', junit),
      docs: verifierFor('changelog', changelog),
    },
    artifacts: {
      build: { ref: 'reports/junit.xml' },
      docs: { ref: 'docs/CHANGELOG.md' },
    },
    resolver,
    now: T0 + 10,
  };
  return { files, resolver, junit, changelog, input };
}

describe('verifyGoalAcceptance', () => {
  it('binds each verdict to its source and completes the goal through evaluate', async () => {
    const { input, junit, changelog } = await setup();
    const verification = await verifyGoalAcceptance(input);
    expect(verification.command).toEqual({
      type: 'evaluate',
      results: verification.results,
      evidence: verification.evidence,
    });
    // Every required criterion by default; the optional one is left alone.
    expect(verification.results.map((result) => result.criterionId)).toEqual(['build', 'docs']);
    const [build, docs] = verification.evidence;
    expect(build).toMatchObject({
      source: 'verifier',
      ref: 'reports/junit.xml',
      digest: junit,
      artifactDigest: junit,
      criterionId: 'build',
      runId: 'run-1',
      verifier: { id: 'junit', version: '1.0.0' },
      specGeneration: 1,
      summary: 'build ok',
      at: T0 + 10,
    });
    expect(build).not.toHaveProperty('workspaceDigest');
    expect(docs).toMatchObject({ workspaceDigest: changelog, digest: changelog });
    expect(docs).not.toHaveProperty('artifactDigest');
    expect(verification.results[0]).toEqual({
      criterionId: 'build',
      verdict: 'passed',
      source: 'verifier',
      evidence: [build!.id],
      at: T0 + 10,
    });

    const judged = transitionGoal(input.goal, verification.command, { now: T0 + 11 });
    expect(judged.acceptance?.verdict).toBe('passed');
    expect(
      transitionGoal(judged.record, { type: 'complete' }, { now: T0 + 12 }).record.status,
    ).toBe('completed');
  });

  it('derives the evidence id from what it binds, so verifying again changes nothing', async () => {
    const { input } = await setup();
    const first = await verifyGoalAcceptance(input);
    const again = await verifyGoalAcceptance({ ...input, now: T0 + 50 });
    expect(again.evidence.map((item) => item.id)).toEqual(first.evidence.map((item) => item.id));
    expect(first.evidence[0]!.id).toMatch(/^acceptance:[0-9a-f]{64}$/);
    const judged = transitionGoal(input.goal, first.command, { now: T0 + 11 }).record;
    expect(transitionGoal(judged, again.command, { now: T0 + 51 }).record.evidence).toHaveLength(2);
    // Another scope, goal, run or generation gives other evidence.
    for (const goal of [
      newGoal({ scope: 'other' }),
      newGoal({ goalId: 'g2' }),
      newGoal({ runId: 'run-2' }),
      newGoal({ specGeneration: 2 }),
    ]) {
      const other = await verifyGoalAcceptance({ ...input, goal });
      expect(other.evidence[0]!.id).not.toBe(first.evidence[0]!.id);
    }
  });

  it('records a failed verdict on its evidence', async () => {
    const { input, files } = await setup();
    files.set('reports/junit.xml', '<testsuite failures="3"/>');
    const verification = await verifyGoalAcceptance(input);
    expect(verification.results[0]).toMatchObject({
      verdict: 'failed',
      evidence: [expect.any(String)],
    });
    const judged = transitionGoal(input.goal, verification.command, { now: T0 + 11 });
    expect(judged.acceptance?.verdict).toBe('failed');
  });

  it('checks only the criteria asked for, and refuses one the goal does not have', async () => {
    const { input } = await setup();
    const only = await verifyGoalAcceptance({ ...input, criteria: ['docs', 'docs'] });
    expect(only.results.map((result) => result.criterionId)).toEqual(['docs']);
    await expect(verifyGoalAcceptance({ ...input, criteria: ['nope'] })).rejects.toMatchObject({
      code: 'invalid_command',
    });
  });

  it('chooses verifiers through a function', async () => {
    const { input, junit } = await setup();
    const verification = await verifyGoalAcceptance({
      ...input,
      criteria: ['build'],
      verifiers: (criterion) =>
        criterion.id === 'build' ? verifierFor('junit', junit) : undefined,
    });
    expect(verification.results[0]!.verdict).toBe('passed');
  });

  it('hands the verifier the goal, the criterion, the resolved artifact and the run', async () => {
    const { input, junit } = await setup();
    const seen: Parameters<typeof verifierFor>[2] = [];
    await verifyGoalAcceptance({
      ...input,
      criteria: ['build'],
      runId: 'run-7',
      verifiers: { build: verifierFor('junit', junit, seen) },
    });
    expect(seen).toEqual([
      {
        criterion: input.goal.criteria[0],
        artifact: { ref: 'reports/junit.xml', kind: 'artifact', digest: junit },
        runId: 'run-7',
      },
    ]);
  });

  describe('gives inconclusive, never passed, and no evidence', () => {
    const inconclusive = async (
      change: (
        input: VerifyGoalAcceptanceInput,
        files: Map<string, string>,
      ) => VerifyGoalAcceptanceInput,
      note: RegExp,
    ) => {
      const { input, files } = await setup();
      const verification = await verifyGoalAcceptance(change(input, files));
      const build = verification.results.find((result) => result.criterionId === 'build')!;
      expect(build).toMatchObject({ verdict: 'inconclusive', source: 'verifier', evidence: [] });
      expect(build.note).toMatch(note);
      expect(verification.evidence.filter((item) => item.criterionId === 'build')).toEqual([]);
      const judged = transitionGoal(input.goal, verification.command, { now: T0 + 11 });
      expect(judged.acceptance?.verdict).toBe('inconclusive');
    };

    it('without a verifier for the criterion', () =>
      inconclusive(
        (input) => ({
          ...input,
          verifiers: { docs: (input.verifiers as Record<string, GoalVerifier>).docs! },
        }),
        /verifier/,
      ));

    it('for a verifier without an id or a version', () =>
      inconclusive(
        (input) => ({
          ...input,
          verifiers: {
            ...input.verifiers,
            build: { id: 'junit', version: '', verify: async () => ({ verdict: 'passed' }) },
          },
        }),
        /verifier/,
      ));

    it('without an artifact to check', () =>
      inconclusive(
        (input) => ({ ...input, artifacts: { docs: { ref: 'docs/CHANGELOG.md' } } }),
        /artifact/,
      ));

    it('without a resolver', () =>
      inconclusive(({ resolver: _resolver, ...input }) => input, /resolver/));

    it('without a producing run', () =>
      inconclusive((input) => {
        const { runId: _runId, ...goal } = input.goal;
        return { ...input, goal };
      }, /run/));

    it('when the artifact is missing', () =>
      inconclusive((input, files) => {
        files.delete('reports/junit.xml');
        return input;
      }, /not found/));

    it('when the resolver throws', () =>
      inconclusive(
        (input) => ({
          ...input,
          resolver: {
            resolve: async (ref) => {
              if (ref === 'reports/junit.xml') throw new Error('disk gone');
              return input.resolver!.resolve(ref);
            },
          },
        }),
        /could not be resolved/,
      ));

    it('when the resolver returns something that is not a digest', () =>
      inconclusive(
        (input) => ({
          ...input,
          resolver: {
            resolve: async (ref) => ({ ref, kind: 'artifact', digest: 'md5:abc' as Sha256Digest }),
          },
        }),
        /malformed/,
      ));

    it('when the digest differs from the expected one', () =>
      inconclusive(
        (input) => ({
          ...input,
          artifacts: {
            ...input.artifacts,
            build: { ref: 'reports/junit.xml', expectedDigest: `sha256:${'0'.repeat(64)}` },
          },
        }),
        /changed/,
      ));

    it('when the artifact changed since the run recorded it', () =>
      inconclusive(
        (input) => ({
          ...input,
          goal: transitionGoal(
            input.goal,
            {
              type: 'evidence',
              evidence: [
                {
                  id: 'produced',
                  source: 'tool',
                  ref: 'reports/junit.xml',
                  runId: 'run-1',
                  artifactDigest: `sha256:${'1'.repeat(64)}`,
                },
              ],
            },
            { now: T0 + 1 },
          ).record,
        }),
        /changed/,
      ));

    it('when the artifact changes while it is verified', () =>
      inconclusive((input, files) => {
        const build = (input.verifiers as Record<string, GoalVerifier>).build!;
        return {
          ...input,
          verifiers: {
            ...input.verifiers,
            build: {
              ...build,
              async verify(args) {
                const verdict = await build.verify(args);
                files.set('reports/junit.xml', 'rewritten');
                return verdict;
              },
            },
          },
        };
      }, /changed while/));

    it('when the verifier throws', () =>
      inconclusive(
        (input) => ({
          ...input,
          verifiers: {
            ...input.verifiers,
            build: {
              id: 'junit',
              version: '1',
              verify: async () => Promise.reject(new Error('boom')),
            },
          },
        }),
        /failed/,
      ));

    it('when the verifier answers with something that is not a verdict', () =>
      inconclusive(
        (input) => ({
          ...input,
          verifiers: {
            ...input.verifiers,
            build: { id: 'junit', version: '1', verify: async () => ({ verdict: 'yes' }) as never },
          },
        }),
        /verdict/,
      ));
  });

  it('never takes the model or remembered facts as evidence', async () => {
    const { input } = await setup();
    // The goal holds the model's own claim of a pass on the artifact.
    const claimed = transitionGoal(
      input.goal,
      {
        type: 'evaluate',
        evidence: [
          {
            id: 'says',
            source: 'model',
            ref: 'reports/junit.xml',
            runId: 'run-1',
            artifactDigest: `sha256:${'9'.repeat(64)}`,
          },
        ],
        results: [{ criterionId: 'build', verdict: 'passed', source: 'model', evidence: ['says'] }],
      },
      { now: T0 + 1 },
    ).record;
    expect(assessGoal(claimed).verdict).toBe('inconclusive');
    // Without a verifier the claim stays a claim.
    const unverified = await verifyGoalAcceptance({ ...input, goal: claimed, verifiers: {} });
    expect(unverified.results.every((result) => result.verdict === 'inconclusive')).toBe(true);
    // Its digest is not what the run produced: the verifier still checks the real artifact.
    const verified = await verifyGoalAcceptance({ ...input, goal: claimed });
    expect(verified.results[0]!.verdict).toBe('passed');
  });

  it('records no spec generation for a goal without one', async () => {
    const { input } = await setup();
    const verification = await verifyGoalAcceptance({
      ...input,
      goal: newGoal({ specGeneration: undefined }),
    });
    expect(verification.evidence[0]).not.toHaveProperty('specGeneration');
  });

  it('rejects when aborted, and refuses malformed input', async () => {
    const { input } = await setup();
    const controller = new AbortController();
    controller.abort(new Error('stop'));
    await expect(verifyGoalAcceptance({ ...input, signal: controller.signal })).rejects.toThrow(
      'stop',
    );
    await expect(verifyGoalAcceptance({ ...input, now: Number.NaN })).rejects.toMatchObject({
      code: 'invalid_command',
    });
    await expect(verifyGoalAcceptance({ ...input, goal: {} as GoalRecord })).rejects.toMatchObject({
      code: 'invalid_goal',
    });
    await expect(verifyGoalAcceptance({ ...input, verifiers: 'junit' as never })).rejects.toThrow(
      TypeError,
    );
    await expect(
      verifyGoalAcceptance({
        ...input,
        artifacts: { build: { ref: 'x', expectedDigest: 'sha256:short' as Sha256Digest } },
      }),
    ).rejects.toThrow(TypeError);
  });
});
