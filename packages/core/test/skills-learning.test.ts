/**
 * `proposeSkillFromRun` (2.4, spec §2.6): a sourced, inert SKILL.md draft
 * from one terminal, completed and verified run, through one budgeted model
 * call over a filtered projection of its transcript.
 */
import { describe, expect, it } from 'vitest';
import {
  proposeSkillFromRun,
  SkillLearningError,
  type ProposeSkillFromRunOptions,
} from '../src/skills/learning';
import type { AgentRunEnvelope } from '../src/types/agent-run';
import { draftJson, recordingModel, verifiedRun } from './fixtures/skill-runs';

const BUDGET = { tokens: 50_000 } as const;

async function refusal(promise: Promise<unknown>): Promise<SkillLearningError> {
  const error = await promise.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(SkillLearningError);
  return error as SkillLearningError;
}

describe('proposeSkillFromRun: the source run', () => {
  const ineligible: [string, (run: AgentRunEnvelope) => AgentRunEnvelope][] = [
    ['still running', (run) => ({ ...run, phase: 'running' })],
    ['finalizing', (run) => ({ ...run, phase: 'finalizing' })],
    [
      'failed',
      (run) => ({
        ...run,
        result: { ...run.result!, status: 'failed', error: { name: 'Error', message: 'x' } },
      }),
    ],
    [
      'stopped',
      (run) => ({ ...run, result: { ...run.result!, status: 'stopped', reason: 'max-steps' } }),
    ],
    ['without a result', (run) => ({ ...run, result: undefined })],
    ['never verified', (run) => ({ ...run, verification: undefined })],
    ['rejected by its verifier', (run) => ({ ...run, verification: 'rejected' })],
    ['inconclusive', (run) => ({ ...run, verification: 'inconclusive' })],
  ];

  it.each(ineligible)('refuses a run that is %s, before any model call', async (_, change) => {
    const { model, calls } = recordingModel([{ text: draftJson() }]);
    const error = await refusal(
      proposeSkillFromRun({ run: change(verifiedRun()), model, budget: BUDGET }),
    );
    expect(error.code).toBe('source_not_eligible');
    expect(calls()).toBe(0);
  });
});

describe('proposeSkillFromRun: options', () => {
  const base = (): ProposeSkillFromRunOptions => ({
    run: verifiedRun(),
    model: recordingModel([{ text: draftJson() }]).model,
    budget: BUDGET,
  });

  it.each<[string, Partial<ProposeSkillFromRunOptions>]>([
    ['no budget', { budget: undefined as never }],
    ['a budget without a bound', { budget: {} }],
    ['a negative token bound', { budget: { tokens: -1 } }],
    ['a non-finite usd bound', { budget: { usd: Number.NaN } }],
    ['a zero maxOutputTokens', { maxOutputTokens: 0 }],
    ['a fractional maxOutputTokens', { maxOutputTokens: 1.5 }],
    ['a zero maxSourceChars', { maxSourceChars: 0 }],
    ['a run that is no native run', { run: { kind: 'other' } as never }],
  ])('rejects %s with a TypeError', async (_, change) => {
    await expect(proposeSkillFromRun({ ...base(), ...change })).rejects.toBeInstanceOf(TypeError);
  });
});
