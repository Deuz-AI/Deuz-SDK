/**
 * @internal The SQL both durable goal runtime stores run (2.4): the schema,
 * the row codecs, the snapshot each write method reads, the statements that
 * apply a plan's writes, and the listing and retention queries. The SQLite
 * and PostgreSQL stores differ only in their dialect (placeholders, column
 * types, row locks) and in how they run a statement: synchronously inside
 * `BEGIN IMMEDIATE`, or awaited on one pinned pooled connection.
 *
 * A write method is a generator: it yields the reads its snapshot needs, one
 * at a time, and returns the planner's answer (`store-shared.ts`). A store
 * drives it inside its transaction, then runs the statements of the writes
 * the plan returned, so reading, deciding and writing commit together.
 *
 * Every table is new and keeps its version in `deuz_goal_runtime_schema`; no
 * 2.3 table or version changes. Records live as JSON text, with the columns a
 * query filters or orders on beside them. Text that is compared or ordered is
 * byte-ordered on both backends (SQLite's BINARY, PostgreSQL's `COLLATE "C"`),
 * the order the in-memory store uses. Node-only.
 */
import { parseGoal } from '../goal/validate';
import type { GoalRecord } from '../goal/types';
import { deliveryKey } from '../goal/runtime/store';
import {
  FINISHED_INTENT_STATUSES,
  planAdvance,
  planApply,
  planEnqueue,
  planGoalSave,
  planIntentClaim,
  planIntentComplete,
  planIntentLaunched,
  planIntentRecord,
  planRuntimeSave,
  planScheduleCancel,
  planSchedulePause,
  planSchedulePut,
  planScheduleResume,
  planWatermarkAdvance,
  type GoalRuntimePlan,
  type GoalRuntimeWrite,
  type InboxListPlan,
  type IntentListPlan,
  type OccurrenceListPlan,
  type ScheduleListPlan,
  type StoredGoal,
  type checkCompletion,
} from '../goal/runtime/store-shared';
import type { GoalListPlan } from '../goal/store';
import type {
  DurableSchedule,
  DurableScheduleInput,
  GoalInboxApplication,
  GoalInboxEnqueue,
  GoalInboxEntry,
  GoalLedgerWatermark,
  GoalRunIntent,
  GoalRunIntentInput,
  GoalRuntimePruneOptions,
  GoalRuntimeState,
  GoalWatermarkAdvance,
  ScheduleAdvance,
  ScheduleOccurrenceRecord,
} from '../goal/runtime/store-types';

/** The schema-meta name and version: `deuz_goal_runtime_schema` holds the version. */
export const GOAL_RUNTIME_SCHEMA_NAME = 'deuz_goal_runtime';
export const GOAL_RUNTIME_SCHEMA_VERSION = 1;

type TableName =
  | 'goals'
  | 'states'
  | 'inbox'
  | 'schedules'
  | 'occurrences'
  | 'intents'
  | 'watermarks';

/** What sets one backend's SQL apart from the other's. */
export interface GoalRuntimeDialect {
  /** A table as the SQL names it: `deuz_goal_runtime_<name>`, schema-qualified on PostgreSQL. */
  table(name: TableName): string;
  /** The type of compared text columns: byte-ordered. */
  text: string;
  /** The type of epoch ms, revisions and flags. */
  integer: string;
  /** The placeholder of the n-th parameter, 1-based. */
  placeholder(n: number): string;
  /** What a snapshot read appends for the rows its transaction may write: a row lock or nothing. */
  lock: string;
}

export type SqlRow = Record<string, unknown>;

/** One statement and its parameters. */
export interface SqlStatement {
  sql: string;
  params: unknown[];
}

/** A read and how its rows become a value. */
export interface SqlRead<T> extends SqlStatement {
  decode(rows: SqlRow[]): T;
}

/** A write method: yields reads, gets their values back, returns the plan. */
export type GoalRuntimeOperation<R> = Generator<SqlRead<unknown>, GoalRuntimePlan<R>, unknown>;

