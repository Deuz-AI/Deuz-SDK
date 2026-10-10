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

/**
 * A request delivered by a renewal, each signal once. A 'cancel' concerns the
 * run: it stays queued when the key changes hands or is released, until some
 * holder's renewal delivers it. A 'drain' concerns the current holder and is
 * dropped with its lease. With acknowledged delivery (2.3) a 'cancel' stays
 * queued after its delivery too, until the holder acknowledges it.
 */
export type LeaseSignal = 'cancel' | 'drain';

/** How a renewal hands over a queued 'cancel' (2.3). */
export interface LeaseRenewOptions {
  /**
   * Acknowledged delivery: a delivered 'cancel' stays queued, reported again by
   * every later renewal and handed to the next holder, until `ack` removes it.
   * Record the cancel durably, then acknowledge it: a holder that dies in
   * between cannot lose it. A provider without `ack` ignores this option and
   * removes every signal it delivers, as in 2.2.
   */
  acknowledge?: boolean;
}

export type LeaseRenewal =
  | {
      held: true;
      lease: Lease;
      signals: readonly LeaseSignal[];
      /**
       * The signals still queued under the key after this renewal (2.3). Set
       * when the renewal asked to `acknowledge` and the provider supports it;
       * absent, the renewal removed every signal it delivered.
       */
      queued?: readonly LeaseSignal[];
    }
  | { held: false };

export interface LeaseProvider {
  /**
   * Take a free or expired key; undefined while another owner holds it. A
   * queued 'cancel' carries over to the new holder; a 'drain' does not.
   */
  acquire(request: { key: string; owner: string; ttlMs: number }): Promise<Lease | undefined>;
  /**
   * Extend a lease and collect its pending signals (each delivered once, or a
   * 'cancel' until acknowledged with `options.acknowledge`). A lapsed lease
   * nobody else took is still renewable; one that changed hands reports
   * `held: false`.
   */
  renew(lease: Lease, ttlMs: number, options?: LeaseRenewOptions): Promise<LeaseRenewal>;
  /** Give the key up, keeping a queued 'cancel'; a stale token is ignored. */
  release(lease: Lease): Promise<void>;
  /** Queue a signal for the current holder; false when nobody holds the key. */
  signal(key: string, signal: LeaseSignal): Promise<boolean>;
  /**
   * Remove the key's queued 'cancel' once the holder recorded it (2.3), or
   * found it moot. Fenced by the lease: false, and nothing removed, once the
   * key changed hands; a lapsed or released lease nobody took over still
   * counts. Optional: a provider with it honours `renew`'s `acknowledge`.
   */
  ack?(lease: Lease, signal: 'cancel'): Promise<boolean>;
  /**
   * Retention (2.3): delete the keys nobody holds, released or expired before
   * `before` (epoch milliseconds on the provider's clock), that queue no
   * 'cancel', and return how many. The next holder of a pruned key starts
   * again at token 1, and a holder whose lease expired before `before` finds
   * it lost when it renews. Optional: the memory, SQLite and Postgres
   * providers have it.
   */
  prune?(before: number): Promise<number>;
}
