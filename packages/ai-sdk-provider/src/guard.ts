/**
 * The per-call guard both public forms share: the circuit breaker, then a
 * reservation against a Deuz `BudgetLedger` (and through it a persistent
 * `BudgetStore`), then the wrapped call, then settlement with the measured
 * usage priced by Deuz's price table, and a cost receipt.
 *
 * Accounting follows core's native requests (`internal/native-request.ts`):
 * a failure whose HTTP status proves the provider billed nothing (400, 401,
 * 403, 404, 422, 429) releases the hold; any other failure keeps the estimate
 * held (fail closed), since the provider may have billed it.
 */
import type {
  LanguageModelV4,
  LanguageModelV4CallOptions,
  LanguageModelV4GenerateResult,
  LanguageModelV4StreamPart,
  LanguageModelV4StreamResult,
  SharedV4ProviderMetadata,
  SharedV4Warning,
} from '@ai-sdk/provider';
import { BreakerOpenError } from '@deuz-sdk/core/errors';
import type { BreakerStore, PriceProvider, Usage } from '@deuz-sdk/core';
import { BudgetLedgerError, createBudgetLedger } from '@deuz-sdk/core/agent';
import type {
  BudgetLedger,
  BudgetReservation,
  BudgetStore,
  BudgetWarning,
  PersistentBudgetScope,
  UnknownPricePolicy,
} from '@deuz-sdk/core/agent';
import { createPriceProvider } from '@deuz-sdk/core/pricing';
import { DeuzBudgetError } from './errors';
import {
  defaultPriceKey,
  estimatePromptTokens,
  isContentPart,
  toDeuzUsage,
  type DeuzModelRef,
} from './spec';

/** Output tokens reserved for a call that sets no `maxOutputTokens`. */
export const DEFAULT_OUTPUT_TOKENS = 4_096;
/** Consecutive provider-health failures that open the breaker (core's `BREAKER_THRESHOLD`). */
export const DEFAULT_BREAKER_THRESHOLD = 5;
/** How long an open breaker fails fast, in ms (core's `BREAKER_COOLDOWN_MS`). */
export const DEFAULT_BREAKER_COOLDOWN_MS = 30_000;

/** Statuses after which the provider billed nothing, so the hold is released (as in core). */
const NOT_BILLED = new Set([400, 401, 403, 404, 422, 429]);

/**
 * Where the budget lives. Without `store` the bounds are in-process: they
 * last as long as the wrapped model and count only this process. With
 * `store` every call is also admitted, all or none, against each persistent
 * scope, shared by every process that uses the same store.
 */
export interface DeuzBudgetOptions {
  /** In-process USD bound across every call through this wrapper. */
  readonly usd?: number;
  /** In-process token bound across every call through this wrapper. */
  readonly tokens?: number;
  /**
   * A model with no price under a USD bound (default `'warn'`): `'warn'` runs
   * it, still bounding and recording its tokens but leaving its cost out of
   * every USD total; `'reject'` refuses it with `DeuzBudgetError` code
   * `'unpriced_model'`. It applies to the persistent scopes too, and a scope's
   * own `limits.unknownPrice: 'reject'` refuses as well.
   */
  readonly unknownPrice?: UnknownPricePolicy;
  /** A persistent store from `@deuz-sdk/core/agent` (memory) or the `ops/sqlite`, `ops/postgres`, `ops/redis` subpaths. */
  readonly store?: BudgetStore;
  /** The persistent scopes every call is admitted against; required with `store`. */
  readonly scopes?: readonly PersistentBudgetScope[];
  /** Warn when a scope's committed usage reaches this percentage of its limit. */
  readonly warnAtPercent?: number;
  /** Called once per crossing per scope and dimension; errors are ignored. */
  readonly onWarning?: (warning: BudgetWarning) => void;
}

