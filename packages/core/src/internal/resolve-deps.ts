import type {
  Dependencies,
  ResolvedDependencies,
  Clock,
  Logger,
  Tracer,
  BreakerStore,
  BreakerState,
} from '../types/deps';

// Defaults live here (not in client.ts) so the inference layer can resolve deps
// without importing client.ts and creating a client → generate → inference →
// client import cycle.

const defaultFetch: typeof fetch = (input, init) => globalThis.fetch(input, init);

const defaultClock: Clock = {
  // eslint-disable-next-line no-restricted-syntax -- injectable inference/runtime default clock
  now: () => Date.now(),
  setTimeout: (fn, ms) => {
    const id = globalThis.setTimeout(fn, ms);
    return () => globalThis.clearTimeout(id);
  },
};

const defaultGenerateId: () => string =
  // eslint-disable-next-line no-restricted-syntax -- the single allowed crypto.randomUUID() in core
  () => crypto.randomUUID();

const noopLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

/**
 * Exported for identity checks (1.6): the observation runtime activates the
 * legacy tracer bridge only when a REAL tracer was injected — comparing
 * against this instance is the "was a tracer provided" signal.
 */
export const noopTracer: Tracer = {
  startSpan: () => ({ setAttribute: () => {}, recordException: () => {}, end: () => {} }),
};

export function createInMemoryBreakerStore(): BreakerStore {
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
    generateId: deps.generateId ?? defaultGenerateId,
  };
}
