/**
 * realtime/models.ts — realtime model descriptors and credential resolution.
 *
 * A descriptor is the public `{ provider, modelId, surface }`; the factory
 * settings (key, baseURL, headers, …) ride on a module-private, NON-ENUMERABLE
 * symbol, so they never leak through `Object.keys`, `JSON.stringify` or a
 * test's `toEqual` — the same trick as the chat and speech providers.
 */
import { AuthenticationError } from '../errors';
import type { ResolvedDependencies } from '../types/deps';
import type {
  GeminiLiveSettings,
  OpenAIRealtimeSettings,
  RealtimeModel,
  RealtimeSurface,
} from './types';

/** Factory settings as the mapping modules read them. */
export interface RealtimeModelConfig {
  apiKey?: string;
  baseURL?: string;
  headers?: Record<string, string>;
  apiVersion?: string;
  apiKeyLocation?: 'header' | 'query';
}

const CONFIG = Symbol('deuz.realtimeConfig');

function describe(
  surface: RealtimeSurface,
  provider: string,
  modelId: string,
  config: RealtimeModelConfig,
): RealtimeModel {
  const model: RealtimeModel = { provider, modelId, surface };
  Object.defineProperty(model, CONFIG, {
    value: config,
    enumerable: false,
    writable: false,
    configurable: false,
  });
  return model;
}

export function readRealtimeConfig(model: RealtimeModel): RealtimeModelConfig {
  return (model as { [CONFIG]?: RealtimeModelConfig })[CONFIG] ?? {};
}

/**
 * OpenAI Realtime over WebSocket (`gpt-realtime`, `gpt-realtime-mini`, …).
 * Not live-verified: the wire is taken from the official SDK's types.
 */
export function createOpenAIRealtime(
  settings: OpenAIRealtimeSettings = {},
): (modelId: string) => RealtimeModel {
  const provider = settings.provider ?? 'openai';
  return (modelId) =>
    describe('openai-realtime', provider, modelId, {
      apiKey: settings.apiKey,
      baseURL: settings.baseURL,
      headers: settings.headers,
    });
}

/**
 * Gemini Live over WebSocket (Gemini Developer API). Not live-verified: the
 * wire is taken from the official SDK's types.
 */
export function createGeminiLive(
  settings: GeminiLiveSettings = {},
): (modelId: string) => RealtimeModel {
  const provider = settings.provider ?? 'google';
  return (modelId) =>
    describe('gemini-live', provider, modelId, {
      apiKey: settings.apiKey,
      baseURL: settings.baseURL,
      headers: settings.headers,
      apiVersion: settings.apiVersion,
      apiKeyLocation: settings.apiKeyLocation,
    });
}

/**
 * The server-side key: `deps.keyProvider` (highest) → the factory's `apiKey`
 * → `AuthenticationError`. The same precedence as every other module.
 */
export async function resolveApiKey(
  model: RealtimeModel,
  deps: Pick<ResolvedDependencies, 'keyProvider'>,
  hint: string,
): Promise<string> {
  let apiKey: string | undefined;
  if (deps.keyProvider) apiKey = (await deps.keyProvider.getKey(model.provider)) ?? undefined;
  if (!apiKey) apiKey = readRealtimeConfig(model).apiKey;
  if (!apiKey) {
    throw new AuthenticationError({
      message: `No API key for realtime provider '${model.provider}'. ${hint}`,
      provider: model.provider,
    });
  }
  return apiKey;
}
