import type { PriceProvider } from './types/deps';
import type { BudgetScopeUsage, PersistentBudgetScope } from './types/budget-store';
import type {
  BudgetAdmission,
  BudgetAggregate,
  BudgetAmounts,
  BudgetCompaction,
  BudgetLedger,
  BudgetLedgerOptions,
  BudgetLedgerSnapshot,
  BudgetLimits,
  BudgetReservation,
  BudgetReservationInput,
  BudgetScope,
  BudgetSettlement,
  BudgetTotals,
} from './types/execution';
import type { Usage } from './types/usage';

export type BudgetLedgerErrorCode =
  | 'invalid_budget'
  | 'budget_exceeded'
  | 'missing_reservation'
  | 'reservation_conflict'
  | 'unknown_request'
  | 'invalid_snapshot'
  | 'persistence_failed'
  /**
   * The persistent `BudgetStore` failed; nothing was admitted or changed
   * locally (2.2). A settlement or release is tried three times first and the
   * error then carries `requestId` and, for a settlement, `settlement` (2.3).
   */
  | 'admission_failed'
  /** A model with no price was refused under a USD bound with `unknownPrice: 'reject'` (2.3). */
  | 'unpriced_model';

/** Attempts at closing a hold (settle, release) in the persistent store (2.3, F17). */
const CLOSE_ATTEMPTS = 3;

export class BudgetLedgerError extends Error {
  readonly name = 'BudgetLedgerError';
  readonly fatalExecution = true;
  // `declare`: only errors that carry them get these properties.
  /**
   * The attempt whose hold a failed store call left in place (2.3). Settle or
   * release it again once the store answers.
   */
  declare readonly requestId?: string;
  /** For a failed settlement: `ledger.settle(settlement)` replays it (2.3). */
  declare readonly settlement?: BudgetSettlement;

  constructor(
    readonly code: BudgetLedgerErrorCode,
    message: string,
    cause?: unknown,
    details?: { readonly requestId: string; readonly settlement?: BudgetSettlement },
  ) {
    super(message, cause === undefined ? undefined : { cause });
    if (details) {
      this.requestId = details.requestId;
      if (details.settlement) this.settlement = details.settlement;
    }
  }
}

const dimensions = ['tokens', 'usd'] as const;

function amount(value: number | undefined, label: string, integer = false): void {
  if (
    value !== undefined &&
    (!Number.isFinite(value) || value < 0 || (integer && !Number.isSafeInteger(value)))
  ) {
    throw new BudgetLedgerError(
      'invalid_budget',
      `${label} must be a finite nonnegative ${integer ? 'safe integer' : 'number'}.`,
    );
  }
}

/** Token and USD amounts only: estimates and actual usage carry no policy. */
function amounts(value: BudgetLimits = {}): BudgetLimits {
  if (value === null || typeof value !== 'object') {
    throw new BudgetLedgerError('invalid_budget', 'Budget must be an object.');
  }
  amount(value.tokens, 'tokens', true);
  amount(value.usd, 'usd');
  return Object.freeze({
    ...(value.tokens !== undefined ? { tokens: value.tokens } : {}),
    ...(value.usd !== undefined ? { usd: value.usd } : {}),
  });
}

/** A budget: its bounds plus how its `usd` bound treats unpriced models (2.3). */
function limits(value: BudgetLimits = {}): BudgetLimits {
  const bounds = amounts(value);
  const policy = value.unknownPrice;
  if (policy === undefined) return bounds;
  if (policy !== 'warn' && policy !== 'reject')
    throw new BudgetLedgerError('invalid_budget', "unknownPrice must be 'warn' or 'reject'.");
  return Object.freeze({ ...bounds, unknownPrice: policy });
}

/**
 * Omitted child limits inherit; supplied limits can only tighten the parent.
 * `unknownPrice: 'reject'` on either side wins (2.3).
 */
export function intersectBudgetLimits(
  parent: BudgetLimits = {},
  child: BudgetLimits = {},
): BudgetLimits {
  const a = limits(parent);
  const b = limits(child);
  const min = (left: number | undefined, right: number | undefined) =>
    left === undefined ? right : right === undefined ? left : Math.min(left, right);
  return limits({
    tokens: min(a.tokens, b.tokens),
    usd: min(a.usd, b.usd),
    unknownPrice:
      a.unknownPrice === 'reject' || b.unknownPrice === 'reject'
        ? 'reject'
        : (a.unknownPrice ?? b.unknownPrice),
  });
}

function identifier(value: string, label: string): void {
  if (typeof value !== 'string' || value.length === 0) {
    throw new BudgetLedgerError('invalid_budget', `${label} must be a nonempty string.`);
  }
}

function copyScopes(input: readonly BudgetScope[] = []): readonly BudgetScope[] {
  if (!Array.isArray(input))
    throw new BudgetLedgerError('invalid_budget', 'Scopes must be an array.');
  const ids = new Set<string>();
  return Object.freeze(
    input.map((scope) => {
      identifier(scope.id, 'scope id');
      if (ids.has(scope.id))
        throw new BudgetLedgerError('invalid_budget', `Duplicate scope: ${scope.id}.`);
      ids.add(scope.id);
      return Object.freeze({ id: scope.id, budget: limits(scope.budget) });
    }),
  );
}

