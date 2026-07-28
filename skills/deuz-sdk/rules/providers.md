# Providers

A factory returns a `Provider` (`(modelId: string) => LanguageModel`). The `LanguageModel` descriptor is `{ provider, modelId, surface }`; factory settings (apiKey/baseURL/fetch/headers/vertex) are stashed on a non-enumerable Symbol, never on the public shape. Each module also exports a no-key singleton (`anthropic`, `openai`, ...) for use with `createClient({ apiKeys })` or `deps.keyProvider`.

All chat factory settings share this shape unless noted:
```ts
interface ProviderSettings { apiKey?: string; baseURL?: string; fetch?: typeof fetch; headers?: Record<string, string>; }
```

## Anthropic — `@deuz-sdk/core/anthropic`
```ts
createAnthropic(settings?: AnthropicSettings): Provider   // surface: 'anthropic'
const anthropic: Provider                                  // no baked key
```
Use for Claude on `/v1/messages` (extended thinking, prompt caching). Surface `anthropic`.

## OpenAI — `@deuz-sdk/core/openai`
```ts
createOpenAI(settings?): Provider           // surface: 'chat_completions'
createOpenAIResponses(settings?): Provider  // surface: 'responses'
createOpenAIEmbedding(settings?): EmbeddingProvider  // surface: 'openai-embeddings'
const openai, openaiResponses: Provider
const openaiEmbedding: EmbeddingProvider
```
- `createOpenAI` → Chat Completions wire. Default for GPT chat.
- `createOpenAIResponses` → Responses API. Pick this for GPT-5.x reasoning + tools (typed `response.*` events, encrypted reasoning round-trip).
- `createOpenAIEmbedding` → `text-embedding-3-small`/`-large`. Returns an `EmbeddingModel` (use with `embed`/`embedMany` only).

## xAI Grok — `@deuz-sdk/core/xai`
```ts
createXai(settings?): Provider   // surface: 'chat_completions'
const xai: Provider
```
Grok over the OpenAI Chat Completions wire (registry-driven quirk flags). Models e.g. `grok-4.3`.

## Google Gemini — `@deuz-sdk/core/google`
```ts
interface GoogleSettings extends ProviderSettings { surface?: 'native' | 'chat_completions'; }
createGoogle(settings?): Provider         // default surface 'chat_completions' (compat)
createGoogleNative(settings?): Provider   // surface 'native' (generateContent)
createGoogleEmbedding(settings?): EmbeddingProvider  // surface 'gemini-embeddings'
const google, googleNative: Provider
const googleEmbedding: EmbeddingProvider
```
- `createGoogle` (compat, `…/v1beta/openai/`) is LIMITED: no reasoning, no explicit cache, no native PDF/audio; usage re-emitted per chunk.
- `createGoogleNative` (or `surface:'native'`) for the FULL wire: reasoning + thoughtSignature, structured output, grounding, native PDF/audio. Prefer this for anything beyond plain chat.

### Gemini extras — `@deuz-sdk/core/google/extras`
Produces the opaque ids the native adapter passes through:
```ts
createGeminiCache(opts): Promise<CachedContent>   // → .name → options.cachedContent (cheap cached reads)
getGeminiCache(name, cfg); deleteGeminiCache(name, cfg); listGeminiCaches(cfg)
uploadFile(opts): Promise<UploadedFile>           // AI Studio Files API → .uri for a fileData Part (>~20MB media)
waitForFileActive(name, cfg)
```
Config takes `apiKey` (AI Studio) OR `accessToken` + `vertex:{project,location}` (Vertex). Edge-safe.

## Vertex AI — `@deuz-sdk/core/vertex`
Vertex authenticates with a short-lived OAuth2 access token, not an API key. `accessToken` is a ~1h
convenience with no refresh path; for anything long-running inject a refreshing `deps.keyProvider`.
1.9 ships both layers, so you no longer write the JWT signing yourself:
`createServiceAccountKeyProvider({ credentials, clock, fetch })` from `@deuz-sdk/core/vertex`
(edge-safe, WebCrypto RS256, `clock`/`fetch` are REQUIRED so nothing is ambient), and
`createAdcKeyProvider({ keyFile? })` from `@deuz-sdk/core/vertex/node` (Application Default
Credentials: explicit keyFile, then GOOGLE_APPLICATION_CREDENTIALS, then the metadata server — the
one documented place Deuz reads env, because ADC is defined in terms of it).
```ts
interface VertexSettings { project: string; location: string; accessToken?: string; fetch?: typeof fetch; headers?: Record<string, string>; }
createVertexAnthropic(settings): Provider       // surface 'anthropic'  — Claude on Vertex, e.g. 'claude-sonnet-4-5'
createVertexGoogle(settings): Provider          // surface 'chat_completions' — Gemini compat, e.g. 'google/gemini-2.5-flash'
createVertexGoogleNative(settings): Provider    // surface 'native' — Gemini full caps, bare id e.g. 'gemini-2.5-pro'
```

