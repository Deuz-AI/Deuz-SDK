/**
 * @internal A native run's cross-process claim (2.3): runAgent's `lease`
 * option. One lease per run, keyed `agent:["scope","runId"]`, held while an
 * executor drives the run and renewed every ttlMs / 3, as the swarm and evolve
 * executors hold theirs. Losing it stops every further write; a 'cancel'
 * signalled to the key stops the run. A provider with `ack` keeps a delivered
 * cancel queued until the run's terminal state is durable, so an executor
 * that dies in between cannot lose it. The claim renews at once, before the
 * run is read: what that renewal delivers was queued before the claim, and
 * every cancel after it concerns the run being driven. Edge-safe.
 */
import type { AgentRunLeaseOptions } from '../types/agent-run';
import type { Clock } from '../types/deps';
import type { Lease, LeaseRenewal, LeaseRenewOptions } from '../types/lease';

/** Why a native run's lease failed it (2.3). */
export type AgentRunLeaseErrorCode = 'lease_held' | 'lease_lost';

/**
 * A native run's lease failure (2.3): `'lease_held'` while another executor
 * drives the run, `'lease_lost'` once this one lost it. Fatal: never a tool
 * error a model could retry.
 */
export class AgentRunLeaseError extends Error {
  readonly name = 'AgentRunLeaseError';
  readonly fatalExecution = true;
  constructor(readonly code: AgentRunLeaseErrorCode) {
    super(
      code === 'lease_held'
        ? 'Another executor holds this native run.'
        : 'This executor lost the native run lease.',
    );
  }
}

/** The lease key of a native run (2.3): `agent:` and the JSON of `[scope, runId]`. */
export function agentRunLeaseKey(session: { scope: string; runId: string }): string {
  return `agent:${JSON.stringify([session.scope, session.runId])}`;
}

/**
 * What the claiming executor is about to drive: a new run, a stored run that
 * has not ended, or one that has (whose resume only reports its result).
 */
export type NativeRunState = 'fresh' | 'active' | 'terminal';

export interface NativeRunLease {
  /**
   * The run's signal: the caller's `signal`, also aborted by a delivered
   * cancel or a lost lease.
   */
  readonly signal: AbortSignal;
  /** A cancel reached this executor: the run stops with reason 'cancelled'. */
  readonly cancelled: boolean;
  /**
   * The error a run that failed reports: `'lease_lost'` once the lease is
   * gone, whatever error the loss surfaced as (an aborted call, a refused
   * write, a receipt that could not be saved); otherwise `error` itself.
   */
  failure(error: unknown): unknown;
  /** Throws `'lease_lost'` once the lease is gone: no write may follow. */
  assertHeld(): void;
  /**
   * Decide, once the run is read, on a cancel the claim's first renewal found
   * queued under the key, which predates this claim: it stops a run that has
   * not ended; a new run starts clean of it, and an ended run makes it moot.
   * A run never collected (one that turned out to exist, or not to) leaves it
   * queued. A cancel any later renewal delivers concerns this run.
   */
  collect(state: NativeRunState): Promise<void>;
  /**
   * Stop renewing and give the lease back. `recorded`: the run's terminal
   * state is durable, so a cancel it was delivered is acknowledged; one a
   * provider without `ack` consumed and the run did not record is queued
   * again for the next executor.
   */
  release(recorded: boolean): Promise<void>;
}

/** Validates the option; a malformed one throws a TypeError. */
function assertLeaseOptions(options: AgentRunLeaseOptions): number {
  const provider = options?.provider;
  if (
    typeof provider?.acquire !== 'function' ||
    typeof provider.renew !== 'function' ||
    typeof provider.release !== 'function' ||
    typeof provider.signal !== 'function'
  )
    throw new TypeError('lease.provider must be a LeaseProvider');
  if (options.owner !== undefined && (typeof options.owner !== 'string' || !options.owner))
    throw new TypeError('lease.owner must be a nonempty string');
  const ttl = options.ttlMs ?? 30_000;
  if (!Number.isSafeInteger(ttl) || ttl < 3)
    throw new TypeError('lease.ttlMs must be an integer of at least 3');
  return ttl;
}

/**
 * Acquire a native run's lease, or throw `'lease_held'` while another owner
 * holds it, and renew it at once, before the run is read: that first renewal
 * takes what was queued under the key before the claim, which `collect`
 * decides on, and the heartbeat starts from it.
 */