function copyUsage(usage: Usage): Readonly<Usage> {
  const required = [
    'inputTokens',
    'outputTokens',
    'reasoningTokens',
    'cachedReadTokens',
    'cacheWriteTokens',
    'cacheWrite1hTokens',
    'totalTokens',
  ] as const;
  if (usage === null || typeof usage !== 'object') {
    throw new BudgetLedgerError('invalid_budget', 'Usage must be an object.');
  }
  for (const field of required) {
    if (usage[field] === undefined)
      throw new BudgetLedgerError('invalid_budget', `Usage.${field} is required.`);
    amount(usage[field], `usage.${field}`, true);
  }
  amount(usage.audioTokens, 'usage.audioTokens', true);
  amount(usage.serverToolUses, 'usage.serverToolUses', true);
  return Object.freeze({
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    reasoningTokens: usage.reasoningTokens,
    cachedReadTokens: usage.cachedReadTokens,
    cacheWriteTokens: usage.cacheWriteTokens,
    cacheWrite1hTokens: usage.cacheWrite1hTokens,
    ...(usage.audioTokens !== undefined ? { audioTokens: usage.audioTokens } : {}),
    ...(usage.serverToolUses !== undefined ? { serverToolUses: usage.serverToolUses } : {}),
    totalTokens: usage.totalTokens,
  });
}

function record(input: BudgetReservation): BudgetReservation {
  identifier(input.requestId, 'requestId');
  identifier(input.modelId, 'modelId');
  identifier(input.kind, 'kind');
  if (!['reserved', 'settled', 'unknown', 'released'].includes(input.state)) {
    throw new BudgetLedgerError('invalid_snapshot', 'Invalid reservation state.');
  }
  if (input.unpriced !== undefined && input.unpriced !== true) {
    throw new BudgetLedgerError('invalid_snapshot', 'Invalid unpriced marker.');
  }
  const actual = amounts(input.actual);
  const usage = input.usage === undefined ? undefined : copyUsage(input.usage);
  if (usage && usage.totalTokens !== actual.tokens) {
    throw new BudgetLedgerError('invalid_snapshot', 'Usage and actual token totals disagree.');
  }
  if (input.state === 'settled' && (actual.tokens === undefined || actual.usd === undefined)) {
    throw new BudgetLedgerError(
      'invalid_snapshot',
      'Settled reservations require known token and USD totals.',
    );
  }
  if (
    (input.state === 'released' || input.state === 'reserved') &&
    (actual.tokens !== undefined || actual.usd !== undefined || usage !== undefined)
  ) {
    throw new BudgetLedgerError(
      'invalid_snapshot',
      `${input.state} reservations cannot contain actual usage.`,
    );
  }
  return Object.freeze({
    requestId: input.requestId,
    modelId: input.modelId,
    kind: input.kind,
    reservation: amounts(input.reservation),
    actual,
    scopes: copyScopes(input.scopes),
    state: input.state,
    ...(usage ? { usage } : {}),
    ...(input.unpriced ? { unpriced: true as const } : {}),
  });
}

/** The USD of this attempt is unknown because its model has no price (2.3). */
const unpricedUsd = (item: BudgetReservation): boolean =>
  item.unpriced === true && item.actual.usd === undefined;

function count(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new BudgetLedgerError('invalid_snapshot', `${label} must be a nonnegative safe integer.`);
  return value;
}

function known(value: BudgetLimits, label: string): BudgetAmounts {
  const copy = amounts(value);
  if (copy.tokens === undefined || copy.usd === undefined)
    throw new BudgetLedgerError('invalid_snapshot', `${label} requires token and USD amounts.`);
  return Object.freeze({ tokens: copy.tokens, usd: copy.usd });
}

function aggregate(input: BudgetAggregate): BudgetAggregate {
  if (input === null || typeof input !== 'object')
    throw new BudgetLedgerError('invalid_snapshot', 'Budget aggregate must be an object.');
  const folded = count(input.count, 'Aggregate count');
  const unknownTokens = count(input.unknownTokens, 'Aggregate unknownTokens');
  const unknownUsd = count(input.unknownUsd, 'Aggregate unknownUsd');
  const unestimatedTokens = count(input.unestimatedTokens, 'Aggregate unestimatedTokens');
  const unestimatedUsd = count(input.unestimatedUsd, 'Aggregate unestimatedUsd');
  const unpriced =
    input.unpricedUsd === undefined ? 0 : count(input.unpricedUsd, 'Aggregate unpricedUsd');
  if (
    unknownTokens > folded ||
    unknownUsd > folded ||
    unestimatedTokens > unknownTokens ||
    unestimatedUsd > unknownUsd ||
    unpriced > unestimatedUsd
  )
    throw new BudgetLedgerError('invalid_snapshot', 'Budget aggregate counts are inconsistent.');
  return Object.freeze({
    scopes: copyScopes(input.scopes),
    count: folded,
    spent: known(input.spent, 'Aggregate spent'),
    held: known(input.held, 'Aggregate held'),
    unknownTokens,
    unknownUsd,
    unestimatedTokens,
    unestimatedUsd,
    ...(unpriced ? { unpricedUsd: unpriced } : {}),
  });
}

