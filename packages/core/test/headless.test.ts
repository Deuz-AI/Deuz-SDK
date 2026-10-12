/**
 * runHeadless / resumeHeadless (2.3 preview, 23.8): real native runs on
 * `createMockModel`, reported as plain JSON with an exit code per outcome.
 */
import { describe, expect, it } from 'vitest';
import { createInMemoryAgentRunStore } from '../src/agent-run';
import { BudgetLedgerError } from '../src/budget-ledger';
import { createMockModel, type MockResponse } from '../src/testing';
import { createOpenAI } from '../src/openai';
import { attachConfig, readConfig } from '../src/internal/config-symbol';
import {
  HEADLESS_EXIT_CODES,
  exitCodeFor,
  inspectRun,
  resumeHeadless,
  runHeadless,
  type HeadlessResumeOptions,
} from '../src/node/headless';
import type { AgentEvent, AgentRunStore, AgentToolSet } from '../src/types/agent-run';
import type { BreakerStore } from '../src/types/deps';
import type { LanguageModel } from '../src/types/model';

/** A mock model answering as `modelId` (the price table keys on the id). */
function mockAs(modelId: string, responses: MockResponse[]): LanguageModel {
  const base = createMockModel({ responses });
  return attachConfig({ ...base, modelId }, readConfig(base)!);
}

const deployTools: AgentToolSet = {
  deploy: {
    description: 'Deploy the build.',
    parameters: {
      type: 'object',
      properties: { env: { type: 'string' } },
      required: ['env'],
      additionalProperties: false,
    },
    needsApproval: true,
    execute: ({ env }: { env: string }) => ({ deployed: env }),
  },
};

