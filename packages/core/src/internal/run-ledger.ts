/**
 * Execution ledgers that one run owns for its whole life (2.3, decision 4),
 * such as a swarm's or an `evolve` run's: their tasks' model calls report an
 * unpriced model once in all. Any other ledger may be shared by many runs, so
 * each run reports it once. Edge-safe; kept apart from the lazy pricing code so
 * the runners that mark a ledger do not pull it in.
 */

/** Models already reported per run ledger. */
const runLedgers = new WeakMap<object, Set<string>>();

/** Mark `ledger` as owned by one run. */
export function markRunLedger(ledger: object): void {
  if (!runLedgers.has(ledger)) runLedgers.set(ledger, new Set());
}

/** False when `ledger` is a run ledger that already reported `modelId`; true otherwise, recording it. */
export function firstRunReport(ledger: object, modelId: string): boolean {
  const models = runLedgers.get(ledger);
  if (!models) return true;
  if (models.has(modelId)) return false;
  models.add(modelId);
  return true;
}
