import type { LanguageModel, ModelSurface, Provider } from './types/model';
import type { ModelCapabilities } from './core/registry';
import { attachConfig, type ProviderConfig } from './internal/config-symbol';
import { InvalidRequestError } from './errors';

/**
 * OpenAI-Chat-Completions-compatible provider factories (v1.6.0). Every named
 * host here speaks the Chat Completions wire, so their descriptors carry
 * `surface: 'chat_completions'` and dispatch to the openai-compatible adapter
 * with registry-driven capability/quirk flags. Default base URLs live in
 * `internal/resolve-call.ts` (`DEFAULT_BASE_URL`); flagship slugs are pinned in
 * `core/registry.ts` and unknown slugs fall back conservatively (no throw).
 *
 * 1.9 adds the generic `createOpenAICompatible({ id, … })` on top of the SAME
 * private closure, so an unlisted OpenAI-shaped host (Ollama, vLLM, LM Studio,
 * an internal gateway) can carry its OWN provider id instead of borrowing an
 * unrelated factory's — see the doc comment on that function.
 *
 * 2.0 adds eight more named hosts — six cloud (Perplexity, Cohere, DeepInfra,
 * NVIDIA NIM, SambaNova, Hyperbolic) and two KEYLESS local ones (Ollama, LM
 * Studio), which pin `apiKeyOptional` so an unauthenticated localhost server
 * needs no ceremonial fake key. See `providers/local.mdx`.
 */
export interface CompatSettings {
  apiKey?: string;
  baseURL?: string;
  fetch?: typeof fetch;
  headers?: Record<string, string>;
  /**
   * Capability overrides for every slug this factory mints (public in 2.0).
   * The registry pins flagship cloud slugs, but a LOCAL host serves whatever
   * you pulled — `ollama('my-finetune:latest')` can never be a known row, so
   * it falls back to the conservative default (`tools: false`, `maxOutput:
   * 4096`). Say what you know here once instead of on every call:
   * `createOllama({ capabilities: { tools: true, maxOutput: 32_000 } })`.
   * A per-call `CommonCallOptions.capabilities` still wins over it.
   */
  capabilities?: Partial<ModelCapabilities>;
}

/**
 * Settings the shared closure understands. The named factories only ever pass
 * the `CompatSettings` subset; `createOpenAICompatible` also passes the wire
 * dialect / auth style, and the two local factories pin `apiKeyOptional`.
 * Keeping ONE implementation is the point — the named factories must stay
 * byte-identical, which is why every post-1.8 field below is spread
 * CONDITIONALLY into the config blob.
 */
interface CompatInternalSettings extends CompatSettings {
  surface?: Extract<ModelSurface, 'chat_completions' | 'responses'>;
  authHeader?: 'bearer' | 'api-key';
  /** Keyless local host — see `ProviderConfig.apiKeyOptional`. */
  apiKeyOptional?: boolean;
}

/** Bind a provider id to the shared factory shape (same pattern as createXai). */
function createCompat(provider: string, settings: CompatInternalSettings): Provider {
  const surface: ModelSurface = settings.surface ?? 'chat_completions';
  return (modelId: string): LanguageModel => {
    const config: ProviderConfig = {
      provider,
      apiKey: settings.apiKey,
      baseURL: settings.baseURL,
      fetch: settings.fetch,
      headers: settings.headers,
      // Conditional so a named factory's config blob is key-for-key what it was
      // before 1.9 (resolveCall also only forwards `authHeader` when truthy).
      ...(settings.authHeader ? { authHeader: settings.authHeader } : {}),
      ...(settings.capabilities ? { capabilities: settings.capabilities } : {}),
      ...(settings.apiKeyOptional ? { apiKeyOptional: true } : {}),
    };
    return attachConfig({ provider, modelId, surface }, config);
  };
}

/**
 * Settings for the generic OpenAI-compatible factory. Extends `CompatSettings`
 * with the three things a named factory hard-codes.
 */
export interface OpenAICompatibleSettings extends CompatSettings {
  /**
   * Logical provider id used for G1 key/baseURL lookup, the capability
   * registry, pricing and every observation event / log line. Required — it is
   * exactly the thing that is wrong when you point `createGroq` at localhost.
   */
  id: string;
  /** Wire dialect. Default `'chat_completions'`. Use `'responses'` for OpenAI-Responses-shaped hosts. */
  surface?: Extract<ModelSurface, 'chat_completions' | 'responses'>;
  /** Auth header style. Default `'bearer'`. */
  authHeader?: 'bearer' | 'api-key';
  /**
   * Opt into the KEYLESS escape (2.0) for a host that authenticates nothing —
   * a self-hosted vLLM / llama.cpp / TGI, or Ollama behind a custom id. When
   * the whole G1 chain comes up empty the resolver substitutes a placeholder
   * bearer token instead of throwing `AuthenticationError`; a real key from
   * any link still wins. Leave it off for anything reachable from the public
   * internet — the throw is what tells you a key went missing.
   */
  apiKeyOptional?: boolean;
}

