import { describe, expect, it, vi } from 'vitest';
import { createAnthropic } from '../src/anthropic';
import { createBatchClient } from '../src/batch/client';
import { createMemoryBatchJobStore } from '../src/batch/store';
import type { BatchJob } from '../src/batch/types';
import { createInMemoryBudgetStore } from '../src/budget-store';
import { createExecutionContext } from '../src/execution-policy';
import { createOpenAIResponses } from '../src/openai';
import { createPriceProvider, priceUsage, PRICES_2026 } from '../src/pricing';
import type { PersistentBudgetScope } from '../src/types/budget-store';
import type { BudgetLimits, NativeExecutionContext } from '../src/types/execution';
import type { Usage } from '../src/types/usage';
import {
  fakeAnthropicBatches,
  fakeOpenAIBatches,
  type AnthropicResult,
} from './fixtures/batch-servers';
import { manualClock } from './fixtures/manual-clock';

// BA2: one budget hold per batch request at submit, priced on the batch tier;
// each result settles its hold, idempotently, in the ledger and in a
// persistent BudgetStore; a job store lets a new process settle them.

const prices = createPriceProvider();

function usage(input: number, output: number): Usage {
  return {
    inputTokens: input,
    outputTokens: output,
    reasoningTokens: 0,
    cachedReadTokens: 0,
    cacheWriteTokens: 0,
    cacheWrite1hTokens: 0,
    totalTokens: input + output,
  };
}

const message = (input = 2000, output = 1000) => ({
  id: 'msg',
  type: 'message',
  role: 'assistant',
  content: [{ type: 'text', text: 'ok' }],
  stop_reason: 'end_turn',
  stop_details: null,
  usage: { input_tokens: input, output_tokens: output },
});

const ok = (input?: number, output?: number): AnthropicResult => ({
  type: 'succeeded',
  message: message(input, output),
});

function setup(
  options: {
    modelId?: string;
    budget?: BudgetLimits;
    execution?: NativeExecutionContext;
    priceProvider?: typeof prices | null;
  } = {},
) {
  const server = fakeAnthropicBatches();
  const model = createAnthropic({ apiKey: 'k', fetch: server.fetch })(
    options.modelId ?? 'claude-haiku-5-5',
  );
  const execution =
    options.execution ?? createExecutionContext({ budget: options.budget ?? { usd: 5 } });
  const time = manualClock(1_000);
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  let n = 0;
  const batch = createBatchClient({
    model,
    execution,
    deps: {
      clock: time.clock,
      logger,
      generateId: () => `key${++n}`,
      ...(options.priceProvider === null ? {} : { priceProvider: options.priceProvider ?? prices }),
    },
  });
  return { server, model, execution, batch, logger };
}