/** Parameters bound in order, each written as the dialect's placeholder. */
class Params {
  readonly values: unknown[] = [];
  constructor(private readonly placeholder: (n: number) => string) {}
  add(value: unknown): string {
    this.values.push(value);
    return this.placeholder(this.values.length);
  }
  list(values: readonly unknown[]): string {
    return values.map((value) => this.add(value)).join(', ');
  }
}

// ===================================================================
// Schema
// ===================================================================

/** The `CREATE ... IF NOT EXISTS` statements of the current version, one statement each. */
export function goalRuntimeSchema(d: GoalRuntimeDialect): string[] {
  const t = d.table;
  const T = d.text;
  const I = d.integer;
  return [
    `CREATE TABLE IF NOT EXISTS ${t('goals')} (goal_id ${T} PRIMARY KEY, scope ${T} NOT NULL, revision ${I} NOT NULL, status ${T} NOT NULL, updated_at ${I} NOT NULL, record TEXT NOT NULL)`,
    `CREATE INDEX IF NOT EXISTS deuz_goal_runtime_goals_updated_idx ON ${t('goals')} (updated_at, goal_id)`,
    `CREATE INDEX IF NOT EXISTS deuz_goal_runtime_goals_scope_idx ON ${t('goals')} (scope, updated_at, goal_id)`,
    `CREATE TABLE IF NOT EXISTS ${t('states')} (goal_id ${T} PRIMARY KEY, scope ${T} NOT NULL, revision ${I} NOT NULL, state TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS ${t('inbox')} (id ${T} PRIMARY KEY, scope ${T} NOT NULL, goal_id ${T} NOT NULL, namespace ${T} NOT NULL, disposition ${T} NOT NULL, not_before ${I}, enqueued_at ${I} NOT NULL, settled_at ${I}, payload_body TEXT, payload_media_type TEXT, payload_pruned ${I} NOT NULL DEFAULT 0, entry TEXT NOT NULL)`,
    `CREATE INDEX IF NOT EXISTS deuz_goal_runtime_inbox_list_idx ON ${t('inbox')} (scope, disposition, enqueued_at, id)`,
    `CREATE INDEX IF NOT EXISTS deuz_goal_runtime_inbox_namespace_idx ON ${t('inbox')} (scope, namespace, disposition)`,
    `CREATE INDEX IF NOT EXISTS deuz_goal_runtime_inbox_settled_idx ON ${t('inbox')} (settled_at)`,
    `CREATE TABLE IF NOT EXISTS ${t('schedules')} (scope ${T} NOT NULL, schedule_id ${T} NOT NULL, goal_id ${T} NOT NULL, status ${T} NOT NULL, schedule TEXT NOT NULL, PRIMARY KEY (scope, schedule_id))`,
    `CREATE INDEX IF NOT EXISTS deuz_goal_runtime_schedules_list_idx ON ${t('schedules')} (schedule_id, scope)`,
    `CREATE TABLE IF NOT EXISTS ${t('occurrences')} (scope ${T} NOT NULL, occurrence_id ${T} NOT NULL, schedule_id ${T} NOT NULL, at ${I} NOT NULL, inbox_entry_id ${T}, recorded_at ${I} NOT NULL, record TEXT NOT NULL, PRIMARY KEY (scope, occurrence_id))`,
    `CREATE INDEX IF NOT EXISTS deuz_goal_runtime_occurrences_list_idx ON ${t('occurrences')} (scope, at, occurrence_id)`,
    `CREATE INDEX IF NOT EXISTS deuz_goal_runtime_occurrences_schedule_idx ON ${t('occurrences')} (scope, schedule_id)`,
    `CREATE INDEX IF NOT EXISTS deuz_goal_runtime_occurrences_recorded_idx ON ${t('occurrences')} (recorded_at)`,
    `CREATE TABLE IF NOT EXISTS ${t('intents')} (scope ${T} NOT NULL, intent_id ${T} NOT NULL, goal_id ${T} NOT NULL, status ${T} NOT NULL, recorded_at ${I} NOT NULL, updated_at ${I} NOT NULL, intent TEXT NOT NULL, PRIMARY KEY (scope, intent_id))`,
    `CREATE INDEX IF NOT EXISTS deuz_goal_runtime_intents_list_idx ON ${t('intents')} (status, recorded_at, scope, intent_id)`,
    `CREATE TABLE IF NOT EXISTS ${t('watermarks')} (scope ${T} NOT NULL, goal_id ${T} NOT NULL, run_id ${T} NOT NULL, revision ${I} NOT NULL, watermark TEXT NOT NULL, PRIMARY KEY (scope, goal_id, run_id))`,
  ];
}

