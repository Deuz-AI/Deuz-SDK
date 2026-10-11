/**
 * runHeadless / resumeHeadless (2.3 preview, 23.8): real native runs on
 * `createMockModel`, reported as plain JSON with an exit code per outcome.
 */
import { describe, expect, it } from 'vitest';
import { createInMemoryAgentRunStore } from '../src/agent-run';
import { createMockModel, type MockResponse } from '../src/testing';
import { createOpenAI } from '../src/openai';
import { attachConfig, readConfig } from '../src/internal/config-symbol';
import {
  HEADLESS_EXIT_CODES,
  exitCodeFor,
  inspectRun,
  resumeHeadless,
  runHeadless,
} from '../src/node/headless';
import type { AgentEvent, AgentToolSet } from '../src/types/agent-run';
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
