import type { PriceProvider } from './types/deps';
import type {
  BudgetAggregate,
  BudgetCompaction,
  BudgetLedger,
  BudgetLedgerOptions,
  BudgetLedgerSnapshot,
  BudgetLimits,
  BudgetReservation,
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
  | 'persistence_failed';

export class BudgetLedgerError extends Error {
  readonly name = 'BudgetLedgerError';
  readonly fatalExecution = true;

  constructor(
    readonly code: BudgetLedgerErrorCode,
    message: string,
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause });
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

function limits(value: BudgetLimits = {}): BudgetLimits {
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

/** Omitted child limits inherit; supplied limits can only tighten the parent. */
export function intersectBudgetLimits(
  parent: BudgetLimits = {},
  child: BudgetLimits = {},
): BudgetLimits {
  const a = limits(parent);
  const b = limits(child);
  const min = (left: number | undefined, right: number | undefined) =>
    left === undefined ? right : right === undefined ? left : Math.min(left, right);
  return limits({ tokens: min(a.tokens, b.tokens), usd: min(a.usd, b.usd) });
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
  const actual = limits(input.actual);
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
    reservation: limits(input.reservation),
    actual,
    scopes: copyScopes(input.scopes),
    state: input.state,
    ...(usage ? { usage } : {}),
  });
}

function count(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new BudgetLedgerError('invalid_snapshot', `${label} must be a nonnegative safe integer.`);
  return value;
}

function known(value: BudgetLimits, label: string): Required<BudgetLimits> {
  const copy = limits(value);
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
  if (
    unknownTokens > folded ||
    unknownUsd > folded ||
    unestimatedTokens > unknownTokens ||
    unestimatedUsd > unknownUsd
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
    subtree: scopeId,
  });
}

function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
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
        (restored.aggregates !== undefined || restored.subtree !== undefined)))
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
      version: folded.length ? 2 : 1,
      revision,
      budget,
      reservations: Object.freeze([...entries.values()]),
      ...(folded.length ? { aggregates: Object.freeze(folded) } : {}),
    });
  }

  function totals(scopeId?: string): BudgetTotals {
    const spent = { tokens: 0, usd: 0 };
    const reserved = { tokens: 0, usd: 0 };
    let unknownTokens = 0;
    let unknownUsd = 0;
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
    }
    for (const item of aggregates.values()) {
      if (!inScope(item.scopes, scopeId)) continue;
      for (const dimension of dimensions) {
        spent[dimension] += item.spent[dimension];
        reserved[dimension] += item.held[dimension];
      }
      unknownTokens += item.unknownTokens;
      unknownUsd += item.unknownUsd;
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
      const estimate = candidate.reservation[dimension];
      const unreserved =
        [...entries.values()].some(
          (item) =>
            item.state !== 'released' &&
            inScope(item.scopes, scopeId) &&
            item.actual[dimension] === undefined &&
            item.reservation[dimension] === undefined,
        ) ||
        [...aggregates.values()].some(
          (item) =>
            inScope(item.scopes, scopeId) &&
            (dimension === 'tokens' ? item.unestimatedTokens : item.unestimatedUsd) > 0,
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
      const candidate = record({
        requestId: input.requestId,
        modelId: input.modelId,
        kind: input.kind ?? 'model',
        reservation: limits(input),
        actual: {},
        scopes: input.scopes ?? [],
        state: 'reserved',
      });
      return enqueue(async () => {
        const existing = entries.get(candidate.requestId);
        if (existing) {
          if (
            existing.modelId !== candidate.modelId ||
            existing.kind !== candidate.kind ||
            !same(existing.reservation, candidate.reservation) ||
            !same(existing.scopes, candidate.scopes)
          ) {
            throw new BudgetLedgerError(
              'reservation_conflict',
              `Conflicting reservation for ${candidate.requestId}.`,
            );
          }
          return save(existing);
        }
        admit(candidate, budget);
        for (const scope of candidate.scopes) {
          let effective = scope.budget;
          for (const existing of [...entries.values(), ...aggregates.values()]) {
            const previous = existing.scopes.find((item) => item.id === scope.id);
            if (previous) effective = intersectBudgetLimits(effective, previous.budget);
          }
          admit(candidate, effective, scope.id);
        }
        return save(candidate);
      });
    },
    settle(input) {
      const copied = { ...input, ...(input.usage ? { usage: copyUsage(input.usage) } : {}) };
      return enqueue(() => save(applySettlement(copied)));
    },
    settleUsage(requestId: string, usage: Usage, priceProvider?: PriceProvider) {
      const copied = copyUsage(usage);
      return enqueue(async () => {
        const existing = required(requestId);
        // Validate before consulting an external price source.
        const partial = applySettlement({ requestId, usage: copied });
        let usd = existing.actual.usd;
        if (usd === undefined && priceProvider) {
          try {
            const priced = await priceProvider.priceUsage(existing.modelId, copied);
            amount(priced, 'priced USD');
            usd = priced;
          } catch {
            // A billing outage is not evidence of zero cost. Preserve the hold.
          }
        }
        return save(
          usd === undefined ? partial : applySettlement({ requestId, usage: copied, usd }),
        );
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
        return save(record({ ...current, state: 'released', actual: {}, usage: undefined }));
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
  return Object.freeze(ledger);
}

export type {
  BudgetAggregate,
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
