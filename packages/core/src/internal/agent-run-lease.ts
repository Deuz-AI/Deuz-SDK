/**
 * @internal A native run's cross-process claim (2.3): runAgent's `lease`
 * option. One lease per run, keyed `agent:["scope","runId"]`, held while an
 * executor drives the run and renewed every ttlMs / 3, as the swarm and evolve
 * executors hold theirs. Losing it stops every further write; a 'cancel'
 * signalled to the key stops the run. A provider with `ack` keeps a delivered
 * cancel queued until the run's terminal state is durable, so an executor
 * that dies in between cannot lose it. Edge-safe.
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
   * Take the signals queued under the key before the run starts, then renew
   * on a heartbeat. A cancel may predate this claim: it stops a run that has
   * not ended; a new run starts clean of it, and an ended run makes it moot.
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
 * holds it. Nothing is renewed until `collect`.
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
  let held: Lease = acquired;

  const controller = new AbortController();
  const follow = (): void => controller.abort(signal?.reason);
  if (signal?.aborted) follow();
  else signal?.addEventListener('abort', follow, { once: true });

  // Acknowledged delivery (2.3) where the provider can acknowledge; otherwise
  // a renewal consumes what it delivers, as in 2.2.
  const renewOptions: LeaseRenewOptions | undefined =
    typeof provider.ack === 'function' ? { acknowledge: true } : undefined;
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
    if (renewal.queued?.includes('cancel')) kept = true;
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
    async collect(state) {
      const renewal = await provider.renew(held, ttl, renewOptions);
      if (!renewal.held) {
        lost = true;
        throw new AgentRunLeaseError('lease_lost');
      }
      held = renewal.lease;
      if (renewal.signals.includes('cancel')) {
        const keeps = !!renewal.queued?.includes('cancel');
        if (state === 'active') {
          if (keeps) kept = true;
          else consumed = true;
          cancel();
        } else if (keeps) {
          // It predates a new run, or a run that already ended: left queued,
          // it would cancel whatever drives this run next.
          await provider.ack!(held, 'cancel');
        }
      }
      beat();
    },
    async release(recorded) {
      stopped = true;
      stopBeat?.();
      signal?.removeEventListener('abort', follow);
      await renewals;
      if (recorded && kept && !lost) await provider.ack!(held, 'cancel').catch(() => false);
      // A cancel the provider no longer queues and the run did not record goes
      // back to whoever holds the key next (2.2).
      else if (!recorded && consumed) await provider.signal(key, 'cancel').catch(() => false);
      if (!lost) await provider.release(held).catch(() => {});
    },
  };
}
