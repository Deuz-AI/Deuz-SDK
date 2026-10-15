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
import { parseSkill } from '../src/skills';
import { createPriceProvider } from '../src/pricing';
import { readConfig } from '../src/internal/config-symbol';
import { isSha256Digest, sha256Digest } from '../src/internal/digest';
import type { AgentRunEnvelope } from '../src/types/agent-run';
import type { Message } from '../src/types/message';
import { createInMemoryAgentRunStore, runAgent } from '../src/agent-run';
import { createInMemoryChatStore } from '../src/chat';
import { createMockModel } from '../src/testing';
import { tool } from '../src/tool';
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

describe('proposeSkillFromRun: the draft', () => {
  const clock = { now: () => 1_700_000_000_000, setTimeout: () => () => {} };

  it('drafts a sourced, inert SKILL.md that passes parseSkill', async () => {
    const { model, calls } = recordingModel([{ text: draftJson() }]);
    const run = verifiedRun();
    const projection = await projectRun(run);
    const proposal = await proposeSkillFromRun({ run, model, budget: BUDGET, deps: { clock } });

    expect(calls()).toBe(1);
    expect(proposal).toMatchObject({
      kind: 'deuz-skill-proposal',
      version: 1,
      status: 'proposed',
      evaluation: 'not-evaluated',
      allowedTools: ['get_version', 'deploy', 'health_check'],
      source: { runId: 'run-billing', scope: 'tenant-a', revision: 7, digest: projection.digest },
      createdAt: clock.now(),
    });
    const parsed = parseSkill(proposal.skillMd);
    expect(parsed.issues).toEqual([]);
    expect(proposal.manifest).toEqual(parsed.manifest);
    expect(parsed.manifest).toMatchObject({
      name: 'staging-deploy-check',
      description:
        'Deploys a service to staging and confirms its health check. Use when a service must be promoted to staging safely.',
      allowedTools: ['get_version', 'deploy', 'health_check'],
      metadata: {
        'deuz-status': 'proposed',
        'deuz-evaluation': 'not-evaluated',
        'deuz-source-digest': projection.digest,
      },
    });
    expect(parsed.manifest.body).toContain(
      '1. Read the version currently deployed. (sources: S2, S3)',
    );
    expect(parsed.manifest.body).toContain('- Shown for one service only.');
    expect(proposal.steps.map((step) => step.text)).toEqual([
      'Read the version currently deployed.',
      'Deploy the next version to staging.',
      'Run the health check and report the version.',
    ]);
    expect(proposal.limitations).toEqual([
      'Shown for one service only.',
      'Proposed from one verified run (run-billing); the skill itself has not been evaluated.',
    ]);
  });

  it('sends the projection in one request, never the raw transcript', async () => {
    const { model, requests } = recordingModel([{ text: draftJson() }]);
    await proposeSkillFromRun({ run: verifiedRun(), model, budget: BUDGET });
    const [body, ...more] = requests();
    expect(more).toEqual([]);
    const wire = JSON.stringify(body);
    expect(Object.values(SECRETS).filter((secret) => wire.includes(secret))).toEqual([]);
    expect(wire).toContain('[S1] task: Deploy the billing service');
    expect(body).not.toHaveProperty('tools');
    expect(body!.max_tokens ?? body!.max_completion_tokens).toBe(2048);
  });

  it('honours maxOutputTokens and the host instructions', async () => {
    const { model, requests } = recordingModel([{ text: draftJson() }]);
    await proposeSkillFromRun({
      run: verifiedRun(),
      model,
      budget: BUDGET,
      maxOutputTokens: 512,
      instructions: 'Name the skill after the service family.',
    });
    const [body] = requests();
    expect(body!.max_tokens ?? body!.max_completion_tokens).toBe(512);
    expect(JSON.stringify(body)).toContain('Name the skill after the service family.');
  });

  it('accounts its call apart from the source run, priced when the model has a price', async () => {
    const { model } = recordingModel([
      { text: draftJson(), usage: { inputTokens: 1000, outputTokens: 200 } },
    ]);
    const run = verifiedRun();
    const before = structuredClone(run);
    const priceProvider = createPriceProvider({ table: { 'mock-model': { input: 1, output: 2 } } });
    const proposal = await proposeSkillFromRun({
      run,
      model,
      budget: { tokens: 50_000, usd: 1 },
      deps: { priceProvider },
    });
    expect(proposal.cost).toEqual({
      modelId: 'mock-model',
      usage: expect.objectContaining({ inputTokens: 1000, outputTokens: 200, totalTokens: 1200 }),
      costUsd: 0.0014,
    });
    expect(run).toEqual(before);
  });

  it('leaves costUsd out for a model without a price', async () => {
    const { model } = recordingModel([{ text: draftJson() }]);
    const proposal = await proposeSkillFromRun({ run: verifiedRun(), model, budget: BUDGET });
    expect(proposal.cost.modelId).toBe('mock-model');
    expect(proposal.cost).not.toHaveProperty('costUsd');
  });

  it('refuses a call its budget cannot admit, before any request', async () => {
    const { model, calls } = recordingModel([{ text: draftJson() }]);
    await expect(
      proposeSkillFromRun({ run: verifiedRun(), model, budget: { tokens: 100 } }),
    ).rejects.toMatchObject({ code: 'budget_exceeded' });
    expect(calls()).toBe(0);
  });

  it('makes exactly one attempt: a failing call is not retried', async () => {
    const { model } = recordingModel([{ text: draftJson() }]);
    let attempts = 0;
    readConfig(model)!.fetch = (async () => {
      attempts += 1;
      return new Response('{"error":{"message":"overloaded"}}', { status: 529 });
    }) as typeof fetch;
    await expect(
      proposeSkillFromRun({ run: verifiedRun(), model, budget: BUDGET }),
    ).rejects.toBeInstanceOf(Error);
    expect(attempts).toBe(1);
  });

  it('works on a frozen run and changes nothing: no file, no registry, no evaluation', async () => {
    const { model } = recordingModel([{ text: draftJson() }]);
    const run = deepFreeze(verifiedRun());
    const proposal = await proposeSkillFromRun({ run, model, budget: BUDGET });
    expect(proposal.status).toBe('proposed');
    expect(JSON.parse(JSON.stringify(proposal))).toEqual(proposal);
  });

  it('may cost again on a repeated call: one draft per call, no exactly-once', async () => {
    const { model, calls } = recordingModel([{ text: draftJson() }]);
    await proposeSkillFromRun({ run: verifiedRun(), model, budget: BUDGET });
    await proposeSkillFromRun({ run: verifiedRun(), model, budget: BUDGET });
    expect(calls()).toBe(2);
  });

  it('stops on an aborted signal without a request', async () => {
    const { model, calls } = recordingModel([{ text: draftJson() }]);
    const controller = new AbortController();
    controller.abort(new Error('host cancelled'));
    await expect(
      proposeSkillFromRun({ run: verifiedRun(), model, budget: BUDGET, signal: controller.signal }),
    ).rejects.toThrow('host cancelled');
    expect(calls()).toBe(0);
  });
});

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const inner of Object.values(value)) deepFreeze(inner);
    Object.freeze(value);
  }
  return value;
}