describe('batch holds at submit', () => {
  it('reserves one hold per request, priced on the batch tier', async () => {
    const { execution, batch } = setup();
    const job = await batch.submit([
      { id: 'a', prompt: 'First question.', maxOutputTokens: 100 },
      { id: 'b', prompt: 'Second question.', maxOutputTokens: 200 },
    ]);
    expect(job.scopeId).toBe('root');
    const holds = job.requests.map((request) => request.hold!);
    expect(holds.map((hold) => hold.id)).toEqual(['root/batch/key1/a', 'root/batch/key1/b']);
    for (const [index, hold] of holds.entries()) {
      const output = [100, 200][index]!;
      const estimate = usage(hold.tokens - output, output);
      expect(hold.usd).toBe(
        priceUsage('claude-haiku-5-5', estimate, PRICES_2026, { tier: 'batch' }),
      );
      // The batch card, not the standard rates.
      expect(hold.usd).toBeLessThan(priceUsage('claude-haiku-5-5', estimate)!);
      expect(execution.ledger.get(hold.id)).toMatchObject({
        kind: 'batch',
        modelId: 'claude-haiku-5-5',
        state: 'reserved',
        reservation: { tokens: hold.tokens, usd: hold.usd },
      });
    }
    expect(execution.ledger.totals().reserved.usd).toBeCloseTo(holds[0]!.usd! + holds[1]!.usd!, 12);
  });

  it('takes a request’s executionEstimate as its hold', async () => {
    const { batch } = setup();
    const job = await batch.submit([
      { id: 'a', prompt: 'x', executionEstimate: { tokens: 777, usd: 0.5 } },
    ]);
    expect(job.requests[0]!.hold).toMatchObject({ tokens: 777, usd: 0.5 });
  });

  it('admits all requests or none, and sends nothing when one is refused', async () => {
    const { server, execution, batch } = setup({ budget: { tokens: 60_000 } });
    // The first hold (about 30,000 tokens) fits; the second does not.
    await expect(
      batch.submit([
        { id: 'a', prompt: 'x', maxOutputTokens: 30_000 },
        { id: 'b', prompt: 'y', maxOutputTokens: 30_000 },
      ]),
    ).rejects.toMatchObject({ name: 'BudgetLedgerError', code: 'budget_exceeded' });
    expect(server.calls).toHaveLength(0);
    expect(execution.ledger.totals().committed.tokens).toBe(0);
    expect(execution.ledger.snapshot().reservations.map((entry) => entry.state)).toEqual([
      'released',
    ]);
  });

  it('runs a model without a batch price under a USD budget, with one warning (decision 4)', async () => {
    const { execution, batch, logger } = setup({ modelId: 'claude-sonnet-4-5' });
    const job = await batch.submit([
      { id: 'a', prompt: 'x' },
      { id: 'b', prompt: 'y' },
    ]);
    expect(job.requests.map((request) => request.hold)).toEqual([
      expect.objectContaining({ unpriced: true }),
      expect.objectContaining({ unpriced: true }),
    ]);
    expect(job.requests[0]!.hold).not.toHaveProperty('usd');
    const warnings = job.warnings!.filter((warning) => warning.type === 'unpriced-model');
    expect(warnings).toEqual([
      {
        type: 'unpriced-model',
        setting: 'budget.usd',
        message:
          'claude-sonnet-4-5 has no batch price, so the USD budget does not count its batch requests.',
      },
    ]);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(execution.ledger.totals().unpriced).toBe(2);
  });

  it('refuses a model without a batch price under unknownPrice reject, before sending', async () => {
    const { server, batch } = setup({
      modelId: 'claude-sonnet-4-5',
      budget: { usd: 5, unknownPrice: 'reject' },
    });
    await expect(batch.submit([{ id: 'a', prompt: 'x' }])).rejects.toMatchObject({
      name: 'BudgetLedgerError',
      code: 'unpriced_model',
    });
    expect(server.calls).toHaveLength(0);
  });

  it('counts a batch without a price provider as unpriced', async () => {
    const { batch } = setup({ priceProvider: null });
    const job = await batch.submit([{ id: 'a', prompt: 'x' }]);
    expect(job.requests[0]!.hold).toMatchObject({ unpriced: true });
    expect(job.warnings).toContainEqual(
      expect.objectContaining({
        type: 'unpriced-model',
        message:
          'No deps.priceProvider is set, so the USD budget does not count batch requests to claude-haiku-5-5.',
      }),
    );
  });

  it('sends and reserves the placeholder cap of a row with no output limit under a bound (F12)', async () => {
    const server = fakeOpenAIBatches();
    const model = createOpenAIResponses({ apiKey: 'k', fetch: server.fetch })('gpt-6-astra');
    const execution = createExecutionContext({ budget: { tokens: 1_000_000 } });
    const batch = createBatchClient({ model, execution });
    const job = await batch.submit([{ id: 'a', prompt: 'x' }]);
    expect(server.inputLines(job.id)[0]!.body).toMatchObject({ max_output_tokens: 4096 });
    expect(job.requests[0]!.hold!.tokens).toBeGreaterThan(4096);
    expect(job.warnings).toContainEqual(expect.objectContaining({ setting: 'maxOutputTokens' }));
  });

  it('releases the holds when the provider refuses the batch', async () => {
    const execution = createExecutionContext({ budget: { usd: 5 } });
    const refusing = createAnthropic({
      apiKey: 'k',
      fetch: async () =>
        new Response(
          JSON.stringify({
            type: 'error',
            error: { type: 'invalid_request_error', message: 'no' },
          }),
          {
            status: 400,
          },
        ),
    })('claude-haiku-5-5');
    const client = createBatchClient({
      model: refusing,
      execution,
      deps: { priceProvider: prices },
    });
    await expect(client.submit([{ id: 'a', prompt: 'x' }])).rejects.toMatchObject({
      name: 'InvalidRequestError',
    });
    expect(execution.ledger.snapshot().reservations.map((entry) => entry.state)).toEqual([
      'released',
    ]);
  });

  it('keeps the holds as unknown when the batch call may have reached the provider', async () => {
    const execution = createExecutionContext({ budget: { usd: 5 } });
    const broken = createAnthropic({
      apiKey: 'k',
      fetch: async () => {
        throw new TypeError('socket hang up');
      },
    })('claude-haiku-5-5');
    const client = createBatchClient({ model: broken, execution, deps: { priceProvider: prices } });
    // A failure before any answer is a NetworkError (status 0): not a refusal.
    await expect(client.submit([{ id: 'a', prompt: 'x' }])).rejects.toMatchObject({
      name: 'NetworkError',
      statusCode: 0,
      cause: expect.objectContaining({ message: 'socket hang up' }),
    });
    expect(execution.ledger.snapshot().reservations.map((entry) => entry.state)).toEqual([
      'unknown',
    ]);
  });

  it('releases the holds when the OpenAI input upload fails: no batch can exist', async () => {
    const execution = createExecutionContext({ budget: { tokens: 10_000_000 } });
    const failing = createOpenAIResponses({
      apiKey: 'k',
      fetch: async () => new Response('upstream down', { status: 503 }),
    })('gpt-5.6-sol');
    const client = createBatchClient({ model: failing, execution });
    await expect(client.submit([{ id: 'a', prompt: 'x' }])).rejects.toMatchObject({
      statusCode: 503,
    });
    expect(execution.ledger.snapshot().reservations.map((entry) => entry.state)).toEqual([
      'released',
    ]);
  });
});

