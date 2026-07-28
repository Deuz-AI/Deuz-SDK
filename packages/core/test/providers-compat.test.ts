import { describe, it, expect } from 'vitest';
import { streamChat, createClient } from '../src/index';
import {
  createOpenAICompatible,
  createGroq,
  createMistral,
  createDeepSeek,
  createTogether,
  createOpenRouter,
  createCerebras,
  createFireworks,
  createMoonshot,
  createQwen,
  createGLM,
  createMiniMax,
  groq,
  mistral,
  deepseek,
  together,
  openrouter,
  cerebras,
  fireworks,
  moonshot,
  qwen,
  glm,
  minimax,
  type CompatSettings,
} from '../src/providers-compat';
import type { Provider } from '../src/types/model';
import { readConfig } from '../src/internal/config-symbol';
import { getCapabilities, type ModelCapabilities } from '../src/core/registry';
import { InvalidRequestError } from '../src/errors';
import { sseResponse, sseEvents, mockFetch } from './fixtures/sse';

const FACTORIES: {
  provider: string;
  create: (settings?: CompatSettings) => Provider;
  instance: Provider;
}[] = [
  { provider: 'groq', create: createGroq, instance: groq },
  { provider: 'mistral', create: createMistral, instance: mistral },
  { provider: 'deepseek', create: createDeepSeek, instance: deepseek },
  { provider: 'together', create: createTogether, instance: together },
  { provider: 'openrouter', create: createOpenRouter, instance: openrouter },
  { provider: 'cerebras', create: createCerebras, instance: cerebras },
  { provider: 'fireworks', create: createFireworks, instance: fireworks },
  { provider: 'moonshot', create: createMoonshot, instance: moonshot },
  { provider: 'qwen', create: createQwen, instance: qwen },
  { provider: 'glm', create: createGLM, instance: glm },
  { provider: 'minimax', create: createMiniMax, instance: minimax },
];

describe('providers-compat: streaming round-trip (golden replay)', () => {
  const CC = sseEvents([
    { data: { choices: [{ delta: { content: 'Hello' }, finish_reason: null }] } },
    { data: { choices: [{ delta: { content: ' compat' }, finish_reason: 'stop' }] } },
    { data: { choices: [], usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 } } },
    { data: '[DONE]' },
  ]);

  const ROUND_TRIPS = [
    {
      provider: 'groq',
      create: createGroq,
      modelId: 'llama-4-maverick',
      url: 'https://api.groq.com/openai/v1/chat/completions',
    },
    {
      provider: 'deepseek',
      create: createDeepSeek,
      modelId: 'deepseek-v3.2',
      url: 'https://api.deepseek.com/v1/chat/completions',
    },
    {
      provider: 'glm',
      create: createGLM,
      modelId: 'glm-4.6',
      url: 'https://open.bigmodel.cn/api/paas/v4/chat/completions',
    },
  ] as const;

  for (const rt of ROUND_TRIPS) {
    it(`${rt.provider}: streams text via the default base URL with Bearer auth`, async () => {
      const { fetch, calls } = mockFetch(() => sseResponse([CC]));
      const result = streamChat({
        model: rt.create({ apiKey: `sk-${rt.provider}`, fetch })(rt.modelId),
        messages: [{ role: 'user', content: 'hi' }],
      });
      let text = '';
      for await (const c of result.textStream) text += c;
      expect(text).toBe('Hello compat');
      expect(await result.finishReason).toBe('stop');
      expect(await result.usage).toMatchObject({ inputTokens: 4, outputTokens: 2, totalTokens: 6 });

      expect(calls[0]!.url).toBe(rt.url);
      const headers = calls[0]!.init!.headers as Record<string, string>;
      expect(headers.authorization).toBe(`Bearer sk-${rt.provider}`);
      const body = JSON.parse(String(calls[0]!.init!.body)) as Record<string, unknown>;
      expect(body.model).toBe(rt.modelId);
      expect(body.stream).toBe(true);
    });
  }

  it('factory baseURL overrides the wire default', async () => {
    const { fetch, calls } = mockFetch(() => sseResponse([CC]));
    const result = streamChat({
      model: createGroq({ apiKey: 'k', baseURL: 'https://proxy.example/v1/', fetch })('anything'),
      messages: [{ role: 'user', content: 'hi' }],
    });
    await result.finishReason;
    expect(calls[0]!.url).toBe('https://proxy.example/v1/chat/completions');
  });
});