describe('runHeadless (headless preview)', () => {
  it('reports a completed run, stores it, and exits 0', async () => {
    const store = createInMemoryAgentRunStore();
    const events: AgentEvent<unknown>['type'][] = [];
    const report = await runHeadless({
      model: createMockModel({ responses: [{ text: 'Build fixed.' }] }),
      prompt: 'Fix the build.',
      store,
      runId: 'run-1',
      onEvent: (event) => events.push(event.type),
    });
    expect(report).toMatchObject({
      kind: 'deuz-headless-report',
      runId: 'run-1',
      scope: 'headless',
      status: 'completed',
      outcome: 'completed',
      phase: 'terminal',
      pending: [],
      output: 'Build fixed.',
      text: 'Build fixed.',
      modelSteps: 1,
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    });
    expect(JSON.parse(JSON.stringify(report))).toEqual(report);
    expect(exitCodeFor(report)).toBe(0);
    expect(events).toContain('result');
    // The run is durable: inspecting it later needs no model call.
    const inspected = await inspectRun(store, 'run-1');
    expect(inspected).toMatchObject({
      status: 'completed',
      outcome: 'completed',
      output: 'Build fixed.',
    });
  });

  it('generates a run ID when none is given', async () => {
    const store = createInMemoryAgentRunStore();
    const report = await runHeadless({
      model: createMockModel({ responses: [{ text: 'ok' }] }),
      prompt: 'hi',
      store,
      scope: 'ci',
    });
    expect(report.runId).toMatch(/\S/);
    expect(report.scope).toBe('ci');
    expect((await store.load(report.runId))?.scope).toBe('ci');
  });

  it('prices the run with the bundled table unless deps carry a price provider', async () => {
    const priced = await runHeadless({
      model: mockAs('gpt-6.1-sol', [
        { text: 'ok', usage: { inputTokens: 1_000_000, outputTokens: 100_000 } },
      ]),
      prompt: 'hi',
      store: createInMemoryAgentRunStore(),
    });
    // $2 per million input tokens, $10 per million output tokens.
    expect(priced.cost).toEqual({ usd: 3, complete: true, unpricedCalls: 0, unknownCalls: 0 });

    const custom = await runHeadless({
      model: createMockModel({ responses: [{ text: 'ok' }] }),
      prompt: 'hi',
      store: createInMemoryAgentRunStore(),
      deps: { priceProvider: { priceUsage: (_model, usage) => usage.totalTokens / 1000 } },
    });
    expect(custom.cost).toEqual({ usd: 0.015, complete: true, unpricedCalls: 0, unknownCalls: 0 });
  });

  it('reports an unpriced model: an incomplete cost, and a warning under a USD budget', async () => {
    const report = await runHeadless({
      model: createMockModel({ responses: [{ text: 'ok' }] }),
      prompt: 'hi',
      store: createInMemoryAgentRunStore(),
      budget: { usd: 1 },
    });
    expect(report.outcome).toBe('completed');
    expect(report.cost).toMatchObject({ usd: 0, complete: false, unpricedCalls: 1 });
    expect(report.warnings.filter((warning) => warning.type === 'unpriced-model')).toHaveLength(1);
  });

  it('suspends on an approval with what resumes it, then resumes to completion', async () => {
    const store = createInMemoryAgentRunStore();
    const model = createMockModel({
      responses: [
        { toolCalls: [{ toolName: 'deploy', args: { env: 'prod' } }] },
        { text: 'Deployed to prod.' },
      ],
    });
    const first = await runHeadless({
      model,
      prompt: 'Deploy.',
      tools: deployTools,
      store,
      runId: 'deploy-1',
    });
    expect(first).toMatchObject({ status: 'suspended', outcome: 'pending', phase: 'running' });
    expect(first.pending).toEqual([
      expect.objectContaining({
        kind: 'approval',
        toolName: 'deploy',
        input: { env: 'prod' },
        resumeWith: 'approvalResponses',
      }),
    ]);
    expect(exitCodeFor(first)).toBe(HEADLESS_EXIT_CODES.pending);
    expect((await inspectRun(store, 'deploy-1')).pending).toEqual(first.pending);

    const approval = first.pending[0]!;
    if (approval.kind !== 'approval') throw new Error('expected an approval');
    const resumed = await resumeHeadless({
      model,
      tools: deployTools,
      store,
      runId: 'deploy-1',
      approvalResponses: [{ approvalId: approval.approvalId, approved: true }],
    });
    expect(resumed).toMatchObject({
      runId: 'deploy-1',
      status: 'completed',
      outcome: 'completed',
      output: 'Deployed to prod.',
      pending: [],
    });
    expect(exitCodeFor(resumed)).toBe(0);
  });

  it('stays pending when resumed without a verdict', async () => {
    const store = createInMemoryAgentRunStore();
    const model = createMockModel({
      responses: [{ toolCalls: [{ toolName: 'deploy', args: { env: 'prod' } }] }],
    });
    await runHeadless({ model, prompt: 'Deploy.', tools: deployTools, store, runId: 'wait-1' });
    const again = await resumeHeadless({ model, tools: deployTools, store, runId: 'wait-1' });
    expect(again.outcome).toBe('pending');
    expect(exitCodeFor(again)).toBe(HEADLESS_EXIT_CODES.pending);
  });

  it('reports a call with an unknown effect as pending, resumed with retryToolCallIds', async () => {
    const memory = createInMemoryAgentRunStore();
    // The store goes down right after the call is recorded as started: its
    // outcome is never saved, so nobody knows whether the charge happened.
    let down = false;
    const flaky: AgentRunStore = {
      load: (runId) => memory.load(runId),
      save: async (envelope) => {
        if (down) throw new Error('store unavailable');
        await memory.save(envelope);
        if (Object.values(envelope.toolResults ?? {}).some((r) => r.stage === 'executing'))
          down = true;
      },
    };
    let charges = 0;
    const tools: AgentToolSet = {
      charge: {
        description: 'Charge the card.',
        parameters: { type: 'object' },
        execute: () => ++charges,
      },
    };
    const model = createMockModel({
      responses: [{ toolCalls: [{ toolName: 'charge', args: {} }] }, { text: 'Charged.' }],
    });
    const crashed = await runHeadless({
      model,
      prompt: 'Charge.',
      tools,
      store: flaky,
      runId: 'pay-1',
    });
    expect(crashed.outcome).toBe('failed');

    const stuck = await resumeHeadless({ model, tools, store: memory, runId: 'pay-1' });
    expect(stuck).toMatchObject({ status: 'stopped', reason: 'tool-reconciliation-required' });
    expect(stuck.outcome).toBe('pending');
    expect(stuck.pending).toEqual([
      expect.objectContaining({
        kind: 'unknown-effect',
        toolName: 'charge',
        resumeWith: ['retryToolCallIds', 'reconciledToolResults'],
      }),
    ]);
    expect(exitCodeFor(stuck)).toBe(HEADLESS_EXIT_CODES.pending);

    // The app checked the effect and chose to run the call again.
    const effect = stuck.pending[0]!;
    if (effect.kind !== 'unknown-effect') throw new Error('expected an unknown effect');
    const done = await resumeHeadless({
      model,
      tools,
      store: memory,
      runId: 'pay-1',
      retryToolCallIds: [effect.toolCallId],
    });
    expect(done).toMatchObject({ outcome: 'completed', output: 'Charged.' });
    expect(charges).toBe(2);
  });

  it('reports a provider failure with its error code and exit 1', async () => {
    const model = createOpenAI({
      apiKey: 'k',
      fetch: (async () =>
        new Response(JSON.stringify({ error: { message: 'Incorrect API key.' } }), {
          status: 401,
          headers: { 'content-type': 'application/json' },
        })) as typeof fetch,
    })('gpt-5.5');
    const report = await runHeadless({
      model,
      prompt: 'hi',
      store: createInMemoryAgentRunStore(),
      maxRetries: 0,
    });
    expect(report.status).toBe('failed');
    expect(report.outcome).toBe('failed');
    expect(report.error).toMatchObject({ code: 'authentication' });
    expect(exitCodeFor(report)).toBe(HEADLESS_EXIT_CODES.failed);
  });

  it('reports a refusal (F16) as refused, never as completed', async () => {
    const report = await runHeadless({
      model: createMockModel({
        responses: [{ text: 'I cannot help.', finishReason: 'content_filter' }],
      }),
      prompt: 'hi',
      store: createInMemoryAgentRunStore(),
    });
    expect(report).toMatchObject({ status: 'stopped', reason: 'refusal', outcome: 'refused' });
    expect(report.output).toBeUndefined();
    expect(exitCodeFor(report)).toBe(HEADLESS_EXIT_CODES.refused);
  });

  it('reports a cancelled run and a budget stop with their own codes', async () => {
    const controller = new AbortController();
    controller.abort();
    const cancelled = await runHeadless({
      model: createMockModel({ responses: [{ text: 'ok' }] }),
      prompt: 'hi',
      store: createInMemoryAgentRunStore(),
      signal: controller.signal,
    });
    expect(cancelled.outcome).toBe('cancelled');
    expect(exitCodeFor(cancelled)).toBe(HEADLESS_EXIT_CODES.cancelled);

    const limited = await runHeadless({
      model: createMockModel({
        responses: [{ toolCalls: [{ toolName: 'look', args: {} }] }, { text: 'done' }],
      }),
      prompt: 'hi',
      store: createInMemoryAgentRunStore(),
      budget: { tokens: 10 },
      tools: {
        look: { description: 'Look around.', parameters: { type: 'object' }, execute: () => 'ok' },
      },
    });
    // The token budget refuses the call's reservation, or stops the loop.
    expect(limited.outcome).toBe('limit');
    expect(limited.reason ?? limited.error?.code).toMatch(/budget/);
    expect(exitCodeFor(limited)).toBe(HEADLESS_EXIT_CODES.limit);
  });

  it('reports a fresh run whose ID is taken as failed, leaving the stored run intact', async () => {
    const store = createInMemoryAgentRunStore();
    const model = createMockModel({ responses: [{ text: 'ok' }] });
    await runHeadless({ model, prompt: 'hi', store, runId: 'taken' });
    const again = await runHeadless({ model, prompt: 'hi', store, runId: 'taken' });
    expect(again.outcome).toBe('failed');
    expect(again.error?.message).toMatch(/already exists/);
    expect(again.phase).toBe('terminal');
    expect((await inspectRun(store, 'taken')).outcome).toBe('completed');
  });
});

