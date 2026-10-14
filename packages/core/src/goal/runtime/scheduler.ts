/**
 * The durable scheduler (2.4, spec §3.2): schedules with an IANA time zone and
 * DST policies, a durable cursor, catch-up, and occurrences committed into a
 * goal's inbox in the same transaction as the cursor. Separate from the
 * in-process `createScheduler` of `@deuz-sdk/core/schedule`, which stays as it
 * is (UTC only, cursor in memory, claim before run, no retry); both reuse
 * `parseCron`, `nextOccurrence` and `occurrencesBetween`. `start()` is a
 * library loop in the host process, not a service. Edge-safe.
 */
import type { Dependencies } from '../../types/deps';
import { notImplemented } from '../../internal/not-implemented';
import { resolveDependencies } from '../../internal/resolve-deps';
import { parseCron } from '../../schedule/cron';
import type { ScheduleCatchUp } from '../../schedule/scheduler';
import { assertTimeZone } from '../../schedule/zoned';
import { GoalError } from '../errors';
import type {
  DurableSchedule,
  DurableScheduleInput,
  DurableSchedulePage,
  DurableScheduleQuery,
  GoalRuntimeStore,
  ScheduleOccurrenceRecord,
} from './store-types';

/** The scheduler's limits (spec §3.2). */
export const DEFAULT_DURABLE_SCHEDULER = {
  /** An occurrence this late when found still counts as on time. */
  graceMs: 60_000,
  /** Deliveries per tick, across every schedule. */
  maxDeliveriesPerTick: 100,
  /** UTC minutes scanned per schedule per tick. */
  maxScanMinutes: 10_000,
  /** `start()` ticks this often on the injected clock. */
  pollMs: 1_000,
} as const;

/** Options of `createDurableScheduler`. */
export interface DurableSchedulerOptions {
  store: GoalRuntimeStore;
  graceMs?: number;
  maxDeliveriesPerTick?: number;
  maxScanMinutes?: number;
  pollMs?: number;
  /** Clock, ids, logger, observer (`deuz.schedule.delivery` spans). */
  deps?: Dependencies;
}

/** Options of a schedule change. */
export interface DurableScheduleChangeOptions {
  /** The revision the change is based on; omit to create (or to take the stored one). */
  expectedRevision?: number;
}

/** What one tick did. */
export interface DurableSchedulerTickResult {
  /** Occurrences handled, delivered or skipped, in order. */
  occurrences: ScheduleOccurrenceRecord[];
  /** Deliveries that were already in the inbox. */
  duplicates: number;
  /** Schedules whose backlog continues next tick. */
  backlog: number;
}

/**
 * The durable scheduler (2.4). Its `put` creates or changes a schedule (a
 * change is a new revision with an explicit UTC transition boundary), `pause`
 * stops new scans, `cancel` also ends deliveries not yet applied.
 */
export interface DurableScheduler {
  put(
    schedule: DurableScheduleInput,
    options?: DurableScheduleChangeOptions,
  ): Promise<DurableSchedule>;
  pause(
    scope: string,
    scheduleId: string,
    options?: DurableScheduleChangeOptions,
  ): Promise<DurableSchedule>;
  resume(
    scope: string,
    scheduleId: string,
    options?: DurableScheduleChangeOptions,
  ): Promise<DurableSchedule>;
  cancel(
    scope: string,
    scheduleId: string,
    options?: DurableScheduleChangeOptions,
  ): Promise<DurableSchedule>;
  get(scope: string, scheduleId: string): Promise<DurableSchedule | undefined>;
  list(query?: DurableScheduleQuery): Promise<DurableSchedulePage>;
  /** One pass over the active schedules at `now` (default: the clock). */
  tick(options?: { now?: number; signal?: AbortSignal }): Promise<DurableSchedulerTickResult>;
  /** Ticks every `pollMs` until stopped. */
  start(options?: { signal?: AbortSignal }): { stop(): Promise<void> };
}

const CATCH_UP: readonly ScheduleCatchUp[] = ['latest', 'all', 'none'];

function nonEmpty(value: unknown, name: string): string {
  if (typeof value !== 'string' || value === '')
    throw new TypeError(`A schedule's ${name} must be a nonempty string`);
  return value;
}

