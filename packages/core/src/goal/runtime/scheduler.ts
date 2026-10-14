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
import { resolveDependencies } from '../../internal/resolve-deps';
import { DEUZ_ATTR, DEUZ_SPAN, recordSpan } from '../../internal/telemetry';
import { parseCron } from '../../schedule/cron';
import type { ScheduleCatchUp } from '../../schedule/scheduler';
import { assertTimeZone, nextZonedOccurrence, zonedOccurrencesBetween } from '../../schedule/zoned';
import type { ZonedCronOptions } from '../../schedule/zoned';
import { GoalError } from '../errors';
import { goalEventFromOccurrence } from '../events';
import { goalDeliveryDigest } from './delivery';
import { goalInboxKey } from './store';
import type {
  DurableSchedule,
  DurableScheduleInput,
  DurableSchedulePage,
  DurableScheduleQuery,
  GoalInboxEnqueue,
  GoalRuntimeStore,
  ScheduleAdvance,
  ScheduleOccurrenceRecord,
  ScheduleSpec,
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
  /**
   * Schedules whose step failed (a store error, say): logged, left where
   * they were, and tried again next tick. The other schedules still advance.
   */
  errors: { scope: string; scheduleId: string; error: unknown }[];
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
const MINUTE = 60_000;
/** Advance conflicts (another scheduler, a change) tolerated per schedule per tick. */
const MAX_CONFLICTS = 3;

/** An occurrence as planned, before the store records it. */
type PlannedOccurrence = Omit<ScheduleOccurrenceRecord, 'recordedAt' | 'inboxEntryId'>;

/** One step of one schedule: the advance to commit. */
interface StepPlan {
  toCursor: number;
  scanTo?: number;
  occurrences: PlannedOccurrence[];
  /** UTC time scanned, against the per-tick allowance. */
  scanned: number;
}

/** The schedule's first instant not yet scanned: its cursor, or its boundary when later. */
const startOf = (schedule: DurableSchedule): number =>
  Math.max(schedule.scheduleCursor, schedule.effectiveFrom);

const zonedOf = (spec: ScheduleSpec): ZonedCronOptions => ({
  timezone: spec.timezone ?? 'UTC',
  dstGap: spec.dstGap ?? 'shift',
  dstOverlap: spec.dstOverlap ?? 'first',
});

const scheduleKey = (schedule: Pick<DurableSchedule, 'scope' | 'scheduleId'>): string =>
  JSON.stringify([schedule.scope, schedule.scheduleId]);

const namespaceOf = (scheduleId: string): string => `schedule:${scheduleId}`;

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
  const graceMs = checkLimit(options.graceMs, 'graceMs', DEFAULT_DURABLE_SCHEDULER.graceMs, 0);
  const maxDeliveries = checkLimit(
    options.maxDeliveriesPerTick,
    'maxDeliveriesPerTick',
    DEFAULT_DURABLE_SCHEDULER.maxDeliveriesPerTick,
    1,
  );
  const maxScanMs =
    checkLimit(
      options.maxScanMinutes,
      'maxScanMinutes',
      DEFAULT_DURABLE_SCHEDULER.maxScanMinutes,
      1,
    ) * MINUTE;
  const pollMs = checkLimit(options.pollMs, 'pollMs', DEFAULT_DURABLE_SCHEDULER.pollMs, 1);
  const deps = resolveDependencies(options.deps);
  /** One advance writes at most this many occurrence records, skipped ones included. */
  const recordCap = maxDeliveries;
  /** An idle schedule moves its cursor up this often, so a later scan starts close by. */
  const idleAdvanceMs = Math.max(MINUTE, Math.floor(maxScanMs / 2));

  // ---------------------------------------------------------------------
  // Planning a step (pure, apart from the next-due cache)
  // ---------------------------------------------------------------------

  /** The next occurrence after each schedule's start, by schedule, while that start holds. */
  const dueCache = new Map<
    string,
    { revision: number; cursor: number; effectiveFrom: number; at: number }
  >();

  function nextAfter(schedule: DurableSchedule, after: number): number {
    try {
      return nextZonedOccurrence(schedule.spec.cron, after, zonedOf(schedule.spec));
    } catch (error) {
      if (error instanceof RangeError) return Infinity;
      throw error;
    }
  }

  function nextDue(schedule: DurableSchedule): number {
    const key = scheduleKey(schedule);
    const cached = dueCache.get(key);
    if (
      cached?.revision === schedule.revision &&
      cached.cursor === schedule.scheduleCursor &&
      cached.effectiveFrom === schedule.effectiveFrom
    )
      return cached.at;
    const at = nextAfter(schedule, startOf(schedule));
    dueCache.set(key, {
      revision: schedule.revision,
      cursor: schedule.scheduleCursor,
      effectiveFrom: schedule.effectiveFrom,
      at,
    });
    return at;
  }

  /** `'due'`: occurrences (or an unfinished window) wait; `'idle'`: only the cursor lags. */
  function work(schedule: DurableSchedule, now: number): 'due' | 'idle' | undefined {
    if (schedule.scanTo !== undefined || nextDue(schedule) <= now) return 'due';
    return now - startOf(schedule) >= idleAdvanceMs ? 'idle' : undefined;
  }

  function planned(
    schedule: DurableSchedule,
    at: number,
    disposition: PlannedOccurrence['disposition'],
    reason?: PlannedOccurrence['reason'],
  ): PlannedOccurrence {
    return {
      occurrenceId: `${schedule.scheduleId}@${at}`,
      scheduleId: schedule.scheduleId,
      scope: schedule.scope,
      goalId: schedule.goalId,
      at,
      disposition,
      ...(reason !== undefined ? { reason } : {}),
    };
  }

  /**
   * The next step of a schedule at `now`: at most `cap` deliveries, at most
   * `scanLeft` ms of UTC time scanned, at most `recordCap` records. Undefined
   * when there is nothing to do.
   */
  function plan(
    schedule: DurableSchedule,
    now: number,
    cap: number,
    scanLeft: number,
  ): StepPlan | undefined {
    const from = startOf(schedule);
    const mode = schedule.spec.catchUp ?? 'latest';
    let scanTo = schedule.scanTo;
    // A window the boundary has overtaken (a change, a resume) is over.
    if (scanTo !== undefined && scanTo <= from)
      return { toCursor: from, occurrences: [], scanned: 0 };
    if (scanTo === undefined) {
      const first = nextDue(schedule);
      if (first > now)
        return now - from >= idleAdvanceMs
          ? { toCursor: now, occurrences: [], scanned: 0 }
          : undefined;
      // An occurrence older than the grace was missed: catch up over a fixed
      // window, so the deliveries do not depend on how many ticks it takes.
      if (mode !== 'all' && first < now - graceMs) scanTo = now;
    }
    const windowEnd = scanTo ?? now;
    let end = Math.min(from + scanLeft, windowEnd);
    if (end <= from) return undefined;
    let found = zonedOccurrencesBetween(
      schedule.spec.cron,
      from,
      end,
      zonedOf(schedule.spec),
      recordCap + 1,
    ).map((occurrence) => occurrence.at);
    if (found.length > recordCap) {
      found = found.slice(0, recordCap);
      end = found[found.length - 1]!;
    }
    const scanned = end - from;

    if (mode === 'latest' && scanTo !== undefined) {
      // Only the newest occurrence of the window, and only once the window is
      // scanned to its end (or nothing is left in it).
      const final = end >= scanTo || nextAfter(schedule, end) > scanTo;
      const last = found.length - 1;
      return {
        toCursor: final ? scanTo : end,
        ...(final ? {} : { scanTo }),
        scanned,
        occurrences: found.map((at, index) =>
          final && index === last
            ? planned(schedule, at, 'delivered')
            : planned(schedule, at, 'skipped', 'catch-up-latest'),
        ),
      };
    }

    // 'all', 'none', and 'latest' while on time: deliver up to `cap`, oldest
    // first; the rest waits for the next step from the persistent cursor.
    const reference = scanTo ?? now;
    const occurrences: PlannedOccurrence[] = [];
    let toCursor = end;
    let delivered = 0;
    for (const at of found) {
      if (mode === 'none' && at < reference - graceMs) {
        occurrences.push(planned(schedule, at, 'skipped', 'catch-up-none'));
        continue;
      }
      if (delivered === cap) {
        toCursor = occurrences[occurrences.length - 1]!.at;
        break;
      }
      occurrences.push(planned(schedule, at, 'delivered'));
      delivered += 1;
    }
    return {
      toCursor,
      ...(scanTo !== undefined && toCursor < scanTo ? { scanTo } : {}),
      scanned: toCursor - from,
      occurrences,
    };
  }

  // ---------------------------------------------------------------------
  // Committing a step
  // ---------------------------------------------------------------------

  async function deliveryOf(schedule: DurableSchedule, at: number): Promise<GoalInboxEnqueue> {
    const occurrenceId = `${schedule.scheduleId}@${at}`;
    const { scope, goalId } = schedule;
    const event = goalEventFromOccurrence(
      { id: schedule.scheduleId, at, key: occurrenceId },
      {
        scope,
        goalId,
        ...(schedule.event?.correlationId !== undefined
          ? { correlationId: schedule.event.correlationId }
          : {}),
        ...(schedule.event?.expiresAfterMs !== undefined
          ? { expiresAt: at + schedule.event.expiresAfterMs }
          : {}),
      },
    );
    return {
      scope,
      goalId,
      namespace: namespaceOf(schedule.scheduleId),
      deliveryId: occurrenceId,
      event,
      digest: await goalDeliveryDigest({ scope, goalId, event }),
    };
  }

  type StepOutcome =
    | { status: 'conflict'; schedule?: DurableSchedule }
    | {
        status: 'advanced';
        schedule: DurableSchedule;
        records: ScheduleOccurrenceRecord[];
        delivered: number;
        duplicates: number;
        scanned: number;
      };

  async function step(
    schedule: DurableSchedule,
    now: number,
    cap: number,
    scanLeft: number,
  ): Promise<StepOutcome | undefined> {
    const next = plan(schedule, now, cap, scanLeft);
    if (!next) return undefined;
    const occurrences: ScheduleAdvance['occurrences'] = await Promise.all(
      next.occurrences.map(async (occurrence) =>
        occurrence.disposition === 'delivered'
          ? { ...occurrence, delivery: await deliveryOf(schedule, occurrence.at) }
          : occurrence,
      ),
    );
    const result = await store.schedules.advance({
      scope: schedule.scope,
      scheduleId: schedule.scheduleId,
      expectedRevision: schedule.revision,
      fromCursor: schedule.scheduleCursor,
      toCursor: next.toCursor,
      ...(next.scanTo !== undefined ? { scanTo: next.scanTo } : {}),
      occurrences,
    });
    if (result.status === 'conflict')
      return { status: 'conflict', ...(result.schedule ? { schedule: result.schedule } : {}) };
    const recordedAt = deps.clock.now();
    const mode = schedule.spec.catchUp ?? 'latest';
    const records = next.occurrences.map((occurrence): ScheduleOccurrenceRecord => {
      const record: ScheduleOccurrenceRecord = { ...occurrence, recordedAt };
      if (occurrence.disposition === 'delivered')
        record.inboxEntryId = goalInboxKey(
          schedule.scope,
          namespaceOf(schedule.scheduleId),
          occurrence.occurrenceId,
        );
      recordSpan(deps, DEUZ_SPAN.scheduleDelivery, {
        [DEUZ_ATTR.scheduleId]: occurrence.scheduleId,
        [DEUZ_ATTR.scheduleOccurrenceId]: occurrence.occurrenceId,
        [DEUZ_ATTR.scheduleDisposition]: occurrence.disposition,
        [DEUZ_ATTR.scheduleCatchUp]: mode,
        [DEUZ_ATTR.goalId]: occurrence.goalId,
        ...(occurrence.reason !== undefined
          ? { [DEUZ_ATTR.scheduleReason]: occurrence.reason }
          : {}),
      });
      return record;
    });
    return {
      status: 'advanced',
      schedule: result.schedule,
      records,
      delivered: records.filter((record) => record.disposition === 'delivered').length,
      duplicates: result.duplicates,
      scanned: next.scanned,
    };
  }

  // ---------------------------------------------------------------------
  // The tick: every active schedule, in turn
  // ---------------------------------------------------------------------

  /** The schedule served last; the next tick starts after it (round-robin). */
  let lastServed: string | undefined;

  async function activeSchedules(signal: AbortSignal | undefined): Promise<DurableSchedule[]> {
    const all: DurableSchedule[] = [];
    let cursor: string | undefined;
    do {
      const page = await store.schedules.list({
        statuses: ['active'],
        limit: 1000,
        ...(cursor !== undefined ? { cursor } : {}),
      });
      all.push(...page.schedules);
      cursor = page.cursor;
    } while (cursor !== undefined && !signal?.aborted);
    const index = all.findIndex((schedule) => scheduleKey(schedule) === lastServed);
    return index < 0 ? all : [...all.slice(index + 1), ...all.slice(0, index + 1)];
  }

  async function tickAt(
    now: number,
    signal: AbortSignal | undefined,
  ): Promise<DurableSchedulerTickResult> {
    if (typeof now !== 'number' || !Number.isFinite(now))
      throw new TypeError('now must be a finite number of milliseconds');
    const result: DurableSchedulerTickResult = {
      occurrences: [],
      duplicates: 0,
      backlog: 0,
      errors: [],
    };
    const scanLeft = new Map<string, number>();
    const conflicts = new Map<string, number>();
    const backlog = new Set<string>();
    let budget = maxDeliveries;
    let queue = await activeSchedules(signal);

    const fail = (schedule: DurableSchedule, error: unknown) => {
      result.errors.push({ scope: schedule.scope, scheduleId: schedule.scheduleId, error });
      deps.logger.error('durable schedule step failed', {
        scope: schedule.scope,
        scheduleId: schedule.scheduleId,
        error,
      });
    };

    // Rounds: each schedule with work takes one step per round, with a fair
    // share of the deliveries left, until the budget or the work runs out.
    while (queue.length > 0 && budget > 0 && !signal?.aborted) {
      const share = Math.max(1, Math.floor(budget / queue.length));
      const again: DurableSchedule[] = [];
      for (const schedule of queue) {
        const key = scheduleKey(schedule);
        if (budget <= 0 || signal?.aborted) {
          again.push(schedule);
          continue;
        }
        let outcome: StepOutcome | undefined;
        try {
          if (!work(schedule, now)) continue;
          outcome = await step(
            schedule,
            now,
            Math.min(share, budget),
            scanLeft.get(key) ?? maxScanMs,
          );
        } catch (error) {
          fail(schedule, error);
          continue;
        }
        if (!outcome) {
          // Due, but no scan left this tick.
          backlog.add(key);
          continue;
        }
        lastServed = key;
        if (outcome.status === 'conflict') {
          const count = (conflicts.get(key) ?? 0) + 1;
          conflicts.set(key, count);
          try {
            const fresh =
              outcome.schedule ?? (await store.schedules.get(schedule.scope, schedule.scheduleId));
            if (fresh?.status === 'active' && count < MAX_CONFLICTS) again.push(fresh);
          } catch (error) {
            fail(schedule, error);
          }
          continue;
        }
        budget -= outcome.delivered;
        result.duplicates += outcome.duplicates;
        result.occurrences.push(...outcome.records);
        const left = (scanLeft.get(key) ?? maxScanMs) - outcome.scanned;
        scanLeft.set(key, left);
        if (work(outcome.schedule, now) === 'due') {
          if (left > 0) again.push(outcome.schedule);
          else backlog.add(key);
        }
      }
      queue = again;
    }
    for (const schedule of queue) {
      try {
        if (work(schedule, now) === 'due') backlog.add(scheduleKey(schedule));
      } catch {
        // Reported when the schedule steps.
      }
    }
    result.backlog = backlog.size;
    return result;
  }

  let running = false;

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

    tick(tickOptions) {
      return tickAt(tickOptions?.now ?? deps.clock.now(), tickOptions?.signal);
    },

    start(startOptions) {
      if (running) throw new Error('This durable scheduler is already started');
      running = true;
      const controller = new AbortController();
      const outer = startOptions?.signal;
      const forward = () => controller.abort();
      if (outer?.aborted) controller.abort();
      else outer?.addEventListener('abort', forward, { once: true });
      let wake: (() => void) | undefined;
      let cancelTimer: (() => void) | undefined;
      controller.signal.addEventListener(
        'abort',
        () => {
          cancelTimer?.();
          wake?.();
        },
        { once: true },
      );
      const loop = (async () => {
        while (!controller.signal.aborted) {
          try {
            await tickAt(deps.clock.now(), controller.signal);
          } catch (error) {
            deps.logger.error('durable scheduler tick failed', { error });
          }
          if (controller.signal.aborted) break;
          await new Promise<void>((resolve) => {
            wake = resolve;
            cancelTimer = deps.clock.setTimeout(resolve, pollMs);
          });
        }
      })().finally(() => {
        outer?.removeEventListener('abort', forward);
        running = false;
      });
      return {
        async stop() {
          controller.abort();
          await loop;
        },
      };
    },
  };
}
