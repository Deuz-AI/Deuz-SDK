/**
 * deuz meter (2.5): the public types of the local budget proxy. A harness
 * (Claude Code, Codex, any OpenAI-compatible client) points its base URL at
 * the meter; each request is charged to a persistent `BudgetStore`, refused
 * with HTTP 402 at the ceiling, and recorded as one receipt. Edge-safe.
 */
import type { Clock, PriceProvider } from '../types/deps';
import type { PersistentBudgetScope, BudgetStore } from '../types/budget-store';
import type { UnknownPricePolicy } from '../types/execution';
import type { Usage } from '../types/usage';

/** The wire protocol of a metered route: it decides how usage is read and how errors look. */
export type MeterProtocol = 'anthropic-messages' | 'openai-chat' | 'openai-responses';

/** The API family of an upstream: Anthropic Messages, or OpenAI and OpenAI-compatible hosts. */
export type MeterUpstreamKind = 'anthropic' | 'openai';

/**
 * One upstream the meter forwards to. A request whose path starts with
 * `mount` goes to `baseUrl` + the rest of the path + the query string.
 *
 * On a `kind: 'anthropic'` upstream, `POST …/messages` is metered. On a
 * `kind: 'openai'` upstream, `POST …/chat/completions` and `POST …/responses`
 * are. Free token-counting calls (`…/messages/count_tokens`,
 * `…/responses/input_tokens`) and every non-POST request pass through
 * unmetered; any other POST follows `MeterOptions.unmeteredRoutes`.
 */
export interface MeterUpstream {
  /** The label receipts carry, e.g. `anthropic`, `openai`, `openrouter`. */
  readonly provider: string;
  readonly kind: MeterUpstreamKind;
  /**
   * Absolute `http(s)` origin plus an optional base path, without a trailing
   * slash: `https://api.anthropic.com`, `https://openrouter.ai/api`.
   */
  readonly baseUrl: string;
  /**
   * The path prefix on the proxy that selects this upstream (default `''`).
   * Point the harness at `http://127.0.0.1:<port><mount>`. The longest
   * matching mount wins. When an Anthropic and an OpenAI upstream share a
   * mount, the metered path decides (`…/messages` versus
   * `…/chat/completions` or `…/responses`); any other request goes to the
   * Anthropic upstream when it carries an `anthropic-version` header, else to
   * the OpenAI one.
   */
  readonly mount?: string;
}

/** What the meter knows about a request before it is forwarded. Never carries credentials or bodies. */
export interface MeterRequestInfo {
  /** The meter's ID for this request; the budget request ID is `meter:<id>`. */
  readonly id: string;
  readonly provider: string;
  readonly protocol: MeterProtocol;
  /** The `model` field of the request body; `'unknown'` when it has none. */
  readonly model: string;
  /** The path on the proxy, without the query string. */
  readonly route: string;
  /** Whether the request asked for a streamed (SSE) response. */
  readonly stream: boolean;
  /** The output cap the request set (`max_tokens`, `max_completion_tokens`, `max_output_tokens`). */
  readonly maxOutputTokens?: number;
  /** Characters of the request body: the input to the default prompt estimate. */
  readonly bodyChars: number;
  /** Request headers with credentials and cookies removed. */
  readonly headers: Readonly<Record<string, string>>;
}

/** A conservative estimate of one request, held in the budget until its usage is measured. */
export interface MeterEstimate {
  /** Prompt plus output tokens. */
  readonly tokens: number;
  /** USD; `undefined` when the model has no price. */
  readonly usd: number | undefined;
}

/** Your own estimator: return token and USD upper bounds for one request. */
export type MeterEstimator = (
  request: MeterRequestInfo,
  body: Readonly<Record<string, unknown>>,
) => MeterEstimate | Promise<MeterEstimate>;

/** Tuning of the default estimator. */
export interface MeterEstimateOptions {
  /**
   * Body characters per prompt token (default 3). Lower is more conservative.
   * Ordinary English and code run at about 3.5 to 4 characters per token;
   * CJK text can approach one token per character, so lower it for that.
   */
  readonly charsPerToken?: number;
  /**
   * Output tokens assumed when the request sets no cap (default 32 000).
   * Anthropic Messages always carries `max_tokens`; OpenAI requests often do not.
   */
  readonly defaultMaxOutputTokens?: number;
  /**
   * The rate the estimated prompt is priced at. `'max'` (default) prices it at
   * the dearest prompt rate of the model's card, the 1-hour cache write, so a
   * prompt that writes the cache still fits the estimate. `'input'` prices it
   * at the plain input rate: tighter, but a request that writes the cache can
   * then cost more than its hold.
   */
  readonly promptRate?: 'max' | 'input';
}

