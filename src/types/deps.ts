import type { Usage, FinishReason } from './usage';

/**
 * The single injection seam. Everything stateful / side-effecting is injected
 * here so `@deuz-sdk/core` stays pure (no Supabase/credit/env coupling) and
 * deterministically testable. All fields have no-op / in-memory defaults.
 */
export interface Dependencies {
  /** HTTP transport. Default: globalThis.fetch (bound). */
  fetch?: typeof fetch;
  /** Time source — core never calls Date.now() directly. */
  clock?: Clock;
  /** Structured logger. Default: no-op. */
  logger?: Logger;
  /** OpenTelemetry-shaped tracer seam. Default: no-op. */
  tracer?: Tracer;
  /** Circuit-breaker state store. Default: in-memory Map (per client). */
  breakerStore?: BreakerStore;
  /** Provider API-key resolver. Default: reads from client config keys. */
  keyProvider?: KeyProvider;
  /** Token -> cost seam. Default: undefined (app computes cost). */
  priceProvider?: PriceProvider;
  /**
   * Randomness seam — request ids, tool-call fallback ids. Core never calls
   * `crypto.randomUUID()` directly so fixtures can assert stable ids.
   * Default: `() => crypto.randomUUID()`.
   */
  generateId?: () => string;
  /** Per-usage callback (metering). */
  onUsage?: (usage: Usage, meta: UsageMeta) => void;
  /** Final-result callback. */
  onFinish?: (meta: FinishMeta) => void;
}

export interface Clock {
  now(): number;
  /** Schedules a callback; returns a canceller. */
  setTimeout(fn: () => void, ms: number): () => void;
}

export interface Logger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

export interface Span {
  setAttribute(key: string, value: unknown): void;
  recordException(error: unknown): void;
  end(): void;
}

export interface Tracer {
  startSpan(name: string, attributes?: Record<string, unknown>): Span;
}

export interface BreakerState {
  failures: number;
  openedAt?: number;
  cooldownUntil?: number;
}

export interface BreakerStore {
  get(key: string): BreakerState | undefined | Promise<BreakerState | undefined>;
  set(key: string, state: BreakerState): void | Promise<void>;
}

export interface KeyProvider {
  getKey(provider: string): string | undefined | Promise<string | undefined>;
}

export interface PriceProvider {
  /** May be async — real price tables (DB/remote) resolve a Promise. */
  priceUsage(model: string, usage: Usage): number | undefined | Promise<number | undefined>;
}

export interface UsageMeta {
  model: string;
  reason: 'finished' | 'aborted' | 'error';
  ttftMs?: number;
  /** Sub-agent path when this usage came from an `agentTool` loop (1.4 additive). */
  agentPath?: string[];
}

export interface FinishMeta {
  model: string;
  finishReason: FinishReason;
}

/** Dependencies after defaults are applied (core-required fields non-optional). */
export type ResolvedDependencies = Dependencies &
  Required<
    Pick<Dependencies, 'fetch' | 'clock' | 'logger' | 'tracer' | 'breakerStore' | 'generateId'>
  >;
