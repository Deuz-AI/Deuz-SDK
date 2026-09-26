import type { Dependencies } from '../types/deps';
import { resolveDependencies } from '../internal/resolve-deps';
import { parseCron, previousOccurrence } from './cron';
import type { CronSchedule } from './cron';

/** One firing of a schedule. `key` (`${id}@${at}`) is its dedupe key. */
export interface ScheduleOccurrence {
  readonly id: string;
  /** The scheduled minute, epoch milliseconds (UTC). */
  readonly at: number;
  readonly key: string;
}

export interface ScheduleDefinition {
  id: string;
  cron: string | CronSchedule;
  run(occurrence: ScheduleOccurrence): unknown;
}

/**
 * Takes the right to run an occurrence: resolves true for the first caller of
 * a key and false for every later one. Share a durable one across processes.
 */
export type ScheduleClaim = (key: string) => boolean | Promise<boolean>;

/**
 * Which due occurrences a tick runs when more than one fell inside its window
 * (after downtime, or a late tick): the newest only, all of them, or the
 * newest only when it is no older than `graceMs`.
 */
export type ScheduleCatchUp = 'latest' | 'all' | 'none';

export interface SchedulerOptions {
  schedules: readonly ScheduleDefinition[];
  /** Default: an in-memory claim, which dedupes within this process only. */
  claim?: ScheduleClaim;
  /** Default 'latest'. */
  catchUp?: ScheduleCatchUp;
  /**
   * How far back the first tick of this scheduler looks, in ms. Later ticks
   * start where the previous one ended. Default 60 000 (one cron minute), so a
   * host cron trigger that fires a little late still catches its minute.
   * Raise it, with a durable claim, to recover occurrences missed while down.
   */
  lookbackMs?: number;
  /**
   * For catchUp 'none': the oldest an occurrence may be and still run, in ms.
   * Default 60 000; `start` raises the default to its interval.
   */
  graceMs?: number;
  /** For catchUp 'all': the most occurrences one schedule runs per tick (newest kept). Default 100. */
  maxCatchUp?: number;
  /** Uses `deps.clock` only. */
  deps?: Dependencies;
}

export type ScheduleOccurrenceResult =
  | (ScheduleOccurrence & { readonly status: 'ran' })
  /** Another tick or process already claimed this key; `run` was not called. */
  | (ScheduleOccurrence & { readonly status: 'duplicate' })
  | (ScheduleOccurrence & {
      readonly status: 'failed';
      readonly phase: 'claim' | 'run';
      readonly error: unknown;
    });

export interface ScheduleTickResult {
  /** The window (from, to] this tick evaluated, epoch ms. */
  readonly from: number;
  readonly to: number;
  /** The occurrences the catch-up policy selected, in time order per schedule. */
  readonly occurrences: readonly ScheduleOccurrenceResult[];
}

export interface ScheduleStartOptions {
  intervalMs: number;
  /** Stops the loop; the returned promise settles once the in-flight tick finishes. */
  signal: AbortSignal;
  onTick?: (result: ScheduleTickResult) => void;
}

export interface Scheduler {
  /** Runs every occurrence due since the previous tick. Never throws for run or claim errors. */
  tick(now?: number): Promise<ScheduleTickResult>;
  /** Ticks now and then every `intervalMs` on `deps.clock` until `signal` aborts. */
  start(options: ScheduleStartOptions): Promise<void>;
}

const DEFAULT_WINDOW_MS = 60_000;
const CATCH_UP: readonly ScheduleCatchUp[] = ['latest', 'all', 'none'];

/** The default claim: remembers the most recent `max` (default 10 000) keys. */
export function createInMemoryClaim(options: { max?: number } = {}): ScheduleClaim {
  const max = options.max ?? 10_000;
  if (!Number.isSafeInteger(max) || max < 1) throw new TypeError('max must be a positive integer');
  const seen = new Set<string>();
  return async (key) => {
    if (seen.has(key)) return false;
    seen.add(key);
    if (seen.size > max) {
      const oldest = seen.values().next();
      if (!oldest.done) seen.delete(oldest.value);
    }
    return true;
  };
}

function assertDuration(value: number | undefined, name: string, min: number): void {
  if (value === undefined) return;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min)
    throw new TypeError(`${name} must be a finite number >= ${min}`);
}

interface Entry {
  definition: ScheduleDefinition;
  cron: CronSchedule;
}

/**
 * Turns cron schedules into deduplicated runs. Drive it with `tick()` from a
 * host cron trigger (Cloudflare, Vercel) or with `start()` in a long-lived
 * process. Edge-safe: time comes from the argument or `deps.clock`.
 */
