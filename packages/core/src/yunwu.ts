/**
 * yunwu.ts — Yunwu (云雾) unified relay provider (OpenAI-compatible aggregator).
 *
 * One `createYunwu({ apiKey, baseURL })` config drives EVERY surface off a single
 * base URL — that is the "creative base URL": you give the host once and the
 * client derives the right path per call (chat/image/embeddings at `/v1`,
 * Midjourney at the bare `/mj` root). Models below are the 2026 catalog actually
 * served by Yunwu's `/v1/models` (live-verified 2026-05-31). The API key is
 * injected (config / deps / ClientConfig) — never hardcoded.
 *
 * @example
 *   const yunwu = createYunwu({ apiKey: process.env.YUNWU_KEY });
 *   streamChat({ model: yunwu.chat('gpt-5.2'), messages });
 *   generateImage({ model: yunwu.image('flux-2-pro'), prompt });
 *   embed({ model: yunwu.embedding('text-embedding-3-large'), value });
 *   imagine({ ...yunwu.mj(), prompt });
 */
import type { LanguageModel, Provider, EmbeddingModel, EmbeddingProvider } from './types/model';
import { attachConfig } from './internal/config-symbol';
import { createImageProvider, type ImageProvider, type ImageProviderSettings } from './image';
import type { MidjourneyConfig } from './midjourney';

/** Default Yunwu host (no `/v1`, no trailing slash). Override for self-host / mirror. */
export const YUNWU_DEFAULT_BASE_URL = 'https://yunwu.ai';

export interface YunwuSettings {
  apiKey?: string;
  /** Yunwu host root (e.g. `https://yunwu.ai`) — `/v1` is appended automatically per surface. */
  baseURL?: string;
  fetch?: typeof fetch;
  headers?: Record<string, string>;
}

/** Strip a trailing slash and any trailing `/v1` so we can re-derive paths cleanly. */
function normalizeRoot(url: string): string {
  return url.replace(/\/+$/, '').replace(/\/v1$/, '');
}

// ===================================================================
// 2026 model catalog — ONLY what Yunwu's /v1/models actually serves.
// (live-verified 2026-05-31; 453 models total, curated to the newest gen)
// ===================================================================

/** Newest-generation chat / reasoning models on Yunwu (2026). */
export const YUNWU_CHAT_MODELS = [
  'gpt-5.2',
  'gpt-5.2-codex',
  'gpt-5.1',
  'gpt-5-pro',
  'gpt-5',
  'claude-opus-4-5',
  'claude-sonnet-4-5',
  'claude-haiku-4-5',
  'gemini-3-pro-preview',
  'grok-4.1',
  'grok-4',
  'deepseek-v3.2',
  'deepseek-r1',
  'qwen3-max',
  'glm-4.6',
  'kimi-k2-thinking',
  'minimax-m2',
] as const;

/** Newest-generation image models on Yunwu (2026). */
export const YUNWU_IMAGE_MODELS = [
  'gpt-image-2',
  'gpt-image-1.5',
  'flux-2-pro',
  'flux.1-kontext-pro',
  'nano-banana',
  'doubao-seedream-5-0-260128',
  'qwen-image-2.0-2026-03-03',
  'grok-4.2-image',
] as const;

/** Newest-generation video models on Yunwu (2026) — async, run via the Midjourney/task proxy or chat surface. */
export const YUNWU_VIDEO_MODELS = [
  'sora-2',
  'veo3.1',
  'kling-2.6',
  'viduq3',
  'viduq3-pro',
  'wan2.7-image-pro',
  'seedance-1-5-pro-250928',
  'MiniMax-Hailuo-2.3',
] as const;

/** Midjourney action slugs Yunwu exposes (mj-proxy). */
export const YUNWU_MIDJOURNEY_MODELS = [
  'mj_imagine',
  'mj_variation',
  'mj_upscale',
  'mj_reroll',
  'mj_blend',
  'mj_describe',
  'mj_zoom',
  'mj_pan',
  'mj_inpaint',
] as const;

/** The full 2026 Yunwu catalog, grouped by modality. */
export const YUNWU_MODELS = {
  chat: YUNWU_CHAT_MODELS,
  image: YUNWU_IMAGE_MODELS,
  video: YUNWU_VIDEO_MODELS,
  midjourney: YUNWU_MIDJOURNEY_MODELS,
} as const;