describe('providers-compat: descriptor shape for all 11 factories', () => {
  it('returns { provider, modelId, surface: chat_completions } with config attached', () => {
    for (const f of FACTORIES) {
      const model = f.create({ apiKey: 'sk-test', headers: { 'x-tenant': 't1' } })('some-model');
      expect(model).toMatchObject({
        provider: f.provider,
        modelId: 'some-model',
        surface: 'chat_completions',
      });
      const cfg = readConfig(model);
      expect(cfg).toBeDefined();
      expect(cfg!.provider).toBe(f.provider);
      expect(cfg!.apiKey).toBe('sk-test');
      expect(cfg!.headers).toEqual({ 'x-tenant': 't1' });
      // Settings live on a non-enumerable Symbol — never on the public shape.
      expect(Object.keys(model)).toEqual(['provider', 'modelId', 'surface']);
    }
  });

  it('default instances carry the same descriptor shape (key resolved later, G1)', () => {
    for (const f of FACTORIES) {
      const model = f.instance('some-model');
      expect(model).toMatchObject({ provider: f.provider, surface: 'chat_completions' });
      expect(readConfig(model)).toBeDefined();
    }
  });
});

describe('providers-compat: registry integration', () => {
  it('unknown slugs fall back to conservative defaults without throwing', () => {
    for (const f of FACTORIES) {
      const caps = getCapabilities(f.instance(`${f.provider}-next-9000`));
      expect(caps.known).toBe(false);
      expect(caps.provider).toBe(f.provider);
      expect(caps.surface).toBe('chat_completions');
      expect(caps.tools).toBe(false); // conservative fallback keeps risky flags OFF
    }
  });

  it('pinned 2026 flagship slugs are known rows with tools enabled', () => {
    expect(getCapabilities(groq('llama-4-maverick'))).toMatchObject({
      known: true,
      tools: true,
      vision: true,
    });
    expect(getCapabilities(deepseek('deepseek-v3.2'))).toMatchObject({ known: true, tools: true });
    expect(getCapabilities(mistral('mistral-large-latest'))).toMatchObject({
      known: true,
      tools: true,
      contextWindow: 256_000,
    });
    expect(getCapabilities(moonshot('kimi-k2'))).toMatchObject({ known: true, tools: true });
  });
});

// ===================================================================
// 1.9 — createOpenAICompatible (item 2.7): the generic factory over the SAME
// private closure, so an unlisted OpenAI-shaped host carries its own id.
// ===================================================================

const CC_OK = sseEvents([
  { data: { choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] } },
  { data: { choices: [], usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 } } },
  { data: '[DONE]' },
]);

const RESP_OK = sseEvents([
  {
    event: 'response.output_text.delta',
    data: { type: 'response.output_text.delta', delta: 'ok' },
  },
  {
    event: 'response.completed',
    data: {
      type: 'response.completed',
      response: {
        status: 'completed',
        usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 },
      },
    },
  },
]);

