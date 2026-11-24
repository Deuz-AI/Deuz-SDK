import { describe, expect, it } from 'vitest';
import { generateText, streamText, wrapLanguageModel } from 'ai';
import { MockLanguageModelV4, convertArrayToReadableStream } from 'ai/test';
import {
  APICallError,
  type LanguageModelV4GenerateResult,
  type LanguageModelV4StreamPart,
  type LanguageModelV4Usage,
} from '@ai-sdk/provider';
import { BreakerOpenError } from '@deuz-sdk/core';
import { createInMemoryBudgetStore } from '@deuz-sdk/core/agent';
import {
  DeuzBudgetError,
  deuz,
  deuzMiddleware,
  defaultPriceKey,
  type DeuzCostReceipt,
} from '../src/index';

const usage = (input: number, output: number): LanguageModelV4Usage => ({
  inputTokens: { total: input, noCache: input, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: output, text: output, reasoning: undefined },
});

const answer = (text: string, used = usage(1_000, 500)): LanguageModelV4GenerateResult => ({
  content: [{ type: 'text', text }],
  finishReason: { unified: 'stop', raw: 'stop' },
  usage: used,
  warnings: [],
});

const parts = (text: string, used = usage(1_000, 500)): LanguageModelV4StreamPart[] => [
  { type: 'stream-start', warnings: [] },
  { type: 'text-start', id: 't' },
  { type: 'text-delta', id: 't', delta: text },
  { type: 'text-end', id: 't' },
  { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage: used },
];

const apiError = (statusCode: number) =>
  new APICallError({
    message: `HTTP ${statusCode}`,
    url: 'https://example.test',
    requestBodyValues: {},
    statusCode,
    isRetryable: statusCode >= 500,
  });

// gpt-5-mini: $0.25 / M input, $2 / M output → 1 000 in + 500 out = $0.00125.
const MINI_COST = 0.00125;

