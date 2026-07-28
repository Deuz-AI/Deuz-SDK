# Providers

One package, one subpath per provider. There is nothing to add to `package.json` per provider, and no env read anywhere.

## Package -> subpath

| Vercel AI SDK package | Deuz import | Factory(s) |
| --- | --- | --- |
| `@ai-sdk/anthropic` | `@deuz-sdk/core/anthropic` | `createAnthropic` (surface `anthropic`) |
| `@ai-sdk/openai` | `@deuz-sdk/core/openai` | `createOpenAI` (Chat Completions), `createOpenAIResponses` (Responses API), `createOpenAIEmbedding` |
| `@ai-sdk/google` | `@deuz-sdk/core/google` | `createGoogle` (compat), `createGoogleNative` (full wire), `createGoogleEmbedding` |
| `@ai-sdk/google-vertex` | `@deuz-sdk/core/vertex` | `createVertexAnthropic`, `createVertexGoogle`, `createVertexGoogleNative` |
| `@ai-sdk/xai` | `@deuz-sdk/core/xai` | `createXai` |
| `@ai-sdk/azure` | `@deuz-sdk/core/azure` | `createAzure` |
| `@ai-sdk/amazon-bedrock` | `@deuz-sdk/core/bedrock` | `createBedrock` |
| `@ai-sdk/openai-compatible` | `@deuz-sdk/core/providers` | `createOpenAICompatible({ id, baseURL })` |
| `@ai-sdk/groq`, `@ai-sdk/mistral`, `@ai-sdk/deepseek`, … | `@deuz-sdk/core/providers` | `createGroq`, `createMistral`, `createDeepSeek`, `createTogether`, `createOpenRouter`, `createCerebras`, `createFireworks`, `createMoonshot` / `createKimi`, `createQwen`, `createGLM`, `createMiniMax` |
| — | `@deuz-sdk/core/voyage` | `createVoyage` (embeddings) |
| — | `@deuz-sdk/core/yunwu` | `createYunwu` unified relay (chat / image / embed / Midjourney) |

Each module also exports a lowercase no-key singleton (`anthropic`, `openai`, `google`, …) for use with `createClient({ apiKeys })` or `deps.keyProvider`. Unlike the AI SDK's singleton it reads **no** environment variable — it simply carries no key.

## The descriptor

A factory returns `Provider = (modelId: string) => LanguageModel`, and a `LanguageModel` is only `{ provider, modelId, surface }`. Factory settings (`apiKey`, `baseURL`, `fetch`, `headers`, Vertex `project`/`location`) live on a non-enumerable Symbol, so they never widen the public type and never leak through `Object.keys` / `JSON.stringify`.

`surface` is the only routing input:

| surface | wire |
| --- | --- |
| `anthropic` | `/v1/messages`, incl. Claude-on-Vertex |
| `chat_completions` | OpenAI Chat Completions, xAI, Gemini-compat, Yunwu, the compat factories |
| `responses` | OpenAI Responses API (GPT-5.x reasoning + tools) |
| `native` | Gemini `generateContent` (reasoning, thoughtSignature, caching, native PDF) |

**Pick the right OpenAI factory.** `createOpenAI` is Chat Completions; `createOpenAIResponses` is the Responses API and is what you want for GPT-5.x reasoning + tools (typed events, encrypted reasoning round-trip). The AI SDK's single `openai(...)` hides this choice, so a port has to make it explicitly.

**Pick the right Gemini factory.** `createGoogle` is the OpenAI-compat surface and is deliberately limited: no reasoning, no explicit cache, no native PDF/audio, and usage re-emitted per chunk. `createGoogleNative` is the full wire. Prefer native for anything beyond plain chat.

## `createOpenAICompatible` — a real provider id

The AI SDK's `@ai-sdk/openai-compatible` maps to `createOpenAICompatible` on `@deuz-sdk/core/providers` (1.9). Use it for Ollama, vLLM, LM Studio, Perplexity, or an internal gateway. Do NOT point a named factory at another host: keys, pricing, registry rows and every log line would resolve under the wrong provider id.