describe('proposeSkillFromRun: what the model may not do', () => {
  const steps = (sources: unknown) => [{ text: 'Do the thing.', sources }];

  it.each<[string, string]>([
    ['cites an id the record does not have', draftJson({ steps: steps(['S2', 'S99']) })],
    ['leaves a step without sources', draftJson({ steps: steps([]) })],
    ['leaves the sources out', draftJson({ steps: [{ text: 'Do the thing.' }] })],
    ['proposes no step', draftJson({ steps: [] })],
    ['writes an empty step', draftJson({ steps: [{ text: '  ', sources: ['S1'] }] })],
    ['suggests a tool the run never called', draftJson({ allowedTools: ['deploy', 'shell'] })],
    ['suggests a tool whose only call failed', draftJson({ allowedTools: ['page_oncall'] })],
    ['names the skill after claude', draftJson({ name: 'claude-deploys' })],
    ['names the skill after anthropic', draftJson({ name: 'anthropic-helper' })],
    ['uses an uppercase name', draftJson({ name: 'Staging-Deploy' })],
    ['uses a name over 64 characters', draftJson({ name: 'a'.repeat(65) })],
    ['writes a description over 1024 characters', draftJson({ description: 'd'.repeat(1025) })],
    ['writes an empty description', draftJson({ description: ' ' })],
    ['puts angle brackets in the description', draftJson({ description: 'Use <script>.' })],
    ['answers with prose', 'Here is a skill: deploy carefully.'],
    ['answers with malformed JSON', '{"name": "x", "steps": ['],
  ])('refuses a draft that %s', async (_, text) => {
    const { model, calls } = recordingModel([{ text }]);
    const error = await refusal(proposeSkillFromRun({ run: verifiedRun(), model, budget: BUDGET }));
    expect(error.code).toBe('invalid_proposal');
    expect(calls()).toBe(1);
  });

  it('refuses a draft cut off at maxOutputTokens', async () => {
    const { model } = recordingModel([{ text: draftJson(), finishReason: 'length' }]);
    const error = await refusal(proposeSkillFromRun({ run: verifiedRun(), model, budget: BUDGET }));
    expect(error.code).toBe('invalid_proposal');
    expect(error.message).toContain('cut off');
  });

  it('refuses a refused draft', async () => {
    const { model } = recordingModel([{ text: draftJson(), finishReason: 'content_filter' }]);
    const error = await refusal(proposeSkillFromRun({ run: verifiedRun(), model, budget: BUDGET }));
    expect(error.code).toBe('invalid_proposal');
  });

  it('accepts a fenced answer and a draft without tools', async () => {
    const { model } = recordingModel([
      { text: '```json\n' + draftJson({ allowedTools: undefined }) + '\n```' },
    ]);
    const proposal = await proposeSkillFromRun({ run: verifiedRun(), model, budget: BUDGET });
    expect(proposal).not.toHaveProperty('allowedTools');
    expect(proposal.manifest.allowedTools).toBeUndefined();
    expect(proposal.skillMd).not.toContain('allowed-tools');
  });

  it('keeps a description with quotes and colons exactly as drafted', async () => {
    const description = `Ships "billing": checks the team's version, then deploys.`;
    const { model } = recordingModel([{ text: draftJson({ description }) }]);
    const proposal = await proposeSkillFromRun({ run: verifiedRun(), model, budget: BUDGET });
    expect(parseSkill(proposal.skillMd).manifest.description).toBe(description);
  });
});