// ===================================================================
// Row codecs
// ===================================================================

const json = (value: unknown): string => JSON.stringify(value);
const parse = <T>(value: unknown): T => JSON.parse(String(value)) as T;

export const decodeGoal = (row: SqlRow): GoalRecord => parseGoal(String(row.record));

/** An entry from its row: the JSON, plus the payload columns retention clears. */
export function decodeEntry(row: SqlRow): GoalInboxEntry {
  const entry = parse<GoalInboxEntry>(row.entry);
  if (row.payload_body !== null && row.payload_body !== undefined)
    entry.payload = {
      body: String(row.payload_body),
      ...(row.payload_media_type !== null && row.payload_media_type !== undefined
        ? { mediaType: String(row.payload_media_type) }
        : {}),
    };
  if (Number(row.payload_pruned)) entry.payloadPruned = true;
  return entry;
}

const ENTRY_COLUMNS = 'entry, payload_body, payload_media_type, payload_pruned' as const;

/** The columns of a row to write, by name; `key` names the primary key columns. */
function rowOf(write: GoalRuntimeWrite): { table: TableName; key: string[]; columns: SqlRow } {
  switch (write.kind) {
    case 'goal': {
      const { record } = write;
      return {
        table: 'goals',
        key: ['goal_id'],
        columns: {
          goal_id: record.goalId,
          scope: record.scope,
          revision: record.revision,
          status: record.status,
          updated_at: record.updatedAt,
          record: json(record),
        },
      };
    }
    case 'runtime': {
      const { state } = write;
      return {
        table: 'states',
        key: ['goal_id'],
        columns: {
          goal_id: state.goalId,
          scope: state.scope,
          revision: state.revision,
          state: json(state),
        },
      };
    }
    case 'entry': {
      const { payload, payloadPruned: _pruned, ...entry } = write.entry;
      return {
        table: 'inbox',
        key: ['id'],
        columns: {
          id: entry.id,
          scope: entry.scope,
          goal_id: entry.goalId,
          namespace: entry.namespace,
          disposition: entry.disposition,
          not_before: entry.event.notBefore ?? null,
          enqueued_at: entry.enqueuedAt,
          settled_at: entry.settledAt ?? null,
          payload_body: payload?.body ?? null,
          payload_media_type: payload?.mediaType ?? null,
          payload_pruned: write.entry.payloadPruned ? 1 : 0,
          entry: json(entry),
        },
      };
    }
    case 'intent': {
      const { intent } = write;
      return {
        table: 'intents',
        key: ['scope', 'intent_id'],
        columns: {
          scope: intent.scope,
          intent_id: intent.intentId,
          goal_id: intent.goalId,
          status: intent.status,
          recorded_at: intent.recordedAt,
          updated_at: intent.updatedAt,
          intent: json(intent),
        },
      };
    }
    case 'schedule': {
      const { schedule } = write;
      return {
        table: 'schedules',
        key: ['scope', 'schedule_id'],
        columns: {
          scope: schedule.scope,
          schedule_id: schedule.scheduleId,
          goal_id: schedule.goalId,
          status: schedule.status,
          schedule: json(schedule),
        },
      };
    }
    case 'occurrence': {
      const { record } = write;
      return {
        table: 'occurrences',
        key: ['scope', 'occurrence_id'],
        columns: {
          scope: record.scope,
          occurrence_id: record.occurrenceId,
          schedule_id: record.scheduleId,
          at: record.at,
          inbox_entry_id: record.inboxEntryId ?? null,
          recorded_at: record.recordedAt,
          record: json(record),
        },
      };
    }
    case 'watermark': {
      const { watermark } = write;
      return {
        table: 'watermarks',
        key: ['scope', 'goal_id', 'run_id'],
        columns: {
          scope: watermark.scope,
          goal_id: watermark.goalId,
          run_id: watermark.runId,
          revision: watermark.revision,
          watermark: json(watermark),
        },
      };
    }
  }
}

