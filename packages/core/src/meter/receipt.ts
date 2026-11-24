/**
 * deuz meter (2.5): receipts for costs nobody measured on the wire. An agent
 * that reports its own usage (over ACP, a headless run, a sub-agent) records
 * it in the meter's receipt shape with `source: 'declared'`, so measured and
 * declared spend land in the same sinks and the same reports. Edge-safe.
 */
import { resolveDependencies } from '../internal/resolve-deps';
import type { Clock, PriceProvider } from '../types/deps';
import type { Usage } from '../types/usage';
import { MeterError } from './errors';
import type { MeterOutcome, MeterReceipt, MeterSettlement } from './types';

/** What an agent declares about one call or turn. */
export interface DeclaredReceiptInput {
  /** The label receipts carry, e.g. `anthropic` or `acp:zed`. */
  readonly provider: string;
  readonly model?: string;
  /** What was declared, e.g. `acp:session/prompt`. Never a URL with a query string. */
  readonly route: string;
  readonly usage?: Usage;
  /** USD as declared. Omitted, it is priced from `usage` when a `priceProvider` is given. */
  readonly usd?: number;
  /** Default: now on the clock. */
  readonly startedAt?: number;
  /** Default: `startedAt`. */
  readonly endedAt?: number;
  /** Default: a new ID, `declared:<id>`. */
  readonly requestId?: string;
  /** Default `'completed'`. */
  readonly outcome?: MeterOutcome;
  /** Default `'none'`: a declared cost charges no budget unless the caller did so. */
  readonly settlement?: MeterSettlement;
  /** What the caller charged to its budget, when it did. */
  readonly charged?: { readonly tokens: number; readonly usd: number };
  readonly budgetKeys?: readonly string[];
  readonly stream?: boolean;
}

/** Dependencies of `declaredReceipt`. */
export interface DeclaredReceiptOptions {
  readonly priceProvider?: PriceProvider;
  readonly clock?: Clock;
  readonly generateId?: () => string;
}

const amount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0;

/**
 * Build a `source: 'declared'` receipt (2.5). Nothing checks a declared
 * amount against the wire; keep the label so reports can tell it from a
 * measured one. Throws `MeterError` for a negative or non-finite amount.
 */
export async function declaredReceipt(
  input: DeclaredReceiptInput,
  options: DeclaredReceiptOptions = {},
): Promise<MeterReceipt> {
  if (input === null || typeof input !== 'object')
    throw new MeterError('invalid_options', 'A declared receipt needs an input object.');
  if (typeof input.provider !== 'string' || input.provider === '')
    throw new MeterError('invalid_options', 'A declared receipt needs a provider.');
  if (typeof input.route !== 'string' || input.route === '')
    throw new MeterError('invalid_options', 'A declared receipt needs a route.');
  if (input.usd !== undefined && !amount(input.usd))
    throw new MeterError('invalid_options', 'A declared usd must be a finite nonnegative number.');
  if (input.charged && !(amount(input.charged.tokens) && amount(input.charged.usd)))
    throw new MeterError('invalid_options', 'A declared charge must hold nonnegative amounts.');
  const deps = resolveDependencies({
    ...(options.clock ? { clock: options.clock } : {}),
    ...(options.generateId ? { generateId: options.generateId } : {}),
  });
  const id = deps.generateId();
  const startedAt = input.startedAt ?? deps.clock.now();
  const endedAt = input.endedAt ?? startedAt;
  let usd = input.usd;
  if (usd === undefined && input.usage && input.model && options.priceProvider) {
    const priced = await options.priceProvider.priceUsage(input.model, input.usage);
    if (amount(priced)) usd = priced;
  }
  return {
    version: 1,
    id,
    requestId: input.requestId ?? `declared:${id}`,
    source: 'declared',
    startedAt,
    endedAt,
    durationMs: Math.max(0, endedAt - startedAt),
    provider: input.provider,
    ...(input.model !== undefined ? { model: input.model } : {}),
    route: input.route,
    outcome: input.outcome ?? 'completed',
    stream: input.stream ?? false,
    ...(input.usage ? { usage: input.usage } : {}),
    usageComplete: input.usage !== undefined,
    ...(usd !== undefined ? { usd } : {}),
    settlement: input.settlement ?? 'none',
    ...(input.charged ? { charged: input.charged } : {}),
    budgetKeys: input.budgetKeys ?? [],
    priced: usd !== undefined,
  };
}