/** Circuit-breaker settings; the defaults are core's (5 failures, 30 s). */
export interface DeuzBreakerOptions {
  /**
   * Where breaker state lives, keyed `provider:modelId` (core's
   * `BreakerStore`). Default: one in-memory store per wrapper; pass a shared
   * one to share state between wrappers or processes.
   */
  readonly store?: BreakerStore;
  /** Consecutive countable failures before the breaker opens (default 5). */
  readonly threshold?: number;
  /** How long an open breaker fails fast, in ms (default 30 000). */
  readonly cooldownMs?: number;
}

/** How a call is estimated before it is sent. */
export interface DeuzEstimateOptions {
  /**
   * Output tokens reserved for a call without `maxOutputTokens` (default
   * 4 096). A provider can bill more than this; see `capOutputTokens`.
   */
  readonly outputTokens?: number;
  /**
   * Send `outputTokens` as `maxOutputTokens` on calls that set none (default
   * false), so the reservation bounds what the provider can bill. The call
   * then reports one warning of type `'other'`. It can cut long answers short.
   */
  readonly capOutputTokens?: boolean;
  /** Replace the character heuristic for the prompt (3.6 characters per token). */
  readonly promptTokens?: (params: LanguageModelV4CallOptions) => number;
}

/** What one completed call cost, reported through `onCost`. */
export interface DeuzCostReceipt {
  /** The ledger and store request id of this call. */
  readonly requestId: string;
  readonly operation: 'generate' | 'stream';
  /** AI SDK identity of the model that answered. */
  readonly provider: string;
  readonly modelId: string;
  /** The Deuz price key the call was priced with. */
  readonly priceKey: string;
  /**
   * `'measured'`: the provider reported usage and it was settled (priced,
   * or recorded as unpriced). `'estimated'`: no usage was reported or the
   * price lookup failed, so the reserved estimate stays charged.
   */
  readonly source: 'measured' | 'estimated';
  /** Tokens charged: the reported total, or the held estimate. */
  readonly tokens: number;
  /** USD charged; `undefined` for a model with no price. */
  readonly usd: number | undefined;
  /** The model has no price: its cost is in no USD total. */
  readonly unpriced: boolean;
  /** The reservation made before the call. */
  readonly estimate: { readonly tokens: number; readonly usd: number | undefined };
  /** Deuz canonical usage, when the provider reported it. */
  readonly usage: Usage | undefined;
  /** False when the store failed to settle: the estimate stays held there. */
  readonly settled: boolean;
  /** Set when an earlier model failed and this one answered. */
  readonly failedOver?: { readonly from: string; readonly reason: string };
  /** When the call settled: epoch ms on the injected clock. */
  readonly at: number;
}

/** Options shared by `deuz()` and `deuzMiddleware()`. */
export interface DeuzOptions {
  /** The budget: options for a new ledger, or an existing core `BudgetLedger` to share. */
  readonly budget?: DeuzBudgetOptions | BudgetLedger;
  /** Prices calls; default `createPriceProvider()` (Deuz's bundled 2026 table). */
  readonly priceProvider?: PriceProvider;
  /**
   * The price key of the wrapped model, or a function from any model (fallbacks
   * included) to its key. `undefined` from the function uses the default
   * mapping (`defaultPriceKey`).
   */
  readonly priceKey?: string | ((model: DeuzModelRef) => string | undefined);
  /** Estimate settings. */
  readonly estimate?: DeuzEstimateOptions;
  /** Circuit breaker settings, or `false` to turn it off. */
  readonly breaker?: DeuzBreakerOptions | false;
  /** Called once per completed call; a throwing callback is ignored. */
  readonly onCost?: (receipt: DeuzCostReceipt) => void;
  /**
   * Called when settling or releasing a hold failed after core's retries. The
   * call still returns: its hold stays charged in the store (fail closed)
   * until a `sweep` or a later settlement closes it.
   */
  readonly onAccountingError?: (error: unknown, requestId: string) => void;
  /** Injected clock (default `Date`). */
  readonly clock?: { now(): number };
  /** Request id source (default `crypto.randomUUID`). */
  readonly generateId?: () => string;
}

/** @internal Fail-over context of one attempt. */
export interface AttemptInfo {
  readonly failedOver?: { readonly from: string; readonly reason: string };
}

