/**
 * A test double of the parts of `GoalRuntimeStore` the durable scheduler and
 * the webhook handler use (2.4, lane L5): goals, the inbox and schedules. It
 * keeps the W0 contract of `goal/runtime/store-types.ts` in the simplest form
 * (every write is one synchronous step, so it is all or nothing) and passes
 * `schedule-store-conformance.ts`. The supervisor's parts (intents claims,
 * watermarks) are not in it. Once lane L4a's real in-memory store lands,
 * `makeGoalRuntimeStore` returns that one instead.
 */
import { createInMemoryGoalStore } from '../../src/goal/store';
import { createInMemoryGoalRuntimeStore, goalInboxKey } from '../../src/goal/runtime/store';
import { NotImplementedError } from '../../src/internal/not-implemented';
import { resolveDependencies } from '../../src/internal/resolve-deps';
import type { Dependencies } from '../../src/types/deps';
import type { GoalRecord } from '../../src/goal/types';
import type {
  DurableSchedule,
  DurableScheduleQuery,
  GoalInboxEnqueue,
  GoalInboxEntry,
  GoalInboxQuery,
  GoalRunIntent,
  GoalRuntimeCommitResult,
  GoalRuntimeState,
  GoalRuntimeStore,
  ScheduleAdvance,
  ScheduleOccurrenceRecord,
} from '../../src/goal/runtime/store-types';

const copy = <T>(value: T): T => structuredClone(value);

function planLimit(limit: number | undefined): number {
  const value = limit ?? 100;
  if (!Number.isSafeInteger(value) || value < 1 || value > 1000)
    throw new TypeError('limit must be an integer from 1 to 1000');
  return value;
}

/** The double, plus what tests read that the store interface has no reader for. */
export interface ScheduleStoreDouble extends GoalRuntimeStore {
  /** Every occurrence record written, in order. */
  occurrenceRecords(): ScheduleOccurrenceRecord[];
}