/** The statement of one write: an INSERT for a new row, an UPDATE by primary key otherwise. */
export function writeStatement(d: GoalRuntimeDialect, write: GoalRuntimeWrite): SqlStatement {
  const { table, key, columns } = rowOf(write);
  const params = new Params(d.placeholder);
  const names = Object.keys(columns);
  if (write.kind === 'occurrence' || write.created)
    return {
      sql: `INSERT INTO ${d.table(table)} (${names.join(', ')}) VALUES (${params.list(names.map((name) => columns[name]))})`,
      params: params.values,
    };
  const sets = names
    .filter((name) => !key.includes(name))
    .map((name) => `${name} = ${params.add(columns[name])}`)
    .join(', ');
  const where = key.map((name) => `${name} = ${params.add(columns[name])}`).join(' AND ');
  return { sql: `UPDATE ${d.table(table)} SET ${sets} WHERE ${where}`, params: params.values };
}

// ===================================================================
// Snapshot reads and write methods
// ===================================================================

/** The SQL of one backend's goal runtime store. */
export type GoalRuntimeSql = ReturnType<typeof goalRuntimeSql>;

export function goalRuntimeSql(d: GoalRuntimeDialect) {
  const t = d.table;
  const read = <T>(
    build: (params: Params) => string,
    decode: (rows: SqlRow[]) => T,
  ): SqlRead<T> => {
    const params = new Params(d.placeholder);
    const sql = build(params);
    return { sql, params: params.values, decode };
  };
  const first =
    <T>(decode: (row: SqlRow) => T) =>
    (rows: SqlRow[]) =>
      rows[0] === undefined ? undefined : decode(rows[0]);

  const reads = {
    storedGoal: (goalId: string, lock: boolean) =>
      read(
        (p) =>
          `SELECT scope, revision FROM ${t('goals')} WHERE goal_id = ${p.add(goalId)}${lock ? d.lock : ''}`,
        first<StoredGoal>((row) => ({ scope: String(row.scope), revision: Number(row.revision) })),
      ),
    runtime: (goalId: string) =>
      read(
        (p) => `SELECT state FROM ${t('states')} WHERE goal_id = ${p.add(goalId)}${d.lock}`,
        first((row) => parse<GoalRuntimeState>(row.state)),
      ),
    entry: (id: string) =>
      read(
        (p) => `SELECT ${ENTRY_COLUMNS} FROM ${t('inbox')} WHERE id = ${p.add(id)}${d.lock}`,
        first(decodeEntry),
      ),
    entries: (ids: readonly string[]) =>
      read(
        (p) => `SELECT ${ENTRY_COLUMNS} FROM ${t('inbox')} WHERE id IN (${p.list(ids)})${d.lock}`,
        (rows) => new Map(rows.map((row) => decodeEntry(row)).map((entry) => [entry.id, entry])),
      ),
    pendingDeliveries: (scope: string, scheduleId: string, namespace: string) =>
      read(
        (p) =>
          `SELECT ${ENTRY_COLUMNS} FROM ${t('inbox')} WHERE scope = ${p.add(scope)} AND disposition = 'pending' AND (namespace = ${p.add(namespace)} OR id IN (SELECT inbox_entry_id FROM ${t('occurrences')} WHERE scope = ${p.add(scope)} AND schedule_id = ${p.add(scheduleId)} AND inbox_entry_id IS NOT NULL))${d.lock}`,
        (rows) => rows.map(decodeEntry),
      ),
    intent: (scope: string, intentId: string) =>
      read(
        (p) =>
          `SELECT intent FROM ${t('intents')} WHERE scope = ${p.add(scope)} AND intent_id = ${p.add(intentId)}${d.lock}`,
        first((row) => parse<GoalRunIntent>(row.intent)),
      ),
    schedule: (scope: string, scheduleId: string) =>
      read(
        (p) =>
          `SELECT schedule FROM ${t('schedules')} WHERE scope = ${p.add(scope)} AND schedule_id = ${p.add(scheduleId)}${d.lock}`,
        first((row) => parse<DurableSchedule>(row.schedule)),
      ),
    recorded: (scope: string, occurrenceIds: readonly string[]) =>
      read(
        (p) =>
          `SELECT occurrence_id FROM ${t('occurrences')} WHERE scope = ${p.add(scope)} AND occurrence_id IN (${p.list(occurrenceIds)})`,
        (rows) => new Set(rows.map((row) => String(row.occurrence_id))),
      ),
    watermark: (scope: string, goalId: string, runId: string) =>
      read(
        (p) =>
          `SELECT watermark FROM ${t('watermarks')} WHERE scope = ${p.add(scope)} AND goal_id = ${p.add(goalId)} AND run_id = ${p.add(runId)}${d.lock}`,
        first((row) => parse<GoalLedgerWatermark>(row.watermark)),
      ),
  };

  /** Yields one read and returns its value, typed. */
  function* get<T>(request: SqlRead<T>): Generator<SqlRead<unknown>, T, unknown> {
    return (yield request) as T;
  }

  const operations = {
    *saveGoal(record: GoalRecord): GoalRuntimeOperation<void> {
      const stored = yield* get(reads.storedGoal(record.goalId, true));
      return { result: undefined, writes: [planGoalSave(stored, record)] };
    },
    *saveRuntime(state: GoalRuntimeState, goal: GoalRecord | undefined) {
      const stored = yield* get(reads.storedGoal(state.goalId, goal !== undefined));
      const runtime = yield* get(reads.runtime(state.goalId));
      return planRuntimeSave({ goal: stored, runtime }, state, goal);
    },
    *enqueue(delivery: GoalInboxEnqueue, now: number) {
      const id = deliveryKey(delivery);
      const goal = yield* get(reads.storedGoal(delivery.goalId, false));
      const entry = yield* get(reads.entry(id));
      return planEnqueue({ entry, goal }, delivery, id, now);
    },
    *apply(application: GoalInboxApplication, now: number) {
      const goal = yield* get(reads.storedGoal(application.goalId, application.goal !== undefined));
      const runtime = yield* get(reads.runtime(application.goalId));
      const entry = yield* get(reads.entry(application.entryId));
      const { intent } = application;
      const intentExists =
        intent !== undefined &&
        (yield* get(reads.intent(intent.scope, intent.intentId))) !== undefined;
      return planApply({ entry, goal, runtime, intentExists }, application, now);
    },
    *putSchedule(
      input: DurableScheduleInput,
      options: { expectedRevision: number; effectiveFrom: number },
      now: number,
    ) {
      const goal = yield* get(reads.storedGoal(input.goalId, false));
      const schedule = yield* get(reads.schedule(input.scope, input.scheduleId));
      return planSchedulePut({ schedule, goal }, input, options, now);
    },
    *pauseSchedule(
      scope: string,
      scheduleId: string,
      options: { expectedRevision: number },
      now: number,
    ) {
      return planSchedulePause(yield* get(reads.schedule(scope, scheduleId)), options, now);
    },
    *resumeSchedule(
      scope: string,
      scheduleId: string,
      options: { expectedRevision: number; effectiveFrom: number },
      now: number,
    ) {
      return planScheduleResume(yield* get(reads.schedule(scope, scheduleId)), options, now);
    },
    *cancelSchedule(
      scope: string,
      scheduleId: string,
      namespace: string,
      options: { expectedRevision: number },
      now: number,
    ) {
      const schedule = yield* get(reads.schedule(scope, scheduleId));
      const pending = yield* get(reads.pendingDeliveries(scope, scheduleId, namespace));
      return planScheduleCancel({ schedule, pending }, options, now);
    },
    *advance(step: ScheduleAdvance, now: number) {
      const schedule = yield* get(reads.schedule(step.scope, step.scheduleId));
      const ids = step.occurrences.flatMap(({ delivery }) =>
        delivery ? [deliveryKey(delivery)] : [],
      );
      const entries = ids.length
        ? yield* get(reads.entries(ids))
        : new Map<string, GoalInboxEntry>();
      const occurrenceIds = step.occurrences.map((occurrence) => occurrence.occurrenceId);
      const recorded = occurrenceIds.length
        ? yield* get(reads.recorded(step.scope, occurrenceIds))
        : new Set<string>();
      return planAdvance({ schedule, entries, recorded }, step, deliveryKey, now);
    },
    *recordIntent(input: GoalRunIntentInput, now: number) {
      const goal = yield* get(reads.storedGoal(input.goalId, false));
      const intent = yield* get(reads.intent(input.scope, input.intentId));
      return planIntentRecord({ intent, goal }, input, now);
    },
    *claimIntent(
      scope: string,
      intentId: string,
      claim: { owner: string; token: number; expectedRevision: number },
      now: number,
    ) {
      return planIntentClaim(yield* get(reads.intent(scope, intentId)), claim, now);
    },
    *launchIntent(
      scope: string,
      intentId: string,
      mark: { token: number; expectedRevision: number },
      now: number,
    ) {
      return planIntentLaunched(yield* get(reads.intent(scope, intentId)), mark, now);
    },
    *completeIntent(
      scope: string,
      intentId: string,
      completion: ReturnType<typeof checkCompletion>,
      now: number,
    ) {
      const intent = yield* get(reads.intent(scope, intentId));
      const goal = intent
        ? yield* get(reads.storedGoal(intent.goalId, completion.goal !== undefined))
        : undefined;
      const runtime = intent ? yield* get(reads.runtime(intent.goalId)) : undefined;
      return planIntentComplete({ intent, goal, runtime }, completion, now);
    },
    *advanceWatermark(advance: GoalWatermarkAdvance, now: number) {
      const goal = yield* get(reads.storedGoal(advance.goalId, true));
      const watermark = yield* get(reads.watermark(advance.scope, advance.goalId, advance.runId));
      return planWatermarkAdvance({ watermark, goal }, advance, now);
    },
  };

  // =================================================================
  // Plain reads
  // =================================================================

  const lookups = {
    goal: (goalId: string, scope: string | undefined) =>
      read(
        (p) =>
          `SELECT record FROM ${t('goals')} WHERE goal_id = ${p.add(goalId)}${scope !== undefined ? ` AND scope = ${p.add(scope)}` : ''}`,
        first(decodeGoal),
      ),
    runtime: (scope: string, goalId: string) =>
      read(
        (p) =>
          `SELECT state FROM ${t('states')} WHERE goal_id = ${p.add(goalId)} AND scope = ${p.add(scope)}`,
        first((row) => parse<GoalRuntimeState>(row.state)),
      ),
    entry: (scope: string, id: string) =>
      read(
        (p) =>
          `SELECT ${ENTRY_COLUMNS} FROM ${t('inbox')} WHERE id = ${p.add(id)} AND scope = ${p.add(scope)}`,
        first(decodeEntry),
      ),
    schedule: (scope: string, scheduleId: string) =>
      read(
        (p) =>
          `SELECT schedule FROM ${t('schedules')} WHERE scope = ${p.add(scope)} AND schedule_id = ${p.add(scheduleId)}`,
        first((row) => parse<DurableSchedule>(row.schedule)),
      ),
    intent: (scope: string, intentId: string) =>
      read(
        (p) =>
          `SELECT intent FROM ${t('intents')} WHERE scope = ${p.add(scope)} AND intent_id = ${p.add(intentId)}`,
        first((row) => parse<GoalRunIntent>(row.intent)),
      ),
    watermark: (scope: string, goalId: string, runId: string) =>
      read(
        (p) =>
          `SELECT watermark FROM ${t('watermarks')} WHERE scope = ${p.add(scope)} AND goal_id = ${p.add(goalId)} AND run_id = ${p.add(runId)}`,
        first((row) => parse<GoalLedgerWatermark>(row.watermark)),
      ),
  };

  // =================================================================
  // Listings: one row more than the limit tells that more follow
  // =================================================================

  const listings = {
    goals: (plan: GoalListPlan) =>
      read(
        (p) => {
          const where: string[] = [];
          if (plan.statuses !== undefined) where.push(`status IN (${p.list(plan.statuses)})`);
          if (plan.scope !== undefined) where.push(`scope = ${p.add(plan.scope)}`);
          if (plan.after !== undefined) {
            const at = p.add(plan.after.updatedAt);
            where.push(
              `(updated_at < ${at} OR (updated_at = ${p.add(plan.after.updatedAt)} AND goal_id < ${p.add(plan.after.goalId)}))`,
            );
          }
          return `SELECT record FROM ${t('goals')}${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY updated_at DESC, goal_id DESC LIMIT ${p.add(plan.limit + 1)}`;
        },
        (rows) => rows.map(decodeGoal),
      ),
    inbox: (plan: InboxListPlan) =>
      read(
        (p) => {
          const where = [
            `scope = ${p.add(plan.scope)}`,
            `disposition IN (${p.list(plan.dispositions)})`,
          ];
          if (plan.goalId !== undefined) where.push(`goal_id = ${p.add(plan.goalId)}`);
          if (plan.dueBy !== undefined)
            where.push(
              `NOT (disposition = 'pending' AND not_before IS NOT NULL AND not_before > ${p.add(plan.dueBy)})`,
            );
          if (plan.after !== undefined) {
            const [enqueuedAt, id] = plan.after;
            where.push(
              `(enqueued_at > ${p.add(enqueuedAt)} OR (enqueued_at = ${p.add(enqueuedAt)} AND id > ${p.add(id)}))`,
            );
          }
          return `SELECT ${ENTRY_COLUMNS} FROM ${t('inbox')} WHERE ${where.join(' AND ')} ORDER BY enqueued_at, id LIMIT ${p.add(plan.limit + 1)}`;
        },
        (rows) => rows.map(decodeEntry),
      ),
    schedules: (plan: ScheduleListPlan) =>
      read(
        (p) => {
          const where: string[] = [];
          if (plan.scope !== undefined) where.push(`scope = ${p.add(plan.scope)}`);
          if (plan.goalId !== undefined) where.push(`goal_id = ${p.add(plan.goalId)}`);
          if (plan.statuses !== undefined) where.push(`status IN (${p.list(plan.statuses)})`);
          if (plan.after !== undefined) {
            const [scheduleId, scope] = plan.after;
            where.push(
              `(schedule_id > ${p.add(scheduleId)} OR (schedule_id = ${p.add(scheduleId)} AND scope > ${p.add(scope)}))`,
            );
          }
          return `SELECT schedule FROM ${t('schedules')}${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY schedule_id, scope LIMIT ${p.add(plan.limit + 1)}`;
        },
        (rows) => rows.map((row) => parse<DurableSchedule>(row.schedule)),
      ),
    occurrences: (plan: OccurrenceListPlan) =>
      read(
        (p) => {
          const where = [`scope = ${p.add(plan.scope)}`];
          if (plan.scheduleId !== undefined) where.push(`schedule_id = ${p.add(plan.scheduleId)}`);
          if (plan.after !== undefined) {
            const [at, occurrenceId] = plan.after;
            where.push(
              `(at > ${p.add(at)} OR (at = ${p.add(at)} AND occurrence_id > ${p.add(occurrenceId)}))`,
            );
          }
          return `SELECT record FROM ${t('occurrences')} WHERE ${where.join(' AND ')} ORDER BY at, occurrence_id LIMIT ${p.add(plan.limit + 1)}`;
        },
        (rows) => rows.map((row) => parse<ScheduleOccurrenceRecord>(row.record)),
      ),
    intents: (plan: IntentListPlan) =>
      read(
        (p) => {
          const where = [`status IN (${p.list(plan.statuses)})`];
          if (plan.scope !== undefined) where.push(`scope = ${p.add(plan.scope)}`);
          if (plan.goalId !== undefined) where.push(`goal_id = ${p.add(plan.goalId)}`);
          if (plan.after !== undefined) {
            const [recordedAt, scope, intentId] = plan.after;
            where.push(
              `(recorded_at > ${p.add(recordedAt)} OR (recorded_at = ${p.add(recordedAt)} AND (scope > ${p.add(scope)} OR (scope = ${p.add(scope)} AND intent_id > ${p.add(intentId)}))))`,
            );
          }
          return `SELECT intent FROM ${t('intents')} WHERE ${where.join(' AND ')} ORDER BY recorded_at, scope, intent_id LIMIT ${p.add(plan.limit + 1)}`;
        },
        (rows) => rows.map((row) => parse<GoalRunIntent>(row.intent)),
      ),
  };

  // =================================================================
  // Retention: one statement each; the store counts the rows it touched
  // =================================================================

  const statement = (build: (params: Params) => string): SqlStatement => {
    const params = new Params(d.placeholder);
    const sql = build(params);
    return { sql, params: params.values };
  };
  const inScope = (p: Params, cut: GoalRuntimePruneOptions) =>
    cut.scope !== undefined ? ` AND scope = ${p.add(cut.scope)}` : '';

  const retention = {
    payloads: (cut: GoalRuntimePruneOptions) =>
      statement(
        (p) =>
          `UPDATE ${t('inbox')} SET payload_body = NULL, payload_media_type = NULL, payload_pruned = 1 WHERE disposition <> 'pending' AND settled_at < ${p.add(cut.before)} AND payload_body IS NOT NULL${inScope(p, cut)}`,
      ),
    inbox: (cut: GoalRuntimePruneOptions) =>
      statement(
        (p) =>
          `DELETE FROM ${t('inbox')} WHERE disposition <> 'pending' AND settled_at < ${p.add(cut.before)}${inScope(p, cut)}`,
      ),
    occurrences: (cut: GoalRuntimePruneOptions) =>
      statement(
        (p) =>
          `DELETE FROM ${t('occurrences')} WHERE recorded_at < ${p.add(cut.before)}${inScope(p, cut)}`,
      ),
    intents: (cut: GoalRuntimePruneOptions) =>
      statement(
        (p) =>
          `DELETE FROM ${t('intents')} WHERE status IN (${p.list(FINISHED_INTENT_STATUSES)}) AND updated_at < ${p.add(cut.before)}${inScope(p, cut)}`,
      ),
  };

  return {
    schema: goalRuntimeSchema(d),
    operations,
    lookups,
    listings,
    retention,
    write: (write: GoalRuntimeWrite) => writeStatement(d, write),
  };
}