/** Where the meter charges requests. */
export interface MeterBudgetOptions {
  readonly store: BudgetStore;
  /**
   * The scopes every metered request is admitted against, all or none. A
   * function chooses them per request (for example from a header the harness
   * sends); returning an empty array meters that request without a budget.
   * A scope's `limits.unknownPrice: 'reject'` refuses unpriced models for it.
   */
  readonly scopes:
    | readonly PersistentBudgetScope[]
    | ((
        request: MeterRequestInfo,
      ) => readonly PersistentBudgetScope[] | Promise<readonly PersistentBudgetScope[]>);
}

/**
 * Who reported a receipt's cost. `'measured'`: the meter read the usage from
 * the provider's response as it passed by. `'declared'`: an agent reported
 * its own cost (for example over ACP), which nothing on the wire confirmed.
 */
export type MeterReceiptSource = 'measured' | 'declared';

/** How a metered request ended. */
export type MeterOutcome =
  /** The upstream answered 2xx and the response reached its end. */
  | 'completed'
  /** The meter answered 402 (budget ceiling or unpriced model): nothing was forwarded. */
  | 'refused'
  /** The upstream answered with a non-2xx status. */
  | 'upstream_error'
  /** The client went away, or the upstream stream broke, before the response ended. */
  | 'aborted'
  /** The meter could not forward or admit the request (network or store failure, bad request). */
  | 'failed';

/**
 * What a receipt's request was charged to the budget with. `'measured'`: its
 * measured usage. `'estimate'`: its held estimate, because no final usage was
 * seen (fail-closed). `'released'`: nothing, the hold was dropped (the
 * upstream refused it, or reported an error before any usage). `'held'`: the
 * store failed to settle or release after three attempts (reported to
 * `onError`), so the estimate stays held until `BudgetStore.sweep` closes it.
 * `'none'`: no budget took part.
 */
export type MeterSettlement = 'measured' | 'estimate' | 'released' | 'held' | 'none';

/** Why the meter refused a request with 402. */
export type MeterRefusal =
  | {
      readonly reason: 'budget_exceeded';
      readonly key: string;
      readonly dimension: 'tokens' | 'usd';
      readonly limit: number;
      /** Committed usage in that scope before this request. */
      readonly committed: number;
    }
  | { readonly reason: 'unpriced_model' };

/**
 * One request's record. A receipt never carries API keys, auth headers,
 * query strings, or request and response bodies. Other modules that record
 * an agent's self-reported cost use the same shape with `source: 'declared'`
 * (see `declaredReceipt`).
 */
export interface MeterReceipt {
  /** Receipt format version. */
  readonly version: 1;
  /** Unique receipt ID. */
  readonly id: string;
  /** The budget request ID (`meter:<id>` for measured receipts). */
  readonly requestId: string;
  readonly source: MeterReceiptSource;
  /** Epoch ms on the injected clock. */
  readonly startedAt: number;
  readonly endedAt: number;
  readonly durationMs: number;
  /** Until the upstream's response headers arrived. */
  readonly upstreamMs?: number;
  readonly provider: string;
  readonly protocol?: MeterProtocol;
  readonly model?: string;
  /** The path on the proxy without the query string, or a declared label such as `acp:session/prompt`. */
  readonly route: string;
  readonly method?: string;
  /** The HTTP status the client received. */
  readonly status?: number;
  readonly outcome: MeterOutcome;
  /** Whether the response was an SSE stream. */
  readonly stream: boolean;
  /** Usage as far as it was seen; absent when none was. */
  readonly usage?: Usage;
  /** Whether `usage` is the provider's final count for the request. */
  readonly usageComplete: boolean;
  /** USD of `usage`; absent when the model has no price or no usage was seen. */
  readonly usd?: number;
  /** The held estimate. */
  readonly estimate?: MeterEstimate;
  /** What the budget was charged. */
  readonly settlement: MeterSettlement;
  readonly charged?: { readonly tokens: number; readonly usd: number };
  /** The persistent budget scope keys the request was admitted against. */
  readonly budgetKeys: readonly string[];
  readonly refusal?: MeterRefusal;
  /** The provider's request ID from its response headers, when it sent one. */
  readonly upstreamRequestId?: string;
  /** Whether the model had a price. */
  readonly priced: boolean;
}