describe('createOpenAICompatible: own provider id (1.9)', () => {
  it('descriptor carries `id` as the provider (NOT a borrowed factory id) and dials the given baseURL', async () => {
    const { fetch, calls } = mockFetch(() => sseResponse([CC_OK]));
    const ollama = createOpenAICompatible({
      id: 'ollama',
      baseURL: 'http://localhost:11434/v1',
      apiKey: 'sk-local',
      fetch,
    });
    const model = ollama('qwen3');

    // The whole point of 2.7: `provider` is 'ollama', not 'groq'. That id is what
    // G1 key lookup, the registry, pricing and every observation event see.
    expect(model).toEqual({ provider: 'ollama', modelId: 'qwen3', surface: 'chat_completions' });
    expect(getCapabilities(model).provider).toBe('ollama');

    const result = streamChat({ model, messages: [{ role: 'user', content: 'hi' }] });
    let text = '';
    for await (const c of result.textStream) text += c;
    expect(text).toBe('ok');
    expect(await result.finishReason).toBe('stop');

    expect(calls[0]!.url).toBe('http://localhost:11434/v1/chat/completions');
    const headers = calls[0]!.init!.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer sk-local');
    expect(headers['api-key']).toBeUndefined();
    expect(JSON.parse(String(calls[0]!.init!.body)).model).toBe('qwen3');
  });

  it("authHeader: 'api-key' sends the other header shape (no Authorization)", async () => {
    const { fetch, calls } = mockFetch(() => sseResponse([CC_OK]));
    const gateway = createOpenAICompatible({
      id: 'acme-gateway',
      baseURL: 'https://ai.acme.internal/v1',
      apiKey: 'sk-acme',
      authHeader: 'api-key',
      fetch,
    });
    const result = streamChat({
      model: gateway('acme-llm'),
      messages: [{ role: 'user', content: 'hi' }],
    });
    await result.finishReason;

    const headers = calls[0]!.init!.headers as Record<string, string>;
    expect(headers['api-key']).toBe('sk-acme');
    expect(headers.authorization).toBeUndefined();
  });

  it("surface: 'responses' routes to the Responses adapter", async () => {
    const { fetch, calls } = mockFetch(() => sseResponse([RESP_OK]));
    const host = createOpenAICompatible({
      id: 'vllm',
      baseURL: 'https://vllm.internal/v1',
      apiKey: 'sk-vllm',
      surface: 'responses',
      fetch,
    });
    const model = host('gpt-oss-120b');
    expect(model.surface).toBe('responses');

    const result = streamChat({ model, messages: [{ role: 'user', content: 'hi' }] });
    let text = '';
    for await (const c of result.textStream) text += c;
    expect(text).toBe('ok');

    // Responses wire: /responses (not /chat/completions) with `input`, not `messages`.
    expect(calls[0]!.url).toBe('https://vllm.internal/v1/responses');
    const body = JSON.parse(String(calls[0]!.init!.body)) as Record<string, unknown>;
    expect(body.input).toBeDefined();
    expect(body.messages).toBeUndefined();
  });

  it('stashes settings (incl. capabilities) on the NON-ENUMERABLE config Symbol — no key leaks', () => {
    const caps: Partial<ModelCapabilities> = { maxOutput: 32_000, reasoning: true };
    const model = createOpenAICompatible({
      id: 'lmstudio',
      baseURL: 'http://localhost:1234/v1',
      apiKey: 'sk-super-secret',
      headers: { 'x-tenant': 't1' },
      capabilities: caps,
    })('local-model');

    expect(Object.keys(model)).toEqual(['provider', 'modelId', 'surface']);
    expect(Object.getOwnPropertyNames(model)).toEqual(['provider', 'modelId', 'surface']);
    expect(JSON.stringify(model)).not.toContain('sk-super-secret');
    expect(JSON.stringify(model)).toBe(
      '{"provider":"lmstudio","modelId":"local-model","surface":"chat_completions"}',
    );

    const cfg = readConfig(model) as
      | (ReturnType<typeof readConfig> & { capabilities?: Partial<ModelCapabilities> })
      | undefined;
    expect(cfg!.provider).toBe('lmstudio');
    expect(cfg!.apiKey).toBe('sk-super-secret');
    expect(cfg!.headers).toEqual({ 'x-tenant': 't1' });
    // Capability overrides ride the same Symbol blob (nothing reads them yet —
    // the merge site is getCapabilities in core/registry.ts).
    expect(cfg!.capabilities).toEqual({ maxOutput: 32_000, reasoning: true });
  });

  it('resolves the key through the SAME G1 chain — keyProvider(id) beats the factory key', async () => {
    const { fetch, calls } = mockFetch(() => sseResponse([CC_OK]));
    const seen: string[] = [];
    const client = createClient({
      // Custom ids get their base URL from the client table exactly like any other.
      baseUrls: { perplexity: 'https://api.perplexity.ai' },
      deps: {
        fetch,
        keyProvider: {
          getKey(provider: string) {
            seen.push(provider);
            return provider === 'perplexity' ? 'sk-from-key-provider' : undefined;
          },
        },
      },
    });
    const model = createOpenAICompatible({ id: 'perplexity', apiKey: 'sk-factory' })('sonar-pro');

    const result = client.streamChat({ model, messages: [{ role: 'user', content: 'hi' }] });
    await result.finishReason;

    // G1: deps.keyProvider is asked with the descriptor's provider id and wins
    // over the factory key; `id` opens no bypass around resolve-call.ts.
    expect(seen).toContain('perplexity');
    expect(calls[0]!.url).toBe('https://api.perplexity.ai/chat/completions');
    const headers = calls[0]!.init!.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer sk-from-key-provider');
  });

  it('a custom id has no default base URL and no env fallback — G2 error, never a throw', async () => {
    const { fetch, calls } = mockFetch(() => sseResponse([CC_OK]));
    const model = createOpenAICompatible({ id: 'mystery-host', apiKey: 'k', fetch })('m');
    // streamChat still returns synchronously (G2); the failure lands on the promises.
    const result = streamChat({ model, messages: [{ role: 'user', content: 'hi' }] });
    await expect(result.finishReason).rejects.toThrow(/No base URL for provider 'mystery-host'/);
    expect(calls).toHaveLength(0);
  });

  it('rejects an empty id and the unsupported responses+api-key combination', () => {
    expect(() => createOpenAICompatible({ id: '' })).toThrow(InvalidRequestError);
    expect(() => createOpenAICompatible({ id: '   ' })).toThrow(/non-empty `id`/);
    // The Responses adapter hard-codes Bearer — fail loudly instead of 401-ing later.
    expect(() =>
      createOpenAICompatible({ id: 'x', surface: 'responses', authHeader: 'api-key' }),
    ).toThrow(/only honoured on the 'chat_completions' wire/);
  });
});