describe('proposeSkillFromRun: source references', () => {
  it('gives every step the run, message, tool call, model step and digest it cites', async () => {
    const run = verifiedRun();
    const { model } = recordingModel([{ text: draftJson() }]);
    const projection = await projectRun(run);
    const digest = (id: string) => projection.items.find((item) => item.id === id)!.digest;
    const proposal = await proposeSkillFromRun({ run, model, budget: BUDGET });
    expect(proposal.steps[0]!.sources).toEqual([
      { runId: 'run-billing', modelStep: 1, messageId: 'run-billing:2', digest: digest('S2') },
      {
        runId: 'run-billing',
        modelStep: 1,
        messageId: 'run-billing:2',
        toolCallId: 'call_1',
        digest: digest('S3'),
      },
    ]);
    expect(proposal.steps[2]!.sources.map((ref) => ref.toolCallId)).toEqual([
      'call_3',
      'call_3',
      undefined,
    ]);
    for (const step of proposal.steps) {
      expect(step.sources.length).toBeGreaterThan(0);
      for (const ref of step.sources) {
        expect(ref.runId).toBe(run.runId);
        expect(isSha256Digest(ref.digest)).toBe(true);
      }
    }
  });

  it('lists the cited items under Sources in the SKILL.md', async () => {
    const { model } = recordingModel([{ text: draftJson() }]);
    const proposal = await proposeSkillFromRun({ run: verifiedRun(), model, budget: BUDGET });
    const body = proposal.manifest.body;
    expect(body).toContain('Proposed from run `run-billing` (revision 7)');
    expect(body).toContain('- S3: tool call `call_1` (get_version), message `run-billing:2`');
    expect(body).not.toContain('- S1:');
  });
});