/** @internal */
export interface Guard {
  readonly ledger: BudgetLedger;
  prepare(params: LanguageModelV4CallOptions): LanguageModelV4CallOptions;
  priceKeyOf(model: DeuzModelRef, override?: string): string;
  generate(
    model: LanguageModelV4,
    params: LanguageModelV4CallOptions,
    run: (params: LanguageModelV4CallOptions) => PromiseLike<LanguageModelV4GenerateResult>,
    attempt?: AttemptInfo & { readonly priceKey?: string },
  ): Promise<LanguageModelV4GenerateResult>;
  stream(
    model: LanguageModelV4,
    params: LanguageModelV4CallOptions,
    run: (params: LanguageModelV4CallOptions) => PromiseLike<LanguageModelV4StreamResult>,
    attempt?: AttemptInfo & { readonly priceKey?: string },
  ): Promise<LanguageModelV4StreamResult>;
}

interface Ticket {
  readonly requestId: string;
  readonly operation: 'generate' | 'stream';
  readonly scopeId: string | undefined;
  readonly ref: DeuzModelRef;
  readonly priceKey: string;
  readonly breakerKey: string;
  readonly breakerFailures: number;
  readonly estimate: { readonly tokens: number; readonly usd: number | undefined };
  readonly unpriced: boolean;
  readonly warnings: readonly SharedV4Warning[];
  readonly attempt: AttemptInfo | undefined;
}

const statusOf = (error: unknown): number | undefined => {
  const status = (error as { statusCode?: unknown } | null)?.statusCode;
  return typeof status === 'number' ? status : undefined;
};

/**
 * Provider-health failures, as core counts them: retryable errors and 5xx.
 * Client errors, aborts, budget refusals and an open breaker are not.
 */
export function isProviderFailure(error: unknown): boolean {
  if (error instanceof BreakerOpenError || DeuzBudgetError.isInstance(error)) return false;
  if ((error as { isRetryable?: unknown } | null)?.isRetryable === true) return true;
  const status = statusOf(error);
  return status !== undefined && status >= 500;
}

function isLedger(value: DeuzBudgetOptions | BudgetLedger | undefined): value is BudgetLedger {
  return typeof (value as BudgetLedger | undefined)?.reserve === 'function';
}

function ledgerOf(budget: DeuzBudgetOptions | BudgetLedger | undefined): {
  ledger: BudgetLedger;
  owned: boolean;
} {
  if (isLedger(budget)) return { ledger: budget, owned: false };
  const options = budget ?? {};
  if (options.store && !options.scopes?.length)
    throw new TypeError('budget.store needs at least one scope in budget.scopes.');
  if (options.scopes?.length && !options.store)
    throw new TypeError('budget.scopes need a budget.store to admit against.');
  const ledger = createBudgetLedger({
    budget: {
      ...(options.usd !== undefined ? { usd: options.usd } : {}),
      ...(options.tokens !== undefined ? { tokens: options.tokens } : {}),
      ...(options.unknownPrice !== undefined ? { unknownPrice: options.unknownPrice } : {}),
    },
    ...(options.store
      ? {
          admission: {
            store: options.store,
            scopes: options.scopes ?? [],
            ...(options.warnAtPercent !== undefined
              ? { warnAtPercent: options.warnAtPercent }
              : {}),
            ...(options.onWarning ? { onWarning: options.onWarning } : {}),
          },
        }
      : {}),
  });
  return { ledger, owned: true };
}

function createMemoryBreakerStore(): BreakerStore {
  const states = new Map<string, { failures: number; openedAt?: number; cooldownUntil?: number }>();
  return {
    get: (key) => states.get(key),
    set: (key, state) => {
      states.set(key, state);
    },
  };
}

const defaultGenerateId = (): string => globalThis.crypto.randomUUID();

