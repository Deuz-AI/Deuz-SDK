/**
 * `@deuz-sdk/core/goal/runtime/sqlite` (2.4): the goal runtime store on
 * `node:sqlite`, the first durable `GoalStore`. New tables with their own
 * `deuz_goal_runtime_schema` version table; every multi-part write is one
 * `BEGIN IMMEDIATE` transaction. Several processes may share the file.
 * Node-only.
 *
 * A write validates its input and reads the clock first, then reads what it
 * touches, decides and writes inside one synchronous transaction: `BEGIN
 * IMMEDIATE` takes the write lock before the first read, so a writer in
 * another process can never slip in between the read and the write.
 */
import type {
  GoalRuntimeStore,
  ScheduleOccurrencePage,
  ScheduleOccurrenceQuery,
} from '../goal/runtime/store-types';
import type { Clock } from '../types/deps';
import { resolveDependencies } from '../internal/resolve-deps';
import { planGoalList, goalListCursor } from '../goal/store';
import {
  checkAdvance,
  checkApplication,
  checkClaim,
  checkCompletion,
  checkEnqueue,
  checkGoal,
  checkIntentInput,
  checkMark,
  checkPruneOptions,
  checkRuntimeState,
  checkScheduleInput,
  checkScheduleOptions,
  checkWatermarkAdvance,
  inboxKey,
  intentKey,
  occurrenceKey,
  pageOf,
  planInboxList,
  planIntentList,
  planOccurrenceList,
  planScheduleList,
  scheduleKey,
  scheduleNamespace,
  type GoalRuntimePlan,
} from '../goal/runtime/store-shared';
import type { SqliteConnectionOptions } from './store-connection';
import type { SqliteDatabaseLike } from './store-sqlite';
import {
  createSqliteConnection,
  createSqliteStatementCache,
  ensureSqliteSchema,
  sqliteTransaction,
  sqliteUnavailableMessage,
} from './sqlite-handle';
import {
  GOAL_RUNTIME_SCHEMA_NAME,
  GOAL_RUNTIME_SCHEMA_VERSION,
  goalRuntimeSql,
  type GoalRuntimeOperation,
  type SqlRead,
  type SqlRow,
  type SqlStatement,
} from './goal-runtime-sql';

/** Options of `createSqliteGoalRuntimeStore`. */
export type SqliteGoalRuntimeStoreOptions = SqliteConnectionOptions & {
  /** The store clock. Every process sharing the file must agree on it. */
  clock?: Clock;
};

/** A SQLite `GoalRuntimeStore`; `close()` closes only a connection it opened. */
export type SqliteGoalRuntimeStore = GoalRuntimeStore & {
  schedules: {
    occurrences(query: ScheduleOccurrenceQuery): Promise<ScheduleOccurrencePage>;
  };
  close(): Promise<void>;
};

const SQL = goalRuntimeSql({
  table: (name) => `deuz_goal_runtime_${name}`,
  text: 'TEXT',
  integer: 'INTEGER',
  placeholder: () => '?',
  lock: '',
});

