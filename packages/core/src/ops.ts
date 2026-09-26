/**
 * `@deuz-sdk/core/ops` (2.2): operational seams for durable runs. Leases decide
 * which executor drives a run; the SQLite and Postgres entries add durable
 * lease providers and native agent run stores. Edge-safe.
 */
import type { Clock } from './types/deps';
import type { Lease, LeaseProvider, LeaseRenewal, LeaseSignal } from './types/lease';
import { resolveDependencies } from './internal/resolve-deps';
import { assertLeaseRequest } from './internal/ops-validate';

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
    async renew(lease, ttlMs): Promise<LeaseRenewal> {
      assertLeaseRequest(lease.key, lease.owner, ttlMs);
      const row = leases.get(lease.key);
      if (!row || row.token !== lease.token || row.owner !== lease.owner || row.expiresAt === 0)
        return { held: false };
      row.expiresAt = clock.now() + ttlMs;
      const signals = row.signals.splice(0);
      return { held: true, lease: view(lease.key, row), signals };
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
  };
}
