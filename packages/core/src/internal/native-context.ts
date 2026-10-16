/**
 * @internal What a V3 run hands its context compiler beside the public
 * `ContextStepInput` (2.4), riding on the input object under private,
 * non-enumerable symbols, so the public type carries no internal runtime and
 * a copy of the input (a spread, JSON, `structuredClone`) drops them:
 *
 * - The step span it compiles for (spec §3.6), so `deuz.context.compile`
 *   nests under that step and shares the run's ids. A compile without one
 *   reports a span of its own, as before.
 * - The run's execution context (spec §3.1 accounting), so a source's
 *   billable call (a RAG query embedding) is charged to the run's ledger: the
 *   compiler hands each source query `accounting` on it. A compile without
 *   one charges nothing, as before.
 *
 * Edge-safe.
 */
import type { NativeExecutionContext } from '../types/execution';
import type { TelemetryParent } from './telemetry';

const PARENT = Symbol('deuz.context.telemetry-parent');
const EXECUTION = Symbol('deuz.context.execution');

function attach(input: object, key: symbol, value: unknown): void {
  Object.defineProperty(input, key, {
    value,
    enumerable: false,
    configurable: true,
    writable: false,
  });
}

/** Attaches `parent` to `input` (when there is one) and returns `input`. */
export function withTelemetryParent<T extends object>(input: T, parent?: TelemetryParent): T {
  if (parent) attach(input, PARENT, parent);
  return input;
}

/** The span parent the loop attached to `input`, if any. */
export function telemetryParentOf(input: object): TelemetryParent | undefined {
  return (input as Record<symbol, TelemetryParent | undefined>)[PARENT];
}

/** Attaches the run's `execution` to `input` (when there is one) and returns `input`. */
export function withRunExecution<T extends object>(
  input: T,
  execution?: NativeExecutionContext,
): T {
  if (execution) attach(input, EXECUTION, execution);
  return input;
}

/** The run's execution context attached to `input`, if any. */
export function runExecutionOf(input: object): NativeExecutionContext | undefined {
  return (input as Record<symbol, NativeExecutionContext | undefined>)[EXECUTION];
}
