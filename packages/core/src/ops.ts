/**
 * `@deuz-sdk/core/ops` (2.2): operational seams for durable runs. Leases decide
 * which executor drives a run; the SQLite and Postgres entries add durable
 * lease providers and native agent run stores. Since 2.3 it also finds native
 * runs that lost their executor. Edge-safe.
 */
import type { Clock } from './types/deps';
import type { Lease, LeaseProvider, LeaseRenewal, LeaseSignal } from './types/lease';
import type { AgentRunStore, AgentRunSummary } from './types/agent-run';
import { resolveDependencies } from './internal/resolve-deps';
import { assertLeaseRequest } from './internal/ops-validate';
import { assertRetentionTime } from './internal/ops-retention';

export type * from './types/lease';

const SIGNALS: readonly LeaseSignal[] = ['cancel', 'drain'];

/** For tests and single-process deployments; its leases die with the process. */
export function createInMemoryLeaseProvider(options: { clock?: Clock } = {}): LeaseProvider {
  const clock = options.clock ?? resolveDependencies().clock;
  const leases = new Map<
    string,
    { owner: string; token: number; expiresAt: number; signals: LeaseSignal[] }
  >();
  const view = (key: string, row: { owner: string; token: number; expiresAt: number }): Lease =>
    Object.freeze({ key, owner: row.owner, token: row.token, expiresAt: row.expiresAt });
  // A queued cancel concerns the run, so it outlives the holder it was sent to
  // until a renewal delivers it (2.2); a drain concerns that holder alone.
  const kept = (signals: readonly LeaseSignal[]): LeaseSignal[] =>
    signals.includes('cancel') ? ['cancel'] : [];
  return {
    async acquire({ key, owner, ttlMs }) {
      assertLeaseRequest(key, owner, ttlMs);
      const now = clock.now();
      const row = leases.get(key);
      if (row && row.expiresAt > now) return undefined;
      const next = {
        owner,
        token: (row?.token ?? 0) + 1,
        expiresAt: now + ttlMs,
        signals: kept(row?.signals ?? []),
      };
      leases.set(key, next);
      return view(key, next);
    },
    async renew(lease, ttlMs, options = {}): Promise<LeaseRenewal> {
      assertLeaseRequest(lease.key, lease.owner, ttlMs);
      const row = leases.get(lease.key);
      if (!row || row.token !== lease.token || row.owner !== lease.owner || row.expiresAt === 0)
        return { held: false };
      row.expiresAt = clock.now() + ttlMs;
      const signals = row.signals.splice(0);
      if (!options.acknowledge) return { held: true, lease: view(lease.key, row), signals };
      // Acknowledged delivery (2.3): the cancel stays queued until ack().
      row.signals = kept(signals);
      return { held: true, lease: view(lease.key, row), signals, queued: [...row.signals] };
    },
    async release(lease) {
      const row = leases.get(lease.key);
      // Keep the row so the next holder's token still increases.
      if (row && row.token === lease.token && row.owner === lease.owner) {
        row.expiresAt = 0;
        row.signals = kept(row.signals);
      }
    },
    async signal(key, signal) {
      if (!SIGNALS.includes(signal)) throw new TypeError(`Unknown lease signal: ${String(signal)}`);
      const row = leases.get(key);
      if (!row || row.expiresAt <= clock.now()) return false;
      if (!row.signals.includes(signal)) row.signals.push(signal);
      return true;
    },
    async ack(lease, signal) {
      if (signal !== 'cancel')
        throw new TypeError(`Only a cancel is acknowledged: ${String(signal)}`);
      const row = leases.get(lease.key);
      // Fenced by the token: once the key changed hands, the cancel is the new holder's.
      if (!row || row.token !== lease.token || row.owner !== lease.owner) return false;
      row.signals = row.signals.filter((queued) => queued !== 'cancel');
      return true;
    },
    async prune(before) {
      assertRetentionTime(before);
      // A key held now is never pruned, whatever the cutoff: a lease expiring
      // after now still has a holder even when it expires before `before`.
      const cutoff = Math.min(before, clock.now());
      let pruned = 0;
      for (const [key, row] of leases)
        if ((row.expiresAt === 0 || row.expiresAt < cutoff) && !row.signals.includes('cancel')) {
          leases.delete(key);
          pruned++;
        }
      return pruned;
    },
  };
}

/** Options of {@link findStaleAgentRuns} (2.3). */
export interface FindStaleAgentRunsOptions {
  /**
   * A run is stale when its last save is more than this many milliseconds
   * old. Default 60 000. A native run saves at every step, not on a
   * heartbeat, so choose it longer than your slowest model turn or tool call,
   * or resume with a run `lease`, which refuses a run whose executor lives.
   */
  staleMs?: number;
  /** Only this scope's runs. */
  scope?: string;
  /**
   * Also return runs suspended on approvals or client results. Default false:
   * those wait for a person, not for an executor.
   */
  includeSuspended?: boolean;
  /** The most runs returned, 1..1000. Default 100. */
  limit?: number;
  /** The clock the store records its saves on. Default: the host clock. */
  clock?: Clock;
}

/** How many runs one call examines at most. */
const STALE_SCAN = 10_000;

/**
 * Native runs that lost their executor (2.3): runs still running or
 * finalizing whose last save is older than `staleMs`, newest change first.
 * Resume each with `resumeAgent` and its session; with the `lease` option a
 * run another process still drives is refused instead of driven twice. Needs
 * a store with `list`, as the memory, SQLite and Postgres stores have. A call
 * examines at most 10 000 runs.
 */
export async function findStaleAgentRuns(
  store: AgentRunStore,
  options: FindStaleAgentRunsOptions = {},
): Promise<AgentRunSummary[]> {
  const staleMs = options.staleMs ?? 60_000;
  if (!Number.isFinite(staleMs) || staleMs < 0)
    throw new TypeError('staleMs must be a finite, nonnegative number of milliseconds');
  const limit = options.limit ?? 100;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000)
    throw new TypeError('limit must be an integer from 1 to 1000');
  if (typeof store?.list !== 'function')
    throw new TypeError('This agent run store cannot list runs: it has no list()');
  const updatedBefore = (options.clock ?? resolveDependencies().clock).now() - staleMs;
  const found: AgentRunSummary[] = [];
  let cursor: string | undefined;
  let scanned = 0;
  do {
    const page = await store.list({
      phases: ['running', 'finalizing'],
      updatedBefore,
      ...(options.scope !== undefined ? { scope: options.scope } : {}),
      // Suspended runs share the phase, so a page may hold fewer stale runs.
      limit: Math.min(1000, Math.max(limit, 100)),
      ...(cursor !== undefined ? { cursor } : {}),
    });
    for (const run of page.runs) {
      scanned++;
      if (run.status === 'suspended' && !options.includeSuspended) continue;
      found.push(run);
      if (found.length === limit) return found;
    }
    cursor = page.cursor;
  } while (cursor !== undefined && scanned < STALE_SCAN);
  return found;
}