## Voyage — `@deuz-sdk/core/voyage` (embeddings)
```ts
createVoyage(settings?): EmbeddingProvider   // surface 'voyage-embeddings'
const voyage: EmbeddingProvider
```
Retrieval-focused embeddings; `embed({ taskType })` maps to Voyage's `input_type` (query/document).

## Yunwu relay — `@deuz-sdk/core/yunwu`
One config, one base URL, every surface derived from it.
```ts
createYunwu(settings?: { apiKey?; baseURL?; fetch?; headers? }): YunwuClient
const yunwu: YunwuClient
// yunwu.chat(id) → LanguageModel (chat_completions, /v1)
// yunwu.image(id) → ImageModel (/v1/images/generations)
// yunwu.embedding(id) → EmbeddingModel (/v1/embeddings)
// yunwu.mj() → Midjourney config (bare root, NOT /v1)
// yunwu.models → pinned 2026 catalog (YUNWU_MODELS)
```
Default host `https://yunwu.ai`. Catalogs: `YUNWU_CHAT_MODELS`, `YUNWU_IMAGE_MODELS`, `YUNWU_VIDEO_MODELS`, `YUNWU_MIDJOURNEY_MODELS`.

## Surface → adapter map (`core/inference.ts`)

| surface | adapter | covers |
| --- | --- | --- |
| `anthropic` | anthropicAdapter | `/v1/messages`, incl. Claude-on-Vertex |
| `chat_completions` | openaiCompatibleAdapter | OpenAI Chat, xAI, Gemini-compat, Yunwu, Vertex-Gemini-compat |
| `responses` | openaiResponsesAdapter | OpenAI Responses API |
| `native` | googleNativeAdapter | Gemini generateContent |

Unknown model slugs do NOT throw — the registry falls back to conservative `(provider, surface)` defaults and logs a warning, so new releases work without a code change.

## Compat hosts + the generic factory - `@deuz-sdk/core/providers`

Named factories (all `surface: 'chat_completions'`): `createGroq`, `createMistral`, `createDeepSeek`, `createTogether`, `createOpenRouter`, `createCerebras`, `createFireworks`, `createMoonshot` / `createKimi`, `createQwen`, `createGLM`, `createMiniMax`, plus `createAzure` / `createBedrock` re-exported from their own subpaths. `createProviderRegistry({...})` gives a local string lookup (`registry.model('groq:llama-4-maverick')`) with zero network - there is no hosted gateway.

For a host with NO named factory (Ollama, vLLM, LM Studio, Perplexity, an internal gateway) use `createOpenAICompatible` (1.9). Do NOT point a named factory somewhere else: keys, pricing, registry rows and every log line would resolve under the wrong provider id.

```ts
import { createOpenAICompatible } from '@deuz-sdk/core/providers';

const ollama = createOpenAICompatible({ id: 'ollama', baseURL: 'http://localhost:11434/v1' });
const model = ollama('qwen3'); // { provider: 'ollama', modelId: 'qwen3', surface: 'chat_completions' }
```

```ts
interface OpenAICompatibleSettings {
  id: string;                                  // REQUIRED - the provider id used for G1 key lookup
  baseURL?: string;                            // effectively required: a custom id has NO default
  apiKey?: string; fetch?: typeof fetch; headers?: Record<string, string>;
  surface?: 'chat_completions' | 'responses';  // default 'chat_completions'
  authHeader?: 'bearer' | 'api-key';           // default 'bearer'
  capabilities?: Partial<ModelCapabilities>;   // for this host's unknown slugs
}
```

Two EAGER errors instead of a confusing 401 later: an empty `id`, and `surface: 'responses'` with `authHeader: 'api-key'` (the Responses adapter always sends `Authorization: Bearer` - pass the header yourself via `headers` if you need it).

## capabilities - override the registry row (1.9)

An unknown slug's fallback row is `maxOutput: 4096`, `reasoning: false`, `structuredOutput: false`, so a brand-new slug is SILENTLY TRUNCATED at 4096 output tokens. Fix it without a registry release:

```ts
await generateText({ model, prompt, capabilities: { maxOutput: 32_000, reasoning: true, structuredOutput: true } });
createOpenAICompatible({ id: 'internal', baseURL: '...', capabilities: { maxOutput: 32_000 } });
```

Shallow-merged over the resolved row; the per-call value wins over the factory one. It overrides what the SDK BELIEVES, not what the provider does - `capabilities.tools` is read by NO adapter. `getModelCapabilities(model)` (root export) returns the effective frozen matrix and never throws; `caps.known === false` means the fallback row was used.
