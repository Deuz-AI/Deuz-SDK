/**
 * `@deuz-sdk/core/goal/runtime/postgres` (2.4): the goal runtime store on
 * PostgreSQL (`pg` peer). New tables with their own
 * `deuz_goal_runtime_schema` version table; each multi-part write pins one
 * pooled connection in one transaction. Node-only.
 *
 * A write reads what it touches with `SELECT ... FOR UPDATE`, decides and
 * writes in one `withPgTransaction`, so concurrent writers on other
 * connections queue on the rows instead of overwriting each other. A row
 * another writer inserted first (the same new inbox entry, intent or goal)
 * fails the insert with a unique violation; the transaction then runs again
 * and answers duplicate or conflict. Ids and other compared text are
 * `COLLATE "C"` (byte order, as the other stores list), and times are
 * `DOUBLE PRECISION`, which keeps every JavaScript number exactly.
 */
import type {
  GoalRuntimeStore,
  ScheduleOccurrencePage,
  ScheduleOccurrenceQuery,
} from '../goal/runtime/store-types';
import type { Clock } from '../types/deps';
import { InvalidRequestError } from '../errors';
import { resolveDependencies } from '../internal/resolve-deps';
import { goalListCursor, planGoalList } from '../goal/store';
import {
  checkAdvance,
  checkApplication,
  checkClaim,
  checkCompletion,
  checkEnqueue,
  checkGoal,
  checkIntentInput,
  checkIntentRecordOptions,
  checkMark,
  checkOccurrencePruneOptions,
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
import type { PostgresConnectionOptions } from './store-connection';
import { assertPgPool, ensurePgSchema, withPgTransaction, type PgPoolLike } from './pg-tx';
import { SERIALIZATION_CODES } from './postgres-migrate';
import {
  GOAL_RUNTIME_SCHEMA_NAME,
  GOAL_RUNTIME_SCHEMA_VERSION,
  goalRuntimeSql,
  type GoalRuntimeOperation,
  type SqlRead,
  type SqlStatement,
} from './goal-runtime-sql';

/** Options of `createPostgresGoalRuntimeStore`. */
export type PostgresGoalRuntimeStoreOptions = PostgresConnectionOptions & {
  /** The store clock (2.4). Every process sharing the database must agree on it. Default: the host clock. */
  clock?: Clock;
};

/** A PostgreSQL `GoalRuntimeStore` with an explicit `migrate`. */
export type PostgresGoalRuntimeStore = GoalRuntimeStore & {
  schedules: {
    occurrences(query: ScheduleOccurrenceQuery): Promise<ScheduleOccurrencePage>;
  };
  /** Creates or upgrades the schema; idempotent, memoized, retried after a failure. */
  migrate(): Promise<void>;
  close(): Promise<void>;
};

const FACTORY = 'createPostgresGoalRuntimeStore';
const SCHEMA_NAME_PATTERN = /^[a-z_][a-z0-9_]*$/;
/** A unique violation from a writer that inserted first: run again and see its row. */
const RETRY_ON: readonly string[] = [...SERIALIZATION_CODES, '23505'];

interface PgModule {
  Pool?: new (config: { connectionString: string }) => PgPoolLike;
  default?: { Pool?: new (config: { connectionString: string }) => PgPoolLike };
}

async function openPool(connectionString: string): Promise<PgPoolLike> {
  let mod: PgModule;
  try {
    mod = (await import('pg' as string)) as unknown as PgModule;
  } catch (cause) {
    throw new InvalidRequestError({
      message: `${FACTORY}({ connectionString }) needs the optional peer 'pg' (npm i pg), or pass { pool }.`,
      cause,
    });
  }
  const Pool = mod.Pool ?? mod.default?.Pool;
  if (!Pool) throw new InvalidRequestError({ message: `${FACTORY}: 'pg' exports no Pool.` });
  return new Pool({ connectionString });
}

/** The PostgreSQL goal runtime store (2.4). */
export function createPostgresGoalRuntimeStore(
  options: PostgresGoalRuntimeStoreOptions,
): PostgresGoalRuntimeStore {
  const schema = options.schema ?? 'public';
  if (!SCHEMA_NAME_PATTERN.test(schema) || schema.length > 63)
    throw new TypeError(
      `Invalid Postgres schema name ${JSON.stringify(schema)}: use lower-case letters, digits and underscores.`,
    );
  const injected = 'pool' in options ? options.pool : undefined;
  if (injected) assertPgPool(injected, FACTORY);
  else if (!('connectionString' in options) || typeof options.connectionString !== 'string')
    throw new TypeError(`${FACTORY} needs { pool } or { connectionString }.`);
  const clock = options.clock ?? resolveDependencies().clock;
  const SQL = goalRuntimeSql({
    table: (name) => `${schema}.deuz_goal_runtime_${name}`,
    text: 'TEXT COLLATE "C"',
    integer: 'BIGINT',
    time: 'DOUBLE PRECISION',
    placeholder: (n) => `$${n}`,
    lock: ' FOR UPDATE',
  });

  let closed = false;
  let opening: Promise<PgPoolLike> | undefined;
  let migration: Promise<void> | undefined;
  const pool = (): Promise<PgPoolLike> => {
    opening ??= injected
      ? Promise.resolve(injected)
      : openPool((options as { connectionString: string }).connectionString);
    return opening;
  };
  const migrate = (): Promise<void> => {
    migration ??= (async () => {
      await ensurePgSchema(await pool(), {
        name: GOAL_RUNTIME_SCHEMA_NAME,
        version: GOAL_RUNTIME_SCHEMA_VERSION,
        create: SQL.schema,
        schema,
      });
    })();
    // A failed migration is not cached: the next call tries again.
    migration.catch(() => {
      migration = undefined;
    });
    return migration;
  };
  const ready = async (): Promise<PgPoolLike> => {
    if (closed) throw new Error('PostgreSQL goal runtime store is closed');
    await migrate();
    return pool();
  };

  const query = async <T>(request: SqlRead<T>): Promise<T> => {
    const { rows } = await (await ready()).query(request.sql, request.params);
    return request.decode(rows);
  };

  /**
   * Drives a write method and applies its plan in one transaction on one
   * connection. A rerun (serialization failure, deadlock, unique violation)
   * builds the method again: it has no effect outside the transaction.
   */
  const transact = async <R>(operation: () => GoalRuntimeOperation<R>): Promise<R> =>
    withPgTransaction(
      await ready(),
      async (tx) => {
        const steps = operation();
        let step = steps.next();
        while (!step.done) {
          const { rows } = await tx.query(step.value.sql, step.value.params);
          step = steps.next(step.value.decode(rows));
        }
        const plan: GoalRuntimePlan<R> = step.value;
        for (const write of plan.writes) {
          const { sql, params } = SQL.write(write);
          await tx.query(sql, params);
        }
        return plan.result;
      },
      { retryOn: RETRY_ON },
    );

  const prune = async ({ sql, params }: SqlStatement): Promise<number> => {
    const { rows } = await (
      await ready()
    ).query(`WITH pruned AS (${sql} RETURNING 1) SELECT COUNT(*) AS n FROM pruned`, params);
    return Number(rows[0]?.n ?? 0);
  };

  return {
    migrate,
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
      async record(intent, recordOptions) {
        const next = checkIntentInput(intent);
        const along = checkIntentRecordOptions(recordOptions);
        const now = clock.now();
        return transact(() => SQL.operations.recordIntent(next, along, now));
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
      return prune(SQL.retention.occurrences(checkOccurrencePruneOptions(pruneOptions)));
    },
    async pruneIntents(pruneOptions) {
      return prune(SQL.retention.intents(checkPruneOptions(pruneOptions)));
    },
    async close() {
      closed = true;
      // A pool opened from `connectionString` is created asynchronously: settle it first.
      const opened = await opening?.catch(() => undefined);
      if (!injected && opened?.end) await opened.end();
    },
  };
}