export function createScheduler(options: SchedulerOptions): Scheduler {
  const catchUp = options.catchUp ?? 'latest';
  if (!CATCH_UP.includes(catchUp))
    throw new TypeError(`Unknown catchUp mode: ${String(options.catchUp)}`);
  assertDuration(options.lookbackMs, 'lookbackMs', 0);
  assertDuration(options.graceMs, 'graceMs', 0);
  if (
    options.maxCatchUp !== undefined &&
    (!Number.isSafeInteger(options.maxCatchUp) || options.maxCatchUp < 1)
  )
    throw new TypeError('maxCatchUp must be a positive integer');
  const lookbackMs = options.lookbackMs ?? DEFAULT_WINDOW_MS;
  const maxCatchUp = options.maxCatchUp ?? 100;
  const claim = options.claim ?? createInMemoryClaim();
  const { clock, logger } = resolveDependencies(options.deps);

  const ids = new Set<string>();
  const entries: Entry[] = options.schedules.map((definition) => {
    if (typeof definition.id !== 'string' || !definition.id)
      throw new TypeError('Schedule id must be a nonempty string');
    if (ids.has(definition.id)) throw new TypeError(`Duplicate schedule id: ${definition.id}`);
    ids.add(definition.id);
    if (typeof definition.run !== 'function')
      throw new TypeError(`Schedule ${definition.id} needs a run function`);
    const cron = typeof definition.cron === 'string' ? parseCron(definition.cron) : definition.cron;
    return { definition, cron };
  });

  let lastTick: number | undefined;
  let running = false;

  function select(cron: CronSchedule, from: number, to: number, graceMs: number): number[] {
    const latest = previousOccurrence(cron, Math.floor(to) + 1);
    if (latest <= from) return [];
    if (catchUp === 'latest') return [latest];
    if (catchUp === 'none') return to - latest <= graceMs ? [latest] : [];
    const out = [latest];
    let cursor = latest;
    while (out.length < maxCatchUp) {
      cursor = previousOccurrence(cron, cursor);
      if (cursor <= from) break;
      out.push(cursor);
    }
    return out.reverse();
  }

  async function attempt(entry: Entry, at: number): Promise<ScheduleOccurrenceResult> {
    const occurrence: ScheduleOccurrence = Object.freeze({
      id: entry.definition.id,
      at,
      key: `${entry.definition.id}@${at}`,
    });
    let claimed: boolean;
    try {
      claimed = (await claim(occurrence.key)) === true;
    } catch (error) {
      return { ...occurrence, status: 'failed', phase: 'claim', error };
    }
    if (!claimed) return { ...occurrence, status: 'duplicate' };
    try {
      await entry.definition.run(occurrence);
      return { ...occurrence, status: 'ran' };
    } catch (error) {
      return { ...occurrence, status: 'failed', phase: 'run', error };
    }
  }

  async function tickAt(now: number, graceMs: number): Promise<ScheduleTickResult> {
    if (typeof now !== 'number' || !Number.isFinite(now))
      throw new TypeError('now must be a finite number of milliseconds');
    const from = lastTick ?? now - lookbackMs;
    const to = now;
    // Advance before awaiting runs so an overlapping tick never re-selects them.
    lastTick = Math.max(lastTick ?? now, now);
    if (to <= from) return { from, to, occurrences: [] };
    const perSchedule = await Promise.all(
      entries.map(async (entry) => {
        const results: ScheduleOccurrenceResult[] = [];
        for (const due of select(entry.cron, from, to, graceMs))
          results.push(await attempt(entry, due));
        return results;
      }),
    );
    return { from, to, occurrences: perSchedule.flat() };
  }

  return {
    tick(now) {
      return tickAt(now ?? clock.now(), options.graceMs ?? DEFAULT_WINDOW_MS);
    },

    async start({ intervalMs, signal, onTick }) {
      if (!Number.isSafeInteger(intervalMs) || intervalMs < 1)
        throw new TypeError('intervalMs must be a positive integer');
      if (running) throw new Error('Scheduler already started');
      if (signal.aborted) return;
      running = true;
      const graceMs = options.graceMs ?? Math.max(DEFAULT_WINDOW_MS, intervalMs);
      try {
        while (!signal.aborted) {
          const result = await tickAt(clock.now(), graceMs);
          try {
            onTick?.(result);
          } catch (error) {
            logger.warn('schedule onTick threw', { error });
          }
          if (signal.aborted) break;
          await new Promise<void>((resolve) => {
            const onAbort = () => {
              cancel();
              resolve();
            };
            const cancel = clock.setTimeout(() => {
              signal.removeEventListener('abort', onAbort);
              resolve();
            }, intervalMs);
            signal.addEventListener('abort', onAbort, { once: true });
          });
        }
      } finally {
        running = false;
      }
    },
  };
}