describe('providers-compat: named factories are byte-identical after the 1.9 widening', () => {
  const PINNED = [
    { create: createGroq, id: 'groq', base: 'https://api.groq.com/openai/v1' },
    { create: createMistral, id: 'mistral', base: 'https://api.mistral.ai/v1' },
    { create: createDeepSeek, id: 'deepseek', base: 'https://api.deepseek.com/v1' },
    { create: createTogether, id: 'together', base: 'https://api.together.xyz/v1' },
    { create: createOpenRouter, id: 'openrouter', base: 'https://openrouter.ai/api/v1' },
    { create: createCerebras, id: 'cerebras', base: 'https://api.cerebras.ai/v1' },
  ] as const;

  it('descriptor + config blob keys are exactly what they were pre-1.9', () => {
    for (const p of PINNED) {
      const model = p.create({ apiKey: `sk-${p.id}` })('m');
      expect(model).toEqual({ provider: p.id, modelId: 'm', surface: 'chat_completions' });
      const cfg = readConfig(model)!;
      // No `surface`/`authHeader`/`capabilities` keys sneak into the blob: the
      // 1.9 fields are spread CONDITIONALLY, so unset means absent.
      expect(Object.keys(cfg)).toEqual(['provider', 'apiKey', 'baseURL', 'fetch', 'headers']);
      expect(cfg.authHeader).toBeUndefined();
    }
  });

  it('each still issues the same Bearer request to its default wire URL', async () => {
    for (const p of PINNED) {
      const { fetch, calls } = mockFetch(() => sseResponse([CC_OK]));
      const result = streamChat({
        model: p.create({ apiKey: `sk-${p.id}`, fetch })('m'),
        messages: [{ role: 'user', content: 'hi' }],
      });
      await result.finishReason;
      expect(calls[0]!.url).toBe(`${p.base}/chat/completions`);
      const headers = calls[0]!.init!.headers as Record<string, string>;
      expect(headers.authorization).toBe(`Bearer sk-${p.id}`);
      expect(headers['api-key']).toBeUndefined();
    }
  });
});