function threshold(value: number | undefined): void {
  if (value !== undefined && (typeof value !== 'number' || !Number.isFinite(value) || value <= 0))
    throw new BudgetLedgerError(
      'invalid_budget',
      'warnAtPercent must be a finite positive number.',
    );
}

function persistentScope(input: PersistentBudgetScope): PersistentBudgetScope {
  if (input === null || typeof input !== 'object')
    throw new BudgetLedgerError('invalid_budget', 'Persistent scope must be an object.');
  identifier(input.key, 'Persistent scope key');
  const window = input.window;
  if (window !== undefined) {
    if (
      window === null ||
      typeof window !== 'object' ||
      !Number.isSafeInteger(window.ms) ||
      window.ms < 1 ||
      (window.buckets !== undefined &&
        (!Number.isSafeInteger(window.buckets) || window.buckets < 1 || window.buckets > window.ms))
    )
      throw new BudgetLedgerError(
        'invalid_budget',
        `Window of ${input.key} needs positive integer ms and buckets no greater than ms.`,
      );
  }
  threshold(input.warnAtPercent);
  return Object.freeze({
    key: input.key,
    limits: limits(input.limits),
    ...(window !== undefined
      ? {
          window: Object.freeze({
            ms: window.ms,
            ...(window.buckets !== undefined ? { buckets: window.buckets } : {}),
          }),
        }
      : {}),
    ...(input.warnAtPercent !== undefined ? { warnAtPercent: input.warnAtPercent } : {}),
  });
}

const windowKey = (scope: PersistentBudgetScope): string =>
  JSON.stringify(scope.window ? [scope.window.ms, scope.window.buckets ?? null] : null);

type ResolvedAdmission = Omit<BudgetAdmission, 'scopes'> & {
  readonly scopes: readonly PersistentBudgetScope[];
};

/** Saved scopes stay; supplied ones are added, and a saved key's limits only tighten. */
function resolveAdmission(
  options: BudgetLedgerOptions['admission'],
  saved: readonly PersistentBudgetScope[] | undefined,
): ResolvedAdmission | undefined {
  if (saved !== undefined && !Array.isArray(saved))
    throw new BudgetLedgerError('invalid_snapshot', 'Snapshot admission must be an array.');
  if (!options) {
    if (saved)
      throw new BudgetLedgerError(
        'invalid_snapshot',
        'This budget snapshot records persistent budget scopes; restore it with their BudgetStore (admission.store).',
      );
    return undefined;
  }
  const store = options.store;
  if (
    store === null ||
    typeof store !== 'object' ||
    typeof store.reserve !== 'function' ||
    typeof store.settle !== 'function' ||
    typeof store.release !== 'function'
  )
    throw new BudgetLedgerError('invalid_budget', 'admission.store must be a BudgetStore.');
  threshold(options.warnAtPercent);
  if (options.onWarning !== undefined && typeof options.onWarning !== 'function')
    throw new BudgetLedgerError('invalid_budget', 'admission.onWarning must be a function.');
  if (options.scopes !== undefined && !Array.isArray(options.scopes))
    throw new BudgetLedgerError('invalid_budget', 'admission.scopes must be an array.');
  const scopes = (saved ?? []).map(persistentScope);
  const supplied = new Set<string>();
  for (const input of options.scopes ?? []) {
    const scope = persistentScope(input);
    if (supplied.has(scope.key))
      throw new BudgetLedgerError('invalid_budget', `Duplicate persistent scope: ${scope.key}.`);
    supplied.add(scope.key);
    const index = scopes.findIndex((item) => item.key === scope.key);
    const previous = scopes[index];
    if (!previous) {
      scopes.push(scope);
      continue;
    }
    if (windowKey(previous) !== windowKey(scope))
      throw new BudgetLedgerError(
        'invalid_budget',
        `Persistent scope ${scope.key} cannot change its window on restore.`,
      );
    scopes[index] = persistentScope({
      ...previous,
      limits: intersectBudgetLimits(previous.limits, scope.limits),
      ...(scope.warnAtPercent !== undefined ? { warnAtPercent: scope.warnAtPercent } : {}),
    });
  }
  if (!scopes.length)
    throw new BudgetLedgerError('invalid_budget', 'Persistent admission needs at least one scope.');
  return Object.freeze({
    store,
    scopes: Object.freeze(scopes),
    ...(options.warnAtPercent !== undefined ? { warnAtPercent: options.warnAtPercent } : {}),
    ...(options.onWarning ? { onWarning: options.onWarning } : {}),
  });
}

const chainKey = (scopes: readonly BudgetScope[]): string =>
  JSON.stringify(scopes.map((scope) => scope.id));

const inScope = (scopes: readonly BudgetScope[], scopeId: string | undefined): boolean =>
  scopeId === undefined || scopes.some((scope) => scope.id === scopeId);