/** Receives every receipt. A sink that throws or rejects is reported to `onError` and never fails a request. */
export type MeterReceiptSink = (receipt: MeterReceipt) => void | Promise<void>;

/** Something the meter tells the host without failing the request. */
export type MeterWarning =
  | { readonly type: 'unpriced-model'; readonly model: string; readonly provider: string }
  | {
      readonly type: 'usage-missing';
      readonly requestId: string;
      readonly model: string;
      /** Why no final usage was seen. */
      readonly detail: string;
    };

/** Where a failure the meter swallowed happened. */
export type MeterErrorStage = 'reserve' | 'settle' | 'release' | 'receipt' | 'upstream';

/** Options of `createMeterHandler`. */
export interface MeterOptions {
  /** Default: `DEFAULT_METER_UPSTREAMS` (Anthropic and OpenAI, both at mount `''`). */
  readonly upstreams?: readonly MeterUpstream[];
  /** Omit to meter and record without a ceiling. */
  readonly budget?: MeterBudgetOptions;
  /** Default: `createPriceProvider()` with the bundled table. */
  readonly priceProvider?: PriceProvider;
  /**
   * Unpriced models under a USD-bounded scope (default `'warn'`). `'warn'`
   * admits them, holds and charges their tokens only, and warns once per
   * model; `'reject'` answers 402. A scope's own `limits.unknownPrice:
   * 'reject'` refuses as well.
   */
  readonly unknownPrice?: UnknownPricePolicy;
  /** Tune the default estimator, or replace it. */
  readonly estimate?: MeterEstimateOptions | MeterEstimator;
  /**
   * OpenAI Chat Completions reports streaming usage only when the request
   * sets `stream_options.include_usage`. When true (default), the meter sets
   * it on streaming chat requests that do not, so their cost is measured;
   * the client then receives one extra final chunk with empty `choices` and
   * the usage, which OpenAI's own SDKs handle. When false, such requests are
   * charged their estimate.
   */
  readonly injectStreamUsage?: boolean;
  /**
   * A POST the meter cannot meter (an unknown or batch endpoint). `'reject'`
   * (default) answers 404 in the provider's error shape, so no spend passes
   * the budget unseen; `'forward'` sends it on uncharged, with a receipt.
   */
  readonly unmeteredRoutes?: 'reject' | 'forward';
  /** One sink or several; each gets every receipt. */
  readonly receipts?: MeterReceiptSink | readonly MeterReceiptSink[];
  readonly onWarning?: (warning: MeterWarning) => void;
  /** Failures the meter answered for or swallowed (store, sink, upstream network). */
  readonly onError?: (
    error: unknown,
    context: { stage: MeterErrorStage; requestId?: string },
  ) => void;
  /** Larger request bodies are refused with 413. Default 32 MiB. */
  readonly maxRequestBytes?: number;
  /**
   * A non-streaming JSON response is copied as it passes, up to this many
   * bytes, to read its usage; a larger one is charged its estimate. Default 16 MiB.
   */
  readonly maxResponseCopyBytes?: number;
  readonly deps?: {
    readonly fetch?: typeof fetch;
    readonly clock?: Clock;
    readonly generateId?: () => string;
  };
}

/** Per-model totals in a stats snapshot. */
export interface MeterModelStats {
  readonly requests: number;
  readonly tokens: number;
  readonly usd: number;
}

/** A snapshot of what the meter has seen since it was created. */
export interface MeterStats {
  readonly startedAt: number;
  /** Metered requests received (refused ones included). */
  readonly requests: number;
  readonly inFlight: number;
  readonly completed: number;
  readonly refused: number;
  readonly upstreamErrors: number;
  readonly aborted: number;
  readonly failed: number;
  /** Requests forwarded without metering (non-POST, free and forwarded unmetered routes). */
  readonly passthrough: number;
  /** Measured tokens and USD (priced usage only for USD). */
  readonly tokens: number;
  readonly usd: number;
  /** Charged to the budget, estimates included. */
  readonly chargedUsd: number;
  readonly byModel: Readonly<Record<string, MeterModelStats>>;
  readonly unpricedModels: readonly string[];
}

/** A fetch-style meter: `fetch(request)` answers like the upstream would. */
export interface MeterHandler {
  /** Forward one request; never rejects (failures become provider-shaped error responses). */
  fetch(request: Request): Promise<Response>;
  stats(): MeterStats;
  /** Resolves once every started request has been settled and every receipt delivered. */
  flush(): Promise<void>;
}
