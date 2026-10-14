/**
 * goal-evidence-2-4.test.ts (2.4, spec §3.5) — evidence binds to what it was
 * produced from: the criterion, the verifier (id and version), the artifact or
 * workspace digest and the goal's spec generation. Every field is optional and
 * additive: a 2.3 record reads as it did, and a 2.4 record keeps them through
 * parse, serialize and every transition.
 */
import { describe, expect, it } from 'vitest';
import { createGoal, parseGoal, serializeGoal, transitionGoal } from '../src/goal';
import type { GoalCommand, GoalEvidenceInput, GoalRecord } from '../src/goal';

const T0 = Date.parse('2026-10-10T10:00:00Z');
const DIGEST = `sha256:${'a'.repeat(64)}` as const;
const WORKSPACE = `sha256:${'b'.repeat(64)}` as const;

const bound: GoalEvidenceInput = {
  id: 'e1',
  source: 'verifier',
  ref: 'reports/junit.xml',
  digest: DIGEST,
  runId: 'run-1',
  criterionId: 'build',
  verifier: { id: 'junit', version: '1.2.0' },
  specGeneration: 1,
  artifactDigest: DIGEST,
};

function newGoal(extra: Partial<Parameters<typeof createGoal>[0]> = {}): GoalRecord {
  return createGoal(
    {
      goalId: 'g',
      scope: 'tenant',
      objective: 'Make the nightly build green.',
      criteria: [{ id: 'build', description: 'The nightly build passes.' }],
      ...extra,
    },
    { now: T0 },
  );
}

const apply = (record: GoalRecord, command: GoalCommand, now = T0 + 1) =>
  transitionGoal(record, command, { now });

describe('evidence bound to its source (2.4)', () => {
  it('records the criterion, verifier, digests and spec generation as given', () => {
    const goal = newGoal({ specGeneration: 1 });
    const next = apply(goal, {
      type: 'evidence',
      evidence: [bound, { id: 'e2', source: 'test', ref: 'ws', workspaceDigest: WORKSPACE }],
    }).record;
    expect(next.evidence[0]).toEqual({ ...bound, at: T0 + 1 });
    expect(next.evidence[1]).toMatchObject({ workspaceDigest: WORKSPACE });
    // Through the JSON text and back, unchanged.
    expect(parseGoal(serializeGoal(next))).toEqual(next);
  });

  it('stores the spec generation a goal opted into, and only then', () => {
    expect(newGoal({ specGeneration: 3 }).specGeneration).toBe(3);
    expect('specGeneration' in newGoal()).toBe(false);
    expect(parseGoal(serializeGoal(newGoal({ specGeneration: 1 }))).specGeneration).toBe(1);
  });

  it('refuses a malformed spec generation on a new goal or a stored record', () => {
    for (const specGeneration of [0, -1, 1.5, Number.NaN, '1'])
      expect(
        () => newGoal({ specGeneration: specGeneration as number }),
        String(specGeneration),
      ).toThrow(expect.objectContaining({ code: 'invalid_goal' }) as unknown as Error);
    expect(() => parseGoal({ ...newGoal(), specGeneration: 0 })).toThrow(
      expect.objectContaining({ code: 'invalid_goal' }) as unknown as Error,
    );
  });

  it('refuses malformed bound fields, in a command and in a stored record', () => {
    const goal = newGoal();
    const malformed: Record<string, unknown>[] = [
      { criterionId: '' },
      { verifier: { id: 'junit' } },
      { verifier: { id: '', version: '1' } },
      { verifier: 'junit@1' },
      { specGeneration: 0 },
      { specGeneration: 2.5 },
      { artifactDigest: 'sha256:abc' },
      { workspaceDigest: `sha256:${'A'.repeat(64)}` },
      { artifactDigest: 'md5:00' },
    ];
    for (const extra of malformed) {
      const evidence = { id: 'e', source: 'test', ref: 'r', ...extra };
      expect(
        () => apply(goal, { type: 'evidence', evidence: [evidence as GoalEvidenceInput] }),
        JSON.stringify(extra),
      ).toThrow(expect.objectContaining({ code: 'invalid_command' }) as unknown as Error);
      expect(() => parseGoal({ ...goal, evidence: [{ ...evidence, at: T0 }] })).toThrow(
        expect.objectContaining({ code: 'invalid_goal' }) as unknown as Error,
      );
    }
  });

  it('takes the same evidence again as a duplicate, and other bindings under its id as a conflict', () => {
    const goal = apply(newGoal(), { type: 'evidence', evidence: [bound] }).record;
    expect(apply(goal, { type: 'evidence', evidence: [bound] }, T0 + 2)).toMatchObject({
      changed: false,
      reason: 'unchanged',
    });
    for (const other of [
      { criterionId: 'docs' },
      { verifier: { id: 'junit', version: '1.3.0' } },
      { artifactDigest: `sha256:${'c'.repeat(64)}` as const },
      { specGeneration: 2 },
    ])
      expect(
        apply(goal, { type: 'evidence', evidence: [{ ...bound, ...other }] }, T0 + 2),
        JSON.stringify(other),
      ).toMatchObject({ outcome: 'rejected', reason: 'evidence-conflict' });
  });

  it('reads a 2.3 record, which carries none of the fields, as it was', () => {
    const goal = apply(newGoal(), {
      type: 'evidence',
      evidence: [{ id: 'ci', source: 'test', ref: 'ci/1' }],
    }).record;
    expect(goal.evidence).toEqual([{ id: 'ci', source: 'test', ref: 'ci/1', at: T0 + 1 }]);
    expect(parseGoal(JSON.parse(serializeGoal(goal)))).toEqual(goal);
  });
});