/** Attach the receipt as `providerMetadata.deuz`. */
function withDeuz(
  metadata: SharedV4ProviderMetadata | undefined,
  receipt: DeuzCostReceipt,
): SharedV4ProviderMetadata {
  return {
    ...metadata,
    deuz: {
      ...metadata?.deuz,
      requestId: receipt.requestId,
      priceKey: receipt.priceKey,
      source: receipt.source,
      tokens: receipt.tokens,
      ...(receipt.usd !== undefined ? { usd: receipt.usd } : {}),
      unpriced: receipt.unpriced,
      ...(receipt.failedOver
        ? { failedOver: { from: receipt.failedOver.from, reason: receipt.failedOver.reason } }
        : {}),
    },
  };
}

/** @internal Build the shared guard. */
export function createGuard(options: DeuzOptions = {}): Guard {
  const { ledger, owned } = ledgerOf(options.budget);
  const priceProvider = options.priceProvider ?? createPriceProvider();
  const clock = options.clock ?? Date;
  const generateId = options.generateId ?? defaultGenerateId;
  const estimate = options.estimate ?? {};
  const outputTokens = estimate.outputTokens ?? DEFAULT_OUTPUT_TOKENS;
  if (!Number.isSafeInteger(outputTokens) || outputTokens < 1)
    throw new TypeError('estimate.outputTokens must be a positive safe integer.');
  const breaker =
    options.breaker === false
      ? undefined
      : {
          store: options.breaker?.store ?? createMemoryBreakerStore(),
          threshold: options.breaker?.threshold ?? DEFAULT_BREAKER_THRESHOLD,
          cooldownMs: options.breaker?.cooldownMs ?? DEFAULT_BREAKER_COOLDOWN_MS,
        };
  /** Params this guard capped, so the call reports it once. */
  const capped = new WeakSet<LanguageModelV4CallOptions>();
  /** Price keys already reported as unpriced by this wrapper. */
  const reportedUnpriced = new Set<string>();

  const report = (error: unknown, requestId: string): void => {
    try {
      options.onAccountingError?.(error, requestId);
    } catch {
      // Advisory only.
    }
  };

  function priceKeyOf(model: DeuzModelRef, override?: string): string {
    if (override !== undefined) return override;
    const key = options.priceKey;
    if (typeof key === 'function') return key(model) ?? defaultPriceKey(model);
    return key ?? defaultPriceKey(model);
  }

  function prepare(params: LanguageModelV4CallOptions): LanguageModelV4CallOptions {
    if (!estimate.capOutputTokens || params.maxOutputTokens !== undefined) return params;
    const next = { ...params, maxOutputTokens: outputTokens };
    capped.add(next);
    return next;
  }

  async function open(
    model: LanguageModelV4,
    params: LanguageModelV4CallOptions,
    operation: 'generate' | 'stream',
    attempt: (AttemptInfo & { readonly priceKey?: string }) | undefined,
  ): Promise<Ticket> {
    const ref: DeuzModelRef = { provider: model.provider, modelId: model.modelId };
    const priceKey = priceKeyOf(ref, attempt?.priceKey);
    const breakerKey = `${ref.provider}:${ref.modelId}`;
    let breakerFailures = 0;
    if (breaker) {
      let state: Awaited<ReturnType<BreakerStore['get']>>;
      try {
        state = await breaker.store.get(breakerKey);
      } catch {
        state = undefined; // A failing breaker store never blocks calls (as in core).
      }
      if (state?.cooldownUntil !== undefined && state.cooldownUntil > clock.now())
        throw new BreakerOpenError({
          provider: ref.provider,
          modelId: ref.modelId,
          cooldownUntil: state.cooldownUntil,
        });
      breakerFailures = state?.failures ?? 0;
    }
    if (params.abortSignal?.aborted)
      throw params.abortSignal.reason ?? new DOMException('Aborted', 'AbortError');

    const promptTokens = estimate.promptTokens?.(params) ?? estimatePromptTokens(params);
    const output = params.maxOutputTokens ?? outputTokens;
    const estimatedUsage: Usage = {
      inputTokens: promptTokens,
      outputTokens: output,
      reasoningTokens: 0,
      cachedReadTokens: 0,
      cacheWriteTokens: 0,
      cacheWrite1hTokens: 0,
      totalTokens: promptTokens + output,
    };
    let usd: number | undefined;
    let unpriced = false;
    try {
      usd = (await priceProvider.priceUsage(priceKey, estimatedUsage)) ?? undefined;
      unpriced = usd === undefined;
    } catch {
      // An outage, not a missing price: a USD bound refuses the call (missing_reservation).
    }
    const requestId = generateId();
    const scopeId = owned ? `call:${requestId}` : undefined;
    let reservation: BudgetReservation;
    try {
      reservation = await ledger.reserve({
        requestId,
        modelId: priceKey,
        kind: 'model',
        tokens: estimatedUsage.totalTokens,
        ...(usd !== undefined ? { usd } : {}),
        ...(unpriced ? { unpriced: true } : {}),
        ...(scopeId ? { scopes: [{ id: scopeId, budget: {} }] } : {}),
      });
    } catch (error) {
      if (error instanceof BudgetLedgerError)
        throw new DeuzBudgetError({
          code: error.code,
          message: `Deuz budget refused ${ref.provider}:${ref.modelId}: ${error.message}`,
          provider: ref.provider,
          modelId: ref.modelId,
          priceKey,
          cause: error,
        });
      throw error;
    }
    const warnings: SharedV4Warning[] = [];
    if (capped.has(params))
      warnings.push({
        type: 'other',
        message: `Deuz sent maxOutputTokens ${output} (estimate.capOutputTokens); pass maxOutputTokens to change it.`,
      });
    if (reservation.unpriced && !reportedUnpriced.has(priceKey)) {
      reportedUnpriced.add(priceKey);
      warnings.push({
        type: 'other',
        message: `Deuz has no price for '${priceKey}': its tokens are budgeted, its USD cost is not counted. Pass priceKey or a priceProvider table row.`,
      });
    }
    return {
      requestId,
      operation,
      scopeId,
      ref,
      priceKey,
      breakerKey,
      breakerFailures,
      estimate: { tokens: estimatedUsage.totalTokens, usd },
      unpriced: reservation.unpriced === true,
      warnings,
      attempt,
    };
  }

  async function compact(ticket: Ticket): Promise<void> {
    // Fold this call's record so a long-lived wrapper keeps a small ledger.
    if (ticket.scopeId) await ledger.compact(ticket.scopeId).catch(() => undefined);
  }

  /** Close a call that failed: release when nothing was billed, otherwise keep the hold. */
  async function fail(ticket: Ticket, error: unknown): Promise<void> {
    const status = statusOf(error);
    try {
      await (status !== undefined && NOT_BILLED.has(status)
        ? ledger.release(ticket.requestId)
        : ledger.markUnknown(ticket.requestId));
    } catch (failure) {
      report(failure, ticket.requestId);
    }
    await compact(ticket);
  }

  async function breakerSuccess(ticket: Ticket): Promise<void> {
    if (!breaker || ticket.breakerFailures === 0) return;
    try {
      await breaker.store.set(ticket.breakerKey, { failures: 0 });
    } catch {
      // Best effort, as in core.
    }
  }

  async function breakerFailure(ticket: Ticket, error: unknown): Promise<void> {
    if (!breaker || !isProviderFailure(error)) return;
    try {
      const failures = ((await breaker.store.get(ticket.breakerKey))?.failures ?? 0) + 1;
      const now = clock.now();
      await breaker.store.set(
        ticket.breakerKey,
        failures >= breaker.threshold
          ? { failures, openedAt: now, cooldownUntil: now + breaker.cooldownMs }
          : { failures },
      );
    } catch {
      // Best effort, as in core.
    }
  }

  async function settle(
    ticket: Ticket,
    reported: Parameters<typeof toDeuzUsage>[0],
  ): Promise<DeuzCostReceipt> {
    const usage = toDeuzUsage(reported);
    let record: BudgetReservation | undefined;
    try {
      record = usage
        ? await ledger.settleUsage(ticket.requestId, usage, priceProvider)
        : await ledger.markUnknown(ticket.requestId);
    } catch (error) {
      report(error, ticket.requestId);
    }
    await compact(ticket);
    const unpriced = ticket.unpriced || record?.unpriced === true;
    const measured =
      usage !== undefined && record !== undefined && (record.actual.usd !== undefined || unpriced);
    const receipt: DeuzCostReceipt = {
      requestId: ticket.requestId,
      operation: ticket.operation,
      provider: ticket.ref.provider,
      modelId: ticket.ref.modelId,
      priceKey: ticket.priceKey,
      source: measured ? 'measured' : 'estimated',
      tokens: record?.actual.tokens ?? ticket.estimate.tokens,
      usd: unpriced ? record?.actual.usd : (record?.actual.usd ?? ticket.estimate.usd),
      unpriced,
      estimate: ticket.estimate,
      usage,
      settled: record !== undefined,
      ...(ticket.attempt?.failedOver ? { failedOver: ticket.attempt.failedOver } : {}),
      at: clock.now(),
    };
    try {
      options.onCost?.(receipt);
    } catch {
      // A receipt callback never changes the call.
    }
    return receipt;
  }

  function meter(
    source: ReadableStream<LanguageModelV4StreamPart>,
    ticket: Ticket,
  ): ReadableStream<LanguageModelV4StreamPart> {
    const reader = source.getReader();
    let content = false;
    let closed = false;
    let early: { error: unknown } | undefined;
    /** The stream ended, failed or was cancelled before its `finish` part. */
    const abandon = async (error?: { error: unknown }): Promise<void> => {
      if (closed) return;
      closed = true;
      const failure = error ?? early;
      if (failure && !content) {
        await fail(ticket, failure.error);
        await breakerFailure(ticket, failure.error);
      } else {
        // Content flowed but no usage arrived: the estimate stays charged.
        try {
          await ledger.markUnknown(ticket.requestId);
        } catch (failed) {
          report(failed, ticket.requestId);
        }
        await compact(ticket);
      }
    };
    return new ReadableStream<LanguageModelV4StreamPart>({
      async pull(controller) {
        let next: Awaited<ReturnType<typeof reader.read>>;
        try {
          next = await reader.read();
        } catch (error) {
          await abandon({ error });
          controller.error(error);
          return;
        }
        if (next.done) {
          await abandon();
          controller.close();
          return;
        }
        const part = next.value;
        if (part.type === 'stream-start') {
          controller.enqueue(
            ticket.warnings.length
              ? { ...part, warnings: [...part.warnings, ...ticket.warnings] }
              : part,
          );
        } else if (part.type === 'finish' && !closed) {
          closed = true;
          if (early && !content) await breakerFailure(ticket, early.error);
          else await breakerSuccess(ticket);
          const receipt = await settle(ticket, part.usage);
          controller.enqueue({
            ...part,
            providerMetadata: withDeuz(part.providerMetadata, receipt),
          });
        } else {
          if (part.type === 'error' && !content && !early) early = { error: part.error };
          else if (isContentPart(part)) content = true;
          controller.enqueue(part);
        }
      },
      async cancel(reason) {
        await reader.cancel(reason).catch(() => undefined);
        await abandon();
      },
    });
  }

  return {
    ledger,
    prepare,
    priceKeyOf,
    async generate(model, params, run, attempt) {
      const call = prepare(params);
      const ticket = await open(model, call, 'generate', attempt);
      let result: LanguageModelV4GenerateResult;
      try {
        result = await run(call);
      } catch (error) {
        await fail(ticket, error);
        await breakerFailure(ticket, error);
        throw error;
      }
      await breakerSuccess(ticket);
      const receipt = await settle(ticket, result.usage);
      return {
        ...result,
        warnings: ticket.warnings.length
          ? [...result.warnings, ...ticket.warnings]
          : result.warnings,
        providerMetadata: withDeuz(result.providerMetadata, receipt),
      };
    },
    async stream(model, params, run, attempt) {
      const call = prepare(params);
      const ticket = await open(model, call, 'stream', attempt);
      let result: LanguageModelV4StreamResult;
      try {
        result = await run(call);
      } catch (error) {
        await fail(ticket, error);
        await breakerFailure(ticket, error);
        throw error;
      }
      return { ...result, stream: meter(result.stream, ticket) };
    },
  };
}
