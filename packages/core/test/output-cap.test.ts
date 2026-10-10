import { describe, expect, it } from 'vitest';
import { generateText } from '../src/generate';
import { createExecutionContext } from '../src/execution-policy';
import { createPriceProvider, priceUsage } from '../src/pricing';
import { createAnthropic } from '../src/anthropic';
import { createOpenAI, createOpenAIResponses } from '../src/openai';
import { createGoogleNative } from '../src/google';
import { anthropicAdapter } from '../src/adapters/anthropic';
import { openaiCompatibleAdapter } from '../src/adapters/openai-compatible';
import { openaiResponsesAdapter } from '../src/adapters/openai-responses';
import { googleNativeAdapter } from '../src/adapters/google-native';
import { getCapabilities, type ModelCapabilities } from '../src/core/registry';
import { normalizeMessages } from '../src/core/normalize';
import { wireOutputCap } from '../src/internal/output-cap';
import { sseEvents, sseResponse } from '../src/testing';
import type { Adapter } from '../src/adapters/types';
import type { CommonCallOptions } from '../src/types/config';
import type { LanguageModel, ModelSurface, Provider } from '../src/types/model';
import type { Usage } from '../src/types/usage';

type Body = Record<string, unknown> & { generationConfig?: Record<string, unknown> };

interface Wire {
  adapter: Adapter;
  factory: (settings: { apiKey: string; fetch?: typeof fetch }) => Provider;
  modelId: string;
  /** Where the wire carries its output cap. */
  read(body: Body): unknown;
}

const WIRES: Record<ModelSurface, Wire> = {
  anthropic: {
    adapter: anthropicAdapter,
    factory: createAnthropic,
    modelId: 'claude-opus-4-6',
    read: (body) => body.max_tokens,
  },
  responses: {
    adapter: openaiResponsesAdapter,
    factory: createOpenAIResponses,
    modelId: 'gpt-5.4',
    read: (body) => body.max_output_tokens,
  },
  chat_completions: {
    adapter: openaiCompatibleAdapter,
    factory: createOpenAI,
    modelId: 'gpt-5.5',
    read: (body) => body.max_completion_tokens ?? body.max_tokens,
  },
  native: {
    adapter: googleNativeAdapter,
    factory: createGoogleNative,
    modelId: 'gemini-2.5-flash',
    read: (body) => body.generationConfig?.maxOutputTokens,
  },
};

const SURFACES = Object.keys(WIRES) as ModelSurface[];

function modelFor(
  surface: ModelSurface,
  fetch?: typeof globalThis.fetch,
  modelId = WIRES[surface].modelId,
): LanguageModel {
  return WIRES[surface].factory({ apiKey: 'k', ...(fetch ? { fetch } : {}) })(modelId);
}

/** The cap the adapter itself puts on the wire for these capabilities and options. */
function builtCap(
  surface: ModelSurface,
  caps: ModelCapabilities,
  options: Pick<CommonCallOptions, 'maxOutputTokens' | 'effort'>,
  modelId?: string,
): unknown {
  const model = modelFor(surface, undefined, modelId);
  const { init } = WIRES[surface].adapter.buildRequest({
    call: {
      provider: model.provider,
      modelId: model.modelId,
      surface,
      apiKey: 'k',
      baseURL: 'https://wire.test',
      fetch: globalThis.fetch,
      headers: {},
    },
    messages: normalizeMessages([{ role: 'user', content: 'hi' }]),
    caps,
    options: { model, messages: [{ role: 'user', content: 'hi' }], ...options },
    generateId: () => 'id',
  });
  return WIRES[surface].read(JSON.parse(init.body as string) as Body);
}

