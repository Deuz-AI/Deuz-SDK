import type { Usage, FinishReason } from './usage';
import type { Observer } from './observe';

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
  /**
   * Span topology for the injected tracer (1.6.1 additive).
   * 'hierarchical' (default, 1.6 behavior): one `invoke` per run with
   * `step`/`execute_tool` children. 'legacy': the 1.5 shape — one flat
   * `invoke` span per model call, no children (for consumers whose
   * dashboards/tests pinned the old topology).
   */
  tracerMode?: 'hierarchical' | 'legacy';
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
  /**
   * Observation event sink (1.6 additive). When absent (and no tracer is
   * injected) the observation fast path is fully off: no event objects, no
   * extra `generateId()` draws. Deliberately NOT in ResolvedDependencies'
   * Required set — absence IS the fast-path signal.
   */
  observer?: Observer;
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

/**
 * Options for {@link Tracer.startSpan} (1.6 additive). `parent` carries the
 * enclosing span so bridges (e.g. the OTel bridge) can build a REAL
 * parent-child trace tree instead of a flat list.
 */
export interface SpanOptions {
  parent?: Span;
}

export interface Tracer {
  startSpan(name: string, attributes?: Record<string, unknown>, options?: SpanOptions): Span;
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
  /**
   * Optional (1.7 additive): USD SAVED by prompt-cache reads vs paying the
   * full input rate for those tokens. Feeds `cacheSavingsUsd` on the live
   * `cost` stream part. `createPriceProvider` implements it from the table.
   */
  cacheSavings?(model: string, usage: Usage): number | undefined | Promise<number | undefined>;
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
