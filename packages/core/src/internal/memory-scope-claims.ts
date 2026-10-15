/**
 * @internal The memory scopes of the native runs running now (2.3; 2.4 adds
 * the V3 run's scopes), so a nested run may only narrow its parent's (spec
 * §2.3, §4.5: the same `claimMemoryScope` / `scopeWithin` rule for the
 * legacy `memory` scope, a versioned memory session and the context
 * sources). Shared by the legacy memory module and the V3 run, both loaded on
 * demand, so a run without either never pulls it in. Edge-safe.
 */
import type { MemoryScope } from '../memory';
import type { BudgetLedger, NativeExecutionContext } from '../types/execution';
import { scopeKey, scopeWithin } from './native-scope';

/** One run's claim: every memory scope it reads or writes. */
interface ScopeClaim {
  scopes: readonly MemoryScope[];
}

/**
 * The claims of each native run that is running now, per shared ledger and
 * execution scope id. A child context's scope id extends its parent's
 * (`<parent>/<child>`), so the nearest registered prefix is the closest
 * ancestor run that has memory. Runs that share one context (a tool that hands
 * its own `ctx.execution` to a nested run) each hold their own claim under the
 * same id, innermost last.
 */
const runningScopes = new WeakMap<BudgetLedger, Map<string, ScopeClaim[]>>();

/**
 * Register a run's memory scopes for its execution, after checking each
 * against the closest run that has one: the latest run on the same execution
 * context, else the closest ancestor. Each scope must lie within one of that
 * run's scopes: a run may narrow (pin more fields), never widen or step into
 * another user, agent or chat. Returns the release, called when the run's
 * executor ends; it drops only this run's claim.
 */
export function claimMemoryScopes(
  execution: NativeExecutionContext,
  scopes: readonly (MemoryScope | undefined)[],
): () => void {
  const own: MemoryScope[] = [];
  for (const scope of scopes)
    if (scope && !own.some((other) => scopeKey(other) === scopeKey(scope))) own.push(scope);
  const running = runningScopes.get(execution.ledger);
  if (own.length > 0 && running) {
    let parent: ScopeClaim | undefined;
    let depth = -1;
    for (const [id, claims] of running) {
      if (
        (id === execution.scopeId || execution.scopeId.startsWith(`${id}/`)) &&
        id.length > depth
      ) {
        parent = claims.at(-1);
        depth = id.length;
      }
    }
    if (parent)
      for (const scope of own)
        if (!parent.scopes.some((outer) => scopeWithin(scope, outer)))
          throw new TypeError(
            `This run's memory scope ${scopeKey(scope)} widens its parent run's ${parent.scopes.map(scopeKey).join(' or ')}; a child may only narrow it.`,
          );
  }
  if (own.length === 0) return () => {};
  const map = running ?? new Map<string, ScopeClaim[]>();
  if (!running) runningScopes.set(execution.ledger, map);
  const claims = map.get(execution.scopeId) ?? [];
  map.set(execution.scopeId, claims);
  // A fresh token per run: equal scopes of two runs are still two claims.
  const claim: ScopeClaim = { scopes: own };
  claims.push(claim);
  return () => {
    const index = claims.indexOf(claim);
    if (index >= 0) claims.splice(index, 1);
    if (claims.length === 0 && map.get(execution.scopeId) === claims) map.delete(execution.scopeId);
  };
}

/** {@link claimMemoryScopes} for a run with one memory scope (the legacy `memory`), or none. */
export function claimMemoryScope(
  execution: NativeExecutionContext,
  scope: MemoryScope | undefined,
): () => void {
  return claimMemoryScopes(execution, [scope]);
}

/**
 * The scope a built-in context source was pinned to (2.4): a memory source's
 * session or store scope, a transcript source's scope. The V3 run claims it
 * like its other memory scopes; a host-written source has none.
 */
const pinnedScopes = new WeakMap<object, MemoryScope>();

/** Records the scope `source` reads within. Returns `source`. */
export function pinSourceScope<T extends object>(source: T, scope: MemoryScope): T {
  pinnedScopes.set(source, scope);
  return source;
}

/** The scope a built-in context source reads within, if it is one. */
export function sourceScope(source: object): MemoryScope | undefined {
  return pinnedScopes.get(source);
}