export function createScheduleStoreDouble(
  options: { deps?: Dependencies } = {},
): ScheduleStoreDouble {
  const { clock } = resolveDependencies(options.deps);
  const goals = createInMemoryGoalStore();
  const inbox = new Map<string, GoalInboxEntry & { seq: number }>();
  const schedules = new Map<string, DurableSchedule>();
  const runtime = new Map<string, GoalRuntimeState>();
  const intents = new Map<string, GoalRunIntent>();
  let occurrences: ScheduleOccurrenceRecord[] = [];
  let seq = 0;

  const scheduleKey = (scope: string, scheduleId: string) => JSON.stringify([scope, scheduleId]);
  const goalKey = (scope: string, goalId: string) => JSON.stringify([scope, goalId]);
  const missing = (name: string) => () => {
    throw new Error(`${name} is not part of the schedule store double`);
  };

  function storedGoal(scope: string, goalId: string): GoalRecord | undefined {
    const goal = goals.load(goalId) as GoalRecord | undefined;
    return goal?.scope === scope ? goal : undefined;
  }

  /** The 2.3 store saves synchronously, so a multi-part write never yields mid-way. */
  function saveGoal(record: GoalRecord): void {
    void goals.save(record);
  }

  function enqueueNow(delivery: GoalInboxEnqueue) {
    const id = goalInboxKey(delivery.scope, delivery.namespace, delivery.deliveryId);
    const existing = inbox.get(id);
    if (existing) {
      const { seq: _seq, ...entry } = existing;
      return {
        status:
          existing.digest === delivery.digest ? ('duplicate' as const) : ('conflict' as const),
        entry: copy(entry),
      };
    }
    const entry: GoalInboxEntry = {
      ...copy(delivery),
      id,
      disposition: 'pending',
      enqueuedAt: clock.now(),
    };
    inbox.set(id, { ...entry, seq: seq++ });
    return { status: 'enqueued' as const, entry: copy(entry) };
  }

  function changed(
    scope: string,
    scheduleId: string,
    expectedRevision: number,
    allowed: readonly DurableSchedule['status'][],
    edit: (schedule: DurableSchedule) => void,
  ) {
    const schedule = schedules.get(scheduleKey(scope, scheduleId));
    if (!schedule || schedule.revision !== expectedRevision || !allowed.includes(schedule.status))
      return { status: 'conflict' as const };
    edit(schedule);
    schedule.revision += 1;
    schedule.updatedAt = clock.now();
    return { status: 'committed' as const, schedule: copy(schedule) };
  }

  const store: ScheduleStoreDouble = {
    occurrenceRecords: () => copy(occurrences),

    async load(goalId, query) {
      const goal = goals.load(goalId) as GoalRecord | undefined;
      if (!goal || (query?.scope !== undefined && goal.scope !== query.scope)) return undefined;
      return goal;
    },
    async save(record) {
      saveGoal(record);
    },
    list: (query) => goals.list(query),

    runtime: {
      async get(scope, goalId) {
        const state = runtime.get(goalKey(scope, goalId));
        return state && copy(state);
      },
      async save(state, goal): Promise<GoalRuntimeCommitResult> {
        const stored = runtime.get(goalKey(state.scope, state.goalId));
        if (state.revision !== (stored?.revision ?? 0) + 1)
          return { status: 'conflict', reason: 'runtime-revision' };
        if (goal) {
          if (goal.scope !== state.scope || goal.goalId !== state.goalId)
            return { status: 'conflict', reason: 'scope-mismatch' };
          const current = goals.load(goal.goalId) as GoalRecord | undefined;
          if (goal.revision !== (current?.revision ?? 0) + 1)
            return { status: 'conflict', reason: 'goal-revision' };
          saveGoal(goal);
        }
        runtime.set(goalKey(state.scope, state.goalId), copy(state));
        return { status: 'committed' };
      },
    },

    inbox: {
      async enqueue(delivery) {
        return enqueueNow(delivery);
      },
      async apply(application): Promise<GoalRuntimeCommitResult> {
        const entry = inbox.get(application.entryId);
        if (!entry || entry.scope !== application.scope || entry.goalId !== application.goalId)
          return { status: 'conflict', reason: 'scope-mismatch' };
        if (entry.disposition !== 'pending') return { status: 'conflict', reason: 'entry-settled' };
        const { goal, runtime: state, intent } = application;
        if (goal) {
          if (goal.scope !== application.scope || goal.goalId !== application.goalId)
            return { status: 'conflict', reason: 'scope-mismatch' };
          const current = storedGoal(application.scope, application.goalId);
          if (goal.revision !== (current?.revision ?? 0) + 1)
            return { status: 'conflict', reason: 'goal-revision' };
        }
        if (state) {
          const stored = runtime.get(goalKey(application.scope, application.goalId));
          if (state.revision !== (stored?.revision ?? 0) + 1)
            return { status: 'conflict', reason: 'runtime-revision' };
        }
        if (intent && intents.has(goalKey(application.scope, intent.intentId)))
          return { status: 'conflict', reason: 'intent-exists' };
        // Every check passed: write all of it.
        if (goal) saveGoal(goal);
        if (state) runtime.set(goalKey(application.scope, application.goalId), copy(state));
        const now = clock.now();
        if (intent)
          intents.set(goalKey(application.scope, intent.intentId), {
            ...copy(intent),
            status: 'pending',
            revision: 1,
            recordedAt: now,
            updatedAt: now,
          });
        entry.disposition = application.disposition;
        entry.settledAt = now;
        if (goal) entry.goalRevision = goal.revision;
        if (intent) entry.intentId = intent.intentId;
        return { status: 'committed' };
      },
      async get(scope, entryId) {
        const entry = inbox.get(entryId);
        if (!entry || entry.scope !== scope) return undefined;
        const { seq: _seq, ...rest } = entry;
        return copy(rest);
      },
      async list(query: GoalInboxQuery) {
        const limit = planLimit(query.limit);
        const dispositions = query.dispositions ?? ['pending'];
        const after = query.cursor === undefined ? -1 : Number(query.cursor);
        const matches = [...inbox.values()]
          .filter(
            (entry) =>
              entry.scope === query.scope &&
              (query.goalId === undefined || entry.goalId === query.goalId) &&
              dispositions.includes(entry.disposition) &&
              (query.dueBy === undefined ||
                (entry.disposition === 'pending' &&
                  (entry.event.notBefore === undefined || entry.event.notBefore <= query.dueBy))) &&
              entry.seq > after,
          )
          .sort((left, right) => left.seq - right.seq);
        const page = matches.slice(0, limit);
        const entries = page.map(({ seq: _seq, ...entry }) => copy(entry));
        return matches.length > limit ? { entries, cursor: String(page.at(-1)!.seq) } : { entries };
      },
    },

    schedules: {
      async put(input, options) {
        const key = scheduleKey(input.scope, input.scheduleId);
        const existing = schedules.get(key);
        const now = clock.now();
        if (options.expectedRevision === 0) {
          if (existing) return { status: 'conflict' };
          // Only the definition is taken from the input, never its status, cursor or times.
          const schedule: DurableSchedule = {
            scheduleId: input.scheduleId,
            scope: input.scope,
            goalId: input.goalId,
            spec: copy(input.spec),
            ...(input.event ? { event: copy(input.event) } : {}),
            status: 'active',
            revision: 1,
            effectiveFrom: options.effectiveFrom,
            scheduleCursor: options.effectiveFrom,
            createdAt: now,
            updatedAt: now,
          };
          schedules.set(key, schedule);
          return { status: 'committed', schedule: copy(schedule) };
        }
        return changed(
          input.scope,
          input.scheduleId,
          options.expectedRevision,
          ['active', 'paused'],
          (schedule) => {
            schedule.goalId = input.goalId;
            schedule.spec = copy(input.spec);
            if (input.event) schedule.event = copy(input.event);
            else delete schedule.event;
            schedule.effectiveFrom = options.effectiveFrom;
            delete schedule.scanTo;
          },
        );
      },
      async get(scope, scheduleId) {
        const schedule = schedules.get(scheduleKey(scope, scheduleId));
        return schedule && copy(schedule);
      },
      async list(query: DurableScheduleQuery = {}) {
        const limit = planLimit(query.limit);
        const order = (schedule: DurableSchedule) =>
          JSON.stringify([schedule.scheduleId, schedule.scope]);
        const matches = [...schedules.values()]
          .filter(
            (schedule) =>
              (query.scope === undefined || schedule.scope === query.scope) &&
              (query.goalId === undefined || schedule.goalId === query.goalId) &&
              (query.statuses === undefined || query.statuses.includes(schedule.status)) &&
              (query.cursor === undefined || order(schedule) > query.cursor),
          )
          .sort((left, right) => (order(left) < order(right) ? -1 : 1));
        const page = matches.slice(0, limit).map(copy);
        return matches.length > limit
          ? { schedules: page, cursor: order(page.at(-1)!) }
          : { schedules: page };
      },
      async pause(scope, scheduleId, options) {
        return changed(scope, scheduleId, options.expectedRevision, ['active'], (schedule) => {
          schedule.status = 'paused';
        });
      },
      async resume(scope, scheduleId, options) {
        return changed(scope, scheduleId, options.expectedRevision, ['paused'], (schedule) => {
          schedule.status = 'active';
          schedule.effectiveFrom = options.effectiveFrom;
          delete schedule.scanTo;
        });
      },
      async cancel(scope, scheduleId, options) {
        const result = changed(
          scope,
          scheduleId,
          options.expectedRevision,
          ['active', 'paused'],
          (schedule) => {
            schedule.status = 'cancelled';
          },
        );
        if (result.status === 'committed') {
          const now = clock.now();
          const ids = new Set(
            occurrences
              .filter((record) => record.scope === scope && record.scheduleId === scheduleId)
              .map((record) => record.inboxEntryId),
          );
          for (const entry of inbox.values())
            if (ids.has(entry.id) && entry.disposition === 'pending') {
              entry.disposition = 'cancelled';
              entry.settledAt = now;
            }
        }
        return result;
      },
      async advance(advance: ScheduleAdvance) {
        if (advance.toCursor < advance.fromCursor)
          throw new TypeError('An advance never moves the cursor back');
        const schedule = schedules.get(scheduleKey(advance.scope, advance.scheduleId));
        if (
          !schedule ||
          schedule.status !== 'active' ||
          schedule.revision !== advance.expectedRevision ||
          schedule.scheduleCursor !== advance.fromCursor
        )
          return { status: 'conflict', ...(schedule ? { schedule: copy(schedule) } : {}) };
        const now = clock.now();
        let enqueued = 0;
        let duplicates = 0;
        for (const { delivery, ...occurrence } of advance.occurrences) {
          const record: ScheduleOccurrenceRecord = { ...copy(occurrence), recordedAt: now };
          if (occurrence.disposition === 'delivered' && delivery) {
            const result = enqueueNow(delivery);
            if (result.status === 'enqueued') enqueued += 1;
            else duplicates += 1;
            record.inboxEntryId = result.entry.id;
          }
          occurrences.push(record);
        }
        schedule.scheduleCursor = advance.toCursor;
        if (advance.scanTo === undefined) delete schedule.scanTo;
        else schedule.scanTo = advance.scanTo;
        schedule.updatedAt = now;
        return { status: 'advanced', schedule: copy(schedule), enqueued, duplicates };
      },
    },

    intents: {
      async record(intent) {
        const key = goalKey(intent.scope, intent.intentId);
        if (intents.has(key)) return { status: 'conflict', reason: 'intent-exists' };
        const now = clock.now();
        intents.set(key, {
          ...copy(intent),
          status: 'pending',
          revision: 1,
          recordedAt: now,
          updatedAt: now,
        });
        return { status: 'committed' };
      },
      async get(scope, intentId) {
        const intent = intents.get(goalKey(scope, intentId));
        return intent && copy(intent);
      },
      claim: missing('intents.claim'),
      launched: missing('intents.launched'),
      complete: missing('intents.complete'),
      list: missing('intents.list'),
    },

    watermarks: { get: missing('watermarks.get'), advance: missing('watermarks.advance') },

    async prunePayloads({ before, scope }) {
      let count = 0;
      for (const entry of inbox.values())
        if (
          entry.disposition !== 'pending' &&
          entry.settledAt !== undefined &&
          entry.settledAt < before &&
          (scope === undefined || entry.scope === scope) &&
          entry.payload
        ) {
          delete entry.payload;
          entry.payloadPruned = true;
          count += 1;
        }
      return count;
    },
    async pruneInbox({ before, scope }) {
      let count = 0;
      for (const [id, entry] of inbox)
        if (
          entry.disposition !== 'pending' &&
          entry.settledAt !== undefined &&
          entry.settledAt < before &&
          (scope === undefined || entry.scope === scope)
        ) {
          inbox.delete(id);
          count += 1;
        }
      return count;
    },
    async pruneOccurrences({ before, scope }) {
      const kept = occurrences.filter(
        (record) =>
          !(record.recordedAt < before && (scope === undefined || record.scope === scope)),
      );
      const count = occurrences.length - kept.length;
      occurrences = kept;
      return count;
    },
    async pruneIntents() {
      return 0;
    },
  };
  return store;
}

