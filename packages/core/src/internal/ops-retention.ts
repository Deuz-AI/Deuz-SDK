/**
 * @internal Validation shared by the ops and swarm stores' retention methods
 * (2.3). Edge-safe.
 */

/** A retention cutoff: epoch milliseconds on the store's clock. */
export function assertRetentionTime(value: unknown, label = 'before'): number {
  if (typeof value !== 'number' || !Number.isFinite(value))
    throw new TypeError(`${label} must be a finite epoch millisecond value`);
  return value;
}