/** Fold one reservation — or, for a released one, only its scope budgets. */
function fold(
  previous: BudgetAggregate | undefined,
  scopes: readonly BudgetScope[],
  item?: BudgetReservation,
): BudgetAggregate {
  const next = {
    scopes: previous
      ? previous.scopes.map((scope, index) => ({
          id: scope.id,
          budget: intersectBudgetLimits(scope.budget, scopes[index]!.budget),
        }))
      : scopes,
    count: previous?.count ?? 0,
    spent: { tokens: previous?.spent.tokens ?? 0, usd: previous?.spent.usd ?? 0 },
    held: { tokens: previous?.held.tokens ?? 0, usd: previous?.held.usd ?? 0 },
    unknownTokens: previous?.unknownTokens ?? 0,
    unknownUsd: previous?.unknownUsd ?? 0,
    unestimatedTokens: previous?.unestimatedTokens ?? 0,
    unestimatedUsd: previous?.unestimatedUsd ?? 0,
    unpricedUsd: previous?.unpricedUsd ?? 0,
  };
  if (item) {
    next.count++;
    for (const dimension of dimensions) {
      const actual = item.actual[dimension];
      if (actual !== undefined) {
        next.spent[dimension] += actual;
        continue;
      }
      const estimate = item.reservation[dimension];
      next.held[dimension] += estimate ?? 0;
      if (dimension === 'tokens') {
        next.unknownTokens++;
        if (estimate === undefined) next.unestimatedTokens++;
      } else {
        next.unknownUsd++;
        if (estimate === undefined) next.unestimatedUsd++;
        // Still unpriced after folding (2.3): it never fails a later USD cap closed.
        if (item.unpriced) next.unpricedUsd++;
      }
    }
  }
  return aggregate(next);
}

/** The accounting charged to one scope (2.2); never restorable as a ledger. */
export function subtreeLedgerSnapshot(
  snapshot: BudgetLedgerSnapshot,
  scopeId: string,
): BudgetLedgerSnapshot {
  identifier(scopeId, 'scopeId');
  const aggregates = (snapshot.aggregates ?? []).filter((item) => inScope(item.scopes, scopeId));
  return Object.freeze({
    version: 2,
    revision: snapshot.revision,
    budget: snapshot.budget,
    reservations: Object.freeze(
      snapshot.reservations.filter((item) => inScope(item.scopes, scopeId)),
    ),
    ...(aggregates.length ? { aggregates: Object.freeze(aggregates) } : {}),
    ...(snapshot.admission ? { admission: snapshot.admission } : {}),
    subtree: scopeId,
  });
}

function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/** The reservation an input asks for, validated and copied. */
function reservationOf(input: BudgetReservationInput): BudgetReservation {
  if (input.unpriced !== undefined && typeof input.unpriced !== 'boolean')
    throw new BudgetLedgerError('invalid_budget', 'unpriced must be boolean.');
  if (input.unpriced && input.usd !== undefined)
    throw new BudgetLedgerError(
      'invalid_budget',
      'An unpriced reservation carries no usd estimate.',
    );
  return record({
    requestId: input.requestId,
    modelId: input.modelId,
    kind: input.kind ?? 'model',
    reservation: amounts(input),
    actual: {},
    scopes: input.scopes ?? [],
    state: 'reserved',
    ...(input.unpriced ? { unpriced: true as const } : {}),
  });
}

/** True when a recorded reservation is the one `candidate` asks for again. */
function sameReservation(existing: BudgetReservation, candidate: BudgetReservation): boolean {
  return (
    existing.modelId === candidate.modelId &&
    existing.kind === candidate.kind &&
    same(existing.reservation, candidate.reservation) &&
    same(existing.scopes, candidate.scopes) &&
    existing.unpriced === candidate.unpriced
  );
}

const conflicting = (requestId: string) =>
  new BudgetLedgerError('reservation_conflict', `Conflicting reservation for ${requestId}.`);

/**
 * Ledger operations batch holds need (2.3), kept off the public
 * `BudgetLedger` type: each ledger `createBudgetLedger` makes registers its own.
 */
interface LedgerInternals {
  adopt(input: BudgetReservationInput): Promise<BudgetReservation>;
}

const internals = new WeakMap<BudgetLedger, LedgerInternals>();

/**
 * Record a reservation another ledger already admitted (2.3): a batch hold a
 * fresh context reads back after a restart, whose provider request has run.
 * This ledger's budgets, its scope budgets and their `unknownPrice` policies
 * do not refuse it (refusing would only hide the spend); its amounts count
 * against them from then on, as an overage settled by the first ledger does.
 * A persistent `BudgetStore` is still asked, where an identical repeat is the
 * same hold; a store or ledger record of that request with other amounts or
 * scope limits is a `reservation_conflict`. A ledger `createBudgetLedger` did
 * not make reserves it instead.
 */
export function adoptReservation(
  ledger: BudgetLedger,
  input: BudgetReservationInput,
): Promise<BudgetReservation> {
  const own = internals.get(ledger);
  return own ? own.adopt(input) : ledger.reserve(input);
}

/**
 * Reservations are admission estimates, not a provider-enforced spend ceiling.
 * Actual overages remain recorded and prevent later admission. Unknown usage
 * never silently frees a reservation. Mutations and persistence are serialized
 * across every context sharing this ledger.
 */
