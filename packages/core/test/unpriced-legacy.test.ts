// Decision 4 in the legacy loops (2.3, F13): generateText/streamChat under a
// `budget.usd` report a model with no price once and keep running, or refuse
// it before the call with `budget.unknownPrice: 'reject'`.
import { describe, expect, it } from 'vitest';
import { generateText, streamChat } from '../src/generate';
import { createMockModel } from '../src/testing';
import { attachConfig, readConfig } from '../src/internal/config-symbol';
import { UnpricedModelError } from '../src/internal/unpriced-error';
import type { LanguageModel } from '../src/types/model';
import type { StreamPart } from '../src/types/stream';

const schema = { type: 'object' as const, properties: {} };
const tools = { noop: { parameters: schema, execute: () => 'ok' } };
const prices = { priceUsage: (model: string) => (model === 'priced-model' ? 0.01 : undefined) };

function counted(): { model: LanguageModel; calls: () => number } {
  const base = createMockModel({ responses: [{ toolCalls: [{ toolName: 'noop', args: {} }] }] });
  const config = readConfig(base)!;
  let calls = 0;
  const model = attachConfig(
    { ...base },
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

describe('legacy agentic loop with an unpriced model under budget.usd (decision 4)', () => {
  it('runs every step and reports one unpriced-model warning (t4 case 1)', async () => {
    const { model, calls } = counted();
    const result = await generateText({
      model,
      prompt: 'go',
      tools,
      maxSteps: 3,
      budget: { usd: 0.003 },
      deps: { priceProvider: prices },
    });
    expect(calls()).toBe(3);
    expect(result.warnings?.filter((w) => w.type === 'unpriced-model')).toEqual([
      expect.objectContaining({
        setting: 'budget.usd',
        message: expect.stringContaining('mock-model'),
      }),
    ]);
  });

  it('streams the warning as a part (t4b)', async () => {
    const { model } = counted();
    const parts: StreamPart[] = [];
    const res = streamChat({
      model,
      prompt: 'go',
      tools,
      maxSteps: 2,
      budget: { usd: 0.003 },
      deps: { priceProvider: prices },
    });
    for await (const part of res.fullStream) parts.push(part);
    expect(
      parts.filter((p) => p.type === 'warning' && p.warning.type === 'unpriced-model'),
    ).toHaveLength(1);
    expect((await res.warnings)?.filter((w) => w.type === 'unpriced-model')).toHaveLength(1);
  });

  it("refuses the model before any call under unknownPrice 'reject'", async () => {
    const { model, calls } = counted();
    const error = await generateText({
      model,
      prompt: 'go',
      tools,
      maxSteps: 3,
      budget: { usd: 1, unknownPrice: 'reject' },
      deps: { priceProvider: prices },
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(UnpricedModelError);
    expect(error).toMatchObject({ code: 'unpriced_model', modelId: 'mock-model' });
    expect(calls()).toBe(0);
  });

  it('treats a missing priceProvider as no price', async () => {
    const { model } = counted();
    const result = await generateText({
      model,
      prompt: 'go',
      tools,
      maxSteps: 1,
      budget: { usd: 1 },
    });
    expect(result.warnings?.find((w) => w.type === 'unpriced-model')?.message).toContain(
      'No deps.priceProvider',
    );
  });
});