describe('deuz() with generateText', () => {
  it('settles the measured usage in the persistent store and emits a measured receipt', async () => {
    const store = createInMemoryBudgetStore();
    const receipts: DeuzCostReceipt[] = [];
    const model = deuz(
      new MockLanguageModelV4({ modelId: 'gpt-5-mini', doGenerate: answer('hi') }),
      {
        budget: { store, scopes: [{ key: 'user:1', limits: { usd: 1 } }] },
        onCost: (receipt) => receipts.push(receipt),
      },
    );

    const result = await generateText({ model, prompt: 'Hello' });

    expect(result.text).toBe('hi');
    expect(await store.usage('user:1')).toEqual({ tokens: 1_500, usd: MINI_COST });
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({
      source: 'measured',
      operation: 'generate',
      priceKey: 'gpt-5-mini',
      tokens: 1_500,
      usd: MINI_COST,
      unpriced: false,
      settled: true,
    });
    expect(result.providerMetadata?.deuz).toMatchObject({ source: 'measured', usd: MINI_COST });
  });

  it('refuses a call at the ceiling with a non-retryable DeuzBudgetError, before the model runs', async () => {
    const inner = new MockLanguageModelV4({ modelId: 'gpt-5-mini', doGenerate: answer('never') });
    const model = deuz(inner, {
      budget: {
        store: createInMemoryBudgetStore(),
        scopes: [{ key: 'u', limits: { usd: 0.001 } }],
      },
    });

    // Default maxRetries (2): a retryable error would be retried; this one is not.
    const error = await generateText({ model, prompt: 'Hello' }).catch((e: unknown) => e);

    expect(DeuzBudgetError.isInstance(error)).toBe(true);
    expect(error).toMatchObject({
      code: 'budget_exceeded',
      isRetryable: false,
      priceKey: 'gpt-5-mini',
    });
    expect(inner.doGenerateCalls).toHaveLength(0);
  });

  it('shares one ceiling across wrappers (processes) through the same store', async () => {
    const store = createInMemoryBudgetStore();
    const budget = { store, scopes: [{ key: 'org:acme', limits: { usd: 0.003 } }] };
    const make = () =>
      deuz(
        new MockLanguageModelV4({
          modelId: 'gpt-5-mini',
          doGenerate: answer('ok', usage(1_000, 900)),
        }),
        {
          budget,
        },
      );

    // Estimate ≈ $0.002 fits; the actual $0.00205 settles.
    await generateText({ model: make(), prompt: 'One', maxOutputTokens: 1_000 });
    const second = generateText({ model: make(), prompt: 'Two', maxOutputTokens: 1_000 });

    await expect(second).rejects.toMatchObject({
      name: 'DeuzBudgetError',
      code: 'budget_exceeded',
    });
    expect((await store.usage('org:acme')).usd).toBeCloseTo(0.00205, 9);
  });

  it("follows unknownPrice: 'reject' refuses an unpriced model, 'warn' runs it and budgets its tokens", async () => {
    const mystery = () =>
      new MockLanguageModelV4({ modelId: 'mystery-model', doGenerate: answer('?') });

    const strict = deuz(mystery(), { budget: { usd: 1, unknownPrice: 'reject' } });
    await expect(generateText({ model: strict, prompt: 'Hi' })).rejects.toMatchObject({
      code: 'unpriced_model',
    });

    const receipts: DeuzCostReceipt[] = [];
    const lenient = deuz(mystery(), { budget: { usd: 1 }, onCost: (r) => receipts.push(r) });
    const result = await generateText({ model: lenient, prompt: 'Hi' });
    expect(receipts[0]).toMatchObject({ unpriced: true, usd: undefined, tokens: 1_500 });
    expect(lenient.ledger.totals().spent.tokens).toBe(1_500);
    expect(
      result.warnings?.some((w) => w.type === 'other' && w.message.includes('mystery-model')),
    ).toBe(true);
  });

  it('prices an unknown model id through the priceKey override and maps Bedrock/Vertex ids', async () => {
    const receipts: DeuzCostReceipt[] = [];
    const model = deuz(
      new MockLanguageModelV4({
        provider: 'azure.chat',
        modelId: 'prod-deployment',
        doGenerate: answer('x'),
      }),
      { priceKey: 'gpt-5-mini', onCost: (r) => receipts.push(r) },
    );
    await generateText({ model, prompt: 'Hi' });
    expect(receipts[0]).toMatchObject({ priceKey: 'gpt-5-mini', usd: MINI_COST, unpriced: false });

    expect(
      defaultPriceKey({
        provider: 'amazon-bedrock',
        modelId: 'us.anthropic.claude-sonnet-4-5-20250929-v1:0',
      }),
    ).toBe('claude-sonnet-4-5-20250929');
    expect(
      defaultPriceKey({ provider: 'google.vertex.anthropic', modelId: 'claude-opus-4-1@20250805' }),
    ).toBe('claude-opus-4-1');
  });

  it('releases the hold of a call the provider rejected with a 4xx', async () => {
    const store = createInMemoryBudgetStore();
    const model = deuz(
      new MockLanguageModelV4({
        modelId: 'gpt-5-mini',
        doGenerate: async () => {
          throw apiError(400);
        },
      }),
      { budget: { store, scopes: [{ key: 'u', limits: { usd: 1 } }] } },
    );
    await expect(generateText({ model, prompt: 'Hi', maxRetries: 0 })).rejects.toBeInstanceOf(
      APICallError,
    );
    expect(await store.usage('u')).toEqual({ tokens: 0, usd: 0 });
  });

  it('fails over to the next model on a 5xx before the first byte', async () => {
    const receipts: DeuzCostReceipt[] = [];
    const hops: string[] = [];
    const model = deuz(
      new MockLanguageModelV4({
        modelId: 'gpt-5-mini',
        doGenerate: async () => {
          throw apiError(503);
        },
      }),
      {
        fallbackModels: [
          new MockLanguageModelV4({ modelId: 'gpt-5-nano', doGenerate: answer('backup') }),
        ],
        onCost: (r) => receipts.push(r),
        onFallback: ({ to }) => hops.push(to.modelId),
      },
    );
    const result = await generateText({ model, prompt: 'Hi', maxRetries: 0 });

    expect(result.text).toBe('backup');
    expect(hops).toEqual(['gpt-5-nano']);
    expect(receipts[0]).toMatchObject({
      modelId: 'gpt-5-nano',
      failedOver: { from: 'mock-provider:gpt-5-mini', reason: 'http_503' },
    });
  });

  it('opens the circuit breaker after 5 provider failures and half-opens after 30 s', async () => {
    let now = 1_000_000;
    const inner = new MockLanguageModelV4({
      modelId: 'gpt-5-mini',
      doGenerate: async () => {
        throw apiError(500);
      },
    });
    const model = deuz(inner, { clock: { now: () => now } });

    for (let i = 0; i < 5; i++)
      await expect(generateText({ model, prompt: 'Hi', maxRetries: 0 })).rejects.toBeInstanceOf(
        APICallError,
      );
    await expect(generateText({ model, prompt: 'Hi', maxRetries: 0 })).rejects.toBeInstanceOf(
      BreakerOpenError,
    );
    expect(inner.doGenerateCalls).toHaveLength(5);

    now += 30_001;
    await expect(generateText({ model, prompt: 'Hi', maxRetries: 0 })).rejects.toBeInstanceOf(
      APICallError,
    );
    expect(inner.doGenerateCalls).toHaveLength(6);
  });
});

