# Providers

A factory returns a `Provider` (`(modelId: string) => LanguageModel`). The `LanguageModel` descriptor is `{ provider, modelId, surface }`; factory settings (apiKey/baseURL/fetch/headers/vertex) are stashed on a non-enumerable Symbol, never on the public shape. Each module also exports a no-key singleton (`anthropic`, `openai`, ...) for use with `createClient({ apiKeys })` or `deps.keyProvider`.

All chat factory settings share this shape unless noted:
```ts
interface ProviderSettings { apiKey?: string; baseURL?: string; fetch?: typeof fetch; headers?: Record<string, string>; }
```

## Anthropic â€” `@deuz-sdk/core/anthropic`
```ts
createAnthropic(settings?: AnthropicSettings): Provider   // surface: 'anthropic'
const anthropic: Provider                                  // no baked key
```
Use for Claude on `/v1/messages` (extended thinking, prompt caching). Surface `anthropic`.

## OpenAI â€” `@deuz-sdk/core/openai`
```ts
createOpenAI(settings?): Provider           // surface: 'chat_completions'
createOpenAIResponses(settings?): Provider  // surface: 'responses'
createOpenAIEmbedding(settings?): EmbeddingProvider  // surface: 'openai-embeddings'
const openai, openaiResponses: Provider
const openaiEmbedding: EmbeddingProvider
```
- `createOpenAI` â†’ Chat Completions wire. Default for GPT chat.
- `createOpenAIResponses` â†’ Responses API. Pick this for GPT-5.x reasoning + tools (typed `response.*` events, encrypted reasoning round-trip).
- `createOpenAIEmbedding` â†’ `text-embedding-3-small`/`-large`. Returns an `EmbeddingModel` (use with `embed`/`embedMany` only).

## xAI Grok â€” `@deuz-sdk/core/xai`
```ts
createXai(settings?): Provider   // surface: 'chat_completions'
const xai: Provider
```
Grok over the OpenAI Chat Completions wire (registry-driven quirk flags). Models e.g. `grok-4.3`.

## Google Gemini â€” `@deuz-sdk/core/google`
```ts
interface GoogleSettings extends ProviderSettings { surface?: 'native' | 'chat_completions'; }
createGoogle(settings?): Provider         // default surface 'chat_completions' (compat)
createGoogleNative(settings?): Provider   // surface 'native' (generateContent)
createGoogleEmbedding(settings?): EmbeddingProvider  // surface 'gemini-embeddings'
const google, googleNative: Provider
const googleEmbedding: EmbeddingProvider
```
- `createGoogle` (compat, `â€¦/v1beta/openai/`) is LIMITED: no reasoning, no explicit cache, no native PDF/audio; usage re-emitted per chunk.
- `createGoogleNative` (or `surface:'native'`) for the FULL wire: reasoning + thoughtSignature, structured output, grounding, native PDF/audio. Prefer this for anything beyond plain chat.

### Gemini extras â€” `@deuz-sdk/core/google/extras`
Produces the opaque ids the native adapter passes through:
```ts
createGeminiCache(opts): Promise<CachedContent>   // â†’ .name â†’ options.cachedContent (cheap cached reads)
getGeminiCache(name, cfg); deleteGeminiCache(name, cfg); listGeminiCaches(cfg)
uploadFile(opts): Promise<UploadedFile>           // AI Studio Files API â†’ .uri for a fileData Part (>~20MB media)
waitForFileActive(name, cfg)
```
Config takes `apiKey` (AI Studio) OR `accessToken` + `vertex:{project,location}` (Vertex). Edge-safe.

## Vertex AI â€” `@deuz-sdk/core/vertex`
Vertex authenticates with a short-lived OAuth2 access token, not an API key. Prefer a refreshing `deps.keyProvider` over the static `accessToken` field.
```ts
interface VertexSettings { project: string; location: string; accessToken?: string; fetch?: typeof fetch; headers?: Record<string, string>; }
createVertexAnthropic(settings): Provider       // surface 'anthropic'  â€” Claude on Vertex, e.g. 'claude-sonnet-4-5'
createVertexGoogle(settings): Provider          // surface 'chat_completions' â€” Gemini compat, e.g. 'google/gemini-2.5-flash'
createVertexGoogleNative(settings): Provider    // surface 'native' â€” Gemini full caps, bare id e.g. 'gemini-2.5-pro'
```

## Voyage â€” `@deuz-sdk/core/voyage` (embeddings)
```ts
createVoyage(settings?): EmbeddingProvider   // surface 'voyage-embeddings'
const voyage: EmbeddingProvider
```
Retrieval-focused embeddings; `embed({ taskType })` maps to Voyage's `input_type` (query/document).

## Yunwu relay â€” `@deuz-sdk/core/yunwu`
One config, one base URL, every surface derived from it.
```ts
createYunwu(settings?: { apiKey?; baseURL?; fetch?; headers? }): YunwuClient
const yunwu: YunwuClient
// yunwu.chat(id) â†’ LanguageModel (chat_completions, /v1)
// yunwu.image(id) â†’ ImageModel (/v1/images/generations)
// yunwu.embedding(id) â†’ EmbeddingModel (/v1/embeddings)
// yunwu.mj() â†’ Midjourney config (bare root, NOT /v1)
// yunwu.models â†’ pinned 2026 catalog (YUNWU_MODELS)
```
Default host `https://yunwu.ai`. Catalogs: `YUNWU_CHAT_MODELS`, `YUNWU_IMAGE_MODELS`, `YUNWU_VIDEO_MODELS`, `YUNWU_MIDJOURNEY_MODELS`.

## Surface â†’ adapter map (`core/inference.ts`)

| surface | adapter | covers |
| --- | --- | --- |
| `anthropic` | anthropicAdapter | `/v1/messages`, incl. Claude-on-Vertex |
| `chat_completions` | openaiCompatibleAdapter | OpenAI Chat, xAI, Gemini-compat, Yunwu, Vertex-Gemini-compat |
| `responses` | openaiResponsesAdapter | OpenAI Responses API |
| `native` | googleNativeAdapter | Gemini generateContent |

Unknown model slugs do NOT throw â€” the registry falls back to conservative `(provider, surface)` defaults and logs a warning, so new releases work without a code change.