```ts
import { createOpenAICompatible } from '@deuz-sdk/core/providers';

const ollama = createOpenAICompatible({ id: 'ollama', baseURL: 'http://localhost:11434/v1' });
const model = ollama('qwen3'); // { provider: 'ollama', modelId: 'qwen3', surface: 'chat_completions' }
```

```ts
interface OpenAICompatibleSettings {
  id: string;                                    // REQUIRED — the provider id
  baseURL?: string;                              // effectively required: a custom id has no default
  apiKey?: string;
  fetch?: typeof fetch;
  headers?: Record<string, string>;
  surface?: 'chat_completions' | 'responses';    // default 'chat_completions'
  authHeader?: 'bearer' | 'api-key';             // default 'bearer'
  capabilities?: Partial<ModelCapabilities>;     // for this host's slugs
}
```

Two eager errors instead of a confusing 401 later: an empty `id`, and `surface: 'responses'` with `authHeader: 'api-key'` (the Responses adapter always sends `Authorization: Bearer`).

Core reads no env vars, so there is no `OPENAI_BASE_URL`-style fallback — pass `baseURL` here or via `createClient({ baseUrls: { [id]: … } })`.

## The registry, and why a port can be silently truncated

`core/registry.ts` is the single source of truth for per-model behaviour: the capability matrix (`vision`, `tools`, `reasoning`, `structuredOutput`, `caching`, `nativePdf`, `audio`, `contextWindow`, `maxOutput`) plus quirk flags.

An unknown slug does **not** throw. It falls back to a conservative `(provider, surface)` row — `maxOutput: 4096`, `reasoning: false`, `structuredOutput: false` — and logs a warning through the (no-op by default) logger. So a ported app on a brand-new slug can be silently capped at 4096 output tokens, lose `effort`, and be pushed onto the tool strategy for structured output.

Fix it without waiting for a registry release:

```ts
// per call
await generateText({ model, prompt, capabilities: { maxOutput: 32_000, reasoning: true, structuredOutput: true } });

// or per factory
createOpenAICompatible({ id: 'internal', baseURL: '…', capabilities: { maxOutput: 32_000 } });
```

The per-call value wins. `capabilities` changes what the SDK BELIEVES, not what the provider does — `capabilities.tools` is read by no adapter. Read the effective matrix with `getModelCapabilities(model)` (frozen copy, never throws; `caps.known === false` means the fallback row was used) and gate your UI on it instead of hard-coding slug lists.

## Gateway / registry

There is no hosted gateway and no plain string model id. `createProviderRegistry` is a pure local lookup over factories you wire yourself:

```ts
import { createProviderRegistry, createMistral, createDeepSeek } from '@deuz-sdk/core/providers';

const registry = createProviderRegistry({
  mistral: createMistral({ apiKey: process.env.MISTRAL_API_KEY! }),
  deepseek: createDeepSeek({ apiKey: process.env.DEEPSEEK_API_KEY! }),
});
const model = registry.model('mistral:mistral-large-latest'); // zero network
```

## Fail-over and middleware

| AI SDK | Deuz |
| --- | --- |
| `wrapLanguageModel` + middleware | `wrapModel(model, [...])` — first array element is OUTERMOST |
| bundled middleware | `logging`, `simpleCache`, `redactPII`, `promptInjectionGuard`, `withFallback` |
| — | `fallbackModels: [...]` on the call: hop to the next model on a pre-first-byte failure with the IDENTICAL canonical history |

`fallbackModels` marks the winner via `providerMetadata.deuz.failedOver = { from, to, reason }`. Note that both `fallbackModels` and the `withFallback` middleware return `consume: undefined`, so `res.consume?.()` is a silent no-op on those paths.

## Embeddings are a separate kind

`EmbeddingModel` and `LanguageModel` are deliberately distinct types — never cast between them. An `EmbeddingModel` (from `createOpenAIEmbedding`, `createGoogleEmbedding`, `createVoyage`, `yunwu.embedding`) only works with `embed` / `embedMany`.

```ts
const { embedding } = await embed({ model: createOpenAIEmbedding({ apiKey })('text-embedding-3-small'), value: 'hello' });
```

`embedMany` auto-batches to the provider's max batch size and caps concurrency.
