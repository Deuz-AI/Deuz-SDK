import { describe, expect, it } from 'vitest';
import { createAnthropic } from '../src/anthropic';
import { prepareRequests, protocolFor, type PrepareInput } from '../src/batch/prepare';
import { BatchError } from '../src/batch/errors';
import type { BatchRequest } from '../src/batch/types';
import { generateObject, generateText } from '../src/generate';
import { createGoogle, createGoogleNative } from '../src/google';
import { createOpenAI, createOpenAIResponses } from '../src/openai';
import { createXai } from '../src/xai';
import { createAzure } from '../src/azure';
import { createVertexAnthropic } from '../src/vertex';
import { resolveCall } from '../src/internal/resolve-call';
import { resolveDependencies } from '../src/internal/resolve-deps';
import { createWarningSink } from '../src/internal/warnings';
import type { LanguageModel } from '../src/types/model';
import type { JSONSchema } from '../src/types/schema';

// BA2: every batch request body comes from the model's own adapter
// (`buildRequest`), with streaming switched off — so a batch sends exactly what
// the same `generateText` / `generateObject` call sends, minus `stream` and
// `stream_options`.

const KEY = { apiKey: 'test-key' };
const models = {
  anthropic: createAnthropic(KEY)('claude-haiku-5-5'),
  responses: createOpenAIResponses(KEY)('gpt-5.6-sol'),
  chat: createOpenAI(KEY)('gpt-5-mini'),
  gemini: createGoogleNative(KEY)('gemini-3.1-pro'),
};

/** The body the streaming path sends for the same call (captured, then refused with a 400). */
async function streamingBody(
  run: (fetch: typeof globalThis.fetch) => Promise<unknown>,
): Promise<Record<string, unknown>> {
  let body: string | undefined;
  const fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    body = init?.body as string;
    return new Response(
      JSON.stringify({ error: { type: 'invalid_request_error', message: 'x' } }),
      {
        status: 400,
        headers: { 'content-type': 'application/json' },
      },
    );
  }) as typeof globalThis.fetch;
  await run(fetch).catch(() => undefined);
  if (body === undefined) throw new Error('no request was captured');
  return JSON.parse(body) as Record<string, unknown>;
}

function withoutStreaming(body: Record<string, unknown>): Record<string, unknown> {
  const copy = { ...body };
  delete copy.stream;
  delete copy.stream_options;
  return copy;
}

async function prepare(
  model: LanguageModel,
  requests: BatchRequest[],
  over: Partial<PrepareInput> = {},
) {
  const deps = resolveDependencies({ generateId: () => 'gen' });
  const warnings = createWarningSink();
  const call = await resolveCall({ model, deps });
  const prepared = await prepareRequests(requests, {
    model,
    call,
    deps,
    warnings,
    bounded: false,
    ...over,
  });
  return { prepared, warnings: warnings.list() };
}

const SCHEMA: JSONSchema = {
  type: 'object',
  properties: { label: { type: 'string' } },
  required: ['label'],
  additionalProperties: false,
};

describe('protocolFor', () => {
  it('routes OpenAI, Anthropic and Gemini models to their batch APIs', () => {
    expect(protocolFor(models.anthropic)).toBe('anthropic');
    expect(protocolFor(models.responses)).toBe('openai');
    expect(protocolFor(models.chat)).toBe('openai');
    expect(protocolFor(models.gemini)).toBe('gemini');
  });

  it.each([
    ['Gemini on the OpenAI-compatible endpoint', createGoogle(KEY)('gemini-3.1-pro')],
    ['xAI', createXai(KEY)('grok-4')],
    ['Azure OpenAI', createAzure({ apiKey: 'k', resourceName: 'r' })('my-deployment')],
    [
      'Claude on Vertex AI',
      createVertexAnthropic({ project: 'p', location: 'us-east5', accessToken: 't' })(
        'claude-haiku-5-5',
      ),
    ],
  ])('refuses %s with an unsupported BatchError', (_label, model) => {
    const error = (() => {
      try {
        protocolFor(model);
      } catch (caught) {
        return caught;
      }
    })();
    expect(error).toBeInstanceOf(BatchError);
    expect((error as BatchError).kind).toBe('unsupported');
  });
});

