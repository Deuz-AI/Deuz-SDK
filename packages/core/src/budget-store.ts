/**
 * Persistent budget scopes (2.2): the in-memory `BudgetStore` and the rules
 * every store shares — validation, idempotency fingerprints and bucket math —
 * so the SQLite and Postgres stores admit exactly like this one. Edge-safe.
 */
import type { Clock } from './types/deps';
import type { BudgetLimits } from './types/execution';
import type {
  BudgetScopeUsage,
  BudgetStore,
  BudgetStoreReservation,
  BudgetStoreReserveInput,
  BudgetUsage,
  BudgetUsageOptions,
} from './types/budget-store';
import { resolveDependencies } from './internal/resolve-deps';

export type * from './types/budget-store';

export type BudgetStoreErrorCode = 'invalid_request' | 'reservation_conflict' | 'window_conflict';

export class BudgetStoreError extends Error {
  readonly name = 'BudgetStoreError';

  constructor(
    readonly code: BudgetStoreErrorCode,
    message: string,
  ) {
    super(message);
  }
}

/** History granularity of a lifetime scope; its admission counts every bucket. */
export const LIFETIME_BUCKET_MS = 3_600_000;
const DEFAULT_BUCKETS = 60;
const MAX_BUCKETS = 1_000;

/** @internal A validated scope with its bucket geometry. */
export interface NormalizedBudgetScope {
  readonly key: string;
  readonly limits: BudgetLimits;
  /** `null` for a lifetime scope. */
  readonly windowMs: number | null;
  /** Buckets counted by admission; 1 for a lifetime scope (which counts all). */
  readonly buckets: number;
  readonly bucketMs: number;
}

/** @internal A validated reservation plus its idempotency fingerprint. */
export interface NormalizedBudgetReserve {
  readonly requestId: string;
  readonly modelId: string;
  readonly tokens?: number;
  readonly usd?: number;
  readonly scopes: readonly NormalizedBudgetScope[];
  readonly fingerprint: string;
}

const invalid = (message: string) => new BudgetStoreError('invalid_request', message);

function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0)
    throw invalid(`${label} must be a nonempty string.`);
  return value;
}

function amount(value: unknown, label: string, integer: boolean): number | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    value < 0 ||
    (integer && !Number.isSafeInteger(value))
  )
    throw invalid(`${label} must be a finite nonnegative ${integer ? 'safe integer' : 'number'}.`);
  return value;
}

/** @internal */
export function assertBudgetKey(key: unknown): string {
  return text(key, 'Budget scope key');
}

/** @internal Validate settlement amounts. */
export function assertBudgetActual(actual: { tokens: number; usd: number }): {
  tokens: number;
  usd: number;
} {
  if (actual === null || typeof actual !== 'object') throw invalid('Actual usage is required.');
  const tokens = amount(actual.tokens, 'tokens', true);
  const usd = amount(actual.usd, 'usd', false);
  if (tokens === undefined || usd === undefined)
    throw invalid('Settlement requires token and USD amounts.');
  return { tokens, usd };
}

/** @internal Validate a reservation and fix its scopes' bucket geometry. */
export function normalizeBudgetReserve(input: BudgetStoreReserveInput): NormalizedBudgetReserve {
  if (input === null || typeof input !== 'object') throw invalid('Reservation must be an object.');
  const requestId = text(input.requestId, 'requestId');
  const modelId = text(input.modelId, 'modelId');
  const tokens = amount(input.tokens, 'tokens', true);
  const usd = amount(input.usd, 'usd', false);
  if (!Array.isArray(input.scopes) || input.scopes.length === 0)
    throw invalid('A reservation needs at least one scope.');
  const keys = new Set<string>();
  const scopes = input.scopes.map((scope): NormalizedBudgetScope => {
    if (scope === null || typeof scope !== 'object') throw invalid('Scope must be an object.');
    const key = assertBudgetKey(scope.key);
    if (keys.has(key)) throw invalid(`Duplicate budget scope: ${key}.`);
    keys.add(key);
    const raw = scope.limits ?? {};
    const limits: BudgetLimits = {
      ...(raw.tokens !== undefined ? { tokens: amount(raw.tokens, `${key} tokens`, true) } : {}),
      ...(raw.usd !== undefined ? { usd: amount(raw.usd, `${key} usd`, false) } : {}),
    };
    if (limits.tokens !== undefined && tokens === undefined)
      throw invalid(`A tokens estimate is required by budget scope ${key}.`);
    if (limits.usd !== undefined && usd === undefined)
      throw invalid(`A usd estimate is required by budget scope ${key}.`);
    if (scope.window === undefined)
      return { key, limits, windowMs: null, buckets: 1, bucketMs: LIFETIME_BUCKET_MS };
    const ms = scope.window?.ms;
    if (typeof ms !== 'number' || !Number.isSafeInteger(ms) || ms < 1)
      throw invalid(`Window of ${key} must be a positive safe integer of milliseconds.`);
    const buckets = scope.window.buckets ?? Math.min(DEFAULT_BUCKETS, ms);
    if (!Number.isSafeInteger(buckets) || buckets < 1 || buckets > MAX_BUCKETS || buckets > ms)
      throw invalid(
        `Window buckets of ${key} must be an integer from 1 to min(${MAX_BUCKETS}, ms).`,
      );
    return { key, limits, windowMs: ms, buckets, bucketMs: Math.ceil(ms / buckets) };
  });
  const fingerprint = JSON.stringify([
    modelId,
    tokens ?? null,
    usd ?? null,
    scopes.map((scope) => [
      scope.key,
      scope.limits.tokens ?? null,
      scope.limits.usd ?? null,
      scope.windowMs,
      scope.windowMs === null ? null : scope.buckets,
    ]),
  ]);
  return {
    requestId,
    modelId,
    ...(tokens !== undefined ? { tokens } : {}),
    ...(usd !== undefined ? { usd } : {}),
    scopes,
    fingerprint,
  };
}

