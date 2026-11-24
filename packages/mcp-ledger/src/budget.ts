/**
 * The spend ledger: reported spend goes into a Deuz `BudgetStore` (the SQLite
 * one in the server) under one lifetime key, and status reads it back for the
 * configured rolling window. Keeping the history under a lifetime key means a
 * changed window or ceiling never conflicts with what was recorded before: the
 * window is applied when reading, not when writing.
 *
 * This is a record, not a gate. A spend is always recorded, even past the
 * ceiling (refusing to record money already spent would make the ledger
 * wrong); the status then reports `exceeded`. Nothing here can stop a model
 * that does not ask.
 */
import type { BudgetStore } from '@deuz-sdk/core/agent';
import { McpLedgerError } from './errors';
import type { LedgerWindow } from './options';

/** The budget store key every reported spend is charged to. */
export const SPEND_KEY = 'mcp-ledger:spend';

/** A configured ceiling. Either dimension may be absent; with neither, status only reports spend. */
export interface LedgerBudgetConfig {
  usd?: number;
  tokens?: number;
  /** Default: a rolling 30 days (`month`). */
  window: LedgerWindow;
  /** Status turns `warning` at this share of a ceiling. Default 80. */
  warnAtPercent?: number;
}

/** A spend to record. */
export interface SpendInput {
  /** What was spent, in US dollars. */
  usd: number;
  /** Tokens used, when known. Default 0. */
  tokens?: number;
  /** The model it was spent on. Default `'unspecified'`. */
  model?: string;
  /** Idempotency key: the same id with the same amounts counts once. Generated when absent. */
  id?: string;
}

/** Amounts in one window. */
export interface SpendAmounts {
  usd: number;
  tokens: number;
}

/** Where the budget stands. */
export interface BudgetStatus {
  /** `'30d'`, `'7d'`, `'lifetime'`, ... */
  window: string;
  /** ISO time the window starts at; absent for `lifetime`. */
  windowStart?: string;
  /** Spent inside the window. */
  spent: SpendAmounts;
  /** The ceiling; absent when none is configured. */
  ceiling?: { usd?: number; tokens?: number };
  /** What is left of each bounded dimension, never below 0. */
  remaining?: { usd?: number; tokens?: number };
  /** The highest share of any ceiling used, in percent (1 decimal). */
  percentUsed?: number;
  /** `no_ceiling`, `ok`, `warning` (past `warnAtPercent`) or `exceeded` (nothing left). */
  state: 'no_ceiling' | 'ok' | 'warning' | 'exceeded';
  /** Spent inside the window, per reported model. */
  byModel: Record<string, SpendAmounts>;
  /** Spent since the ledger began. */
  lifetime: SpendAmounts;
  /** Only when an estimate was passed: whether it fits what is left. */
  fits?: boolean;
  /** Always `'advisory'`: the ledger records, it does not block. */
  enforcement: 'advisory';
}

/** The budget half of the ledger. */
export interface LedgerBudget {
  readonly config: LedgerBudgetConfig;
  /** Where the budget stands; with `estimate`, also whether it fits. */
  status(estimate?: { usd?: number; tokens?: number }): Promise<BudgetStatus>;
  /**
   * Record spend. Always recorded, also past the ceiling.
   *
   * @throws McpLedgerError `invalid_argument` for a negative or non-finite amount
   *   or `usd` above 1 000 000 000,
   *   `spend_conflict` when the id was recorded with other amounts.
   */
  record(input: SpendInput): Promise<{ id: string; status: BudgetStatus }>;
}

const roundUsd = (usd: number): number => Math.round(usd * 1e6) / 1e6;

/**
 * The largest single spend `record` accepts, in USD. Anything larger is a
 * mistake, and an amount near `Number.MAX_VALUE` would turn the lifetime
 * totals (and every later status) into `Infinity`.
 */
const MAX_SPEND_USD = 1_000_000_000;
const round1 = (n: number): number => Math.round(n * 10) / 10;

function nonnegative(
  value: unknown,
  label: string,
  integer: boolean,
  max = Number.MAX_VALUE,
): number | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > max ||
    (integer && !Number.isSafeInteger(value))
  ) {
    throw new McpLedgerError(
      'invalid_argument',
      `${label} must be a finite nonnegative ${integer ? 'integer' : 'number'}${max < Number.MAX_VALUE ? ` up to ${max}` : ''}.`,
    );
  }
  return value;
}