/**
 * Generic OpenAI-compatible provider factory (1.9) — for any host that speaks
 * the OpenAI wire but has no named factory here: Ollama, vLLM, LM Studio,
 * Perplexity, an internal company gateway.
 *
 * ```ts
 * import { createOpenAICompatible } from '@deuz-sdk/core/providers';
 *
 * const ollama = createOpenAICompatible({ id: 'ollama', baseURL: 'http://localhost:11434/v1' });
 * const model = ollama('qwen3'); // → { provider: 'ollama', modelId: 'qwen3', surface: 'chat_completions' }
 * ```
 *
 * G1 is untouched: `id` is stored as the descriptor's `provider`, so the key
 * still resolves through `internal/resolve-call.ts` in the documented order
 * (`deps.keyProvider` > factory `apiKey` > `ClientConfig.apiKeys[id]` > throw
 * `AuthenticationError`, or a placeholder when `apiKeyOptional` is set for a
 * keyless local host) — `id` creates no bypass. Core NEVER reads env vars,
 * so there is no `OPENAI_BASE_URL`-style fallback: pass `baseURL` here or via
 * `createClient({ baseUrls: { [id]: … } })`, otherwise the call fails with an
 * `InvalidRequestError` (no default exists for a custom id).
 */
export function createOpenAICompatible(settings: OpenAICompatibleSettings): Provider {
  const id = settings.id?.trim();
  if (!id) {
    throw new InvalidRequestError({
      message:
        'createOpenAICompatible requires a non-empty `id` — it is the provider id used for key lookup (G1), the registry, pricing and observation.',
    });
  }
  // The Responses adapter hard-codes `Authorization: Bearer` (call.authHeader is
  // only honoured on the chat_completions wire). Fail loudly instead of sending
  // the wrong auth header and letting the host answer 401 with no explanation.
  if (settings.surface === 'responses' && settings.authHeader === 'api-key') {
    throw new InvalidRequestError({
      message:
        "createOpenAICompatible: authHeader 'api-key' is only honoured on the 'chat_completions' wire; the Responses adapter always sends `Authorization: Bearer`. Use surface 'chat_completions', or pass the header yourself via `headers: { 'api-key': … }`.",
      provider: id,
    });
  }
  return createCompat(id, {
    apiKey: settings.apiKey,
    baseURL: settings.baseURL,
    fetch: settings.fetch,
    headers: settings.headers,
    ...(settings.surface ? { surface: settings.surface } : {}),
    ...(settings.authHeader ? { authHeader: settings.authHeader } : {}),
    ...(settings.capabilities ? { capabilities: settings.capabilities } : {}),
    ...(settings.apiKeyOptional ? { apiKeyOptional: true } : {}),
  });
}

/** Groq LPU cloud (Llama 4, DeepSeek distills, …) — OpenAI Chat Completions-compatible wire. */
export function createGroq(settings: CompatSettings = {}): Provider {
  return createCompat('groq', settings);
}
export const groq: Provider = createGroq();

/** Mistral La Plateforme — OpenAI Chat Completions-compatible wire. */
export function createMistral(settings: CompatSettings = {}): Provider {
  return createCompat('mistral', settings);
}
export const mistral: Provider = createMistral();

/** DeepSeek (V3.x chat / R1 reasoner) — OpenAI Chat Completions-compatible wire. */
export function createDeepSeek(settings: CompatSettings = {}): Provider {
  return createCompat('deepseek', settings);
}
export const deepseek: Provider = createDeepSeek();

/** Together AI open-model host — OpenAI Chat Completions-compatible wire. */
export function createTogether(settings: CompatSettings = {}): Provider {
  return createCompat('together', settings);
}
export const together: Provider = createTogether();

/** OpenRouter multi-provider router — OpenAI Chat Completions-compatible wire. */
export function createOpenRouter(settings: CompatSettings = {}): Provider {
  return createCompat('openrouter', settings);
}
export const openrouter: Provider = createOpenRouter();

/** Cerebras wafer-scale inference — OpenAI Chat Completions-compatible wire. */
export function createCerebras(settings: CompatSettings = {}): Provider {
  return createCompat('cerebras', settings);
}
export const cerebras: Provider = createCerebras();

/** Fireworks AI open-model host — OpenAI Chat Completions-compatible wire. */
export function createFireworks(settings: CompatSettings = {}): Provider {
  return createCompat('fireworks', settings);
}
export const fireworks: Provider = createFireworks();

/** Moonshot AI (Kimi K2 family) — OpenAI Chat Completions-compatible wire. */
export function createMoonshot(settings: CompatSettings = {}): Provider {
  return createCompat('moonshot', settings);
}
export const moonshot: Provider = createMoonshot();

