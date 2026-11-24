/**
 * The persistent budget behind `deuz meter` and `deuz acp`: open the store
 * (SQLite when `--store` names a file, else in memory), check the key once at
 * startup, and report what is left.
 */
import { mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import type { BudgetStore, PersistentBudgetScope } from '@deuz-sdk/core/agent';
import { resolvePath, type CliBudget } from './args';
import { DeuzCliError, describeError } from './errors';

/** An open budget: the store, the one scope every request is admitted against, and how to close it. */
export interface OpenBudget {
  readonly budget: CliBudget;
  readonly store: BudgetStore;
  readonly scopes: readonly PersistentBudgetScope[];
  /** The resolved SQLite path, or `undefined` for an in-memory store. */
  readonly path: string | undefined;
  /** What is left now, as text (`$4.95 of $5.00 left`), with `exhausted` when nothing is. */
  remaining(): Promise<{ text: string; exhausted: boolean }>;
  close(): Promise<void>;
}

/**
 * Open the store and probe the key: a zero reservation, released at once,
 * which fails fast when the key was created with another window.
 *
 * @throws DeuzCliError `store_unavailable` when the store cannot be opened,
 *   `budget_conflict` on a window conflict.
 */
export async function openBudget(
  budget: CliBudget,
  cwd: string,
  clock: () => number = Date.now,
): Promise<OpenBudget> {
  let store: BudgetStore & { close?(): Promise<void> };
  let path: string | undefined;
  if (budget.store !== undefined) {
    path = resolvePath(cwd, budget.store);
    try {
      mkdirSync(dirname(path), { recursive: true });
      const { createSqliteBudgetStore } = await import('@deuz-sdk/core/ops/sqlite');
      store = createSqliteBudgetStore({ path });
    } catch (error) {
      throw new DeuzCliError(
        'store_unavailable',
        `cannot open the budget store ${path}: ${describeError(error)} (SQLite needs Node 22.13 or later).`,
        { cause: error },
      );
    }
  } else {
    const { createInMemoryBudgetStore } = await import('@deuz-sdk/core/agent');
    store = createInMemoryBudgetStore();
  }

  const scope: PersistentBudgetScope = {
    key: budget.key,
    limits: {
      ...(budget.usd !== undefined ? { usd: budget.usd } : {}),
      ...(budget.tokens !== undefined ? { tokens: budget.tokens } : {}),
    },
    ...(budget.window.ms !== null ? { window: { ms: budget.window.ms } } : {}),
  };
  const scopes = [scope];

  const probeId = `deuz-cli:probe:${randomUUID()}`;
  try {
    await store.reserve({
      requestId: probeId,
      modelId: 'deuz-cli-probe',
      tokens: 0,
      usd: 0,
      scopes,
    });
    await store.release(probeId);
  } catch (error) {
    await store.close?.().catch(() => {});
    if ((error as { code?: string }).code === 'window_conflict') {
      throw new DeuzCliError(
        'budget_conflict',
        `budget key '${budget.key}' already exists with a different window; pass the window it was created with, or a new --key.`,
        { cause: error },
      );
    }
    throw new DeuzCliError(
      'store_unavailable',
      `the budget store failed: ${describeError(error)}`,
      {
        cause: error,
      },
    );
  }

  return {
    budget,
    store,
    scopes,
    path,
    async remaining() {
      const since = budget.window.ms !== null ? clock() - budget.window.ms : undefined;
      const used = await store.usage(budget.key, since !== undefined ? { since } : {});
      const parts: string[] = [];
      let exhausted = false;
      if (budget.usd !== undefined) {
        const left = Math.max(0, budget.usd - used.usd);
        if (left <= 0) exhausted = true;
        parts.push(`${formatUsd(left)} of ${formatUsd(budget.usd)}`);
      }
      if (budget.tokens !== undefined) {
        const left = Math.max(0, budget.tokens - used.tokens);
        if (left <= 0) exhausted = true;
        parts.push(`${formatInt(left)} of ${formatInt(budget.tokens)} tokens`);
      }
      return { text: `${parts.join(' and ')} left`, exhausted };
    },
    async close() {
      await store.close?.();
    },
  };
}

/** A one-line description of a budget: `$5.00 + 1,000,000 tokens (lifetime, key deuz:meter, in memory)`. */
export function describeBudget(open: OpenBudget): string {
  const { budget } = open;
  const ceiling = [
    budget.usd !== undefined ? formatUsd(budget.usd) : undefined,
    budget.tokens !== undefined ? `${formatInt(budget.tokens)} tokens` : undefined,
  ]
    .filter(Boolean)
    .join(' + ');
  const window = budget.window.ms === null ? 'lifetime' : `rolling ${budget.window.label}`;
  const where = open.path ? `stored in ${open.path}` : 'in memory, gone when this process exits';
  return `${ceiling} (${window}, key ${budget.key}, ${where})`;
}

/** USD for display: cents at or above a dollar, four decimals below. */
export function formatUsd(amount: number): string {
  return amount >= 1 || amount === 0 ? `$${amount.toFixed(2)}` : `$${amount.toFixed(4)}`;
}

/** An integer with thousands separators. */
export function formatInt(n: number): string {
  return Math.round(n).toLocaleString('en-US');
}