export async function claimNativeRunLease(
  options: AgentRunLeaseOptions,
  session: { scope: string; runId: string },
  deps: { clock: Clock; generateId(): string },
  signal: AbortSignal | undefined,
): Promise<NativeRunLease> {
  const ttl = assertLeaseOptions(options);
  const { provider } = options;
  const { clock } = deps;
  const key = agentRunLeaseKey(session);
  const acquired = await provider.acquire({
    key,
    owner: options.owner ?? deps.generateId(),
    ttlMs: ttl,
  });
  if (!acquired) throw new AgentRunLeaseError('lease_held');

  // Acknowledged delivery (2.3) where the provider can acknowledge; otherwise
  // a renewal consumes what it delivers, as in 2.2.
  const renewOptions: LeaseRenewOptions | undefined =
    typeof provider.ack === 'function' ? { acknowledge: true } : undefined;
  // The first renewal, with no other I/O since the claim: a cancel it
  // delivers was queued before this executor held the key.
  let first: LeaseRenewal;
  try {
    first = await provider.renew(acquired, ttl, renewOptions);
  } catch (error) {
    await provider.release(acquired).catch(() => {});
    throw error;
  }
  if (!first.held) throw new AgentRunLeaseError('lease_lost');
  let held: Lease = first.lease;
  /**
   * The cancel the first renewal delivered, if any, until `collect` decides
   * on it: `'kept'` while the provider keeps it queued, `'consumed'` once it
   * took it off the queue.
   */
  const found: 'kept' | 'consumed' | undefined = first.signals.includes('cancel')
    ? first.queued?.includes('cancel')
      ? 'kept'
      : 'consumed'
    : undefined;
  let collected = false;

  const controller = new AbortController();
  const follow = (): void => controller.abort(signal?.reason);
  if (signal?.aborted) follow();
  else signal?.addEventListener('abort', follow, { once: true });

  let cancelled = false;
  /** A delivered cancel the provider keeps queued until acknowledged. */
  let kept = false;
  /** A delivered cancel the provider took off the queue. */
  let consumed = false;
  let lost = false;
  let stopped = false;
  let stopBeat: (() => void) | undefined;
  let renewals: Promise<void> = Promise.resolve();

  const lose = (): void => {
    if (lost) return;
    lost = true;
    controller.abort(new AgentRunLeaseError('lease_lost'));
  };
  const cancel = (): void => {
    cancelled = true;
    controller.abort(new Error('Native run cancelled'));
  };
  const note = (renewal: LeaseRenewal): boolean => {
    if (!renewal.held || !renewal.signals.includes('cancel')) return false;
    const keeps = !!renewal.queued?.includes('cancel');
    // Until `collect` decides on the cancel the claim found, a provider that
    // keeps it queued delivers it again: that is still the same cancel.
    if (keeps && found === 'kept' && !collected) return false;
    if (keeps) kept = true;
    else consumed = true;
    return true;
  };
  // One renewal at a time, so each delivered signal is noted exactly once.
  const renew = (): Promise<void> =>
    (renewals = renewals.then(async () => {
      if (stopped || lost) return;
      try {
        const renewal = await provider.renew(held, ttl, renewOptions);
        // Noted even after the run stopped: release() acknowledges or restores it.
        const delivered = note(renewal);
        if (stopped) return;
        if (!renewal.held) return lose();
        held = renewal.lease;
        if (delivered) cancel();
      } catch {
        // A provider outage is survivable until the lease could have lapsed.
        if (!stopped && clock.now() >= held.expiresAt) lose();
      }
    }));
  const beat = (): void => {
    if (!stopped && !lost)
      stopBeat = clock.setTimeout(() => void renew().then(beat), Math.max(1, Math.floor(ttl / 3)));
  };
  // The heartbeat runs from the first renewal on, while the run is read.
  beat();

  return {
    signal: controller.signal,
    get cancelled() {
      return cancelled;
    },
    failure(error) {
      return lost ? new AgentRunLeaseError('lease_lost') : error;
    },
    assertHeld() {
      if (lost) throw new AgentRunLeaseError('lease_lost');
    },
    collect(state) {
      // In line with the renewals, so none delivers the cancel meanwhile.
      const decided = renewals.then(async () => {
        if (lost) throw new AgentRunLeaseError('lease_lost');
        collected = true;
        if (state === 'active' && found) {
          if (found === 'kept') kept = true;
          else consumed = true;
          cancel();
        } else if (found === 'kept') {
          // It predates a new run, or a run that already ended: left queued,
          // it would cancel whatever drives this run next.
          await provider.ack!(held, 'cancel');
        }
      });
      renewals = decided.catch(() => {});
      return decided;
    },
    async release(recorded) {
      stopped = true;
      stopBeat?.();
      signal?.removeEventListener('abort', follow);
      await renewals;
      if (recorded && kept && !lost) await provider.ack!(held, 'cancel').catch(() => false);
      // A cancel the provider no longer queues and the run did not record goes
      // back to whoever holds the key next (2.2), and so does one the claim
      // found when no `collect` decided on it.
      else if (!recorded && (consumed || (!collected && found === 'consumed')))
        await provider.signal(key, 'cancel').catch(() => false);
      if (!lost) await provider.release(held).catch(() => {});
    },
  };
}
