/**
 * Leases (2.2) decide which executor drives a durable run right now. A lease is
 * liveness only: an executor that loses it stops writing, and the run's own
 * revision checks remain the safety fence against a stale writer.
 */
export interface Lease {
  readonly key: string;
  readonly owner: string;
  /** Increases every time the key changes hands, including after a release. */
  readonly token: number;
  /** Epoch milliseconds on the provider's clock. */
  readonly expiresAt: number;
}

/** A request the current holder receives on its next renewal. */
export type LeaseSignal = 'cancel' | 'drain';

export type LeaseRenewal =
  | { held: true; lease: Lease; signals: readonly LeaseSignal[] }
  | { held: false };

export interface LeaseProvider {
  /** Take a free or expired key; undefined while another owner holds it. */
  acquire(request: { key: string; owner: string; ttlMs: number }): Promise<Lease | undefined>;
  /**
   * Extend a lease and collect its pending signals (each delivered once). A
   * lapsed lease nobody else took is still renewable; one that changed hands
   * reports `held: false`.
   */
  renew(lease: Lease, ttlMs: number): Promise<LeaseRenewal>;
  /** Give the key up; a stale token is ignored. */
  release(lease: Lease): Promise<void>;
  /** Queue a signal for the current holder; false when nobody holds the key. */
  signal(key: string, signal: LeaseSignal): Promise<boolean>;
}
