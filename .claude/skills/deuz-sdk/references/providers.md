<!-- verified: 2026-09-20 against @deuz-sdk/core@2.1.0 · api-contract sha256:c301da6ab500
     sources: packages/core/src/{providers-compat,providers,openai,anthropic,google,xai,azure,bedrock,vertex,voyage,yunwu}.ts,
     packages/core/src/node/vertex-auth.ts, packages/core/src/types/{config,model,deps}.ts,
     packages/core/src/core/registry.ts, packages/core/src/internal/resolve-call.ts,
     docs/content/docs/providers/*.mdx, docs/content/docs/advanced/model-registry.mdx -->

# Providers and models

**Load when:** picking or wiring a provider, choosing between two wires of the same vendor (OpenAI Chat vs Responses, Gemini compat vs native), reaching a self-hosted or internal OpenAI-shaped host, authenticating Vertex/Azure/Bedrock, debugging `AuthenticationError` or a silently truncated answer, or building a string-keyed model router.

## The factory pattern

Every provider module exports a `createX(settings?)` **factory** plus a bare lowercase **singleton**. The factory returns a `Provider` — literally `(modelId: string) => LanguageModel`. Calling it builds a descriptor `{ provider, modelId, surface }`; the settings you passed (`apiKey`, `baseURL`, `fetch`, `headers`, …) are stashed on a non-enumerable Symbol, so they never appear in `Object.keys`, `JSON.stringify`, or a test's `toEqual`.

```ts
import { generateText } from '@deuz-sdk/core';
import { createAnthropic, anthropic } from '@deuz-sdk/core/anthropic';

// Factory: the key is baked into the closure.
const claude = createAnthropic({ apiKey: process.env.ANTHROPIC_API_KEY! });
const model = claude('claude-opus-4-8');
// → { provider: 'anthropic', modelId: 'claude-opus-4-8', surface: 'anthropic' }

// Singleton: NO key baked in — usable only when a key arrives some other way.
const bare = anthropic('claude-opus-4-8');

const { text } = await generateText({ model, prompt: 'ping' });
console.log(text, bare.surface);
```

Nothing is dialed at factory time — a `Provider` is a pure descriptor builder. Minting one per request costs nothing, and minting several with different `capabilities` or `baseURL` is the normal way to serve several models.

`EmbeddingProvider` is a deliberately separate kind: `createOpenAIEmbedding`, `createGoogleEmbedding`, `createVoyage` and `yunwu.embedding` return `EmbeddingModel` descriptors that only `embed` / `embedMany` accept. The type system refuses to let one reach `streamChat`; do not cast around it.

## Wire surfaces

`surface` is the only routing input — one exhaustive switch picks the adapter, with no per-provider branching anywhere else.

| `surface` | Wire | Factories that mint it |
| --- | --- | --- |
| `anthropic` | `/v1/messages` | `createAnthropic`, `createVertexAnthropic` |
| `chat_completions` | OpenAI Chat Completions | `createOpenAI`, `createXai`, `createGoogle`, `createAzure`, `createBedrock`, `createVertexGoogle`, every `/providers` compat factory, `createYunwuChat` |
| `responses` | OpenAI Responses | `createOpenAIResponses`, `createOpenAICompatible({ surface: 'responses' })` |
| `native` | Gemini `generateContent` | `createGoogleNative`, `createVertexGoogleNative` |

## Anthropic — `@deuz-sdk/core/anthropic`

`createAnthropic(settings?: AnthropicSettings)` → `Provider` (surface `anthropic`); singleton `anthropic`. Settings: `apiKey` (sent as `x-api-key`), `baseURL` (adapter appends `/v1/messages`), `fetch`, `headers`.

Use it for Claude with vision, extended thinking, prompt caching and tools. Reasoning is the canonical `effort` option; the adapter picks the wire from the registry row's `effortWire` — `output_config.effort` on Opus 4.7+/Sonnet 5/Fable 5 (manual `thinking.budget_tokens` 400s there), `thinking.budget_tokens` on Opus 4.6 and older. Those flagship rows also set `samplingRestrictions`, so `temperature`/`topP` are dropped rather than sent. `promptCaching: 'auto'` (or `'auto-1h'`) is the one-flag cache write; other providers cache implicitly and ignore it. Forced `toolChoice` is illegal alongside thinking — the adapter downgrades it to `'auto'`.

## OpenAI — `@deuz-sdk/core/openai`

Three factories, one settings type (`OpenAISettings`: `apiKey`, `baseURL`, `fetch`, `headers` — there is no `organization` field, send it via `headers`).

| Factory | Returns | Surface | Pick when |
| --- | --- | --- | --- |
| `createOpenAI` | `Provider` | `chat_completions` | General chat, tools, vision, structured output. `gpt-5.5`/`gpt-5.5-pro` accept `effort` here too. |
| `createOpenAIResponses` | `Provider` | `responses` | GPT-5.x / `o`-series reasoning (`gpt-5.4`, `o4-mini`), hosted `openaiWebSearch()`, encrypted reasoning replay across tool steps. |
| `createOpenAIEmbedding` | `EmbeddingProvider` | `openai-embeddings` | `text-embedding-3-small` (1536) / `-large` (3072). |

Singletons: `openai`, `openaiResponses`, `openaiEmbedding`. Chat Completions is the default for plain chat. Move to Responses when you need reasoning models: their registry rows carry `samplingRestrictions` (temperature/topP dropped), `maxOutputTokens` maps to `max_output_tokens`, and a Responses call with tools on a reasoning model automatically requests `include: ["reasoning.encrypted_content"]` with `store: false` and replays the encrypted items on later steps — stateless multi-step tool use stays coherent. Hosted provider tools (`openaiWebSearch`) exist on Responses only; they are dropped on the Chat Completions wire.

```ts
import { generateText, openaiWebSearch } from '@deuz-sdk/core';
import { createOpenAIResponses } from '@deuz-sdk/core/openai';

const responses = createOpenAIResponses({ apiKey: process.env.OPENAI_API_KEY! });

const res = await generateText({
  model: responses('gpt-5.4'),
  effort: 'high',
  prompt: 'What shipped in TypeScript this month?',
  tools: { web_search: openaiWebSearch({ search_context_size: 'low' }) },
  maxSteps: 4,
});
console.log(res.text, res.usage.reasoningTokens);
```

## xAI — `@deuz-sdk/core/xai`

`createXai(settings?: XaiSettings)` → `Provider` (`chat_completions`, default base `https://api.x.ai/v1`); singleton `xai`. Same four settings as OpenAI. Pinned slug `grok-4.3` (1M context, 128k output, vision + tools + reasoning). None of the Gemini-compat quirks apply. xAI is chat-only — there is no xAI embedding model, and passing one to `embed` is rejected before any network call.

## Google Gemini — `@deuz-sdk/core/google`

`GoogleSettings` adds one field to the usual four: `surface?: 'native' | 'chat_completions'` (default `chat_completions`).

| Factory | Surface | What you get |
| --- | --- | --- |
| `createGoogleNative` | `native` | Reasoning + `thoughtSignature` round-trip, explicit + implicit caching, native PDF/audio, `googleSearch()` grounding, structured output |
| `createGoogle` | `chat_completions` | Text, tools, vision only — **no** reasoning, **no** explicit cache, **no** native PDF/audio |
| `createGoogleEmbedding` | `gemini-embeddings` | `gemini-embedding-001` / `gemini-embedding-2`, with `taskType` / `dimensions` / `normalize` |

Singletons `google`, `googleNative`, `googleEmbedding`; `createGoogleNative(s)` is exactly `createGoogle({ ...s, surface: 'native' })`. **Default to native.** The compat surface exists for drop-in OpenAI-shaped interop and is capability-limited by design. Its two wire quirks (usage re-emitted on every chunk; every streamed tool-call fragment arriving with `index=0`) are already normalized by the adapter from registry flags — do not dedupe usage or re-key tool fragments yourself, and do not add your own `finishReason` checks: the loop counts accumulated `tool_use` precisely because Gemini can emit `finish: stop` with calls still pending.

`effort` maps per family on the native wire: `gemini-3*` → `thinkingConfig.thinkingLevel`, `gemini-2.5*` → `thinkingConfig.thinkingBudget`. Structured output goes through Gemini's restricted OpenAPI subset — `$ref` / `oneOf` / `anyOf` / `allOf` / `additionalProperties` are **stripped**, so flatten unions and recursion before passing a schema.

### `@deuz-sdk/core/google/extras`

The producer side for the opaque ids the native adapter passes through. Edge-safe. `createGeminiCache(opts) → CachedContent` (its `.name` goes on `providerOptions.google.cachedContent`), plus `getGeminiCache`, `listGeminiCaches`, `deleteGeminiCache`; `uploadFile(opts) → UploadedFile` for media over ~20 MB, then `waitForFileActive(name, cfg)` before you reference `file.uri`. Credentials are `apiKey` (AI Studio) **or** `accessToken` + `vertex: { project, location }`. `uploadFile` is AI Studio only — on Vertex it throws; upload to GCS and pass a `gs://` URI instead.

```ts
import { generateText } from '@deuz-sdk/core';
import { createGoogleNative } from '@deuz-sdk/core/google';
import { createGeminiCache } from '@deuz-sdk/core/google/extras';

const apiKey = process.env.GEMINI_API_KEY!;
declare const longManual: string;
const cache = await createGeminiCache({
  apiKey,
  model: 'gemini-2.5-flash', // must match the model on the call
  contents: [{ role: 'user', parts: [{ text: longManual }] }],
  ttl: '3600s',
});

const { text } = await generateText({
  model: createGoogleNative({ apiKey })('gemini-2.5-flash'),
  prompt: 'Summarize section 4.',
  providerOptions: { google: { cachedContent: cache.name } },
});
console.log(text);
```

## Azure — `@deuz-sdk/core/azure`

`createAzure(settings?: AzureSettings)` → `Provider` (`chat_completions`); singleton `azure`. Also re-exported from `/providers`.

| Field | Default | Notes |
| --- | --- | --- |
| `apiKey` | — | Azure key, or an Entra access token when `auth: 'bearer'` |
| `resourceName` | — | Builds `https://{resource}.openai.azure.com/openai/deployments/{deployment}`. Required unless `baseURL` is set — otherwise `InvalidRequestError` |
| `apiVersion` | `'2024-12-01-preview'` | Appended as `?api-version=…` on every request |
| `baseURL` | — | Foundry / proxy root; when set, `resourceName` is ignored |
| `auth` | `'api-key'` | `'bearer'` for Microsoft Entra ID |
| `fetch`, `headers` | — | Factory `fetch` wins over `deps.fetch` |

The argument to the returned `Provider` is the **deployment name**, not the model slug — and this is Chat Completions only, not the Azure AI Agents / Assistants REST surface.

## Bedrock — `@deuz-sdk/core/bedrock`

`createBedrock(settings?: BedrockSettings)` → `Provider` (`chat_completions`); singleton `bedrock`. Fields: `apiKey` (a Bedrock API key / short-term bearer, sent as `Authorization: Bearer`), `region` (default `'us-east-1'`), `baseURL`, `fetch`, `headers`. Default root `https://bedrock-mantle.{region}.api.aws/openai/v1`. Zero AWS SDK, no SigV4, edge-safe — which is also the limit: this is the **Mantle OpenAI-compatible** endpoint, not the Bedrock Runtime `Converse` API. Model ids are the Mantle form your account exposes (`openai.gpt-oss-120b`, `xai.grok-4.3`).

## Vertex AI — `@deuz-sdk/core/vertex` (+ `/vertex/node`)

Vertex hosts both Claude and Gemini behind one regional, IAM-gated transport and authenticates with a short-lived OAuth2 **Bearer token**, not an API key. `VertexSettings`: `project` and `location` (both required), optional `accessToken`, `fetch`, `headers`.

| Factory | Hosts | Surface | Model id form |
| --- | --- | --- | --- |
| `createVertexAnthropic` | Claude | `anthropic` | bare — `claude-sonnet-4-5` |
| `createVertexGoogleNative` | Gemini, full caps | `native` | bare — `gemini-2.5-flash` |
| `createVertexGoogle` | Gemini, OpenAI-compat | `chat_completions` | prefixed — `google/gemini-2.5-flash` |

`location: 'global'` resolves to `https://aiplatform.googleapis.com`; anything else to `https://<location>-aiplatform.googleapis.com`. The descriptor's provider id is `vertex-anthropic` or `vertex-google`, and `CLOUD_PLATFORM_SCOPE` is exported if you need the literal scope string.

`accessToken` expires in ~1h with **no refresh path** — it is only safe for a one-off script. For anything long-running inject a refreshing `deps.keyProvider`, and the SDK ships both halves so you do not write JWT signing yourself:

- **Edge / anywhere**: `createServiceAccountKeyProvider({ credentials, clock, fetch, scopes?, refreshSkewMs?, providers? })` from `/vertex`. WebCrypto RS256 over the service-account JSON. `clock` and `fetch` are **required** (nothing ambient). Tokens are cached per (client_email, scopes, endpoint) and concurrent misses coalesce into one exchange. It answers only for provider names starting with `vertex` unless you set `providers`.
- **Node**: `createAdcKeyProvider({ keyFile?, scopes?, refreshSkewMs?, clock?, fetch?, env?, metadataHost?, metadataTimeoutMs?, providers? })` from `/vertex/node`. Application Default Credentials: explicit `keyFile`, then `GOOGLE_APPLICATION_CREDENTIALS`, then the GCE/Cloud Run metadata server. This is the one documented place Deuz touches env, because ADC is *defined* in terms of it.

```ts
import { streamChat } from '@deuz-sdk/core';
import { createVertexAnthropic, createServiceAccountKeyProvider } from '@deuz-sdk/core/vertex';

const keyProvider = createServiceAccountKeyProvider({
  credentials: JSON.parse(process.env.GCP_SERVICE_ACCOUNT_JSON!),
  // Injected on purpose: core reads no ambient clock and no global fetch.
  clock: { now: () => Date.now(), setTimeout: (fn, ms) => { const t = setTimeout(fn, ms); return () => clearTimeout(t); } },
  fetch,
});

const vertex = createVertexAnthropic({ project: process.env.GCP_PROJECT!, location: 'us-east5' });

const result = streamChat({
  model: vertex('claude-sonnet-4-5'),
  prompt: 'Summarize Vertex AI in one sentence.',
  deps: { keyProvider },
});
for await (const chunk of result.textStream) process.stdout.write(chunk);
```

## Voyage — `@deuz-sdk/core/voyage`

`createVoyage(settings?: VoyageSettings)` → `EmbeddingProvider` (`voyage-embeddings`); singleton `voyage`. Settings are the usual four; default base `https://api.voyageai.com/v1`. Embedding-only — a Voyage model can never reach `generateText`/`streamChat`. Canonical `taskType` maps to Voyage's `input_type`: `search_document` → `document`, `search_query` → `query`, anything else omitted. `dimensions` sends `output_dimension` (Matryoshka truncation); pair it with `normalize: true`. Pinned slugs `voyage-3.5` / `voyage-3.5-lite` (1024 dims, batch 1000); unknown slugs fall back to 1024 dims / batch 96 with a warning.

## Yunwu relay — `@deuz-sdk/core/yunwu`

One key and one host root, every modality derived from it. `createYunwu(settings?: YunwuSettings)` → `YunwuClient`; singleton `yunwu`. `YunwuSettings` is `apiKey`, `baseURL` (default `YUNWU_DEFAULT_BASE_URL` = `https://yunwu.ai`, **no** `/v1`), `fetch`, `headers` — a trailing `/v1` or slash is stripped and re-derived per surface.

| Member | Returns | Path |
| --- | --- | --- |
| `chat(id)` | `LanguageModel` (`chat_completions`) | `{root}/v1/chat/completions` |
| `image(id)` | image model | `{root}/v1/images/generations` |
| `video(id)` | `VideoModel` | `{root}/v1/videos` |
| `embedding(id)` | `EmbeddingModel` | `{root}/v1/embeddings` |
| `mj()` | partial Midjourney config to spread | bare root, **not** `/v1` |
| `baseURL`, `models` | resolved root, pinned catalog | — |

Per-surface factories skip the client: `createYunwuChat`, `createYunwuImage`, `createYunwuVideo`, `createYunwuEmbedding`. Catalogs: `YUNWU_MODELS`, `YUNWU_CHAT_MODELS`, `YUNWU_IMAGE_MODELS`, `YUNWU_VIDEO_MODELS`, `YUNWU_MIDJOURNEY_MODELS` — pass-through strings, so any slug the relay serves works.

## `/providers` — every compat host

All of these speak Chat Completions and take the same `CompatSettings`: `apiKey`, `baseURL`, `fetch`, `headers`, `capabilities`.

| Factory | Singleton | Provider id | Default base URL | Notes |
| --- | --- | --- | --- | --- |
| `createGroq` | `groq` | `groq` | `https://api.groq.com/openai/v1` | pinned `llama-4-maverick` |
| `createMistral` | `mistral` | `mistral` | `https://api.mistral.ai/v1` | pinned `mistral-large-latest` |
| `createDeepSeek` | `deepseek` | `deepseek` | `https://api.deepseek.com/v1` | V4 rows always reason — see below |
| `createTogether` | `together` | `together` | `https://api.together.xyz/v1` | no pinned slugs |
| `createOpenRouter` | `openrouter` | `openrouter` | `https://openrouter.ai/api/v1` | no pinned slugs |
| `createCerebras` | `cerebras` | `cerebras` | `https://api.cerebras.ai/v1` | no pinned slugs |
| `createFireworks` | `fireworks` | `fireworks` | `https://api.fireworks.ai/inference/v1` | no pinned slugs |
| `createMoonshot` / `createKimi` | `moonshot` / `kimi` | `moonshot` | `https://api.moonshot.ai/v1` | `createKimi` is an alias, same id |
| `createQwen` | `qwen` | `qwen` | `https://dashscope.aliyuncs.com/compatible-mode/v1` | pinned `qwen3-max` |
| `createGLM` | `glm` | `glm` | `https://open.bigmodel.cn/api/paas/v4` | pinned `glm-4.6` |
| `createMiniMax` | `minimax` | `minimax` | `https://api.minimax.io/v1` | pinned `minimax-m2` |
| `createPerplexity` | `perplexity` | `perplexity` | `https://api.perplexity.ai` | **no `/v1`**; rows pin `tools: false` |
| `createCohere` | `cohere` | `cohere` | `https://api.cohere.ai/compatibility/v1` | OpenAI *compatibility* endpoint |
| `createDeepInfra` | `deepinfra` | `deepinfra` | `https://api.deepinfra.com/v1/openai` | `org/Model` slugs |
| `createNvidia` | `nvidia` | `nvidia` | `https://integrate.api.nvidia.com/v1` | NIM, lower-cased `vendor/model` |
| `createSambaNova` | `sambanova` | `sambanova` | `https://api.sambanova.ai/v1` | bare CamelCase slugs |
| `createHyperbolic` | `hyperbolic` | `hyperbolic` | `https://api.hyperbolic.xyz/v1` | `org/Model` slugs |
| `createOllama` | `ollama` | `ollama` | `http://localhost:11434/v1` | **keyless** (`apiKeyOptional` pinned) |
| `createLMStudio` | `lmstudio` | `lmstudio` | `http://localhost:1234/v1` | **keyless** (`apiKeyOptional` pinned) |
| `createAzure` | `azure` | `azure` | deployment-scoped | re-export of `/azure` |
| `createBedrock` | `bedrock` | `bedrock` | Mantle `…/openai/v1` | re-export of `/bedrock` |

**Perplexity `tools: false`.** Sonar's search runs server-side; the API has no `tools` array, so `sonar` / `sonar-pro` / `sonar-reasoning-pro` pin `tools: false` and `structuredOutput: false` and a tool loop against them calls nothing. Perplexity's `citations` array is a top-level response field the Chat Completions wire has no slot for, so it is not surfaced as a canonical part.

**The keyless two.** `createOllama` and `createLMStudio` set `apiKeyOptional` internally: when the whole G1 chain comes up empty the resolver substitutes a placeholder bearer token instead of throwing. That is the only change — a real key from any link still wins (useful behind an authenticating reverse proxy). No cloud factory inherits this; `createPerplexity()` with no key still throws `AuthenticationError`.

**DeepSeek V4 always thinks.** `deepseek-v4-flash` / `-pro` reason on every call with no switch, and reasoning shares the output budget — a `maxOutputTokens` sized for the visible reply returns an **empty string**, not an error. Give it room (512+). `generateObject` does not work on V4 at all: it rejects both the `json_schema` and the forced-`tool_choice` strategies. Ask for the shape in the prompt and `JSON.parse` the text; ordinary unforced tool calling is unaffected.

**The registry is keyed by slug alone, not by (provider, slug).** Two hosts serving the same string share one row. That is usually right on an aggregator (`openrouter('kimi-k2')` inherits the Moonshot row) and occasionally wrong: `together('gpt-5.5')` would pick up the OpenAI row. A per-factory `capabilities` override fixes it, because the merge happens after the row is chosen.

## `createOpenAICompatible` — a self-hosted model or internal gateway

For any OpenAI-shaped host with no named factory: vLLM, llama.cpp, TGI, a company gateway. Do **not** point a named factory somewhere else (`createGroq({ baseURL: 'https://llm.internal/v1' })`) — keys, pricing, registry rows and every log line would resolve under the wrong provider id.

```ts
import { streamChat } from '@deuz-sdk/core';
import { createOpenAICompatible } from '@deuz-sdk/core/providers';

const vllm = createOpenAICompatible({
  id: 'vllm', // YOUR provider id: key lookup, registry, pricing, observation, logs
  baseURL: 'http://gpu-box.internal:8000/v1', // effectively required — a custom id has no default
  apiKeyOptional: true, // unauthenticated box on your LAN; drop it the moment it is public
  capabilities: { tools: true, maxOutput: 32_000, contextWindow: 131_072 },
});

const result = streamChat({ model: vllm('gpt-oss-120b'), prompt: 'ping' });
for await (const chunk of result.textStream) process.stdout.write(chunk);
```

`OpenAICompatibleSettings` = `CompatSettings` (`apiKey`, `baseURL`, `fetch`, `headers`, `capabilities`) plus:

| Field | Default | Meaning |
| --- | --- | --- |
| `id` | — | **Required.** Non-empty; used verbatim as the descriptor's `provider` |
| `surface` | `'chat_completions'` | Or `'responses'` for a Responses-shaped host |
| `authHeader` | `'bearer'` | Or `'api-key'` — honoured on the `chat_completions` wire only |
| `apiKeyOptional` | `false` | Substitute a placeholder when the whole G1 chain is empty, instead of throwing |

Two **eager** errors (`InvalidRequestError`, before any request) instead of a confusing 401 later: an empty `id`, and `surface: 'responses'` combined with `authHeader: 'api-key'` — the Responses adapter always sends `Authorization: Bearer`; pass the header yourself via `headers: { 'api-key': … }` if you need it.

Core reads no env, so there is no `OPENAI_BASE_URL`-style fallback: supply `baseURL` here or via `createClient({ baseUrls: { [id]: … } })`, or the call fails with `InvalidRequestError`.

## `createProviderRegistry` — a string-keyed router

A pure, synchronous descriptor lookup over factories you wire up — zero network, no hosted gateway.

```ts
import { generateText } from '@deuz-sdk/core';
import { createProviderRegistry, createGroq, createOllama } from '@deuz-sdk/core/providers';
import { createOpenAI } from '@deuz-sdk/core/openai';

const registry = createProviderRegistry({
  groq: createGroq({ apiKey: process.env.GROQ_API_KEY! }),
  openai: createOpenAI({ apiKey: process.env.OPENAI_API_KEY! }),
  ollama: createOllama({ capabilities: { tools: true, maxOutput: 32_000 } }),
});

registry.providers; // ['groq', 'openai', 'ollama'] — insertion order

const { text } = await generateText({ model: registry.model('groq:llama-4-maverick'), prompt: 'ping' });
console.log(text);
```

Only the **first** separator splits, so slash-namespaced ids survive (`'openrouter:meta-llama/llama-4-maverick'`). Pass `{ separator: '/' }` as the second argument to change it (an empty separator throws `InvalidRequestError`). An unknown provider id throws `ModelNotFoundError`; a missing or empty model id throws `InvalidRequestError`. The map keys are yours — they need not match the factory's own provider id, but the descriptor still carries the factory's id, which is what G1, pricing and the registry use.

## The capability registry — and the 4096 trap

A descriptor carries no capabilities. Everything about *how* to talk to a model comes from one flat registry keyed by slug. **An unknown slug never throws.** It takes a conservative fallback row plus one `unknown-model` warning:

| Field | Fallback | What it costs |
| --- | --- | --- |
| `maxOutput` | `4096` | **The one that matters.** It becomes the request's `max_tokens` — long answers are silently truncated mid-sentence |
| `contextWindow` | `128_000` | Feeds compaction sizing |
| `tools` | `false` | Reported only; **no adapter reads it**, tool calling works regardless |
| `reasoning` | `false` | `effort` is dropped rather than sent |
| `structuredOutput` | `false` | `generateObject` uses the tool strategy instead of `json_schema` |
| `vision`, `caching`, `nativePdf`, `audio` | `false` | Reported only |

The `native` (Gemini) surface is the exception: its fallback is fully ON (`contextWindow: 1_000_000`, `maxOutput: 64_000`) because that wire is uniform across generations.

Fix it without waiting for a registry release. `capabilities` is shallow-merged over the resolved row; the **per-call** value wins over the factory one.

```ts
import { generateText, getModelCapabilities } from '@deuz-sdk/core';
import { createTogether } from '@deuz-sdk/core/providers';

// Once, at the factory — applies to every slug this factory mints.
const together = createTogether({
  apiKey: process.env.TOGETHER_API_KEY!,
  capabilities: { maxOutput: 32_000, contextWindow: 131_072, reasoning: true },
});
const model = together('some-new-model');

const caps = getModelCapabilities(model);
if (!caps.known) console.warn('fallback row in use:', caps.maxOutput);

// Per call wins over the factory value.
const { text } = await generateText({
  model,
  prompt: 'Write a long design doc.',
  capabilities: { maxOutput: 64_000, structuredOutput: true },
});
console.log(text);
```

`getModelCapabilities(model)` returns the effective row plus any factory override as a **frozen copy**. It never throws and never emits a warning, so it is safe to call from UI gating code (`caps.vision` → show the image upload, `caps.known === false` → show a "new model" hint). Mutating the result is a no-op.

Two things `capabilities` is not. It overrides what the SDK **believes**, never what the provider does — `capabilities.tools` is read by no adapter, so setting it neither enables nor disables tool calling. And nothing is validated: an override is a claim about your model. Be especially careful with `structuredOutput: true` on a local model — it switches `generateObject` from the tool strategy to `response_format: { type: 'json_schema' }`, which a small fine-tune will happily ignore and answer with prose.

A call that passes `capabilities` runs against a per-call clone of the descriptor, so object *identity* differs for that call; key and base-URL resolution are unchanged.

## G1 — key precedence, spelled out

Core reads **no** environment variable, ever (it has to run on Edge). Keys are injected. Precedence, highest first:

1. `deps.keyProvider.getKey(provider)` — may be async, may return `undefined` to fall through.
2. Factory `apiKey` — `createOpenAI({ apiKey })`.
3. `createClient({ apiKeys: { [providerId]: key } })` — lowest, deliberately not wrapped as a keyProvider.
4. Nothing → `AuthenticationError`, *or* a placeholder bearer token when the factory set `apiKeyOptional` (Ollama, LM Studio, opt-in `createOpenAICompatible`).

`baseURL` follows its own chain: factory `baseURL` → `createClient({ baseUrls })` → the wire default (and there is no default for a custom `createOpenAICompatible` id). Factory `fetch` wins over `deps.fetch`.

`ClientConfig.apiKeys` has an index signature in 2.0, so any provider id resolves through it — the 2.0 hosts, a `createOpenAICompatible` id, and modality providers like `elevenlabs` / `deepgram` (threaded onto free functions via `client.bind(...)`).

A `keyProvider` is **client-wide** and sits at the top of the chain, so an unscoped one hands its token to every provider. Return `undefined` for anything that is not yours:

```ts
import { createClient } from '@deuz-sdk/core';
import type { KeyProvider } from '@deuz-sdk/core';
import { anthropic } from '@deuz-sdk/core/anthropic';

declare function fetchFromVault(name: string): Promise<string>;

const keyProvider: KeyProvider = {
  async getKey(provider) {
    // Scope it: anything not ours falls through to the factory / apiKeys table.
    if (provider !== 'anthropic') return undefined;
    return fetchFromVault('anthropic-prod'); // rotated per request, cached by you
  },
};

const client = createClient({
  deps: { keyProvider },
  apiKeys: { openai: process.env.OPENAI_API_KEY! }, // lowest link — used for openai
  baseUrls: { openai: 'https://gateway.internal/openai/v1' },
});

// The keyless singleton is fine here: the keyProvider supplies the key.
const { text } = await client.generateText({ model: anthropic('claude-opus-4-8'), prompt: 'ping' });
console.log(text);
```

Do not try to "fix" the ordering by passing client-level keys as a keyProvider — they are last on purpose, so a per-model factory key can override the app-wide default.

## Sharp edges

- An unknown slug is **silently capped at 4096 output tokens**, and the only signal is a `logger.warn` — and the default logger is a no-op. Wire a real `deps.logger` or you will never see it.
- `result.warnings` carries the `unknown-model` notice on every call shape, tool-carrying ones included — as a promise on `streamChat` / `streamObject`, as a plain array on `generateText` / `generateObject` with the key omitted when empty.
- Node-only provider auth: `/vertex/node` (`createAdcKeyProvider`) throws on Edge; `/vertex` (`createServiceAccountKeyProvider`) is edge-safe. And pointing `createOpenAI` at a Gemini endpoint works on the wire but skips the Gemini quirk flags — use `createGoogle` / `createGoogleNative`.
- A local embedding server has no keyless escape: point `createOpenAIEmbedding({ baseURL, apiKey: 'anything' })` at it, and accept that the descriptor's provider id stays `'openai'` for pricing and logs.
- Cost is `undefined`, not broken, for a provider id with no price row (every local and custom id).

## Deep dive

- [/docs/providers/anthropic](/docs/providers/anthropic)
- [/docs/providers/openai](/docs/providers/openai)
- [/docs/providers/google](/docs/providers/google)
- [/docs/providers/vertex](/docs/providers/vertex)
- [/docs/providers/azure](/docs/providers/azure), [/docs/providers/bedrock](/docs/providers/bedrock)
- [/docs/providers/xai](/docs/providers/xai)
- [/docs/providers/voyage](/docs/providers/voyage), [/docs/providers/yunwu](/docs/providers/yunwu)
- [/docs/providers/compat](/docs/providers/compat), [/docs/providers/local](/docs/providers/local)
- [/docs/advanced/model-registry](/docs/advanced/model-registry)
- [/docs/core/dependencies](/docs/core/dependencies)