/** A checked copy of a schedule, with every default spelled out. */
function checkSchedule(input: DurableScheduleInput): DurableScheduleInput {
  if (typeof input !== 'object' || input === null)
    throw new TypeError('A schedule must be an object');
  const scheduleId = nonEmpty(input.scheduleId, 'scheduleId');
  const scope = nonEmpty(input.scope, 'scope');
  const goalId = nonEmpty(input.goalId, 'goalId');
  const spec = input.spec;
  if (typeof spec !== 'object' || spec === null)
    throw new TypeError(`Schedule ${scheduleId} needs a spec`);
  parseCron(spec.cron);
  const timezone = assertTimeZone(spec.timezone ?? 'UTC');
  const dstGap = spec.dstGap ?? 'shift';
  if (dstGap !== 'shift' && dstGap !== 'skip')
    throw new TypeError(`dstGap must be 'shift' or 'skip', not ${JSON.stringify(dstGap)}`);
  const dstOverlap = spec.dstOverlap ?? 'first';
  if (dstOverlap !== 'first' && dstOverlap !== 'both')
    throw new TypeError(`dstOverlap must be 'first' or 'both', not ${JSON.stringify(dstOverlap)}`);
  const catchUp = spec.catchUp ?? 'latest';
  if (!CATCH_UP.includes(catchUp))
    throw new TypeError(
      `catchUp must be one of ${CATCH_UP.join(', ')}, not ${JSON.stringify(catchUp)}`,
    );
  const event = input.event;
  if (event !== undefined) {
    if (typeof event !== 'object' || event === null)
      throw new TypeError(`Schedule ${scheduleId}'s event must be an object`);
    if (event.correlationId !== undefined) nonEmpty(event.correlationId, 'event.correlationId');
    if (
      event.expiresAfterMs !== undefined &&
      (typeof event.expiresAfterMs !== 'number' ||
        !Number.isFinite(event.expiresAfterMs) ||
        event.expiresAfterMs <= 0)
    )
      throw new TypeError('event.expiresAfterMs must be a positive number of milliseconds');
  }
  return {
    scheduleId,
    scope,
    goalId,
    spec: { cron: spec.cron, timezone, dstGap, dstOverlap, catchUp },
    ...(event !== undefined
      ? {
          event: {
            ...(event.correlationId !== undefined ? { correlationId: event.correlationId } : {}),
            ...(event.expiresAfterMs !== undefined ? { expiresAfterMs: event.expiresAfterMs } : {}),
          },
        }
      : {}),
  };
}

function checkLimit(
  value: number | undefined,
  name: string,
  fallback: number,
  min: number,
): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < min)
    throw new TypeError(`${name} must be an integer >= ${min}`);
  return value;
}

/**
 * A durable scheduler over a `GoalRuntimeStore` (2.4).
 *
 * - Time zones: UTC by default; an IANA zone is evaluated with `Intl`. A local
 *   time a DST change skips runs once at the first valid instant after the
 *   gap (`dstGap: 'shift'`, the default) or not at all (`'skip'`); a repeated
 *   local time runs once (`dstOverlap: 'first'`) or twice with distinct UTC
 *   occurrence ids (`'both'`).
 * - Catch-up: `'latest'` (default) delivers only the newest missed occurrence
 *   and only after the whole window was scanned; `'all'` delivers every one,
 *   leaving what exceeds the tick limit to the next tick; `'none'` skips
 *   them. Grace 60 s, 100 deliveries per tick, 10 000 UTC minutes scanned.
 * - Each step is one `store.schedules.advance`: the cursor never moves
 *   without its deliveries, and schedules advance in turn so one backlog
 *   never starves the others.
 * - Reports one `deuz.schedule.delivery` span per occurrence (occurrence id,
 *   disposition, catch-up mode).
 */
