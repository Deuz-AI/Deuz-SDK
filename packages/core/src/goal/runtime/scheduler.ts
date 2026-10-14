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
export function createDurableScheduler(_options: DurableSchedulerOptions): DurableScheduler {
  return notImplemented('createDurableScheduler');
}
