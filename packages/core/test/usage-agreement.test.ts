// F02 Kabul (2.3): one call's cost is the same whichever path counts it — the
// price of the usage the adapter reported, the legacy loop's cost (its `cost`
// parts), a single-turn call's `cost` part and the native ledger's totals — on
// cached and uncached turns, and they are all unknown together when the
// provider reported no usage or the stream ended before its usage arrived.
import { describe, expect, it } from 'vitest';
import { generateText, streamChat } from '../src/generate';
import { createAnthropic } from '../src/anthropic';
import { createOpenAI, createOpenAIResponses } from '../src/openai';
import { createGoogleNative } from '../src/google';
import { createExecutionContext } from '../src/execution-policy';
import { createPriceProvider } from '../src/pricing';
import { sseEvents, sseResponse } from './fixtures/sse';
import type { LanguageModel, Provider } from '../src/types/model';
import type { StreamPart } from '../src/types/stream';
import type { Usage } from '../src/types/usage';
import type { UsageMeta } from '../src/types/deps';

type Events = { event?: string; data: unknown }[];
type Fixture = 'uncached' | 'cached' | 'missing usage' | 'partial stream';

const MODEL = 'agreement-model';
/** USD per 1M tokens, every rate distinct so a misplaced bucket shows. */
const priceProvider = createPriceProvider({
  table: { [MODEL]: { input: 2, output: 10, cachedRead: 0.2, cacheWrite: 2.5, cacheWrite1h: 4 } },
});

const text = (delta: string): Events => [
  { data: { choices: [{ index: 0, delta: { content: delta } }] } },
];

const WIRES: Record<
  string,
  {
    factory: (s: { apiKey: string; fetch: typeof fetch }) => Provider;
    turns: Record<Fixture, Events>;
  }
> = {
  anthropic: {
    factory: createAnthropic,
    turns: (() => {
      const start = (usage?: Record<string, number>) => ({
        event: 'message_start',
        data: { type: 'message_start', message: usage ? { usage } : {} },
      });
      const block: Events = [
        {
          event: 'content_block_start',
          data: {
            type: 'content_block_start',
            index: 0,
            content_block: { type: 'text', text: '' },
          },
        },
        {
          event: 'content_block_delta',
          data: {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'text_delta', text: 'ok' },
          },
        },
      ];
      const end = (output?: number): Events => [
        {
          event: 'message_delta',
          data: {
            type: 'message_delta',
            delta: { stop_reason: 'end_turn' },
            ...(output !== undefined ? { usage: { output_tokens: output } } : {}),
          },
        },
        { event: 'message_stop', data: { type: 'message_stop' } },
      ];
      return {
        uncached: [start({ input_tokens: 100, output_tokens: 1 }), ...block, ...end(50)],
        cached: [
          start({
            input_tokens: 100,
            cache_read_input_tokens: 400,
            cache_creation_input_tokens: 200,
            output_tokens: 1,
          }),
          ...block,
          ...end(50),
        ],
        'missing usage': [start(), ...block, ...end()],
        'partial stream': [start({ input_tokens: 100, output_tokens: 1 }), ...block],
      };
    })(),
  },
  responses: {
    factory: createOpenAIResponses,
    turns: (() => {
      const delta = { data: { type: 'response.output_text.delta', delta: 'ok' } };
      const completed = (usage?: Record<string, unknown>) => ({
        data: { type: 'response.completed', response: usage ? { usage } : {} },
      });
      return {
        uncached: [delta, completed({ input_tokens: 100, output_tokens: 50, total_tokens: 150 })],
        cached: [
          delta,
          completed({
            input_tokens: 500,
            input_tokens_details: { cached_tokens: 400 },
            output_tokens: 50,
            total_tokens: 550,
          }),
        ],
        'missing usage': [delta, completed()],
        'partial stream': [delta],
      };
    })(),
  },
  chat: {
    factory: createOpenAI,
    turns: (() => {
      const stop = { data: { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] } };
      const usage = (u: Record<string, unknown>) => ({ data: { choices: [], usage: u } });
      const done = { data: '[DONE]' };
      return {
        uncached: [
          ...text('ok'),
          stop,
          usage({ prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 }),
          done,
        ],
        cached: [
          ...text('ok'),
          stop,
          usage({
            prompt_tokens: 500,
            prompt_tokens_details: { cached_tokens: 400 },
            completion_tokens: 50,
            total_tokens: 550,
          }),
          done,
        ],
        'missing usage': [...text('ok'), stop, done],
        'partial stream': text('ok'),
      };
    })(),
  },
  native: {
    factory: createGoogleNative,
    turns: (() => {
      const chunk = (finish: boolean, usageMetadata?: Record<string, number>) => ({
        data: {
          candidates: [
            {
              content: { role: 'model', parts: [{ text: 'ok' }] },
              ...(finish ? { finishReason: 'STOP' } : {}),
            },
          ],
          ...(usageMetadata ? { usageMetadata } : {}),
        },
      });
      return {
        uncached: [
          chunk(true, { promptTokenCount: 100, candidatesTokenCount: 50, totalTokenCount: 150 }),
        ],
        cached: [
          chunk(true, {
            promptTokenCount: 500,
            cachedContentTokenCount: 400,
            candidatesTokenCount: 50,
            totalTokenCount: 550,
          }),
        ],
        'missing usage': [chunk(true)],
        'partial stream': [chunk(false)],
      };
    })(),
  },
};