export type YunwuChatModel = (typeof YUNWU_CHAT_MODELS)[number] | (string & {});
export type YunwuImageModel = (typeof YUNWU_IMAGE_MODELS)[number] | (string & {});

// ===================================================================
// Factories (each bound to a base URL + injected key)
// ===================================================================

/** Yunwu chat/reasoning provider (OpenAI Chat Completions wire). */
export function createYunwuChat(settings: YunwuSettings = {}): Provider {
  const v1 = `${normalizeRoot(settings.baseURL ?? YUNWU_DEFAULT_BASE_URL)}/v1`;
  return (modelId: string): LanguageModel =>
    attachConfig(
      { provider: 'yunwu', modelId, surface: 'chat_completions' },
      {
        provider: 'yunwu',
        apiKey: settings.apiKey,
        baseURL: v1,
        fetch: settings.fetch,
        headers: settings.headers,
      },
    );
}

/** Yunwu synchronous image provider (`POST /v1/images/generations`). */
export function createYunwuImage(
  settings: Omit<ImageProviderSettings, 'provider'> = {},
): ImageProvider {
  return createImageProvider({
    provider: 'yunwu',
    baseURL: `${normalizeRoot(settings.baseURL ?? YUNWU_DEFAULT_BASE_URL)}/v1`,
    apiKey: settings.apiKey,
    fetch: settings.fetch,
    headers: settings.headers,
  });
}

/** Yunwu embedding provider (OpenAI-compatible `/v1/embeddings`). */
export function createYunwuEmbedding(settings: YunwuSettings = {}): EmbeddingProvider {
  const v1 = `${normalizeRoot(settings.baseURL ?? YUNWU_DEFAULT_BASE_URL)}/v1`;
  return (modelId: string): EmbeddingModel =>
    attachConfig(
      { provider: 'yunwu', modelId, surface: 'openai-embeddings' } as unknown as LanguageModel,
      {
        provider: 'yunwu',
        apiKey: settings.apiKey,
        baseURL: v1,
        fetch: settings.fetch,
        headers: settings.headers,
      },
    ) as unknown as EmbeddingModel;
}

// ===================================================================
// Unified client — one config, every surface, one base URL.
// ===================================================================

export interface YunwuClient {
  /** Resolved host root (no `/v1`). */
  readonly baseURL: string;
  /** The 2026 model catalog. */
  readonly models: typeof YUNWU_MODELS;
  /** Chat / reasoning model descriptor (for `streamChat` / `generateText`). */
  chat(modelId: YunwuChatModel): LanguageModel;
  /** Image model descriptor (for `generateImage`). */
  image(modelId: YunwuImageModel): ReturnType<ImageProvider>;
  /** Embedding model descriptor (for `embed` / `embedMany`). */
  embedding(modelId: string): EmbeddingModel;
  /** Pre-bound Midjourney config (spread into `imagine`/`submitImagine`/…). */
  mj(): Pick<MidjourneyConfig, 'apiKey' | 'baseURL' | 'provider' | 'fetch' | 'headers'>;
}

/**
 * Create a Yunwu client. Give the base URL (and key) ONCE; every surface —
 * chat, image, embeddings, Midjourney — is derived from it.
 */
export function createYunwu(settings: YunwuSettings = {}): YunwuClient {
  const root = normalizeRoot(settings.baseURL ?? YUNWU_DEFAULT_BASE_URL);
  const chat = createYunwuChat({ ...settings, baseURL: root });
  const image = createYunwuImage({ ...settings, baseURL: root });
  const embedding = createYunwuEmbedding({ ...settings, baseURL: root });

  return {
    baseURL: root,
    models: YUNWU_MODELS,
    chat,
    image,
    embedding,
    mj: () => ({
      provider: 'yunwu',
      apiKey: settings.apiKey,
      // Midjourney proxy lives at the bare host root (NOT under /v1).
      baseURL: root,
      fetch: settings.fetch,
      headers: settings.headers,
    }),
  };
}

/** Convenience singleton (key injected via deps / ClientConfig at call time). */
export const yunwu: YunwuClient = createYunwu();