/** The SQLite goal runtime store (2.4). */
export function createSqliteGoalRuntimeStore(
  options: SqliteGoalRuntimeStoreOptions,
): SqliteGoalRuntimeStore {
  const clock = options.clock ?? resolveDependencies().clock;
  const statement = createSqliteStatementCache();
  const connection = createSqliteConnection<SqliteDatabaseLike>(
    options.database
      ? // A borrowed handle keeps its journal mode: ':memory:' skips the WAL switch.
        { path: ':memory:', database: options.database }
      : { path: options.path, ...(options.wal !== undefined ? { wal: options.wal } : {}) },
    {
      injected: 'borrowed',
      closedMessage: 'SQLite goal runtime store is closed',
      unavailable: sqliteUnavailableMessage('createSqliteGoalRuntimeStore'),
      setup(db) {
        ensureSqliteSchema(db, {
          name: GOAL_RUNTIME_SCHEMA_NAME,
          version: GOAL_RUNTIME_SCHEMA_VERSION,
          create: SQL.schema,
        });
        return db;
      },
    },
  );

  const all = (db: SqliteDatabaseLike, { sql, params }: SqlStatement): SqlRow[] =>
    statement(db, sql).all(...params) as SqlRow[];
  const run = (db: SqliteDatabaseLike, { sql, params }: SqlStatement): number => {
    const result = statement(db, sql).run(...params) as { changes?: number | bigint } | undefined;
    return Number(result?.changes ?? 0);
  };
  const query = <T>(request: SqlRead<T>): Promise<T> =>
    connection.use((db) => request.decode(all(db, request)));

  /** Drives a write method and applies its plan, in one synchronous transaction. */
  const transact = <R>(operation: () => GoalRuntimeOperation<R>): Promise<R> =>
    connection.use((db) =>
      sqliteTransaction(db, () => {
        const steps = operation();
        let step = steps.next();
        while (!step.done) step = steps.next(step.value.decode(all(db, step.value)));
        const plan: GoalRuntimePlan<R> = step.value;
        for (const write of plan.writes) run(db, SQL.write(write));
        return plan.result;
      }),
    );

  const prune = (request: SqlStatement): Promise<number> =>
    connection.use((db) => run(db, request));

  return {
    async load(goalId, loadOptions) {
      return query(SQL.lookups.goal(goalId, loadOptions?.scope));
    },
    async save(record) {
      const next = checkGoal(record);
      await transact(() => SQL.operations.saveGoal(next));
    },
    async list(listQuery) {
      const plan = planGoalList(listQuery);
      if (plan.statuses?.length === 0) return { goals: [] };
      const rows = await query(SQL.listings.goals(plan));
      const goals = rows.slice(0, plan.limit);
      const last = goals.at(-1);
      return rows.length > plan.limit && last ? { goals, cursor: goalListCursor(last) } : { goals };
    },
    runtime: {
      async get(scope, goalId) {
        return query(SQL.lookups.runtime(scope, goalId));
      },
      async save(state, goal) {
        const next = checkRuntimeState(state);
        const nextGoal = goal === undefined ? undefined : checkGoal(goal);
        return transact(() => SQL.operations.saveRuntime(next, nextGoal));
      },
    },
    inbox: {
      async enqueue(delivery) {
        const next = checkEnqueue(delivery);
        const now = clock.now();
        return transact(() => SQL.operations.enqueue(next, now));
      },
      async apply(application) {
        const next = checkApplication(application);
        const now = clock.now();
        return transact(() => SQL.operations.apply(next, now));
      },
      async get(scope, entryId) {
        return query(SQL.lookups.entry(scope, entryId));
      },
      async list(listQuery) {
        const plan = planInboxList(listQuery);
        if (plan.dispositions.length === 0) return { entries: [] };
        const page = pageOf(await query(SQL.listings.inbox(plan)), plan.limit, inboxKey);
        return page.cursor ? { entries: page.rows, cursor: page.cursor } : { entries: page.rows };
      },
    },
    schedules: {
      async put(schedule, putOptions) {
        const input = checkScheduleInput(schedule);
        const change = checkScheduleOptions(putOptions, true);
        const now = clock.now();
        return transact(() => SQL.operations.putSchedule(input, change, now));
      },
      async get(scope, scheduleId) {
        return query(SQL.lookups.schedule(scope, scheduleId));
      },
      async list(listQuery) {
        const plan = planScheduleList(listQuery);
        if (plan.statuses?.length === 0) return { schedules: [] };
        const page = pageOf(await query(SQL.listings.schedules(plan)), plan.limit, scheduleKey);
        return page.cursor
          ? { schedules: page.rows, cursor: page.cursor }
          : { schedules: page.rows };
      },
      async pause(scope, scheduleId, pauseOptions) {
        const change = checkScheduleOptions(pauseOptions, false);
        const now = clock.now();
        return transact(() => SQL.operations.pauseSchedule(scope, scheduleId, change, now));
      },
      async resume(scope, scheduleId, resumeOptions) {
        const change = checkScheduleOptions(resumeOptions, true);
        const now = clock.now();
        return transact(() => SQL.operations.resumeSchedule(scope, scheduleId, change, now));
      },
      async cancel(scope, scheduleId, cancelOptions) {
        const change = checkScheduleOptions(cancelOptions, false);
        const now = clock.now();
        return transact(() =>
          SQL.operations.cancelSchedule(
            scope,
            scheduleId,
            scheduleNamespace(scheduleId),
            change,
            now,
          ),
        );
      },
      async advance(step) {
        const next = checkAdvance(step);
        const now = clock.now();
        return transact(() => SQL.operations.advance(next, now));
      },
      async occurrences(listQuery) {
        const plan = planOccurrenceList(listQuery);
        const page = pageOf(await query(SQL.listings.occurrences(plan)), plan.limit, occurrenceKey);
        return page.cursor
          ? { occurrences: page.rows, cursor: page.cursor }
          : { occurrences: page.rows };
      },
    },
    intents: {
      async record(intent) {
        const next = checkIntentInput(intent);
        const now = clock.now();
        return transact(() => SQL.operations.recordIntent(next, now));
      },
      async get(scope, intentId) {
        return query(SQL.lookups.intent(scope, intentId));
      },
      async claim(scope, intentId, claim) {
        const next = checkClaim(claim);
        const now = clock.now();
        return transact(() => SQL.operations.claimIntent(scope, intentId, next, now));
      },
      async launched(scope, intentId, mark) {
        const next = checkMark(mark);
        const now = clock.now();
        return transact(() => SQL.operations.launchIntent(scope, intentId, next, now));
      },
      async complete(scope, intentId, completion) {
        const next = checkCompletion(completion);
        const now = clock.now();
        return transact(() => SQL.operations.completeIntent(scope, intentId, next, now));
      },
      async list(listQuery) {
        const plan = planIntentList(listQuery);
        if (plan.statuses.length === 0) return { intents: [] };
        const page = pageOf(await query(SQL.listings.intents(plan)), plan.limit, intentKey);
        return page.cursor ? { intents: page.rows, cursor: page.cursor } : { intents: page.rows };
      },
    },
    watermarks: {
      async get(scope, goalId, runId) {
        return query(SQL.lookups.watermark(scope, goalId, runId));
      },
      async advance(advance) {
        const next = checkWatermarkAdvance(advance);
        const now = clock.now();
        return transact(() => SQL.operations.advanceWatermark(next, now));
      },
    },
    async prunePayloads(pruneOptions) {
      return prune(SQL.retention.payloads(checkPruneOptions(pruneOptions)));
    },
    async pruneInbox(pruneOptions) {
      return prune(SQL.retention.inbox(checkPruneOptions(pruneOptions)));
    },
    async pruneOccurrences(pruneOptions) {
      return prune(SQL.retention.occurrences(checkPruneOptions(pruneOptions)));
    },
    async pruneIntents(pruneOptions) {
      return prune(SQL.retention.intents(checkPruneOptions(pruneOptions)));
    },
    close: () => connection.close(),
  };
}