/** @internal Build the spend ledger over a budget store. */
export function createLedgerBudget(deps: {
  store: BudgetStore;
  config: LedgerBudgetConfig;
  now: () => number;
  generateId: () => string;
}): LedgerBudget {
  const { store, config, now, generateId } = deps;
  const warnAt = config.warnAtPercent ?? 80;
  const hasCeiling = config.usd !== undefined || config.tokens !== undefined;

  const amounts = (usage: { usd: number; tokens: number }): SpendAmounts => ({
    usd: roundUsd(usage.usd),
    tokens: usage.tokens,
  });

  async function status(estimate?: { usd?: number; tokens?: number }): Promise<BudgetStatus> {
    const estimateUsd = nonnegative(estimate?.usd, 'estimateUsd', false) ?? 0;
    const estimateTokens = nonnegative(estimate?.tokens, 'estimateTokens', true) ?? 0;
    const at = now();
    const since = config.window.ms === null ? undefined : at - config.window.ms;
    const [inWindow, lifetime] = await Promise.all([
      store.usage(SPEND_KEY, { byModel: true, ...(since !== undefined ? { since } : {}) }),
      since === undefined ? undefined : store.usage(SPEND_KEY),
    ]);
    const spent = amounts(inWindow);
    const byModel: Record<string, SpendAmounts> = {};
    for (const [model, usage] of Object.entries(inWindow.byModel ?? {}))
      byModel[model] = amounts(usage);

    const result: BudgetStatus = {
      window: config.window.label,
      ...(since !== undefined ? { windowStart: new Date(since).toISOString() } : {}),
      spent,
      state: 'no_ceiling',
      byModel,
      lifetime: lifetime ? amounts(lifetime) : spent,
      enforcement: 'advisory',
    };
    if (!hasCeiling) {
      if (estimate !== undefined) result.fits = true;
      return result;
    }
    const remaining: { usd?: number; tokens?: number } = {};
    let percent = 0;
    let fits = true;
    let exhausted = false;
    if (config.usd !== undefined) {
      remaining.usd = roundUsd(Math.max(0, config.usd - spent.usd));
      percent = Math.max(
        percent,
        config.usd > 0 ? (spent.usd / config.usd) * 100 : spent.usd > 0 ? Infinity : 100,
      );
      if (roundUsd(spent.usd + estimateUsd) > config.usd) fits = false;
      if (spent.usd >= config.usd) exhausted = true;
    }
    if (config.tokens !== undefined) {
      remaining.tokens = Math.max(0, config.tokens - spent.tokens);
      percent = Math.max(
        percent,
        config.tokens > 0
          ? (spent.tokens / config.tokens) * 100
          : spent.tokens > 0
            ? Infinity
            : 100,
      );
      if (spent.tokens + estimateTokens > config.tokens) fits = false;
      if (spent.tokens >= config.tokens) exhausted = true;
    }
    result.ceiling = {
      ...(config.usd !== undefined ? { usd: config.usd } : {}),
      ...(config.tokens !== undefined ? { tokens: config.tokens } : {}),
    };
    result.remaining = remaining;
    if (Number.isFinite(percent)) result.percentUsed = round1(percent);
    result.state = exhausted ? 'exceeded' : percent >= warnAt ? 'warning' : 'ok';
    if (estimate !== undefined) result.fits = fits;
    return result;
  }

  return {
    config,
    status,
    async record(input) {
      if (input === null || typeof input !== 'object') {
        throw new McpLedgerError('invalid_argument', 'A spend must be an object.');
      }
      const usd = nonnegative(input.usd, 'usd', false, MAX_SPEND_USD);
      if (usd === undefined) throw new McpLedgerError('invalid_argument', 'A spend needs usd.');
      const tokens = nonnegative(input.tokens, 'tokens', true) ?? 0;
      const model =
        typeof input.model === 'string' && input.model.trim() ? input.model.trim() : 'unspecified';
      const id = typeof input.id === 'string' && input.id.trim() ? input.id.trim() : generateId();
      const requestId = `spend:${id}`;
      try {
        // No limits on the scope: a spend that already happened is always admitted.
        await store.reserve({
          requestId,
          modelId: model,
          tokens,
          usd,
          scopes: [{ key: SPEND_KEY, limits: {} }],
        });
        await store.settle(requestId, { tokens, usd });
      } catch (error) {
        if (error instanceof Error && error.name === 'BudgetStoreError') {
          throw new McpLedgerError(
            'spend_conflict',
            `Spend '${id}' was already recorded with different amounts or model. Use a new id for a new spend.`,
            { cause: error },
          );
        }
        throw error;
      }
      return { id, status: await status() };
    },
  };
}