const EFFORTS = [undefined, 'none', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
const REQUESTED = [undefined, 1_000, 30_000, 200_000];
const CAPS: Partial<ModelCapabilities>[] = [
  { reasoning: true, effortWire: 'budget_tokens', maxOutput: 8_192 },
  { reasoning: true, effortWire: 'budget_tokens', maxOutput: 128_000 },
  { reasoning: true, effortWire: 'output_config', maxOutput: 128_000 },
  { reasoning: false, effortWire: 'budget_tokens', maxOutput: 4_096 },
  { reasoning: true, samplingRestrictions: true, maxOutput: 64_000 },
  { reasoning: false, samplingRestrictions: false, maxOutput: 2_048 },
  // 2.3 rows: a level list clamps 'max' to 'high' (a smaller thinking budget),
  // and 'none' can be sent as the lowest level (a thinking budget after all).
  {
    reasoning: true,
    effortWire: 'budget_tokens',
    maxOutput: 8_192,
    effortLevels: ['low', 'medium', 'high'],
  },
  { reasoning: true, effortWire: 'budget_tokens', maxOutput: 8_192, effortNone: 'lowest' },
];

describe('wire output cap (F12)', () => {
  it.each(SURFACES)(
    'matches what the %s adapter sends for every effort, cap and row',
    (surface) => {
      const base = getCapabilities(modelFor(surface));
      let compared = 0;
      for (const override of CAPS) {
        const caps = { ...base, ...override };
        for (const effort of EFFORTS) {
          for (const maxOutputTokens of REQUESTED) {
            const options = {
              ...(effort !== undefined ? { effort } : {}),
              ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
            };
            expect(
              { caps: override, options, cap: wireOutputCap(surface, caps, options) },
              `${surface} ${JSON.stringify(override)} ${JSON.stringify(options)}`,
            ).toEqual({ caps: override, options, cap: builtCap(surface, caps, options) });
            compared++;
          }
        }
      }
      expect(compared).toBe(CAPS.length * EFFORTS.length * REQUESTED.length);
    },
  );

  it.each(SURFACES)(
    'matches what the %s adapter sends for a model the registry does not know',
    (surface) => {
      // A placeholder row: the optional-cap wires leave the cap off (C1, 2.3),
      // Anthropic still sends its required max_tokens.
      const modelId = 'deuz-unlisted-model-1';
      const caps = getCapabilities(modelFor(surface, undefined, modelId));
      for (const effort of EFFORTS) {
        for (const maxOutputTokens of REQUESTED) {
          const options = {
            ...(effort !== undefined ? { effort } : {}),
            ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
          };
          expect(
            { options, cap: wireOutputCap(surface, caps, options, modelId) },
            `${surface} ${JSON.stringify(options)}`,
          ).toEqual({ options, cap: builtCap(surface, caps, options, modelId) });
        }
      }
      expect(wireOutputCap(surface, caps, {}, modelId)).toBe(
        surface === 'anthropic' ? caps.maxOutput : undefined,
      );
    },
  );

  it('includes the Anthropic thinking raise of an explicit cap (t3b case A)', () => {
    const caps = getCapabilities(modelFor('anthropic'));
    expect(wireOutputCap('anthropic', caps, { effort: 'max', maxOutputTokens: 1_000 })).toBe(
      49_024,
    );
    expect(wireOutputCap('anthropic', caps, { maxOutputTokens: 1_000 })).toBe(1_000);
  });
});

function outputOnly(tokens: number): Usage {
  return {
    inputTokens: 0,
    outputTokens: tokens,
    reasoningTokens: 0,
    cachedReadTokens: 0,
    cacheWriteTokens: 0,
    cacheWrite1hTokens: 0,
    totalTokens: tokens,
  };
}

/** Make one native call, capture its wire body, and stop it with an unbilled 400. */
async function reserveOnce(
  surface: ModelSurface,
  options: Pick<CommonCallOptions, 'maxOutputTokens' | 'effort' | 'promptCaching'>,
  prompt = 'hi',
) {
  let body: Body | undefined;
  const fetch = (async (_url: unknown, init?: RequestInit) => {
    body = JSON.parse(init!.body as string) as Body;
    // A 400 is never billed: the attempt is released after the reservation was made.
    return new Response(JSON.stringify({ error: { message: 'stop here' } }), { status: 400 });
  }) as typeof globalThis.fetch;
  const execution = createExecutionContext({ budget: { usd: 1_000 } });
  const model = modelFor(surface, fetch);
  await expect(
    generateText({
      model,
      prompt,
      execution,
      deps: { priceProvider: createPriceProvider() },
      ...options,
    }),
  ).rejects.toThrow();
  const [record] = execution.ledger.snapshot().reservations;
  expect(record?.state).toBe('released');
  return { model, wire: WIRES[surface].read(body!), reservation: record!.reservation };
}

describe('native reservation covers the wire cap (F12)', () => {
  const cases: [ModelSurface, Pick<CommonCallOptions, 'maxOutputTokens' | 'effort'>][] = [
    ['anthropic', { effort: 'max', maxOutputTokens: 1_000 }],
    ['anthropic', {}],
    ['responses', {}],
    ['responses', { effort: 'high', maxOutputTokens: 2_000 }],
    ['chat_completions', {}],
    ['native', { effort: 'high' }],
  ];

  it.each(cases)(
    '%s %j reserves at least the price of the wire output cap',
    async (surface, options) => {
      const { model, wire, reservation } = await reserveOnce(surface, options);
      expect(typeof wire).toBe('number');
      expect(reservation.tokens).toBeGreaterThanOrEqual(wire as number);
      expect(reservation.usd).toBeGreaterThanOrEqual(
        priceUsage(model.modelId, outputOnly(wire as number))!,
      );
    },
  );

  it('prices a prompt the call caches at the cache-write rate', async () => {
    const prompt = 'cache me '.repeat(5_000);
    const plain = await reserveOnce('anthropic', {}, prompt);
    const fiveMinutes = await reserveOnce('anthropic', { promptCaching: 'auto' }, prompt);
    const oneHour = await reserveOnce('anthropic', { promptCaching: 'auto-1h' }, prompt);
    // Same token hold; the dollar hold covers the write premium (1.25x, then 2x input).
    expect(fiveMinutes.reservation.tokens).toBe(plain.reservation.tokens);
    expect(oneHour.reservation.tokens).toBe(plain.reservation.tokens);
    expect(fiveMinutes.reservation.usd).toBeGreaterThan(plain.reservation.usd!);
    expect(oneHour.reservation.usd).toBeGreaterThan(fiveMinutes.reservation.usd!);
  });

  /** A Claude turn that bills `output` output tokens. */
  function claudeTurn(output: number): Response {
    return sseResponse([
      sseEvents([
        {
          data: {
            type: 'message_start',
            message: { usage: { input_tokens: 50, output_tokens: 1 } },
          },
        },
        {
          data: {
            type: 'content_block_start',
            index: 0,
            content_block: { type: 'text', text: '' },
          },
        },
        {
          data: {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'text_delta', text: 'ok' },
          },
        },
        { data: { type: 'content_block_stop', index: 0 } },
        {
          data: {
            type: 'message_delta',
            delta: { stop_reason: 'end_turn' },
            usage: { output_tokens: output },
          },
        },
        { data: { type: 'message_stop' } },
      ]),
    ]);
  }

  async function parallel(usd: number) {
    const execution = createExecutionContext({ budget: { usd } });
    // Each call bills 100k output tokens: within the 128k wire cap, far above 4,096.
    const model = createAnthropic({
      apiKey: 'k',
      fetch: (async () => claudeTurn(100_000)) as typeof fetch,
    })('claude-fable-5');
    const outcomes = await Promise.allSettled(
      [1, 2, 3].map(() =>
        generateText({
          model,
          prompt: 'hi',
          execution,
          deps: { priceProvider: createPriceProvider() },
        }),
      ),
    );
    return { outcomes, spent: execution.ledger.totals().spent.usd };
  }

  it('parallel calls can no longer spend past the USD budget (t3b case C)', async () => {
    // 2.2 reserved 4,096 output tokens ($0.20) per call, admitted two and spent $10.
    const tight = await parallel(0.5);
    expect(tight.outcomes.every((o) => o.status === 'rejected')).toBe(true);
    expect(tight.spent).toBe(0);
    // Room for exactly one worst case: one call runs, the other two are refused.
    const one = await parallel(7);
    expect(one.outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
    for (const outcome of one.outcomes.filter((o) => o.status === 'rejected'))
      expect((outcome as PromiseRejectedResult).reason).toMatchObject({ code: 'budget_exceeded' });
    expect(one.spent).toBeLessThanOrEqual(7);
  });
});
