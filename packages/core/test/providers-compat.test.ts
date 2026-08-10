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
  createPerplexity,
  createCohere,
  createDeepInfra,
  createNvidia,
  createSambaNova,
  createHyperbolic,
  createOllama,
  createLMStudio,
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
  perplexity,
  cohere,
  deepinfra,
  nvidia,
  sambanova,
  hyperbolic,
  ollama,
  lmstudio,
  type CompatSettings,
} from '../src/providers-compat';
import type { Provider } from '../src/types/model';
import { readConfig } from '../src/internal/config-symbol';
import { getCapabilities, type ModelCapabilities } from '../src/core/registry';
import { AuthenticationError, InvalidRequestError } from '../src/errors';
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
  // --- 2.0 ---
  { provider: 'perplexity', create: createPerplexity, instance: perplexity },
  { provider: 'cohere', create: createCohere, instance: cohere },
  { provider: 'deepinfra', create: createDeepInfra, instance: deepinfra },
  { provider: 'nvidia', create: createNvidia, instance: nvidia },
  { provider: 'sambanova', create: createSambaNova, instance: sambanova },
  { provider: 'hyperbolic', create: createHyperbolic, instance: hyperbolic },
  { provider: 'ollama', create: createOllama, instance: ollama },
  { provider: 'lmstudio', create: createLMStudio, instance: lmstudio },
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
    // --- 2.0 base-URL goldens. These four are the ones whose roots are NOT the
    // boring `https://api.<host>/v1`, i.e. the ones a typo would silently 404. ---
    {
      // No `/v1` segment at all — the adapter appends `/chat/completions` to the
      // bare root. An extra `/v1` here is the classic Perplexity 404.
      provider: 'perplexity',
      create: createPerplexity,
      modelId: 'sonar-pro',
      url: 'https://api.perplexity.ai/chat/completions',
    },
    {
      provider: 'cohere',
      create: createCohere,
      modelId: 'command-a-03-2025',
      url: 'https://api.cohere.ai/compatibility/v1/chat/completions',
    },
    {
      provider: 'deepinfra',
      create: createDeepInfra,
      modelId: 'deepseek-ai/DeepSeek-V3.2',
      url: 'https://api.deepinfra.com/v1/openai/chat/completions',
    },
    {
      // A real key still travels the normal G1 path on a keyless factory.
      provider: 'ollama',
      create: createOllama,
      modelId: 'qwen3',
      url: 'http://localhost:11434/v1/chat/completions',
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

describe('providers-compat: descriptor shape for all 19 factories', () => {
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

  it('2.0 rows land on the right provider — and Perplexity Sonar has NO client tools', () => {
    expect(getCapabilities(perplexity('sonar'))).toMatchObject({
      known: true,
      provider: 'perplexity',
      tools: false,
      structuredOutput: false,
    });
    expect(getCapabilities(perplexity('sonar-reasoning-pro'))).toMatchObject({
      known: true,
      reasoning: true,
      tools: false,
    });
    expect(getCapabilities(cohere('command-a-03-2025'))).toMatchObject({
      known: true,
      provider: 'cohere',
      tools: true,
    });
    expect(getCapabilities(deepinfra('deepseek-ai/DeepSeek-V3.2'))).toMatchObject({
      known: true,
      provider: 'deepinfra',
    });
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

// ===================================================================
// 2.0 — keyless local hosts. The claim under test is narrow and load-bearing:
// `apiKeyOptional` fills the hole at the END of the G1 chain and does nothing
// else. Every link above it must still win, and no cloud factory may inherit
// the escape.
// ===================================================================

const authOf = (call: { init?: RequestInit }): string | undefined =>
  (call.init!.headers as Record<string, string>).authorization;

describe('providers-compat: keyless local hosts (2.0)', () => {
  it('(a) createOllama() with NO key anywhere streams, sending the placeholder bearer', async () => {
    const { fetch, calls } = mockFetch(() => sseResponse([CC_OK]));
    const result = streamChat({
      model: createOllama({ fetch })('qwen3'),
      messages: [{ role: 'user', content: 'hi' }],
    });
    let text = '';
    for await (const c of result.textStream) text += c;
    expect(text).toBe('ok');
    expect(await result.finishReason).toBe('stop');

    expect(calls[0]!.url).toBe('http://localhost:11434/v1/chat/completions');
    expect(authOf(calls[0]!)).toBe('Bearer sk-no-key');
  });

  it('(b) a factory apiKey still wins over the sentinel (G1 link 2)', async () => {
    const { fetch, calls } = mockFetch(() => sseResponse([CC_OK]));
    const result = streamChat({
      model: createOllama({ apiKey: 'real', fetch })('qwen3'),
      messages: [{ role: 'user', content: 'hi' }],
    });
    await result.finishReason;
    expect(authOf(calls[0]!)).toBe('Bearer real');
  });

  it('(c) createClient({ apiKeys: { ollama } }) still wins over the sentinel (G1 link 3)', async () => {
    const { fetch, calls } = mockFetch(() => sseResponse([CC_OK]));
    const client = createClient({ apiKeys: { ollama: 'k' }, deps: { fetch } });
    const result = client.streamChat({
      model: ollama('qwen3'),
      messages: [{ role: 'user', content: 'hi' }],
    });
    await result.finishReason;
    expect(authOf(calls[0]!)).toBe('Bearer k');
  });

  it('deps.keyProvider still outranks everything (G1 link 1) — the chain is untouched', async () => {
    const { fetch, calls } = mockFetch(() => sseResponse([CC_OK]));
    const client = createClient({
      apiKeys: { ollama: 'from-client' },
      deps: {
        fetch,
        keyProvider: { getKey: (p: string) => (p === 'ollama' ? 'from-kp' : undefined) },
      },
    });
    const result = client.streamChat({
      model: createOllama({ apiKey: 'from-factory' })('qwen3'),
      messages: [{ role: 'user', content: 'hi' }],
    });
    await result.finishReason;
    expect(authOf(calls[0]!)).toBe('Bearer from-kp');
  });

  it('(d) a CLOUD factory does not inherit the escape — createPerplexity() keyless still fails auth', async () => {
    const { fetch, calls } = mockFetch(() => sseResponse([CC_OK]));
    // G2: still synchronous, still no throw — the failure lands on the promises.
    const result = streamChat({
      model: createPerplexity({ fetch })('sonar'),
      messages: [{ role: 'user', content: 'hi' }],
    });
    await expect(result.finishReason).rejects.toThrow(AuthenticationError);
    await expect(result.usage).rejects.toThrow(/No API key for provider 'perplexity'/);
    expect(calls).toHaveLength(0); // never dialled — the key is missing, not wrong
  });

  it('LM Studio is the same deal on its own port', async () => {
    const { fetch, calls } = mockFetch(() => sseResponse([CC_OK]));
    const result = streamChat({
      model: createLMStudio({ fetch })('local-model'),
      messages: [{ role: 'user', content: 'hi' }],
    });
    await result.finishReason;
    expect(calls[0]!.url).toBe('http://localhost:1234/v1/chat/completions');
    expect(authOf(calls[0]!)).toBe('Bearer sk-no-key');
  });

  it('createOpenAICompatible opts in explicitly — for a self-hosted vLLM / llama.cpp', async () => {
    const { fetch, calls } = mockFetch(() => sseResponse([CC_OK]));
    const vllm = createOpenAICompatible({
      id: 'vllm',
      baseURL: 'http://gpu-box.internal:8000/v1',
      apiKeyOptional: true,
      fetch,
    });
    const result = streamChat({
      model: vllm('gpt-oss-120b'),
      messages: [{ role: 'user', content: 'hi' }],
    });
    await result.finishReason;
    expect(authOf(calls[0]!)).toBe('Bearer sk-no-key');

    // …and WITHOUT the opt-in the same host still throws, so the flag is the
    // only thing that moves.
    const strict = createOpenAICompatible({
      id: 'vllm',
      baseURL: 'http://gpu-box.internal:8000/v1',
      fetch,
    });
    await expect(
      streamChat({ model: strict('gpt-oss-120b'), messages: [{ role: 'user', content: 'hi' }] })
        .finishReason,
    ).rejects.toThrow(/No API key for provider 'vllm'/);
  });

  it('the flag rides the config Symbol and ONLY the local factories set it', () => {
    expect(readConfig(createOllama()('m'))!.apiKeyOptional).toBe(true);
    expect(readConfig(createLMStudio()('m'))!.apiKeyOptional).toBe(true);
    for (const create of [createPerplexity, createCohere, createDeepInfra, createGroq]) {
      const cfg = readConfig(create({ apiKey: 'k' })('m'))!;
      expect(cfg.apiKeyOptional).toBeUndefined();
      // Conditional spread: the key is ABSENT, not `undefined`.
      expect(Object.keys(cfg)).toEqual(['provider', 'apiKey', 'baseURL', 'fetch', 'headers']);
    }
  });

  it('CompatSettings.capabilities is public in 2.0 — the override reaches the wire for a local slug', async () => {
    const { fetch, calls } = mockFetch(() => sseResponse([CC_OK]));
    const local = createOllama({ fetch, capabilities: { tools: true, maxOutput: 32_000 } });
    const model = local('my-finetune:latest');

    // Unknown slug (no registry row can exist for a user-pulled model) — but the
    // factory override lands on top of the conservative fallback.
    const caps = getCapabilities(model);
    expect(caps.known).toBe(false);
    expect(caps.provider).toBe('ollama');
    expect(caps.tools).toBe(true);
    expect(caps.maxOutput).toBe(32_000);

    const result = streamChat({ model, messages: [{ role: 'user', content: 'hi' }] });
    await result.finishReason;
    const body = JSON.parse(String(calls[0]!.init!.body)) as { max_tokens: number };
    expect(body.max_tokens).toBe(32_000); // not the 4096 silent-truncation default
  });
});
