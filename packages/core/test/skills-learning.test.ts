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
import { projectRun } from '../src/skills/learning/projection';
import { isSha256Digest, sha256Digest } from '../src/internal/digest';
import type { AgentRunEnvelope } from '../src/types/agent-run';
import {
  FINALIZE_PROMPT,
  SECRETS,
  draftJson,
  recordingModel,
  verifiedRun,
  verifiedRunV3,
  verifiedRunWithoutTranscript,
} from './fixtures/skill-runs';

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

describe('the source projection', () => {
  const leaked = (text: string) =>
    Object.entries(SECRETS)
      .filter(([, secret]) => text.includes(secret))
      .map(([name]) => name);

  it('keeps the task, the assistant text and the tool calls, as numbered items', async () => {
    const projection = await projectRun(verifiedRun());
    expect(projection.items.map((item) => [item.id, item.kind])).toEqual([
      ['S1', 'task'],
      ['S2', 'assistant'],
      ['S3', 'tool-call'],
      ['S4', 'tool-result'],
      ['S5', 'assistant'],
      ['S6', 'tool-call'],
      ['S7', 'tool-result'],
      ['S8', 'tool-call'],
      ['S9', 'tool-call'],
      ['S10', 'tool-result'],
      ['S11', 'tool-result'],
      ['S12', 'assistant'],
    ]);
    expect(projection.text).toContain(
      '[S1] task: Deploy the billing service to staging and confirm the health check.',
    );
    expect(projection.text).toContain(
      '[S6] tool call deploy (call_2): {"env":"staging","service":"billing","version":"1.4.3"}',
    );
    expect(projection.text).toContain(
      '[S12] assistant: Billing 1.4.3 is live on staging; the health check passed.',
    );
  });

  it('drops reasoning, provider metadata, system and SDK-internal turns and raw tool results', async () => {
    const projection = await projectRun(verifiedRun());
    expect(leaked(projection.text)).toEqual([]);
    expect(projection.text).toContain('[S4] tool result get_version (call_1): omitted');
    expect(projection.text).toContain('[S11] tool result page_oncall (call_4): error, omitted');
  });

  it('uses a host summary in place of a raw tool result', async () => {
    const projection = await projectRun(verifiedRun(), {
      toolSummaries: { call_3: 'Health check returned ok in 120 ms.' },
    });
    expect(projection.text).toContain(
      '[S10] tool result health_check (call_3): Health check returned ok in 120 ms.',
    );
    expect(leaked(projection.text)).toEqual([]);
  });

  it('without a transcript, drops the known SDK turns, summaries, compiler blocks and images', async () => {
    const projection = await projectRun(verifiedRunWithoutTranscript());
    expect(leaked(projection.text)).toEqual([]);
    expect(projection.text).not.toContain(FINALIZE_PROMPT);
    expect(projection.text).not.toContain('failed validation');
    expect(projection.text).not.toContain('The output was rejected');
    expect(projection.items[0]).toMatchObject({ kind: 'task', messageId: 'run-billing:2' });
  });

  it('projects a V3 envelope like its 2.3 counterpart', async () => {
    const v3 = await projectRun(verifiedRunV3());
    const v2 = await projectRun(verifiedRun());
    expect(v3.text).toBe(v2.text);
    expect(v3.digest).toBe(v2.digest);
  });

  it('cites each item by run, message, tool call, model step and digest', async () => {
    const projection = await projectRun(verifiedRun());
    const byId = new Map(projection.items.map((item) => [item.id, item]));
    expect(byId.get('S1')).toMatchObject({ messageId: 'run-billing:0' });
    expect(byId.get('S1')!.modelStep).toBeUndefined();
    expect(byId.get('S2')).toMatchObject({ messageId: 'run-billing:2', modelStep: 1 });
    expect(byId.get('S3')).toMatchObject({
      messageId: 'run-billing:2',
      toolCallId: 'call_1',
      modelStep: 1,
    });
    expect(byId.get('S10')).toMatchObject({
      messageId: 'run-billing:7',
      toolCallId: 'call_3',
      modelStep: 3,
    });
    for (const item of projection.items) {
      expect(isSha256Digest(item.digest)).toBe(true);
      expect(item.digest).toBe(await sha256Digest(item.content));
    }
    expect(projection.digest).toBe(await sha256Digest(projection.text));
  });

  it('counts as used only the tools whose calls returned without an error', async () => {
    const projection = await projectRun(verifiedRun());
    expect(projection.usedTools).toEqual(['deploy', 'get_version', 'health_check']);
  });

  it('refuses a projection over maxSourceChars before any model call, never cutting it', async () => {
    const { model, calls } = recordingModel([{ text: draftJson() }]);
    const { text } = await projectRun(verifiedRun());
    const error = await refusal(
      proposeSkillFromRun({
        run: verifiedRun(),
        model,
        budget: BUDGET,
        maxSourceChars: text.length - 1,
      }),
    );
    expect(error.code).toBe('source_too_large');
    expect(error.message).toContain(String(text.length));
    expect(calls()).toBe(0);
  });

  it('refuses the default 32 000 characters by default', async () => {
    const { model, calls } = recordingModel([{ text: draftJson() }]);
    const run = verifiedRun();
    run.transcript!.messages[0] = { role: 'user', content: 'x'.repeat(32_001) };
    const error = await refusal(proposeSkillFromRun({ run, model, budget: BUDGET }));
    expect(error.code).toBe('source_too_large');
    expect(calls()).toBe(0);
  });
});