describe('batch settlement', () => {
  it('settles each hold from its result on the batch tier', async () => {
    const { server, execution, batch } = setup();
    const job = await batch.submit([
      { id: 'ok', prompt: 'x' },
      { id: 'bad', prompt: 'y' },
      { id: 'busy', prompt: 'z' },
      { id: 'stop', prompt: 'w' },
      { id: 'late', prompt: 'v' },
      { id: 'blank', prompt: 'u' },
    ]);
    const { usage: _omit, ...withoutUsage } = message();
    server.finish(job.id, {
      ok: ok(2000, 1000),
      bad: {
        type: 'errored',
        error: { type: 'error', error: { type: 'invalid_request_error', message: 'x' } },
      },
      busy: {
        type: 'errored',
        error: { type: 'error', error: { type: 'overloaded_error', message: 'x' } },
      },
      stop: { type: 'canceled' },
      late: { type: 'expired' },
      blank: { type: 'succeeded', message: withoutUsage },
    });
    const results = Object.fromEntries(
      (await batch.collect(job)).map((result) => [result.id, result]),
    );
    const hold = (id: string) =>
      execution.ledger.get(job.requests.find((request) => request.id === id)!.hold!.id)!;
    const cost = priceUsage('claude-haiku-5-5', usage(2000, 1000), PRICES_2026, { tier: 'batch' });
    expect(hold('ok')).toMatchObject({ state: 'settled', actual: { tokens: 3000, usd: cost } });
    expect(results.ok!.costUsd).toBe(cost);
    // Refused by the provider: never billed.
    expect(hold('bad').state).toBe('released');
    // A server-side failure may have been billed: the hold stays, unknown.
    expect(hold('busy').state).toBe('unknown');
    expect(hold('stop').state).toBe('released');
    expect(hold('late').state).toBe('released');
    // A reply without usage: its cost is unknown (F02).
    expect(hold('blank').state).toBe('unknown');
    expect(results.blank!.usageAvailable).toBe(false);
  });

  it('settles idempotently: reading the results again changes nothing', async () => {
    const inner = createInMemoryBudgetStore();
    const settle = vi.fn(inner.settle);
    const store = { ...inner, settle };
    const scope: PersistentBudgetScope = { key: 'user:1', limits: { usd: 10 } };
    const execution = createExecutionContext({
      budget: { usd: 5 },
      admission: { store, scopes: [scope] },
    });
    const { server, batch } = setup({ execution });
    const job = await batch.submit([
      { id: 'a', prompt: 'x' },
      { id: 'b', prompt: 'y' },
    ]);
    server.finish(job.id, { a: ok(2000, 1000), b: { type: 'expired' } });
    await batch.collect(job);
    const revision = execution.ledger.snapshot().revision;
    const totals = execution.ledger.totals();
    const held = await store.usage('user:1');
    expect(settle).toHaveBeenCalledTimes(1);
    settle.mockClear();
    await batch.collect(job);
    expect(execution.ledger.snapshot().revision).toBe(revision);
    expect(execution.ledger.totals()).toEqual(totals);
    expect(await store.usage('user:1')).toEqual(held);
    expect(settle).not.toHaveBeenCalled();
    expect(held.usd).toBe(
      priceUsage('claude-haiku-5-5', usage(2000, 1000), PRICES_2026, { tier: 'batch' }),
    );
  });

  it('releases the requests of a batch that failed validation (OpenAI)', async () => {
    const server = fakeOpenAIBatches();
    const model = createOpenAIResponses({ apiKey: 'k', fetch: server.fetch })('gpt-5.6-sol');
    const execution = createExecutionContext({ budget: { tokens: 10_000_000 } });
    const batch = createBatchClient({ model, execution });
    const job = await batch.submit([{ id: 'a', prompt: 'x' }]);
    server.setStatus(job.id, 'failed');
    await batch.collect(job);
    expect(execution.ledger.get(job.requests[0]!.hold!.id)!.state).toBe('released');
  });

  it('keeps the hold of a request a completed batch never answered', async () => {
    const { server, execution, batch } = setup();
    const job = await batch.submit([
      { id: 'a', prompt: 'x' },
      { id: 'b', prompt: 'y' },
    ]);
    server.finish(job.id, { a: ok() });
    await batch.collect(job);
    expect(execution.ledger.get(job.requests[1]!.hold!.id)!.state).toBe('unknown');
  });

  it('refuses to read a job with holds without an execution context', async () => {
    const { server, model, batch } = setup();
    const job = await batch.submit([{ id: 'a', prompt: 'x' }]);
    server.finish(job.id, { a: ok() });
    const bare = createBatchClient({ model });
    await expect(bare.collect(job)).rejects.toMatchObject({
      kind: 'invalid-job',
      message: /execution/,
    });
  });

  it('settles through a child context that shares the ledger', async () => {
    const { server, model, execution, batch } = setup();
    const job = await batch.submit([{ id: 'a', prompt: 'x' }]);
    server.finish(job.id, { a: ok() });
    const child = createBatchClient({ model, execution: execution.child({ scopeId: 'reader' }) });
    await child.collect(job);
    expect(execution.ledger.get(job.requests[0]!.hold!.id)!.state).toBe('settled');
  });
});

