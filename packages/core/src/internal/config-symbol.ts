import type { LanguageModel } from '../types/model';

/**
 * The descriptor returned by a provider factory (`anthropic('model')`) is the
 * LOCKED, pure `LanguageModel` shape `{ provider, modelId, surface }`. The
 * settings passed to `createAnthropic({ apiKey, baseURL, ... })` are stashed on
 * the descriptor under a module-private, NON-ENUMERABLE Symbol so the public
 * type stays clean and secrets never leak into `Object.keys`/`JSON.stringify`/
 * `toEqual`. The inference layer reads them back via `readConfig`.
 */
export interface VertexConfig {
  project: string;
  location: string;
}

export interface ProviderConfig {
  provider: string;
  apiKey?: string;
  baseURL?: string;
  /** Factory-level fetch override (wins over deps.fetch). */
  fetch?: typeof fetch;
  /** Factory-level static headers (lowest precedence). */
  headers?: Record<string, string>;
  /** Present for Vertex AI transports — adapters build Vertex URLs/bodies. */
  vertex?: VertexConfig;
}

const CONFIG = Symbol('deuz.providerConfig');

/** Attach factory settings to a descriptor without changing its public shape. */
export function attachConfig(model: LanguageModel, config: ProviderConfig): LanguageModel {
  Object.defineProperty(model, CONFIG, {
    value: config,
    enumerable: false,
    writable: false,
    configurable: false,
  });
  return model;
}

/** Read factory settings back off a descriptor (undefined if none attached). */
export function readConfig(model: LanguageModel): ProviderConfig | undefined {
  return (model as { [CONFIG]?: ProviderConfig })[CONFIG];
}
