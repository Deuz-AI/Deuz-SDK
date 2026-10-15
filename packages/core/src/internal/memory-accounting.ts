/**
 * internal/memory-accounting.ts (2.4, spec §3.1) — one memory helper call
 * (the memory LLM, the memory embedder) charged to an execution context's
 * ledger. The call is reserved first, at a conservative token estimate, so a
 * budget can refuse it before it runs; afterwards an accounted callback
 * (`accounted: true`) settles the usage it reported, and an unmarked one is
 * reserved `unaccounted` and left `unknown` (its estimate stays held: never
 * free) with one `unaccounted-usage` warning. A call that throws is marked
 * unknown too, since it may have been billed.
 *
 * Host callbacks name their model only in their answer, so the reservation
 * names `'memory-llm'` or `'memory-embedder'` (as the versioned memory session
 * does by default) and is unpriced: tokens are accounted, USD is not. Loaded
 * lazily by `memory.ts`, only when `seams.execution` is set, so the 2.3 path
 * carries none of this. Edge-safe.
 */
import type { AccountedUsage } from '../types/accounting';
import type { NativeExecutionContext } from '../types/execution';
import type { CallWarning } from '../types/methods';
import { isAccounted } from './accounting';
import { createTokenEstimator } from './estimate-tokens';

/** The two kinds of memory helper call: the reservation's `kind`. */
export type MemoryCallKind = 'memory-llm' | 'memory-embedding';

/** The model a reservation names for each kind: a host callback names its own only afterwards. */
const RESERVED_MODEL: Readonly<Record<MemoryCallKind, string>> = {
  'memory-llm': 'memory-llm',
  'memory-embedding': 'memory-embedder',
};

/** Output tokens held for a memory LLM answer on top of its prompt. */
const LLM_OUTPUT_ALLOWANCE = 1024;

export interface ChargedMemoryCall<T> {
  execution: NativeExecutionContext;
  /** Unique per call; scoped under the context: `<scopeId>/memory/<id>`. */
  id: string;
  kind: MemoryCallKind;
  /** The callback (or embedder object) the call goes to: its mark decides accounted or not. */
  callback: unknown;
  /** The text the call sends, for the estimate. */
  input: readonly string[];
  /** The context's clock, for a deadline policy. */
  now: number;
  run: () => Promise<T>;
  /** The usage an accounted answer carries. */
  usageOf: (answer: T) => AccountedUsage | undefined;
  warn: (warning: CallWarning) => void;
}

/** The `unaccounted-usage` warning: one text per call kind, so a sink keeps one. */
export function unaccountedWarning(kind: MemoryCallKind): CallWarning {
  const what = kind === 'memory-llm' ? 'memory LLM callback' : 'memory embedder';
  return {
    type: 'unaccounted-usage',
    message:
      `The ${what} reports no usage, so its calls are counted as unaccounted, never as free. ` +
      (kind === 'memory-llm'
        ? 'Wrap it with defineAccountedMemoryLLM and pass it as the seams `accountedLlm`, not `llm`, to have them settled.'
        : 'Give it `accounted: true` and return the usage with the vectors to have them settled.'),
  };
}

export async function chargeMemoryCall<T>(call: ChargedMemoryCall<T>): Promise<T> {
  const { execution, kind } = call;
  const requestId = `${execution.scopeId}/memory/${call.id}`;
  const accounted = isAccounted(call.callback);
  const estimate = createTokenEstimator().estimate(
    call.input.map((text) => ({ role: 'user' as const, content: text })),
  );
  await execution.reserve({
    requestId,
    modelId: RESERVED_MODEL[kind],
    kind,
    tokens: estimate + (kind === 'memory-llm' ? LLM_OUTPUT_ALLOWANCE : 0),
    now: call.now,
    unpriced: true,
    ...(accounted ? {} : { unaccounted: true }),
  });
  let answer: T;
  try {
    answer = await call.run();
  } catch (error) {
    // It may have been billed: keep the estimate held.
    await execution.ledger.markUnknown(requestId).catch(() => undefined);
    throw error;
  }
  const reported = accounted ? call.usageOf(answer) : undefined;
  if (reported) await execution.ledger.settleUsage(requestId, reported.usage);
  else {
    await execution.ledger.markUnknown(requestId);
    call.warn(unaccountedWarning(kind));
  }
  return answer;
}
