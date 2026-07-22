import type { LanguageModel, Provider } from './types/model';
import { attachConfig } from './internal/config-symbol';

/**
 * OpenAI-Chat-Completions-compatible provider factories (v1.6.0). Every host
 * here speaks the Chat Completions wire, so all descriptors carry
 * `surface: 'chat_completions'` and dispatch to the openai-compatible adapter
 * with registry-driven capability/quirk flags. Default base URLs live in
 * `internal/resolve-call.ts` (`DEFAULT_BASE_URL`); flagship slugs are pinned in
 * `core/registry.ts` and unknown slugs fall back conservatively (no throw).
 */
export interface CompatSettings {
  apiKey?: string;
  baseURL?: string;
  fetch?: typeof fetch;
  headers?: Record<string, string>;
}

/** Bind a provider id to the shared factory shape (same pattern as createXai). */
function createCompat(provider: string, settings: CompatSettings): Provider {
  return (modelId: string): LanguageModel =>
    attachConfig(
      { provider, modelId, surface: 'chat_completions' },
      {
        provider,
        apiKey: settings.apiKey,
        baseURL: settings.baseURL,
        fetch: settings.fetch,
        headers: settings.headers,
      },
    );
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