export function createDurableScheduler(options: DurableSchedulerOptions): DurableScheduler {
  if (typeof options !== 'object' || options === null || typeof options.store !== 'object')
    throw new TypeError('createDurableScheduler needs a GoalRuntimeStore');
  const { store } = options;
  checkLimit(options.graceMs, 'graceMs', DEFAULT_DURABLE_SCHEDULER.graceMs, 0);
  checkLimit(
    options.maxDeliveriesPerTick,
    'maxDeliveriesPerTick',
    DEFAULT_DURABLE_SCHEDULER.maxDeliveriesPerTick,
    1,
  );
  checkLimit(options.maxScanMinutes, 'maxScanMinutes', DEFAULT_DURABLE_SCHEDULER.maxScanMinutes, 1);
  checkLimit(options.pollMs, 'pollMs', DEFAULT_DURABLE_SCHEDULER.pollMs, 1);
  const deps = resolveDependencies(options.deps);

  /** The stored schedule, or `scope_mismatch` (a schedule of another scope reads as missing). */
  async function existing(scope: string, scheduleId: string): Promise<DurableSchedule> {
    const schedule = await store.schedules.get(scope, scheduleId);
    if (!schedule)
      throw new GoalError('scope_mismatch', `No schedule ${scheduleId} in scope ${scope}.`);
    return schedule;
  }

  function conflict(
    scope: string,
    scheduleId: string,
    expected: number,
    actual?: number,
  ): GoalError {
    return new GoalError(
      'revision_conflict',
      `Schedule ${scheduleId} in scope ${scope} is at revision ${String(actual ?? 0)}, not ${expected}.`,
    );
  }

  function cancelled(schedule: DurableSchedule): GoalError {
    return new GoalError(
      'invalid_command',
      `Schedule ${schedule.scheduleId} in scope ${schedule.scope} is cancelled; put a new one instead.`,
    );
  }

  /** The revision a change is based on: the caller's, checked, or the stored one. */
  function basis(
    schedule: DurableSchedule,
    change: DurableScheduleChangeOptions | undefined,
  ): number {
    const expected = change?.expectedRevision ?? schedule.revision;
    if (expected !== schedule.revision)
      throw conflict(schedule.scope, schedule.scheduleId, expected, schedule.revision);
    return expected;
  }

  async function committed(
    result: { status: 'committed'; schedule: DurableSchedule } | { status: 'conflict' },
    scope: string,
    scheduleId: string,
    expected: number,
  ): Promise<DurableSchedule> {
    if (result.status === 'committed') return result.schedule;
    const now = await store.schedules.get(scope, scheduleId);
    throw conflict(scope, scheduleId, expected, now?.revision);
  }

  return {
    async put(input, change) {
      const schedule = checkSchedule(input);
      const { scope, scheduleId, goalId } = schedule;
      if (!(await store.load(goalId, { scope })))
        throw new GoalError(
          'scope_mismatch',
          `Schedule ${scheduleId} targets goal ${goalId}, which does not exist in scope ${scope}.`,
        );
      const stored = await store.schedules.get(scope, scheduleId);
      if (stored?.status === 'cancelled') throw cancelled(stored);
      const expected = change?.expectedRevision ?? stored?.revision ?? 0;
      if (expected !== (stored?.revision ?? 0))
        throw conflict(scope, scheduleId, expected, stored?.revision);
      const result = await store.schedules.put(schedule, {
        expectedRevision: expected,
        effectiveFrom: deps.clock.now(),
      });
      return committed(result, scope, scheduleId, expected);
    },

    async pause(scope, scheduleId, change) {
      const schedule = await existing(scope, scheduleId);
      const expected = basis(schedule, change);
      if (schedule.status === 'cancelled') throw cancelled(schedule);
      if (schedule.status === 'paused') return schedule;
      const result = await store.schedules.pause(scope, scheduleId, { expectedRevision: expected });
      return committed(result, scope, scheduleId, expected);
    },

    async resume(scope, scheduleId, change) {
      const schedule = await existing(scope, scheduleId);
      const expected = basis(schedule, change);
      if (schedule.status === 'cancelled') throw cancelled(schedule);
      if (schedule.status === 'active') return schedule;
      const result = await store.schedules.resume(scope, scheduleId, {
        expectedRevision: expected,
        effectiveFrom: deps.clock.now(),
      });
      return committed(result, scope, scheduleId, expected);
    },

    async cancel(scope, scheduleId, change) {
      const schedule = await existing(scope, scheduleId);
      const expected = basis(schedule, change);
      if (schedule.status === 'cancelled') return schedule;
      const result = await store.schedules.cancel(scope, scheduleId, {
        expectedRevision: expected,
      });
      return committed(result, scope, scheduleId, expected);
    },

    get: (scope, scheduleId) => store.schedules.get(scope, scheduleId),
    list: (query) => store.schedules.list(query),

    tick() {
      return notImplemented('DurableScheduler.tick');
    },
    start() {
      return notImplemented('DurableScheduler.start');
    },
  };
}
