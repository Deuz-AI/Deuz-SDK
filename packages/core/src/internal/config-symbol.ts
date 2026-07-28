import type { LanguageModel } from '../types/model';
// TYPE-ONLY, fully erased under `verbatimModuleSyntax`: `core/registry.ts` has a
// RUNTIME import of this module (`readConfig`, for the capability merge), so a
// value import here would close a real cycle. This one adds no runtime edge.
import type { ModelCapabilities } from '../core/registry';

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
  /**
   * Extra query params appended to the wire URL (e.g. Azure OpenAI
   * `api-version`). Adapters merge these onto the final request URL.
   */
  query?: Record<string, string>;
  /**
   * Auth header style for OpenAI-compatible wires. Default `'bearer'`
   * (`Authorization: Bearer <key>`). Azure OpenAI uses `'api-key'`.
   */
  authHeader?: 'bearer' | 'api-key';
  /**
   * Capability overrides for every slug this factory mints (1.9), e.g.
   * `createOpenAICompatible({ id: 'ollama', capabilities: { maxOutput: 32_000 } })`.
   * The ONLY reader is `getCapabilities` (`core/registry.ts`), which shallow-
   * merges it over the resolved registry row — a per-call
   * `CommonCallOptions.capabilities` still wins over it. Stored on the config
   * blob rather than the descriptor so the public `LanguageModel` shape
   * (`{ provider, modelId, surface }`) stays locked.
   */
  capabilities?: Partial<ModelCapabilities>;
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

/**
 * Route a PER-CALL `capabilities` override (1.9) into the one channel
 * `getCapabilities` reads: the config Symbol of a per-call descriptor CLONE.
 *
 * Why a clone and not a third argument threaded through the pipeline: the
 * capability matrix is resolved at four independent sites (the pump, both object
 * entry points, the loop's compaction sizing). Passing the override down each
 * path would create four merge sites and guarantee they drift; the merge must
 * live in exactly ONE place (`getCapabilities`). Attaching to the CALLER's
 * descriptor is not an option either — it is shared across concurrent calls and
 * `attachConfig` is intentionally non-writable — hence a per-call clone, built
 * only when the caller actually passed an override.
 *
 * G1 is untouched: the whole config blob is copied, so `apiKey`/`baseURL`/
 * `fetch`/`headers`/`vertex`/`query`/`authHeader` resolve identically. When the
 * descriptor had NO config, the synthesized blob carries only `provider` +
 * `capabilities`, and every `config?.x` read in `resolve-call.ts` still falls
 * through to the client context / wire default exactly as before.
 *
 * The clone copies OWN PROPERTY DESCRIPTORS (not `{ ...model }`) so any other
 * hidden Symbol a descriptor may carry survives; `{ ...model }` copies only
 * enumerable string keys and would silently drop them.
 */
export function withCapabilityOverride(
  model: LanguageModel,
  capabilities: Partial<ModelCapabilities> | undefined,
): LanguageModel {
  if (!capabilities || Object.keys(capabilities).length === 0) return model;
  const base = readConfig(model);
  const clone = Object.create(Object.getPrototypeOf(model) as object | null) as LanguageModel;
  for (const key of Reflect.ownKeys(model)) {
    if (key === CONFIG) continue; // re-attached below with the merged capabilities
    const descriptor = Object.getOwnPropertyDescriptor(model, key);
    if (descriptor) Object.defineProperty(clone, key, descriptor);
  }
  return attachConfig(clone, {
    ...(base ?? { provider: model.provider }),
    // Per-call wins over factory — the documented precedence, applied where the
    // two channels meet (registry sees a single already-merged blob).
    capabilities: { ...base?.capabilities, ...capabilities },
  });
}