/** @internal Reject a scope whose window differs from the one its key was created with. */
export function assertSameWindow(
  scope: NormalizedBudgetScope,
  saved: { windowMs: number | null; buckets: number },
): void {
  if (
    saved.windowMs !== scope.windowMs ||
    (scope.windowMs !== null && saved.buckets !== scope.buckets)
  )
    throw new BudgetStoreError(
      'window_conflict',
      `Budget scope ${scope.key} already uses a different window.`,
    );
}

/** @internal The bucket index a time falls in. */
export const bucketIndex = (scope: { bucketMs: number }, at: number): number =>
  Math.floor(at / scope.bucketMs);

/** @internal The lowest bucket index admission still counts at `at`. */
export const firstCountedBucket = (
  scope: { windowMs: number | null; buckets: number; bucketMs: number },
  at: number,
): number =>
  scope.windowMs === null ? Number.MIN_SAFE_INTEGER : bucketIndex(scope, at) - scope.buckets + 1;

/**
 * @internal Pick the first scope and dimension a request does not fit.
 * `committed` is each scope's usage inside its window before this request.
 */
export function decideBudgetAdmission(
  request: NormalizedBudgetReserve,
  committed: readonly { tokens: number; usd: number }[],
): BudgetStoreReservation {
  const scopes: BudgetScopeUsage[] = [];
  for (const [index, scope] of request.scopes.entries()) {
    const current = committed[index] ?? { tokens: 0, usd: 0 };
    for (const dimension of ['tokens', 'usd'] as const) {
      const limit = scope.limits[dimension];
      if (limit !== undefined && current[dimension] + (request[dimension] ?? 0) > limit)
        return { admitted: false, key: scope.key, dimension, limit, committed: current[dimension] };
    }
    scopes.push({
      key: scope.key,
      tokens: current.tokens + (request.tokens ?? 0),
      usd: current.usd + (request.usd ?? 0),
    });
  }
  return { admitted: true, scopes };
}

/** @internal */
export const reservationConflict = (requestId: string) =>
  new BudgetStoreError('reservation_conflict', `Conflicting reservation for ${requestId}.`);

/** @internal What settling or releasing a recorded request should do. */
export function planBudgetTransition(
  requestId: string,
  current: {
    state: 'reserved' | 'settled' | 'released' | 'denied';
    actualTokens?: number | null;
    actualUsd?: number | null;
  },
  next: { settle: { tokens: number; usd: number } } | { release: true },
): 'apply' | 'noop' {
  if (current.state === 'denied') return 'noop';
  if ('settle' in next) {
    if (current.state === 'released')
      throw new BudgetStoreError(
        'reservation_conflict',
        `Released request cannot be settled: ${requestId}.`,
      );
    if (current.state === 'settled') {
      if (current.actualTokens === next.settle.tokens && current.actualUsd === next.settle.usd)
        return 'noop';
      throw new BudgetStoreError(
        'reservation_conflict',
        `Conflicting settlement for ${requestId}.`,
      );
    }
    return 'apply';
  }
  if (current.state === 'released') return 'noop';
  if (
    current.state === 'settled' &&
    ((current.actualTokens ?? 0) > 0 || (current.actualUsd ?? 0) > 0)
  )
    throw new BudgetStoreError(
      'reservation_conflict',
      `Billed request cannot be released: ${requestId}.`,
    );
  return 'apply';
}

/** @internal Sum usage rows into the public shape. */
export function summarizeBudgetUsage(
  rows: Iterable<{ modelId: string; tokens: number; usd: number }>,
  byModel: boolean | undefined,
): BudgetUsage {
  let tokens = 0;
  let usd = 0;
  const models: Record<string, { tokens: number; usd: number }> = {};
  for (const row of rows) {
    tokens += row.tokens;
    usd += row.usd;
    const model = (models[row.modelId] ??= { tokens: 0, usd: 0 });
    model.tokens += row.tokens;
    model.usd += row.usd;
  }
  return byModel ? { tokens, usd, byModel: models } : { tokens, usd };
}