const FIXTURES: Fixture[] = ['uncached', 'cached', 'missing usage', 'partial stream'];

function modelFor(wire: string, fixture: Fixture): LanguageModel {
  const { factory, turns } = WIRES[wire]!;
  return factory({
    apiKey: 'k',
    fetch: (async () => sseResponse([sseEvents(turns[fixture])])) as typeof fetch,
  })(MODEL);
}

const costs = (parts: StreamPart[]): number[] =>
  parts.flatMap((part) => (part.type === 'cost' ? [part.costUsd] : []));

async function drain(stream: AsyncIterable<StreamPart>): Promise<StreamPart[]> {
  const parts: StreamPart[] = [];
  for await (const part of stream) parts.push(part);
  return parts;
}

/** Every path's view of one call's cost; `undefined` = unknown. */
async function paths(wire: string, fixture: Fixture) {
  // The usage the adapter reported, and whether it was the provider's.
  const reported: { usage: Usage; meta: UsageMeta }[] = [];
  const legacy = streamChat({
    model: modelFor(wire, fixture),
    prompt: 'hi',
    tools: { noop: { parameters: { type: 'object', properties: {} }, execute: () => 'ok' } },
    maxSteps: 1,
    onUsage: (usage, meta) => reported.push({ usage, meta }),
    deps: { priceProvider },
  });
  const legacyCosts = costs(await drain(legacy.fullStream));

  const single = streamChat({
    model: modelFor(wire, fixture),
    prompt: 'hi',
    deps: { priceProvider },
  });
  const singleCosts = costs(await drain(single.fullStream));

  const execution = createExecutionContext({ budget: { usd: 100 } });
  await generateText({
    model: modelFor(wire, fixture),
    prompt: 'hi',
    execution,
    deps: { priceProvider },
  });
  const totals = execution.ledger.totals();

  expect(reported).toHaveLength(1);
  const [{ usage, meta }] = reported as [{ usage: Usage; meta: UsageMeta }];
  return {
    available: meta.usageAvailable !== false,
    price: meta.usageAvailable === false ? undefined : await priceProvider.priceUsage(MODEL, usage),
    legacy: legacyCosts.at(-1),
    single: singleCosts.at(-1),
    ledger: totals.unknownUsd === 0 ? totals.spent.usd : undefined,
    unknownUsd: totals.unknownUsd,
  };
}

describe('F02: price, legacy cost and ledger totals agree for every adapter', () => {
  for (const wire of Object.keys(WIRES)) {
    describe(wire, () => {
      for (const fixture of FIXTURES) {
        it(fixture, async () => {
          const seen = await paths(wire, fixture);
          if (fixture === 'uncached' || fixture === 'cached') {
            expect(seen.available).toBe(true);
            expect(seen.price).toBeGreaterThan(0);
            expect(seen).toEqual({
              available: true,
              price: seen.price,
              legacy: seen.price,
              single: seen.price,
              ledger: seen.price,
              unknownUsd: 0,
            });
          } else {
            // Before: the legacy loop and the single-turn cost part priced the
            // zeros as a known $0 while the ledger kept the call unknown.
            expect(seen).toEqual({
              available: false,
              price: undefined,
              legacy: undefined,
              single: undefined,
              ledger: undefined,
              unknownUsd: 1,
            });
          }
        });
      }
    });
  }

  it('the cached fixtures bill their cache buckets', async () => {
    const plain = await paths('anthropic', 'uncached');
    const cached = await paths('anthropic', 'cached');
    // 400 cache reads at $0.2/M and 200 cache writes at $2.5/M on top.
    expect(cached.price! - plain.price!).toBeCloseTo(0.00058, 6);
  });
});

describe('F02: a call without usage under the legacy budget.usd', () => {
  it('leaves the loop cost unknown instead of counting a free call', async () => {
    const model = createOpenAI({
      apiKey: 'k',
      fetch: (async () =>
        sseResponse([
          sseEvents([
            {
              data: {
                choices: [
                  {
                    index: 0,
                    delta: {
                      tool_calls: [
                        {
                          index: 0,
                          id: 'call_1',
                          type: 'function',
                          function: { name: 'noop', arguments: '{}' },
                        },
                      ],
                    },
                  },
                ],
              },
            },
            { data: { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] } },
            { data: '[DONE]' },
          ]),
        ])) as typeof fetch,
    })(MODEL);
    const run = (native: boolean) =>
      streamChat({
        model,
        prompt: 'go',
        tools: { noop: { parameters: { type: 'object', properties: {} }, execute: () => 'ok' } },
        maxSteps: 2,
        ...(native ? { execution: createExecutionContext({ budget: { usd: 100 } }) } : {}),
        deps: { priceProvider },
      });
    const legacy = costs(await drain(run(false).fullStream));
    const native = costs(await drain(run(true).fullStream));
    expect(native).toEqual([]);
    expect(legacy).toEqual(native);
  });
});