export function createBudgetLedger(options: BudgetLedgerOptions = {}): BudgetLedger {
  const entries = new Map<string, BudgetReservation>();
  const aggregates = new Map<string, BudgetAggregate>();
  const restored = options.snapshot;
  if (
    restored &&
    ((restored.version !== 1 && restored.version !== 2) ||
      !Number.isSafeInteger(restored.revision) ||
      restored.revision < 0 ||
      !Array.isArray(restored.reservations) ||
      (restored.aggregates !== undefined && !Array.isArray(restored.aggregates)) ||
      (restored.version === 1 &&
        (restored.aggregates !== undefined ||
          restored.subtree !== undefined ||
          restored.admission !== undefined)))
  ) {
    throw new BudgetLedgerError('invalid_snapshot', 'Unsupported or malformed budget snapshot.');
  }
  if (restored?.subtree !== undefined) {
    throw new BudgetLedgerError(
      'invalid_snapshot',
      'A subtree budget snapshot records one scope and cannot restore a ledger.',
    );
  }
  const budget = intersectBudgetLimits(restored?.budget, options.budget);
  const admission = resolveAdmission(options.admission, restored?.admission);
  /** Scope/dimension pairs at or above their warning threshold. */
  const warned = new Set<string>();
  let revision = restored?.revision ?? 0;
  for (const item of restored?.reservations ?? []) {
    const saved = record(item);
    if (entries.has(saved.requestId))
      throw new BudgetLedgerError('invalid_snapshot', `Duplicate request ID: ${saved.requestId}.`);
    entries.set(saved.requestId, saved);
  }
  for (const item of restored?.aggregates ?? []) {
    const saved = aggregate(item);
    const key = chainKey(saved.scopes);
    if (aggregates.has(key))
      throw new BudgetLedgerError('invalid_snapshot', 'Duplicate budget aggregate.');
    aggregates.set(key, saved);
  }
  let queue: Promise<unknown> = Promise.resolve();
  let persistenceFailure: BudgetLedgerError | undefined;
  const persistenceSinks = new Set<{ write: NonNullable<BudgetLedgerOptions['persist']> }>();
  if (options.persist) persistenceSinks.add({ write: options.persist });
  let invokingPersistence = false;

  function snapshot(): BudgetLedgerSnapshot {
    const folded = [...aggregates.values()];
    return Object.freeze({
      version: folded.length || admission ? 2 : 1,
      revision,
      budget,
      reservations: Object.freeze([...entries.values()]),
      ...(folded.length ? { aggregates: Object.freeze(folded) } : {}),
      ...(admission ? { admission: admission.scopes } : {}),
    });
  }

  /**
   * Run a store call; a failure changes nothing locally and admits nothing. A
   * call that closes a hold (settle, release) is repeated, since both are
   * idempotent in the store, and its final failure names the request and what
   * it still owes, so the hold can be closed later (2.3, F17). A conflict is
   * not a failure: the store already closed that hold, typically a sweep that
   * got there first, so it keeps its own amounts and the caller's local
   * transition goes ahead without a retry.
   */
  function mirror<T>(call: () => Promise<T>): Promise<T>;
  function mirror(
    call: () => Promise<void>,
    closing: { readonly requestId: string; readonly settlement?: BudgetSettlement },
  ): Promise<void>;
  async function mirror<T>(
    call: () => Promise<T>,
    closing?: { readonly requestId: string; readonly settlement?: BudgetSettlement },
  ): Promise<T | void> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await call();
      } catch (error) {
        if (closing && (error as { code?: unknown } | null)?.code === 'reservation_conflict')
          return;
        if (closing && attempt < CLOSE_ATTEMPTS) continue;
        throw new BudgetLedgerError(
          'admission_failed',
          closing
            ? `The persistent budget store failed to close ${closing.requestId}; nothing was changed and its hold stays.`
            : 'The persistent budget store failed; nothing was changed.',
          error,
          closing,
        );
      }
    }
  }

  /** Second gate (2.2): all-or-nothing admission in the shared store. */
  async function admitPersistent(candidate: BudgetReservation, strict: boolean): Promise<void> {
    if (!admission) return;
    for (const scope of admission.scopes) {
      for (const dimension of dimensions) {
        if (scope.limits[dimension] === undefined || candidate.reservation[dimension] !== undefined)
          continue;
        if (dimension === 'usd' && candidate.unpriced) {
          // Decision 4 (2.3): the run's policy or the scope's own can refuse it.
          if (strict || scope.limits.unknownPrice === 'reject')
            throw new BudgetLedgerError(
              'unpriced_model',
              `${candidate.modelId} has no price, so persistent scope ${scope.key} cannot admit it under its usd limit (unknownPrice: 'reject').`,
            );
          continue;
        }
        throw new BudgetLedgerError(
          'missing_reservation',
          `Known ${dimension} reservations are required by persistent scope ${scope.key}.`,
        );
      }
    }
    const store = admission.store;
    const outcome = await mirror(() =>
      store.reserve({
        requestId: candidate.requestId,
        modelId: candidate.modelId,
        ...candidate.reservation,
        // An unpriced call holds no USD; a usd-bounded scope still needs an amount.
        ...(candidate.unpriced ? { usd: 0 } : {}),
        scopes: admission.scopes.map((scope) => ({
          key: scope.key,
          limits: amounts(scope.limits),
          ...(scope.window ? { window: scope.window } : {}),
        })),
      }),
    );
    if (!outcome.admitted) {
      throw new BudgetLedgerError(
        'budget_exceeded',
        `${outcome.dimension} budget exceeded in persistent scope ${outcome.key}.`,
      );
    }
    warn(admission, candidate.requestId, outcome.scopes);
  }

  function warn(
    active: ResolvedAdmission,
    requestId: string,
    usage: readonly BudgetScopeUsage[],
  ): void {
    for (const scope of active.scopes) {
      const warnAtPercent = scope.warnAtPercent ?? active.warnAtPercent;
      const used = usage.find((item) => item.key === scope.key);
      if (warnAtPercent === undefined || !used) continue;
      for (const dimension of dimensions) {
        const limit = scope.limits[dimension];
        if (limit === undefined) continue;
        const committed = used[dimension];
        const percent = limit > 0 ? (committed * 100) / limit : committed > 0 ? Infinity : 0;
        const id = JSON.stringify([scope.key, dimension]);
        if (percent < warnAtPercent) {
          warned.delete(id);
          continue;
        }
        if (warned.has(id)) continue;
        warned.add(id);
        try {
          active.onWarning?.({
            key: scope.key,
            dimension,
            committed,
            limit,
            percent,
            warnAtPercent,
            requestId,
          });
        } catch {
          // A warning is advisory: a failing callback never changes admission.
        }
      }
    }
  }

  /**
   * Mirror a transition into `settled`; unknown usage keeps the store's hold.
   * A request reserved without a USD estimate holds no USD in the store (no
   * persistent scope can bound USD for it: those require the estimate), so it
   * settles there as soon as its tokens are known, with zero USD, even while
   * the local record waits for a price. Undefined when there is nothing to
   * mirror, so ledgers without persistent admission keep their exact queue
   * timing.
   */
  function mirrorSettlement(
    previous: BudgetReservation,
    next: BudgetReservation,
  ): Promise<void> | undefined {
    if (!admission || !settledInStore(next) || settledInStore(previous)) return undefined;
    const store = admission.store;
    return mirror(
      () =>
        store.settle(next.requestId, { tokens: next.actual.tokens!, usd: next.actual.usd ?? 0 }),
      {
        requestId: next.requestId,
        // `ledger.settle(settlement)` replays exactly this transition.
        settlement: {
          requestId: next.requestId,
          ...(next.usage ? { usage: next.usage } : { tokens: next.actual.tokens! }),
          ...(next.actual.usd !== undefined ? { usd: next.actual.usd } : {}),
        },
      },
    );
  }

  function settledInStore(reservation: BudgetReservation): boolean {
    return (
      reservation.state === 'settled' ||
      (reservation.reservation.usd === undefined && reservation.actual.tokens !== undefined)
    );
  }

  function totals(scopeId?: string): BudgetTotals {
    const spent = { tokens: 0, usd: 0 };
    const reserved = { tokens: 0, usd: 0 };
    let unknownTokens = 0;
    let unknownUsd = 0;
    let unpriced = 0;
    for (const item of entries.values()) {
      if (
        item.state === 'released' ||
        (scopeId !== undefined && !item.scopes.some((scope) => scope.id === scopeId))
      )
        continue;
      for (const dimension of dimensions) {
        const value = item.actual[dimension];
        if (value !== undefined) spent[dimension] += value;
        else {
          reserved[dimension] += item.reservation[dimension] ?? 0;
          if (dimension === 'tokens') unknownTokens++;
          else unknownUsd++;
        }
      }
      if (unpricedUsd(item)) unpriced++;
    }
    for (const item of aggregates.values()) {
      if (!inScope(item.scopes, scopeId)) continue;
      for (const dimension of dimensions) {
        spent[dimension] += item.spent[dimension];
        reserved[dimension] += item.held[dimension];
      }
      unknownTokens += item.unknownTokens;
      unknownUsd += item.unknownUsd;
      unpriced += item.unpricedUsd ?? 0;
    }
    return Object.freeze({
      spent: Object.freeze(spent),
      reserved: Object.freeze(reserved),
      committed: Object.freeze({
        tokens: spent.tokens + reserved.tokens,
        usd: spent.usd + reserved.usd,
      }),
      unknownTokens,
      unknownUsd,
      ...(unpriced ? { unpriced } : {}),
    });
  }

  function enqueue<T>(operation: () => T | Promise<T>): Promise<T> {
    if (invokingPersistence) {
      throw new BudgetLedgerError(
        'persistence_failed',
        'Persistence callbacks must not mutate their ledger.',
      );
    }
    const result = queue.then(() => {
      if (persistenceFailure) throw persistenceFailure;
      return operation();
    });
    queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  function required(requestId: string): BudgetReservation {
    const existing = entries.get(requestId);
    if (!existing)
      throw new BudgetLedgerError('unknown_request', `Unknown request ID: ${requestId}.`);
    return existing;
  }

  async function save(next: BudgetReservation): Promise<BudgetReservation> {
    if (!same(entries.get(next.requestId), next)) {
      entries.set(next.requestId, next);
      revision++;
    }
    // Idempotent recovery still awaits persistence before a caller proceeds.
    await persistSnapshot();
    return next;
  }

  async function persistSnapshot(): Promise<void> {
    try {
      const saved = snapshot();
      for (const sink of [...persistenceSinks]) {
        let write: void | Promise<void>;
        invokingPersistence = true;
        try {
          write = sink.write(saved);
        } finally {
          invokingPersistence = false;
        }
        await write;
      }
    } catch (error) {
      persistenceFailure = new BudgetLedgerError(
        'persistence_failed',
        'Budget ledger persistence failed; recover a new ledger from durable state before continuing.',
        error,
      );
      throw persistenceFailure;
    }
  }

  function admit(candidate: BudgetReservation, cap: BudgetLimits, scopeId?: string): void {
    const current = totals(scopeId);
    for (const dimension of dimensions) {
      const maximum = cap[dimension];
      if (maximum === undefined) continue;
      let estimate = candidate.reservation[dimension];
      if (dimension === 'usd' && estimate === undefined && candidate.unpriced) {
        // Decision 4 (2.3): a model with no price adds nothing to the USD total
        // (the run warns) unless this bound refuses unpriced models.
        if (cap.unknownPrice === 'reject')
          throw new BudgetLedgerError(
            'unpriced_model',
            `${candidate.modelId} has no price, so the usd budget${scopeId ? ` of ${scopeId}` : ''} cannot admit it (unknownPrice: 'reject').`,
          );
        estimate = 0;
      }
      const unreserved =
        [...entries.values()].some(
          (item) =>
            item.state !== 'released' &&
            inScope(item.scopes, scopeId) &&
            item.actual[dimension] === undefined &&
            item.reservation[dimension] === undefined &&
            !(dimension === 'usd' && unpricedUsd(item)),
        ) ||
        [...aggregates.values()].some(
          (item) =>
            inScope(item.scopes, scopeId) &&
            (dimension === 'tokens'
              ? item.unestimatedTokens
              : item.unestimatedUsd - (item.unpricedUsd ?? 0)) > 0,
        );
      if (estimate === undefined || unreserved) {
        throw new BudgetLedgerError(
          'missing_reservation',
          `Known ${dimension} reservations are required for bounded admission${scopeId ? ` in ${scopeId}` : ''}.`,
        );
      }
      if (current.committed[dimension] + estimate > maximum) {
        throw new BudgetLedgerError(
          'budget_exceeded',
          `${dimension} budget exceeded${scopeId ? ` in ${scopeId}` : ''}.`,
        );
      }
    }
  }

  function applySettlement(input: BudgetSettlement): BudgetReservation {
    const current = required(input.requestId);
    if (current.state === 'released')
      throw new BudgetLedgerError(
        'reservation_conflict',
        `Released request cannot be settled: ${input.requestId}.`,
      );
    const usage = input.usage === undefined ? undefined : copyUsage(input.usage);
    const incoming = limits({ tokens: input.tokens ?? usage?.totalTokens, usd: input.usd });
    if (usage && input.tokens !== undefined && input.tokens !== usage.totalTokens) {
      throw new BudgetLedgerError('reservation_conflict', 'Settlement tokens disagree with usage.');
    }
    if (usage && current.usage && !same(usage, current.usage)) {
      throw new BudgetLedgerError(
        'reservation_conflict',
        `Conflicting usage for ${input.requestId}.`,
      );
    }
    for (const dimension of dimensions) {
      if (
        current.actual[dimension] !== undefined &&
        incoming[dimension] !== undefined &&
        current.actual[dimension] !== incoming[dimension]
      ) {
        throw new BudgetLedgerError(
          'reservation_conflict',
          `Conflicting ${dimension} settlement for ${input.requestId}.`,
        );
      }
    }
    const actual = limits({
      tokens: current.actual.tokens ?? incoming.tokens,
      usd: current.actual.usd ?? incoming.usd,
    });
    return record({
      ...current,
      actual,
      state: actual.tokens !== undefined && actual.usd !== undefined ? 'settled' : 'unknown',
      ...(usage ? { usage } : {}),
    });
  }

  /** See `adoptReservation`: `reserve` without this ledger's own admission. */
  function adopt(input: BudgetReservationInput): Promise<BudgetReservation> {
    const candidate = reservationOf(input);
    return enqueue(async () => {
      const existing = entries.get(candidate.requestId);
      if (existing) {
        if (!sameReservation(existing, candidate)) throw conflicting(candidate.requestId);
        return save(existing);
      }
      if (admission) {
        try {
          // Not strict: this ledger's unknownPrice policy is local admission too.
          await admitPersistent(candidate, false);
        } catch (error) {
          // The store's own record of this request has other amounts or scope limits.
          const cause = error instanceof BudgetLedgerError ? error.cause : undefined;
          if ((cause as { code?: unknown } | undefined)?.code === 'reservation_conflict')
            throw new BudgetLedgerError(
              'reservation_conflict',
              `The persistent budget store records ${candidate.requestId} with other amounts or scope limits.`,
              cause,
            );
          throw error;
        }
      }
      return save(candidate);
    });
  }

  const ledger: BudgetLedger = {
    budget,
    addPersistence(persist) {
      if (persistenceFailure) throw persistenceFailure;
      if (invokingPersistence)
        throw new BudgetLedgerError(
          'persistence_failed',
          'Persistence callbacks must not mutate their ledger.',
        );
      if (typeof persist !== 'function')
        throw new BudgetLedgerError('invalid_budget', 'Persistence sink must be a function.');
      const sink = { write: persist };
      persistenceSinks.add(sink);
      return () => {
        persistenceSinks.delete(sink);
      };
    },
    reserve(input) {
      // Copy before queueing so caller mutation cannot change admission.
      const candidate = reservationOf(input);
      return enqueue(async () => {
        const existing = entries.get(candidate.requestId);
        if (existing) {
          if (!sameReservation(existing, candidate)) throw conflicting(candidate.requestId);
          return save(existing);
        }
        admit(candidate, budget);
        // A persistent scope refuses an unpriced model when any budget of the run does.
        let strict = budget.unknownPrice === 'reject';
        for (const scope of candidate.scopes) {
          let effective = scope.budget;
          for (const existing of [...entries.values(), ...aggregates.values()]) {
            const previous = existing.scopes.find((item) => item.id === scope.id);
            if (previous) effective = intersectBudgetLimits(effective, previous.budget);
          }
          admit(candidate, effective, scope.id);
          if (effective.unknownPrice === 'reject') strict = true;
        }
        if (admission) await admitPersistent(candidate, strict);
        return save(candidate);
      });
    },
    settle(input) {
      const copied = { ...input, ...(input.usage ? { usage: copyUsage(input.usage) } : {}) };
      return enqueue(() => {
        const next = applySettlement(copied);
        const mirrored = mirrorSettlement(required(copied.requestId), next);
        return mirrored ? mirrored.then(() => save(next)) : save(next);
      });
    },
    settleUsage(requestId: string, usage: Usage, priceProvider?: PriceProvider) {
      const copied = copyUsage(usage);
      return enqueue(async () => {
        const existing = required(requestId);
        // Validate before consulting an external price source.
        const partial = applySettlement({ requestId, usage: copied });
        let usd = existing.actual.usd;
        let unpriced = existing.unpriced === true;
        if (usd === undefined && priceProvider) {
          try {
            const priced = (await priceProvider.priceUsage(existing.modelId, copied)) ?? undefined;
            if (priced === undefined) {
              // No price (2.3): a USD estimate held for the call becomes its charge,
              // which closes the hold; without one its cost stays out of every total.
              unpriced = true;
              usd = existing.reservation.usd;
            } else {
              amount(priced, 'priced USD');
              usd = priced;
              unpriced = false;
            }
          } catch {
            // A billing outage is not evidence of zero cost. Preserve the hold.
          }
        }
        const settled =
          usd === undefined ? partial : applySettlement({ requestId, usage: copied, usd });
        const next =
          (settled.unpriced === true) === unpriced
            ? settled
            : record({ ...settled, unpriced: unpriced ? true : undefined });
        const mirrored = mirrorSettlement(existing, next);
        if (mirrored) await mirrored;
        return save(next);
      });
    },
    markUnknown(requestId) {
      return enqueue(() => {
        const current = required(requestId);
        return save(
          current.state === 'reserved' ? record({ ...current, state: 'unknown' }) : current,
        );
      });
    },
    release(requestId) {
      return enqueue(() => {
        const current = required(requestId);
        if ((current.actual.tokens ?? 0) > 0 || (current.actual.usd ?? 0) > 0) {
          throw new BudgetLedgerError(
            'reservation_conflict',
            `Billed request cannot be released: ${requestId}.`,
          );
        }
        const released = () =>
          save(record({ ...current, state: 'released', actual: {}, usage: undefined }));
        if (!admission || current.state === 'released') return released();
        const store = admission.store;
        return mirror(() => store.release(requestId), { requestId }).then(released);
      });
    },
    get: (requestId) => entries.get(requestId),
    totals,
    compact(scopeId) {
      identifier(scopeId, 'scopeId');
      return enqueue(async (): Promise<BudgetCompaction> => {
        let folded = 0;
        let dropped = 0;
        let retained = 0;
        const removed: string[] = [];
        const changed = new Map<string, BudgetAggregate>();
        for (const item of entries.values()) {
          const index = item.scopes.findIndex((scope) => scope.id === scopeId);
          if (index < 0) continue;
          // An in-flight attempt may still settle; it stays until it does.
          if (item.state === 'reserved') {
            retained++;
            continue;
          }
          const ancestors = item.scopes.slice(0, index);
          const key = chainKey(ancestors);
          const previous = changed.get(key) ?? aggregates.get(key);
          if (item.state === 'released') {
            dropped++;
            // A released attempt never counts, but its ancestor budgets still tighten admission.
            if (ancestors.length) changed.set(key, fold(previous, ancestors));
          } else {
            folded++;
            changed.set(key, fold(previous, ancestors, item));
          }
          removed.push(item.requestId);
        }
        const result = Object.freeze({ scopeId, folded, dropped, retained });
        if (!removed.length) return result;
        for (const requestId of removed) entries.delete(requestId);
        for (const [key, value] of changed) aggregates.set(key, value);
        revision++;
        await persistSnapshot();
        return result;
      });
    },
    snapshot,
  };
  internals.set(ledger, { adopt });
  return Object.freeze(ledger);
}

export type {
  BudgetAdmission,
  BudgetAdmissionRestore,
  BudgetAggregate,
  BudgetAmounts,
  BudgetCompaction,
  BudgetLedger,
  BudgetLedgerOptions,
  BudgetLedgerSnapshot,
  BudgetLimits,
  BudgetReservation,
  BudgetReservationInput,
  BudgetScope,
  BudgetSettlement,
  BudgetTotals,
  BudgetWarning,
  UnknownPricePolicy,
} from './types/execution';