/** @internal Validate a usage query. */
export function assertUsageOptions(key: string, options: BudgetUsageOptions = {}): void {
  assertBudgetKey(key);
  if (options.since !== undefined && !Number.isFinite(options.since))
    throw invalid('since must be a finite epoch millisecond value.');
}

interface Charge {
  readonly key: string;
  readonly index: number;
}

interface MemoryRequest {
  readonly fingerprint: string;
  readonly modelId: string;
  readonly tokens: number;
  readonly usd: number;
  state: 'reserved' | 'settled' | 'released' | 'denied';
  readonly charges: readonly Charge[];
  actualTokens?: number;
  actualUsd?: number;
  readonly outcome: BudgetStoreReservation;
}

/** For tests and single-process deployments; its budgets die with the process. */
export function createInMemoryBudgetStore(options: { clock?: Clock } = {}): BudgetStore {
  const clock = options.clock ?? resolveDependencies().clock;
  const windows = new Map<string, { windowMs: number | null; buckets: number; bucketMs: number }>();
  /** key → bucket index → model → amounts. */
  const counters = new Map<string, Map<number, Map<string, { tokens: number; usd: number }>>>();
  const requests = new Map<string, MemoryRequest>();

  const add = (charge: Charge, modelId: string, tokens: number, usd: number) => {
    let buckets = counters.get(charge.key);
    if (!buckets) counters.set(charge.key, (buckets = new Map()));
    let models = buckets.get(charge.index);
    if (!models) buckets.set(charge.index, (models = new Map()));
    const row = models.get(modelId) ?? { tokens: 0, usd: 0 };
    models.set(modelId, { tokens: row.tokens + tokens, usd: row.usd + usd });
  };
  const committed = (scope: NormalizedBudgetScope, at: number) => {
    const first = firstCountedBucket(scope, at);
    let tokens = 0;
    let usd = 0;
    for (const [index, models] of counters.get(scope.key) ?? []) {
      if (index < first) continue;
      for (const row of models.values()) {
        tokens += row.tokens;
        usd += row.usd;
      }
    }
    return { tokens, usd };
  };
  const recorded = (request: NormalizedBudgetReserve) => {
    const existing = requests.get(request.requestId);
    if (existing && existing.fingerprint !== request.fingerprint)
      throw reservationConflict(request.requestId);
    return existing;
  };

  return Object.freeze({
    async reserve(input) {
      const request = normalizeBudgetReserve(input);
      const existing = recorded(request);
      if (existing) return existing.outcome;
      for (const scope of request.scopes) {
        const saved = windows.get(scope.key);
        if (saved) assertSameWindow(scope, saved);
      }
      for (const scope of request.scopes)
        if (!windows.has(scope.key)) windows.set(scope.key, scope);
      const at = clock.now();
      const outcome = decideBudgetAdmission(
        request,
        request.scopes.map((scope) => committed(scope, at)),
      );
      const charges = request.scopes.map((scope) => ({
        key: scope.key,
        index: bucketIndex(scope, at),
      }));
      const tokens = request.tokens ?? 0;
      const usd = request.usd ?? 0;
      if (outcome.admitted) for (const charge of charges) add(charge, request.modelId, tokens, usd);
      requests.set(request.requestId, {
        fingerprint: request.fingerprint,
        modelId: request.modelId,
        tokens,
        usd,
        state: outcome.admitted ? 'reserved' : 'denied',
        charges,
        outcome,
      });
      return outcome;
    },
    async settle(requestId, actual) {
      text(requestId, 'requestId');
      const settle = assertBudgetActual(actual);
      const current = requests.get(requestId);
      if (!current || planBudgetTransition(requestId, current, { settle }) === 'noop') return;
      for (const charge of current.charges)
        add(charge, current.modelId, settle.tokens - current.tokens, settle.usd - current.usd);
      current.state = 'settled';
      current.actualTokens = settle.tokens;
      current.actualUsd = settle.usd;
    },
    async release(requestId) {
      text(requestId, 'requestId');
      const current = requests.get(requestId);
      if (!current || planBudgetTransition(requestId, current, { release: true }) === 'noop')
        return;
      if (current.state === 'reserved')
        for (const charge of current.charges)
          add(charge, current.modelId, -current.tokens, -current.usd);
      current.state = 'released';
    },
    async usage(key, usageOptions = {}) {
      assertUsageOptions(key, usageOptions);
      const scope = windows.get(key);
      const rows: { modelId: string; tokens: number; usd: number }[] = [];
      for (const [index, models] of counters.get(key) ?? []) {
        // A bucket counts while any part of it lies after `since`.
        if (
          scope &&
          usageOptions.since !== undefined &&
          (index + 1) * scope.bucketMs <= usageOptions.since
        )
          continue;
        for (const [modelId, row] of models) rows.push({ modelId, ...row });
      }
      return summarizeBudgetUsage(rows, usageOptions.byModel);
    },
  } satisfies BudgetStore);
}