describe('resuming after a restart', () => {
  it('settles the holds in the BudgetStore from a fresh context and the job store', async () => {
    const budgetStore = createInMemoryBudgetStore();
    const jobs = createMemoryBatchJobStore();
    const scope: PersistentBudgetScope = { key: 'org:1', limits: { usd: 100, tokens: 10_000_000 } };
    const server = fakeAnthropicBatches();
    const model = createAnthropic({ apiKey: 'k', fetch: server.fetch })('claude-haiku-5-5');

    // Process A submits and dies.
    const before = createExecutionContext({ admission: { store: budgetStore, scopes: [scope] } });
    const first = createBatchClient({
      model,
      execution: before,
      store: jobs,
      deps: { priceProvider: prices },
    });
    const job = await first.submit([
      { id: 'a', prompt: 'x' },
      { id: 'b', prompt: 'y' },
    ]);
    const held = await budgetStore.usage('org:1');
    const estimate = job.requests.reduce((sum, request) => sum + request.hold!.tokens, 0);
    expect(held.tokens).toBe(estimate);

    // Process B: a fresh ledger on the same persistent scopes.
    server.finish(job.id, { a: ok(2000, 1000), b: { type: 'expired' } });
    const after = createExecutionContext({ admission: { store: budgetStore, scopes: [scope] } });
    const second = createBatchClient({
      model,
      execution: after,
      store: jobs,
      deps: { priceProvider: prices },
    });
    const [open] = await second.pending();
    expect(open!.id).toBe(job.id);
    await second.collect(open!);
    const cost = priceUsage('claude-haiku-5-5', usage(2000, 1000), PRICES_2026, { tier: 'batch' })!;
    // The store holds the actual usage only: no estimate is left, nothing counted twice.
    expect(await budgetStore.usage('org:1')).toEqual({ tokens: 3000, usd: cost });
    expect(after.ledger.get(job.requests[0]!.hold!.id)).toMatchObject({ state: 'settled' });
    expect(after.ledger.get(job.requests[1]!.hold!.id)).toMatchObject({ state: 'released' });
    expect(await second.pending()).toEqual([]);
  });

  it('settles the holds of a context restored from its snapshot', async () => {
    const server = fakeAnthropicBatches();
    const model = createAnthropic({ apiKey: 'k', fetch: server.fetch })('claude-haiku-5-5');
    const before = createExecutionContext({ budget: { usd: 5 } });
    const job = await createBatchClient({
      model,
      execution: before,
      deps: { priceProvider: prices },
    }).submit([{ id: 'a', prompt: 'x' }]);
    const saved = JSON.parse(JSON.stringify(before.snapshot()));
    server.finish(job.id, { a: ok() });
    const restored = createExecutionContext({ snapshot: saved });
    await createBatchClient({
      model,
      execution: restored,
      deps: { priceProvider: prices },
    }).collect(JSON.parse(JSON.stringify(job)) as BatchJob);
    expect(restored.ledger.get(job.requests[0]!.hold!.id)!.state).toBe('settled');
    expect(restored.ledger.totals().reserved.usd).toBe(0);
  });

  it('refuses to re-reserve a hold the ledger does not know under another scope', async () => {
    const { server, model, batch } = setup();
    const job = await batch.submit([{ id: 'a', prompt: 'x' }]);
    server.finish(job.id, { a: ok() });
    const elsewhere = createExecutionContext({ budget: { usd: 5 }, scopeId: 'other' });
    const client = createBatchClient({
      model,
      execution: elsewhere,
      deps: { priceProvider: prices },
    });
    await expect(client.collect(job)).rejects.toMatchObject({
      kind: 'invalid-job',
      message: /scope/,
    });
  });

  // A fresh context adopts the job's holds without its own budget admission:
  // the provider already ran (and billed) the requests, so refusing a hold
  // would only hide the spend and leave the results unreadable (W2a S5-1).
  function restart() {
    const budgetStore = createInMemoryBudgetStore();
    const jobs = createMemoryBatchJobStore();
    const scope: PersistentBudgetScope = { key: 'org:1', limits: { usd: 100, tokens: 10_000_000 } };
    const server = fakeAnthropicBatches();
    const model = createAnthropic({ apiKey: 'k', fetch: server.fetch })('claude-haiku-5-5');
    /** One process: its own context of the same scope, budget and persistent scopes. */
    const start = (budget: BudgetLimits) => {
      const execution = createExecutionContext({
        budget,
        admission: { store: budgetStore, scopes: [scope] },
      });
      const batch = createBatchClient({
        model,
        execution,
        store: jobs,
        deps: { priceProvider: prices },
      });
      return { execution, batch };
    };
    return { budgetStore, server, start };
  }

  it('reads every result of a fresh context whose budget the actual usage exceeds', async () => {
    const { budgetStore, server, start } = restart();
    // Process A: two holds of $0.0002 fit its $0.0005 budget; then it dies.
    const a = start({ usd: 0.0005 });
    const job = await a.batch.submit([
      { id: 'a', prompt: 'x', executionEstimate: { tokens: 3000, usd: 0.0002 } },
      { id: 'b', prompt: 'y', executionEstimate: { tokens: 3000, usd: 0.0002 } },
    ]);
    // The provider bills each request more than its estimate.
    server.finish(job.id, { a: ok(2000, 1000), b: ok(2000, 1000) });
    const cost = priceUsage('claude-haiku-5-5', usage(2000, 1000), PRICES_2026, { tier: 'batch' })!;
    expect(cost).toBeGreaterThan(0.0002);

    // Process B: a's actual cost leaves no room in its budget for b's hold.
    const b = start({ usd: 0.0005 });
    const [open] = await b.batch.pending();
    expect(open!.id).toBe(job.id);
    const results = await b.batch.collect(open!);
    expect(results.map((result) => [result.id, result.status])).toEqual([
      ['a', 'succeeded'],
      ['b', 'succeeded'],
    ]);
    for (const request of job.requests)
      expect(b.execution.ledger.get(request.hold!.id)).toMatchObject({ state: 'settled' });
    // The overage counts in B as it would in A: new work is refused.
    expect(b.execution.ledger.totals().spent.usd).toBeCloseTo(2 * cost, 12);
    await expect(
      b.execution.reserve({ requestId: 'next', modelId: 'claude-haiku-5-5', tokens: 1, usd: 0 }),
    ).rejects.toMatchObject({ code: 'budget_exceeded' });
    // The store holds what the provider billed, each request once.
    expect((await budgetStore.usage('org:1')).usd).toBeCloseTo(2 * cost, 12);
    expect(await b.batch.pending()).toEqual([]);
  });

  it('reads an old job after the fresh context reserved other work first', async () => {
    const { server, start } = restart();
    const a = start({ usd: 1 });
    const old = await a.batch.submit([
      { id: 'a', prompt: 'x', executionEstimate: { tokens: 1000, usd: 0.3 } },
    ]);
    server.finish(old.id, { a: ok(200, 100) });

    // After a restart the worker submits tonight's batch, then reads last night's.
    const b = start({ usd: 1 });
    await b.batch.submit([{ id: 'n', prompt: 'z', executionEstimate: { tokens: 1000, usd: 0.8 } }]);
    const open = (await b.batch.pending()).find((job) => job.id === old.id);
    await expect(b.batch.collect(open!)).resolves.toMatchObject([{ id: 'a', status: 'succeeded' }]);
    expect(b.execution.ledger.get(old.requests[0]!.hold!.id)).toMatchObject({ state: 'settled' });
  });

  it('settles, releases or keeps every adopted hold, however full the fresh budget is', async () => {
    const { budgetStore, server, start } = restart();
    const a = start({ usd: 1 });
    const job = await a.batch.submit([
      { id: 'ok', prompt: 'x', executionEstimate: { tokens: 1000, usd: 0.2 } },
      { id: 'late', prompt: 'y', executionEstimate: { tokens: 1000, usd: 0.2 } },
      { id: 'busy', prompt: 'z', executionEstimate: { tokens: 1000, usd: 0.2 } },
    ]);
    server.finish(job.id, {
      ok: ok(200, 100),
      late: { type: 'expired' },
      busy: {
        type: 'errored',
        error: { type: 'error', error: { type: 'overloaded_error', message: 'x' } },
      },
    });

    // B's own budget is already committed in full when it reads the job.
    const b = start({ usd: 1 });
    await b.execution.reserve({
      requestId: 'other',
      modelId: 'claude-haiku-5-5',
      usd: 1,
      tokens: 1,
    });
    const results = await b.batch.collect((await b.batch.pending())[0]!);
    expect(results.map((result) => result.status)).toEqual(['succeeded', 'expired', 'errored']);
    const hold = (id: string) =>
      b.execution.ledger.get(job.requests.find((request) => request.id === id)!.hold!.id)!;
    expect(hold('ok').state).toBe('settled');
    expect(hold('late').state).toBe('released');
    // A server-side failure may have been billed: its hold stays, at its estimate.
    expect(hold('busy')).toMatchObject({ state: 'unknown', reservation: { usd: 0.2 } });
    const cost = priceUsage('claude-haiku-5-5', usage(200, 100), PRICES_2026, { tier: 'batch' })!;
    // The store: the billed request, the hold kept for `busy` and B's own work, each once.
    expect((await budgetStore.usage('org:1')).usd).toBeCloseTo(cost + 0.2 + 1, 12);
  });

  it('refuses a hold the BudgetStore recorded with other amounts', async () => {
    const { budgetStore, server, start } = restart();
    const a = start({ usd: 1 });
    const job = await a.batch.submit([
      { id: 'a', prompt: 'x', executionEstimate: { tokens: 1000, usd: 0.2 } },
    ]);
    server.finish(job.id, { a: ok(200, 100) });
    const held = await budgetStore.usage('org:1');
    const request = job.requests[0]!;
    const altered: BatchJob = {
      ...job,
      requests: [{ ...request, hold: { ...request.hold!, usd: 0.1 } }],
    };
    const b = start({ usd: 1 });
    await expect(b.batch.collect(altered)).rejects.toMatchObject({
      name: 'BudgetLedgerError',
      code: 'reservation_conflict',
    });
    expect(b.execution.ledger.get(request.hold!.id)).toBeUndefined();
    expect(await budgetStore.usage('org:1')).toEqual(held);
  });
});