describe('the source projection of a real run', () => {
  /** A conversation whose earlier turn called a tool the current run never calls. */
  const history: Message[] = [
    { role: 'user', content: 'Clean up the staging database.' },
    {
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'old_1', name: 'drop_table', input: { table: 'tmp' } }],
    },
    { role: 'tool', content: [{ type: 'tool_result', toolUseId: 'old_1', result: 'dropped' }] },
    { role: 'assistant', content: 'Dropped the tmp table.' },
    { role: 'user', content: 'What is the capital of France?' },
  ];

  for (const withChat of [false, true])
    it(`never counts a tool only the input history called as used (chat: ${withChat})`, async () => {
      const store = createInMemoryAgentRunStore();
      const result = await runAgent({
        model: createMockModel({ responses: [{ text: 'Paris.' }] }),
        messages: history,
        verify: () => ({ status: 'verified' as const }),
        session: { store, runId: 'run-x', scope: 'tenant' },
        ...(withChat
          ? { chat: { store: createInMemoryChatStore(), chatId: 'c', scope: { userId: 'u' } } }
          : {}),
      });
      expect(result.status).toBe('completed');
      const run = (await store.load('run-x'))!;
      expect(Object.keys(run.toolResults ?? {})).toEqual([]); // the run executed no tool
      const projection = await projectRun(run);
      // Spec §2.6: allowed-tools is a subset of the tools the source run really used.
      expect(projection.usedTools).toEqual([]);
      expect(projection.text).toContain('tool call drop_table (old_1)');
      expect(projection.items.find((item) => item.toolCallId === 'old_1')!.modelStep).toBe(
        undefined,
      );
      const draft = JSON.stringify({
        name: 'answer-capitals',
        description: 'Answers capital questions.',
        steps: [{ text: 'Answer.', sources: [projection.items.at(-1)!.id] }],
        limitations: [],
        allowedTools: ['drop_table'],
      });
      const error = await refusal(
        proposeSkillFromRun({
          run,
          model: createMockModel({ responses: [{ text: draft }] }),
          budget: BUDGET,
        }),
      );
      expect(error.code).toBe('invalid_proposal');
    });

  it('counts a tool the run called as used only when its receipt records a completed call', async () => {
    const run = verifiedRun();
    // The history answers call_2 without an error, but no receipt records its execution.
    delete run.toolResults!['2:call_2'];
    expect((await projectRun(run)).usedTools).toEqual(['get_version', 'health_check']);
    // A receipt for another tool under the same id does not vouch for it either.
    run.toolResults!['2:call_2'] = {
      ...run.toolResults!['1:call_1']!,
      modelStep: 2,
      toolCallId: 'call_2',
    };
    expect((await projectRun(run)).usedTools).toEqual(['get_version', 'health_check']);
  });

  it('counts the tools a real run executed', async () => {
    const store = createInMemoryAgentRunStore();
    const result = await runAgent({
      model: createMockModel({
        responses: [
          { toolCalls: [{ id: 'call_a', toolName: 'lookup', args: { q: 'x' } }] },
          { text: 'Found it.' },
        ],
      }),
      prompt: 'Look x up.',
      tools: {
        lookup: tool({
          description: 'Looks a thing up.',
          parameters: { type: 'object', properties: { q: { type: 'string' } } },
          execute: async () => 'x is 42',
        }),
      },
      verify: () => ({ status: 'verified' as const }),
      session: { store, runId: 'run-t', scope: 'tenant' },
    });
    expect(result.status).toBe('completed');
    const projection = await projectRun((await store.load('run-t'))!);
    expect(projection.usedTools).toEqual(['lookup']);
  });

  it('drops custom verifier feedback from a run without a transcript', async () => {
    const store = createInMemoryAgentRunStore();
    let calls = 0;
    const result = await runAgent({
      model: createMockModel({ responses: [{ text: 'first' }, { text: 'second' }] }),
      prompt: 'Say something.',
      verify: () =>
        ++calls === 1
          ? { status: 'rejected' as const, feedback: 'INTERNAL-VERIFIER-NOTE: be nicer.' }
          : { status: 'verified' as const },
      session: { store, runId: 'run-v', scope: 'tenant' },
    });
    expect(result.status).toBe('completed');
    const run = (await store.load('run-v'))!;
    expect(run.verification).toBe('verified');
    expect(run.transcript).toBeUndefined();
    const projection = await projectRun(run);
    expect(projection.text).not.toContain('INTERNAL-VERIFIER-NOTE');
    expect(projection.items[0]).toMatchObject({ kind: 'task', content: 'task: Say something.' });
    expect(projection.items.map((item) => item.kind)).not.toContain('user');
  });

  it('keeps a multi-turn input as the task and drops the feedback after it (no transcript)', async () => {
    const store = createInMemoryAgentRunStore();
    let calls = 0;
    await runAgent({
      model: createMockModel({ responses: [{ text: 'first' }, { text: 'second' }] }),
      messages: [
        { role: 'user', content: 'We talk about France.' },
        { role: 'assistant', content: 'Sure.' },
        { role: 'user', content: 'Name its capital.' },
      ],
      verify: () =>
        ++calls === 1
          ? { status: 'rejected' as const, feedback: 'INTERNAL-VERIFIER-NOTE: be brief.' }
          : { status: 'verified' as const },
      session: { store, runId: 'run-m', scope: 'tenant' },
    });
    const run = (await store.load('run-m'))!;
    expect(run.verification).toBe('verified');
    expect(run.transcript).toBeUndefined();
    const projection = await projectRun(run);
    expect(projection.text).not.toContain('INTERNAL-VERIFIER-NOTE');
    expect(
      projection.items.filter((item) => item.kind === 'task').map((item) => item.content),
    ).toEqual(['task: We talk about France.', 'task: Name its capital.']);
  });

  it('cites a carried-over input message by the id it keeps in the run chat projection', async () => {
    const chats = createInMemoryChatStore();
    const store = createInMemoryAgentRunStore();
    const chat = { store: chats, chatId: 'c', scope: { userId: 'u' } };
    await runAgent({
      model: createMockModel({ responses: [{ text: 'Hello.' }] }),
      prompt: 'Greet me.',
      chat,
      session: { store, runId: 'run-1', scope: 'tenant' },
    });
    const stored = (await chats.loadChat('c'))!;
    expect(stored.messageIds?.[0]).toBe('run-1:0');
    const result = await runAgent({
      model: createMockModel({ responses: [{ text: 'Paris.' }] }),
      messages: [...stored.messages, { role: 'user', content: 'Capital of France?' }],
      chat,
      verify: () => ({ status: 'verified' as const }),
      session: { store, runId: 'run-2', scope: 'tenant' },
    });
    expect(result.status).toBe('completed');
    const run2 = (await store.load('run-2'))!;
    expect(run2.chat?.messageIds[0]).toBe('run-1:0');
    const projection = await projectRun(run2);
    const first = projection.items[0]!;
    expect(first.kind).toBe('task');
    expect(first.messageId).toBe('run-1:0');
    // A message of this run keeps `<runId>:<index>`, as in the chat projection.
    expect(projection.items.at(-1)!.messageId).toBe(run2.chat!.messageIds.at(-1));
    expect(projection.items.at(-1)!.messageId).toMatch(/^run-2:/);
    const draft = JSON.stringify({
      name: 'answer-capitals',
      description: 'Answers capital questions.',
      steps: [{ text: 'Answer.', sources: [first.id] }],
      limitations: [],
    });
    const proposal = await proposeSkillFromRun({
      run: run2,
      model: createMockModel({ responses: [{ text: draft }] }),
      budget: BUDGET,
    });
    expect(run2.chat!.messageIds).toContain(proposal.steps[0]!.sources[0]!.messageId);
  });
});
