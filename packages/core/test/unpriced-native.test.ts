import { describe, expect, it, vi } from 'vitest';
import { generateText } from '../src/generate';
import { runAgent, streamAgent } from '../src/agent-run';
import { createAgent } from '../src/agent';
import { createInMemorySwarmStore, createSwarm } from '../src/swarm';
import { evolve } from '../src/evolve/controller';
import { createInMemoryPopulationStore } from '../src/evolve/store';
import { createExecutionContext } from '../src/execution-policy';
import { createInMemoryBudgetStore } from '../src/budget-store';
import { createMockModel } from '../src/testing';
import { attachConfig, readConfig } from '../src/internal/config-symbol';
import type { AgentEvent } from '../src/types/agent-run';
import type { BudgetLimits } from '../src/types/execution';
import type { LanguageModel } from '../src/types/model';
import type { Usage } from '../src/types/usage';

/** Prices only `priced-model`, at $1 per million tokens; every other model has no price. */
const prices = {
  priceUsage: (model: string, usage: Usage) =>
    model === 'priced-model' ? usage.totalTokens / 1_000_000 : undefined,
};

function logger() {
  const noop = (_message: string, _fields?: Record<string, unknown>): void => {};
  return { debug: vi.fn(noop), info: vi.fn(noop), warn: vi.fn(noop), error: vi.fn(noop) };
}

/** A mock model (no price under `prices`) whose provider calls are counted. */
function counted(text = 'done', modelId?: string): { model: LanguageModel; calls: () => number } {
  const base = createMockModel({
    responses: [{ text, usage: { inputTokens: 10, outputTokens: 5 } }],
  });
  const config = readConfig(base)!;
  let calls = 0;
  const model = attachConfig(
    { ...base, ...(modelId ? { modelId } : {}) },
    {
      ...config,
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        calls++;
        return config.fetch!(input, init);
      }) as typeof fetch,
    },
  );
  return { model, calls: () => calls };
}

const unpricedWarnings = (log: ReturnType<typeof logger>) =>
  log.warn.mock.calls.filter(([, fields]) => fields?.warning === 'unpriced-model');

const schema = { type: 'object' as const, properties: {} };

describe('native calls to an unpriced model under a USD budget (decision 4)', () => {
  it('run with a warning instead of failing closed (t3b case E)', async () => {
    const { model, calls } = counted();
    const execution = createExecutionContext({ budget: { usd: 1 } });
    const result = await generateText({
      model,
      prompt: 'hi',
      // A tool routes the call through the loop, whose result carries the warnings.
      tools: { noop: { parameters: schema, execute: () => 'ok' } },
      execution,
      deps: { priceProvider: prices },
    });
    expect(result.text).toBe('done');
    expect(calls()).toBe(1);
    expect(result.warnings?.filter((w) => w.type === 'unpriced-model')).toEqual([
      expect.objectContaining({
        setting: 'budget.usd',
        message: expect.stringContaining('mock-model'),
      }),
    ]);
    const [record] = execution.ledger.snapshot().reservations;
    expect(record).toMatchObject({ unpriced: true, actual: { tokens: 15 } });
    expect(execution.ledger.totals()).toMatchObject({
      spent: { tokens: 15, usd: 0 },
      reserved: { tokens: 0, usd: 0 },
      unknownUsd: 1,
      unpriced: 1,
    });
  });

  it('treat a missing priceProvider as no price (t3b case H)', async () => {
    const { model, calls } = counted();
    const log = logger();
    const execution = createExecutionContext({ budget: { usd: 1 } });
    await expect(
      generateText({ model, prompt: 'hi', execution, deps: { logger: log } }),
    ).resolves.toMatchObject({ text: 'done' });
    expect(calls()).toBe(1);
    // A single-turn call has no loop sink: the warning goes to the logger, once.
    expect(unpricedWarnings(log)).toEqual([
      [
        expect.stringContaining('No deps.priceProvider'),
        expect.objectContaining({ setting: 'budget.usd' }),
      ],
    ]);
  });

  it("refuse the call before it is sent under unknownPrice 'reject'", async () => {
    const { model, calls } = counted();
    const execution = createExecutionContext({ budget: { usd: 1, unknownPrice: 'reject' } });
    await expect(
      generateText({ model, prompt: 'hi', execution, deps: { priceProvider: prices } }),
    ).rejects.toMatchObject({ name: 'BudgetLedgerError', code: 'unpriced_model' });
    expect(calls()).toBe(0);
    expect(execution.ledger.snapshot().reservations).toEqual([]);
  });

  it('keep bounding their tokens', async () => {
    const { model, calls } = counted();
    const execution = createExecutionContext({ budget: { usd: 1, tokens: 100 } });
    // The reservation covers the 4,096-token wire cap of an unknown model.
    await expect(
      generateText({ model, prompt: 'hi', execution, deps: { priceProvider: prices } }),
    ).rejects.toMatchObject({
      code: 'budget_exceeded',
      message: expect.stringContaining('tokens'),
    });
    expect(calls()).toBe(0);
  });

  it('stay silent without a USD bound', async () => {
    const { model } = counted();
    const log = logger();
    const execution = createExecutionContext({ budget: { tokens: 10_000 } });
    await generateText({
      model,
      prompt: 'hi',
      execution,
      deps: { priceProvider: prices, logger: log },
    });
    expect(unpricedWarnings(log)).toEqual([]);
  });
});

