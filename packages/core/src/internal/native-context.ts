/**
 * @internal Where a context compile reports its span (2.4, spec §3.6): the
 * native loop hands the compiler the step span it compiles for, so
 * `deuz.context.compile` nests under that step and shares the run's ids. The
 * parent rides on the `ContextStepInput` object under a private,
 * non-enumerable symbol, so the public type carries no internal observation
 * runtime and a copy of the input (a spread, JSON, `structuredClone`) drops
 * it. A compile without one reports a span of its own, as before. Edge-safe.
 */
import type { TelemetryParent } from './telemetry';

const PARENT = Symbol('deuz.context.telemetry-parent');

/** Attaches `parent` to `input` (when there is one) and returns `input`. */
export function withTelemetryParent<T extends object>(input: T, parent?: TelemetryParent): T {
  if (parent)
    Object.defineProperty(input, PARENT, {
      value: parent,
      enumerable: false,
      configurable: true,
      writable: false,
    });
  return input;
}

/** The span parent the loop attached to `input`, if any. */
export function telemetryParentOf(input: object): TelemetryParent | undefined {
  return (input as Record<symbol, TelemetryParent | undefined>)[PARENT];
}