/**
 * Alias for {@link createMoonshot} — same host, provider id `moonshot`
 * (registry slugs like `kimi-k2`). Prefer this name when branding as Kimi.
 */
export function createKimi(settings: CompatSettings = {}): Provider {
  return createMoonshot(settings);
}
export const kimi: Provider = createKimi();

/** Alibaba Qwen via DashScope compatible-mode — OpenAI Chat Completions-compatible wire. */
export function createQwen(settings: CompatSettings = {}): Provider {
  return createCompat('qwen', settings);
}
export const qwen: Provider = createQwen();

/** Zhipu GLM (BigModel open platform) — OpenAI Chat Completions-compatible wire. */
export function createGLM(settings: CompatSettings = {}): Provider {
  return createCompat('glm', settings);
}
export const glm: Provider = createGLM();

/** MiniMax (M2 family) — OpenAI Chat Completions-compatible wire. */
export function createMiniMax(settings: CompatSettings = {}): Provider {
  return createCompat('minimax', settings);
}
export const minimax: Provider = createMiniMax();

/**
 * Perplexity Sonar (search-grounded answers) — OpenAI Chat Completions-compatible wire.
 *
 * Two things differ from every other host here. Its root has NO `/v1` segment
 * (`https://api.perplexity.ai/chat/completions`), and the Sonar models do not
 * do client tool calling — the search is Perplexity's own, server-side, so the
 * registry rows pin `tools: false` and `structuredOutput: false`. The answer
 * text arrives on the canonical stream like any other; Perplexity's `citations`
 * array is a top-level response field the Chat Completions wire has no slot
 * for, so it is not surfaced as a canonical part.
 */
export function createPerplexity(settings: CompatSettings = {}): Provider {
  return createCompat('perplexity', settings);
}
export const perplexity: Provider = createPerplexity();

/** Cohere Command via its OpenAI **compatibility** endpoint (`/compatibility/v1`). */
export function createCohere(settings: CompatSettings = {}): Provider {
  return createCompat('cohere', settings);
}
export const cohere: Provider = createCohere();

/** DeepInfra open-model host (`org/Model` slugs) — OpenAI Chat Completions-compatible wire. */
export function createDeepInfra(settings: CompatSettings = {}): Provider {
  return createCompat('deepinfra', settings);
}
export const deepinfra: Provider = createDeepInfra();

/** NVIDIA NIM / `integrate.api.nvidia.com` — OpenAI Chat Completions-compatible wire. */
export function createNvidia(settings: CompatSettings = {}): Provider {
  return createCompat('nvidia', settings);
}
export const nvidia: Provider = createNvidia();

/** SambaNova Cloud (RDU inference) — OpenAI Chat Completions-compatible wire. */
export function createSambaNova(settings: CompatSettings = {}): Provider {
  return createCompat('sambanova', settings);
}
export const sambanova: Provider = createSambaNova();

/** Hyperbolic open-model host — OpenAI Chat Completions-compatible wire. */
export function createHyperbolic(settings: CompatSettings = {}): Provider {
  return createCompat('hyperbolic', settings);
}
export const hyperbolic: Provider = createHyperbolic();

// --- Keyless local hosts (2.0) -------------------------------------------------
// Both pin `apiKeyOptional`, so a plain `ollama('qwen3')` against a default
// localhost install just works: when the G1 chain finds no key, resolve-call
// substitutes a placeholder bearer token rather than throwing. `settings` is
// spread FIRST so a user-supplied `apiKey` (a reverse proxy in front of the
// server, say) still travels the normal chain and wins — the flag only ever
// decides what happens when the chain came up EMPTY.

/**
 * Ollama's OpenAI-compatible endpoint (`http://localhost:11434/v1`) — no API
 * key required.
 *
 * Slugs are whatever you have pulled, so they are deliberately absent from the
 * registry and fall back to the conservative row (`tools: false`,
 * `maxOutput: 4096`, one `unknown-model` warning). Teach it the truth once via
 * `capabilities` — see `providers/local.mdx`:
 *
 * ```ts
 * const ollama = createOllama({ capabilities: { tools: true, maxOutput: 32_000 } });
 * const model = ollama('qwen3');
 * ```
 */
export function createOllama(settings: CompatSettings = {}): Provider {
  return createCompat('ollama', { ...settings, apiKeyOptional: true });
}
export const ollama: Provider = createOllama();

/**
 * LM Studio's local server (`http://localhost:1234/v1`) — no API key required.
 * Same unknown-slug story as {@link createOllama}: pass `capabilities` for the
 * model you actually loaded.
 */
export function createLMStudio(settings: CompatSettings = {}): Provider {
  return createCompat('lmstudio', { ...settings, apiKeyOptional: true });
}
export const lmstudio: Provider = createLMStudio();