describe('runAgent, swarm and evolve follow the same policy (t4)', () => {
  it('runAgent completes with one warning, or fails with unpriced_model before any call', async () => {
    const warned = logger();
    const { model, calls } = counted();
    const run = await runAgent({
      model,
      prompt: 'go',
      budget: { usd: 1 },
      deps: { priceProvider: prices, logger: warned },
    });
    // 2.2: failed with missing_reservation and made no model call.
    expect(run.status).toBe('completed');
    expect(calls()).toBe(1);
    expect(unpricedWarnings(warned)).toHaveLength(1);

    const strict = counted();
    // runAgent forwards its budget to the execution context, policy included.
    const budget: BudgetLimits = { usd: 1, unknownPrice: 'reject' };
    const refused = await runAgent({
      model: strict.model,
      prompt: 'go',
      budget,
      deps: { priceProvider: prices },
    });
    expect(refused).toMatchObject({ status: 'failed', error: { code: 'unpriced_model' } });
    expect(strict.calls()).toBe(0);
  });

  it('a swarm runs its tasks and warns once per model for the whole run', async () => {
    const log = logger();
    const { model, calls } = counted();
    const swarm = createSwarm({
      agents: { worker: createAgent({ model }) },
      store: createInMemorySwarmStore(),
      budget: { usd: 1 },
      deps: { priceProvider: prices, logger: log },
    });
    const outcome = await (
      await swarm.run({
        scope: 'tenant',
        tasks: ['a', 'b', 'c'].map((id) => ({ id, agent: 'worker', prompt: 'go' })),
      })
    ).result;
    expect(outcome.run.status).toBe('completed');
    expect(outcome.tasks.map((task) => task.status)).toEqual([
      'completed',
      'completed',
      'completed',
    ]);
    expect(calls()).toBe(3);
    expect(unpricedWarnings(log)).toHaveLength(1);

    const strict = counted();
    const refused = await (
      await createSwarm({
        agents: { worker: createAgent({ model: strict.model }) },
        store: createInMemorySwarmStore(),
        budget: { usd: 1, unknownPrice: 'reject' },
        deps: { priceProvider: prices },
      }).run({ scope: 'tenant', tasks: [{ id: 'a', agent: 'worker', prompt: 'go' }] })
    ).result;
    expect(refused.tasks[0]).toMatchObject({ status: 'failed', error: { code: 'unpriced_model' } });
    expect(strict.calls()).toBe(0);
  });

  const initial = [
    'def f(x):',
    '    # EVOLVE-BLOCK-START',
    '    return x',
    '    # EVOLVE-BLOCK-END',
    '',
  ].join('\n');
  const GROW =
    '<<<<<<< SEARCH\n    return x\n=======\n    x = x + 1\n    return x\n>>>>>>> REPLACE';
  let ids = 0;
  const evolveOptions = (
    model: LanguageModel,
    budget: { usd: number; unknownPrice?: 'reject' },
  ) => ({
    scope: 'tenant',
    runId: `run-${++ids}`,
    initial,
    stages: [
      { name: 'count', evaluate: (p: string) => ({ score: p.split('x = x + 1').length - 1 }) },
    ],
    models: [{ model }],
    store: createInMemoryPopulationStore(),
    generations: 1,
    mutationsPerGeneration: 2,
    selection: 'beam' as const,
    patch: { diff: 1 },
    budget,
    seed: 'fixed',
    deps: { priceProvider: prices, generateId: () => `id-${++ids}` },
  });

  it('evolve completes under a USD budget, or refuses the model before any call', async () => {
    const { model, calls } = counted(GROW);
    // 2.2 threw missing_reservation before the first mutation.
    const done = await evolve(evolveOptions(model, { usd: 1 })).result;
    expect(done.status).toBe('completed');
    expect(calls()).toBe(2);

    const strict = counted(GROW);
    await expect(
      evolve(evolveOptions(strict.model, { usd: 1, unknownPrice: 'reject' })).result,
    ).rejects.toMatchObject({ code: 'unpriced_model' });
    expect(strict.calls()).toBe(0);
  });

  it('a persistent scope settles the tokens of an unpriced run and holds no USD', async () => {
    const store = createInMemoryBudgetStore();
    const { model } = counted();
    const run = await runAgent({
      model,
      prompt: 'go',
      execution: createExecutionContext({
        scopeId: 'run',
        admission: { store, scopes: [{ key: 'tenant:1', limits: { usd: 1 } }] },
      }),
      deps: { priceProvider: prices },
    });
    expect(run.status).toBe('completed');
    // 2.2 refused the run; with a caller estimate it kept the estimate held forever.
    expect(await store.usage('tenant:1')).toEqual({ tokens: 15, usd: 0 });
  });
});

