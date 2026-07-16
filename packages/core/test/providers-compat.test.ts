import { describe, it, expect } from 'vitest';
import { streamChat } from '../src/index';
import {
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
import { getCapabilities } from '../src/core/registry';
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