/**
 * A store that goes down right after a call is recorded as started: the
 * call's effect lands, and its outcome is never saved.
 */
function crashingAfterStart(memory: AgentRunStore): AgentRunStore {
  let down = false;
  return {
    load: (runId) => memory.load(runId),
    save: async (envelope) => {
      if (down) throw new Error('store unavailable');
      await memory.save(envelope);
      if (Object.values(envelope.toolResults ?? {}).some((r) => r.stage === 'executing'))
        down = true;
    },
  };
}

/** A circuit breaker that every call finds open: the provider is in an outage. */
const outage: BreakerStore = {
  get: () => ({ failures: 5, openedAt: 0, cooldownUntil: Number.MAX_SAFE_INTEGER }),
  set: () => {},
};

describe('resumeHeadless with the 2.3 durability options (headless preview)', () => {
  /** A run stopped on a charge whose effect is unknown, as resumeHeadless reports it. */
  async function unknownCharge() {
    const memory = createInMemoryAgentRunStore();
    const charges: number[] = [];
    const tools: AgentToolSet = {
      charge: {
        description: 'Charge the card.',
        parameters: { type: 'object' },
        execute: () => {
          charges.push(charges.length + 1);
          return { charged: 5 };
        },
      },
    };
    const model = createMockModel({
      responses: [{ toolCalls: [{ toolName: 'charge', args: {} }] }, { text: 'Charged.' }],
    });
    const crashed = await runHeadless({
      model,
      prompt: 'Charge.',
      tools,
      store: crashingAfterStart(memory),
      runId: 'pay',
    });
    expect(crashed.outcome).toBe('failed');
    const stuck = await resumeHeadless({ model, tools, store: memory, runId: 'pay' });
    const effect = stuck.pending[0];
    if (effect?.kind !== 'unknown-effect') throw new Error('expected an unknown effect');
    return { memory, charges, tools, model, toolCallId: effect.toolCallId };
  }

  it('records the result that landed with reconciledToolResults, without running the call again', async () => {
    const { memory, charges, tools, model, toolCallId } = await unknownCharge();
    expect(charges).toEqual([1]);
    // The app found the charge in the payment system: it landed.
    const done = await resumeHeadless({
      model,
      tools,
      store: memory,
      runId: 'pay',
      reconciledToolResults: [{ toolCallId, output: { charged: 5 } }],
    });
    expect(done).toMatchObject({ status: 'completed', outcome: 'completed', output: 'Charged.' });
    expect(exitCodeFor(done)).toBe(0);
    expect(charges).toEqual([1]);
    expect(await inspectRun(memory, 'pay')).toMatchObject({ outcome: 'completed', pending: [] });
  });

  it('refuses an answer that does not fit the unknown effects before writing anything', async () => {
    const { memory, charges, tools, model, toolCallId } = await unknownCharge();
    const before = await memory.load('pay');
    const answers: [string, Partial<HeadlessResumeOptions>][] = [
      [
        'a call that is not unknown',
        { reconciledToolResults: [{ toolCallId: 'nope', output: 1 }] },
      ],
      [
        'the same call listed twice',
        {
          reconciledToolResults: [
            { toolCallId, output: 1 },
            { toolCallId, output: 2 },
          ],
        },
      ],
      [
        'a call both run again and recorded',
        { retryToolCallIds: [toolCallId], reconciledToolResults: [{ toolCallId, output: 1 }] },
      ],
      ['not an array', { reconciledToolResults: 'landed' as never }],
    ];
    for (const [label, answer] of answers) {
      const report = await resumeHeadless({ model, tools, store: memory, runId: 'pay', ...answer });
      expect(report, label).toMatchObject({
        status: 'failed',
        outcome: 'failed',
        error: { name: 'TypeError', message: expect.stringContaining('reconciledToolResults') },
      });
      expect(exitCodeFor(report), label).toBe(HEADLESS_EXIT_CODES.failed);
      expect(await memory.load('pay'), label).toEqual(before);
    }
    expect(charges).toEqual([1]);
    // The run still waits for the decision.
    expect((await inspectRun(memory, 'pay')).pending).toEqual([
      expect.objectContaining({ kind: 'unknown-effect', toolCallId }),
      { kind: 'resume', phase: 'running' },
    ]);
  });

  it('reports a run that failed in transit as retryable, and re-enters it with retryFailed', async () => {
    const store = createInMemoryAgentRunStore();
    const model = createMockModel({ responses: [{ text: 'Fixed.' }] });
    const first = await runHeadless({
      model,
      prompt: 'Fix the build.',
      store,
      runId: 'flaky',
      deps: { breakerStore: outage },
    });
    expect(first).toMatchObject({
      status: 'failed',
      outcome: 'failed',
      error: { code: 'breaker_open' },
      retry: { cause: 'model-call', phase: 'running', resumeWith: 'retryFailed' },
      pending: [],
    });
    expect(exitCodeFor(first)).toBe(HEADLESS_EXIT_CODES.failed);
    expect((await inspectRun(store, 'flaky')).retry).toEqual(first.retry);

    // Without the option, a resume returns the stored failure, still retryable.
    const again = await resumeHeadless({ model, store, runId: 'flaky' });
    expect(again).toMatchObject({ outcome: 'failed', error: first.error, retry: first.retry });

    const retried = await resumeHeadless({ model, store, runId: 'flaky', retryFailed: true });
    expect(retried).toMatchObject({ status: 'completed', outcome: 'completed', output: 'Fixed.' });
    expect(retried.retry).toBeUndefined();
    expect((await inspectRun(store, 'flaky')).retry).toBeUndefined();
  });

  it('reports no retry for any other failure, and refuses retryFailed for it before writing', async () => {
    const store = createInMemoryAgentRunStore();
    const model = createOpenAI({
      apiKey: 'k',
      fetch: (async () =>
        new Response(JSON.stringify({ error: { message: 'Incorrect API key.' } }), {
          status: 401,
          headers: { 'content-type': 'application/json' },
        })) as typeof fetch,
    })('gpt-5.5');
    const failed = await runHeadless({ model, prompt: 'hi', store, runId: 'key', maxRetries: 0 });
    expect(failed).toMatchObject({ outcome: 'failed', error: { code: 'authentication' } });
    expect(failed.retry).toBeUndefined();
    const before = await store.load('key');
    for (const retryFailed of [true, 'yes' as unknown as boolean]) {
      const refused = await resumeHeadless({ model, store, runId: 'key', retryFailed });
      expect(refused, String(retryFailed)).toMatchObject({
        outcome: 'failed',
        error: { name: 'TypeError', message: expect.stringContaining('retryFailed') },
      });
      expect(refused.retry, String(retryFailed)).toBeUndefined();
      expect(await store.load('key'), String(retryFailed)).toEqual(before);
    }
  });

  it('reports its own error, not the stored retry, for a leg refused before it wrote', async () => {
    const store = createInMemoryAgentRunStore();
    const model = createMockModel({ responses: [{ text: 'Fixed.' }] });
    const first = await runHeadless({
      model,
      prompt: 'Fix the build.',
      store,
      runId: 'bound',
      deps: { breakerStore: outage },
    });
    expect(first.retry).toBeDefined();
    const before = await store.load('bound');
    // A changed binding refuses the resume; a fresh run under the same ID is refused too.
    const changed = await resumeHeadless({
      model,
      store,
      runId: 'bound',
      retryFailed: true,
      tools: deployTools,
    });
    expect(changed).toMatchObject({ outcome: 'failed', error: { name: 'TypeError' } });
    expect(changed.retry).toBeUndefined();
    const taken = await runHeadless({ model, prompt: 'Again.', store, runId: 'bound' });
    expect(taken.error?.message).toMatch(/already exists/);
    expect(taken.retry).toBeUndefined();
    expect(await store.load('bound')).toEqual(before);
    expect((await inspectRun(store, 'bound')).retry).toEqual(first.retry);
  });

  it('asks for retryFailed with the answers when a retried run stops before its first write', async () => {
    // A fatal budget-store conflict raised inside the tool call, after its
    // effect: the receipt stays 'executing' and the run fails in transit.
    const store = createInMemoryAgentRunStore();
    const effects: string[] = [];
    const tools: AgentToolSet = {
      charge: {
        description: 'Charge the card.',
        parameters: { type: 'object' },
        execute: () => {
          effects.push('charge');
          if (effects.length === 1)
            throw new BudgetLedgerError(
              'admission_failed',
              'The persistent budget store failed; nothing was changed.',
              Object.assign(new Error('could not serialize access'), { code: '40001' }),
            );
          return 'charged';
        },
      },
    };
    const model = createMockModel({
      responses: [{ toolCalls: [{ toolName: 'charge', args: {} }] }, { text: 'Charged.' }],
    });
    const options = { model, tools, store, runId: 'contended' };
    const first = await runHeadless({ ...options, prompt: 'Charge.' });
    expect(first).toMatchObject({
      outcome: 'failed',
      retry: { cause: 'admission', phase: 'running', resumeWith: 'retryFailed' },
    });
    const stopped = await resumeHeadless({ ...options, retryFailed: true });
    // Nothing was written: the stored run still failed, and the next resume
    // needs retryFailed again, with an answer for the unknown effect.
    expect(stopped).toMatchObject({
      status: 'stopped',
      reason: 'tool-reconciliation-required',
      outcome: 'pending',
      phase: 'terminal',
      retry: first.retry,
    });
    const effect = stopped.pending[0];
    if (effect?.kind !== 'unknown-effect') throw new Error('expected an unknown effect');
    expect(effect.resumeWith).toEqual(['retryToolCallIds', 'reconciledToolResults']);
    const done = await resumeHeadless({
      ...options,
      retryFailed: true,
      reconciledToolResults: [{ toolCallId: effect.toolCallId, output: 'charged' }],
    });
    expect(done).toMatchObject({ outcome: 'completed', output: 'Charged.' });
    expect(done.retry).toBeUndefined();
    expect(effects).toEqual(['charge']);
  });
});