describe('native cost parts follow the price provider (2.3)', () => {
  // One tool step, the loop's answer, then a structured finalization: cost parts
  // can come from the loop's steps and from the finalization request.
  const run = async (deps?: { priceProvider: typeof prices }) => {
    const model = createMockModel({
      responses: [
        { toolCalls: [{ toolName: 'noop', id: 'n1', args: {} }] },
        { text: 'ready' },
        { text: '{}' },
      ],
    });
    const stream = streamAgent({
      model,
      prompt: 'go',
      tools: { noop: { parameters: schema, execute: () => 'ok' } },
      output: { schema, mode: 'json', validate: (value: unknown) => value as object },
      ...(deps ? { deps } : {}),
    });
    const events: AgentEvent<object>[] = [];
    for await (const event of stream.events) events.push(event);
    const costs = events.flatMap((e) =>
      e.type === 'part' && e.part.type === 'cost'
        ? [{ phase: e.phase, costUsd: e.part.costUsd }]
        : [],
    );
    return { result: await stream.result, costs };
  };

  it('stream none without a priceProvider, whose cost is unknown rather than zero', async () => {
    const { result, costs } = await run();
    expect(result.status).toBe('completed');
    expect(result.accounting).toMatchObject({ spent: { usd: 0 }, unknownUsd: 3, unpriced: 3 });
    // 2.2 streamed no cost part here; a $0 part would read as a free run.
    expect(costs).toEqual([]);
  });

  it('stream the priced sum when the provider has no price for the model (decision 4)', async () => {
    const { result, costs } = await run({ priceProvider: prices });
    expect(result.status).toBe('completed');
    expect(costs).toEqual([
      { phase: 'running', costUsd: 0 },
      { phase: 'running', costUsd: 0 },
      { phase: 'finalizing', costUsd: 0 },
    ]);
  });
});
