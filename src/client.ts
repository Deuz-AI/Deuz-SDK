import { streamChat, generateText, generateObject } from './generate';
import type { ClientConfig } from './types/config';
import type {
  Dependencies,
  ResolvedDependencies,
  Clock,
  Logger,
  Tracer,
  BreakerStore,
  BreakerState,
} from './types/deps';
import type {
  StreamChat,
  GenerateText,
  GenerateObject,
  GenerateObjectOptions,
} from './types/methods';

// ---- Defaults (no-op / in-memory / global) ----

const defaultFetch: typeof fetch = (input, init) => globalThis.fetch(input, init);

const defaultClock: Clock = {
  // eslint-disable-next-line no-restricted-syntax -- the single allowed Date.now() in core
  now: () => Date.now(),
  setTimeout: (fn, ms) => {
    const id = globalThis.setTimeout(fn, ms);
    return () => globalThis.clearTimeout(id);
  },
};

const noopLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

const noopTracer: Tracer = {
  startSpan: () => ({ setAttribute: () => {}, recordException: () => {}, end: () => {} }),
};

function createInMemoryBreakerStore(): BreakerStore {
  const store = new Map<string, BreakerState>();
  return {
    get: (key) => store.get(key),
    set: (key, state) => {
      store.set(key, state);
    },
  };
}

/** Apply defaults to a (possibly empty) dependency bag. */
export function resolveDependencies(deps: Dependencies = {}): ResolvedDependencies {
  return {
    ...deps,
    fetch: deps.fetch ?? defaultFetch,
    clock: deps.clock ?? defaultClock,
    logger: deps.logger ?? noopLogger,
    tracer: deps.tracer ?? noopTracer,
    breakerStore: deps.breakerStore ?? createInMemoryBreakerStore(),
  };
}

/**
 * Optional convenience wrapper. The canonical API is the free functions
 * (`streamChat`, `generateText`, `generateObject`); `createClient` simply
 * pre-binds shared `deps` so heavy callers don't repeat them on every call.
 */
export interface DeuzClient {
  readonly config: Readonly<ClientConfig>;
  streamChat: StreamChat;
  generateText: GenerateText;
  generateObject: GenerateObject;
}

export function createClient(config: ClientConfig = {}): DeuzClient {
  const shared = config.deps ?? {};
  const withShared = <O extends { deps?: Dependencies }>(options: O): O => ({
    ...options,
    deps: { ...shared, ...options.deps },
  });

  return {
    config: Object.freeze({ ...config }),
    streamChat: (options) => streamChat(withShared(options)),
    generateText: (options) => generateText(withShared(options)),
    generateObject: <T = unknown>(options: GenerateObjectOptions<T>) =>
      generateObject(withShared(options)),
  };
}