/** What `withStoreFaults` does around one call: crash before it commits, or after. */
export type StoreFault = 'before' | 'after' | undefined;

/** A process dying mid-call, as the caller sees it. */
export class SimulatedCrash extends Error {
  override readonly name = 'SimulatedCrash';
}

export interface StoreFaultPlan {
  /** Asked before each `schedules.advance`, with its 1-based call number. */
  advance?: (call: number, advance: ScheduleAdvance) => StoreFault;
  /** Asked before each `inbox.enqueue`, with its 1-based call number. */
  enqueue?: (call: number, delivery: GoalInboxEnqueue) => StoreFault;
}

function overlay<T extends object>(target: T, overrides: Partial<T>): T {
  return new Proxy(target, {
    get(object, property) {
      if (Object.prototype.hasOwnProperty.call(overrides, property))
        return overrides[property as keyof T];
      const value = Reflect.get(object, property, object) as unknown;
      return typeof value === 'function'
        ? (value as (...args: unknown[]) => unknown).bind(object)
        : value;
    },
  });
}

/**
 * The same store, with crashes where the plan says: `'before'` throws
 * `SimulatedCrash` without calling the store (nothing committed), `'after'`
 * calls it and then throws (committed, but the caller never learns it).
 */
export function withStoreFaults<S extends GoalRuntimeStore>(store: S, plan: StoreFaultPlan): S {
  let advances = 0;
  let enqueues = 0;
  const around = async <R>(fault: StoreFault, call: () => Promise<R>): Promise<R> => {
    if (fault === 'before') throw new SimulatedCrash('crashed before the write');
    const result = await call();
    if (fault === 'after') throw new SimulatedCrash('crashed after the write');
    return result;
  };
  const schedules = overlay(store.schedules, {
    advance: (advance: ScheduleAdvance) =>
      around(plan.advance?.(++advances, advance), () => store.schedules.advance(advance)),
  });
  const inbox = overlay(store.inbox, {
    enqueue: (delivery: GoalInboxEnqueue) =>
      around(plan.enqueue?.(++enqueues, delivery), () => store.inbox.enqueue(delivery)),
  });
  return overlay(store, { schedules, inbox } as Partial<S>);
}

/**
 * The real in-memory `GoalRuntimeStore` once lane L4a has landed (it no
 * longer throws `NotImplementedError`), else the double: tests and scenarios
 * that only use the store interface run on the real store after the merge.
 */
export function makeGoalRuntimeStore(deps?: Dependencies): GoalRuntimeStore {
  try {
    return createInMemoryGoalRuntimeStore(deps ? { deps } : undefined);
  } catch (error) {
    if (error instanceof NotImplementedError)
      return createScheduleStoreDouble(deps ? { deps } : {});
    throw error;
  }
}