describe('deuz() with streamText', () => {
  it('settles the usage when the finish part arrives', async () => {
    const store = createInMemoryBudgetStore();
    const receipts: DeuzCostReceipt[] = [];
    const model = deuz(
      new MockLanguageModelV4({
        modelId: 'gpt-5-mini',
        doStream: async () => ({ stream: convertArrayToReadableStream(parts('streamed')) }),
      }),
      {
        budget: { store, scopes: [{ key: 'u', limits: { usd: 1 } }] },
        onCost: (r) => receipts.push(r),
      },
    );

    const result = streamText({ model, prompt: 'Hello' });
    expect(await result.text).toBe('streamed');
    expect(await store.usage('u')).toEqual({ tokens: 1_500, usd: MINI_COST });
    expect(receipts[0]).toMatchObject({ operation: 'stream', source: 'measured', usd: MINI_COST });
    expect((await result.providerMetadata)?.deuz).toMatchObject({ source: 'measured' });
  });

  it('surfaces the ceiling as an error part and through onError', async () => {
    const inner = new MockLanguageModelV4({
      modelId: 'gpt-5-mini',
      doStream: async () => ({ stream: convertArrayToReadableStream(parts('never')) }),
    });
    const model = deuz(inner, { budget: { usd: 0.0001 } });
    const errors: unknown[] = [];

    const result = streamText({
      model,
      prompt: 'Hello',
      onError: ({ error }) => void errors.push(error),
    });
    const seen: { type: string; error?: unknown }[] = [];
    for await (const part of result.fullStream)
      seen.push(part as { type: string; error?: unknown });

    const errorPart = seen.find((part) => part.type === 'error');
    expect(DeuzBudgetError.isInstance(errorPart?.error)).toBe(true);
    expect(DeuzBudgetError.isInstance(errors[0])).toBe(true);
    expect(inner.doStreamCalls).toHaveLength(0);
  });

  it('fails over on an error before the first byte, but not after content', async () => {
    const backup = () =>
      new MockLanguageModelV4({
        modelId: 'gpt-5-nano',
        doStream: async () => ({ stream: convertArrayToReadableStream(parts('backup')) }),
      });
    const early = deuz(
      new MockLanguageModelV4({
        modelId: 'gpt-5-mini',
        doStream: async () => ({
          stream: convertArrayToReadableStream<LanguageModelV4StreamPart>([
            { type: 'stream-start', warnings: [] },
            { type: 'error', error: apiError(503) },
          ]),
        }),
      }),
      { fallbackModels: [backup()] },
    );
    expect(await streamText({ model: early, prompt: 'Hi', maxRetries: 0 }).text).toBe('backup');

    const lateBackup = backup();
    const late = deuz(
      new MockLanguageModelV4({
        modelId: 'gpt-5-mini',
        doStream: async () => ({
          stream: convertArrayToReadableStream<LanguageModelV4StreamPart>([
            { type: 'stream-start', warnings: [] },
            { type: 'text-start', id: 't' },
            { type: 'text-delta', id: 't', delta: 'partial' },
            { type: 'error', error: apiError(503) },
          ]),
        }),
      }),
      { fallbackModels: [lateBackup] },
    );
    const types: string[] = [];
    for await (const part of streamText({
      model: late,
      prompt: 'Hi',
      maxRetries: 0,
      onError: () => {},
    }).fullStream)
      types.push(part.type);
    expect(types).toContain('error');
    expect(lateBackup.doStreamCalls).toHaveLength(0);
  });
});

describe('deuzMiddleware()', () => {
  it('guards a model through wrapLanguageModel with an in-process token budget', async () => {
    const middleware = deuzMiddleware({ budget: { tokens: 100 } });
    const model = wrapLanguageModel({
      model: new MockLanguageModelV4({
        modelId: 'gpt-5-mini',
        doGenerate: answer('small', usage(5, 10)),
      }),
      middleware,
    });

    // Prompt ≈ 5 tokens + 50 output reserved: fits, then settles 15.
    expect((await generateText({ model, prompt: 'Hi', maxOutputTokens: 50 })).text).toBe('small');
    expect(middleware.ledger.totals().spent.tokens).toBe(15);
    // Without maxOutputTokens 4 096 output tokens are reserved: refused.
    await expect(generateText({ model, prompt: 'Hi' })).rejects.toMatchObject({
      code: 'budget_exceeded',
    });
  });
});