describe('prepareRequests: bodies come from the adapters with streaming off', () => {
  const request = {
    instructions: 'Be brief.',
    prompt: 'Summarize the plot of Hamlet.',
    maxOutputTokens: 300,
  };

  it.each(Object.entries(models))(
    '%s: equals the streaming body minus stream fields',
    async (_wire, model) => {
      const streaming = await streamingBody((fetch) =>
        generateText({ model, ...request, deps: { fetch } }),
      );
      const { prepared } = await prepare(model, [{ id: 'r1', ...request }]);
      expect(prepared).toHaveLength(1);
      expect(prepared[0]!.id).toBe('r1');
      expect(prepared[0]!.body).toEqual(withoutStreaming(streaming));
      expect(prepared[0]!.body).not.toHaveProperty('stream');
      expect(prepared[0]!.body).not.toHaveProperty('stream_options');
    },
  );

  it.each(Object.entries(models))(
    '%s: structured output equals generateObject’s request',
    async (_wire, model) => {
      const streaming = await streamingBody((fetch) =>
        generateObject({
          model,
          prompt: 'Label it.',
          schema: SCHEMA,
          schemaName: 'label',
          deps: { fetch },
        }),
      );
      const { prepared } = await prepare(model, [
        { id: 'o1', prompt: 'Label it.', schema: SCHEMA, schemaName: 'label' },
      ]);
      expect(prepared[0]!.body).toEqual(withoutStreaming(streaming));
      expect(prepared[0]!.object).toMatchObject({ strategy: 'json' });
    },
  );

  it('records the forced tool of the tool strategy', async () => {
    const model = createAnthropic(KEY)('claude-haiku-4-5');
    const { prepared } = await prepare(model, [
      { id: 't1', prompt: 'Label it.', schema: SCHEMA, schemaName: 'label', mode: 'tool' },
    ]);
    expect(prepared[0]!.object).toMatchObject({ strategy: 'tool', toolName: 'label' });
    expect(prepared[0]!.body).toMatchObject({ tool_choice: { type: 'tool', name: 'label' } });
  });

  it('keeps OpenAI Responses requests stateless (decision 5)', async () => {
    const { prepared } = await prepare(models.responses, [{ id: 's', prompt: 'Hi' }]);
    expect(prepared[0]!.body.store).toBe(false);
  });

  it('reports what the wire dropped or clamped, as generateText does', async () => {
    const { warnings } = await prepare(models.responses, [
      { id: 'w1', prompt: 'Hi', temperature: 0.3 },
      { id: 'w2', prompt: 'Hello', temperature: 0.3 },
    ]);
    // gpt-5.6-sol restricts sampling: reported once for the whole batch.
    expect(warnings.filter((w) => w.setting === 'temperature')).toHaveLength(1);
  });

  it('sends the row placeholder as the output cap under a budget bound (F12)', async () => {
    const model = createOpenAIResponses(KEY)('gpt-6-astra');
    const free = await prepare(model, [{ id: 'a', prompt: 'Hi' }]);
    expect(free.prepared[0]!.body).not.toHaveProperty('max_output_tokens');
    const bound = await prepare(model, [{ id: 'a', prompt: 'Hi' }], { bounded: true });
    expect(bound.prepared[0]!.body).toHaveProperty('max_output_tokens', 4096);
    expect(bound.prepared[0]!.options.maxOutputTokens).toBe(4096);
    expect(bound.warnings).toContainEqual(
      expect.objectContaining({ type: 'clamped-setting', setting: 'maxOutputTokens' }),
    );
  });

  it('carries factory headers such as anthropic-beta on every prepared request', async () => {
    const model = createAnthropic({
      ...KEY,
      headers: { 'anthropic-beta': 'some-beta-2026-01-01' },
    })('claude-haiku-5-5');
    const { prepared } = await prepare(model, [{ id: 'h', prompt: 'Hi' }]);
    expect(prepared[0]!.headers['anthropic-beta']).toBe('some-beta-2026-01-01');
  });
});

describe('prepareRequests: validation', () => {
  it.each([
    ['no requests', []],
    ['an id with a space', [{ id: 'has space', prompt: 'x' }]],
    ['an id longer than 64 characters', [{ id: 'x'.repeat(65), prompt: 'x' }]],
    [
      'a repeated id',
      [
        { id: 'a', prompt: 'x' },
        { id: 'a', prompt: 'y' },
      ],
    ],
    [
      'prompt with messages',
      [{ id: 'a', prompt: 'x', messages: [{ role: 'user', content: 'y' }] }],
    ],
    ['no input', [{ id: 'a' }]],
    ['tools', [{ id: 'a', prompt: 'x', tools: { t: {} } }]],
  ])('refuses %s before any request is built', async (_label, requests) => {
    await expect(prepare(models.anthropic, requests as BatchRequest[])).rejects.toMatchObject({
      name: 'BatchError',
      kind: 'invalid-request',
    });
  });
});
