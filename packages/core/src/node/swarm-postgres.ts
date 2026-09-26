/**
 * `@deuz-sdk/core/swarm/postgres` (2.2): a durable swarm store on Postgres.
 *
 * `PgClientLike` exposes a single `query()`, and a pool may run consecutive
 * queries on different connections, so there are no client-side transactions.
 * Validation reads are separate queries; every WRITE is one SQL statement whose
 * data-modifying CTEs are all gated on the run row's revision update. If the
 * revision moved since the reads, the gate matches nothing, nothing is written,
 * and the commit rejects with SwarmConflictError. Node-only.
 */
import type { PgClientLike } from './store-postgres';
import type {
  SwarmChannelEntry,
  SwarmChannelPost,
  SwarmEvent,
  SwarmKey,
  SwarmRunRecord,
  SwarmSnapshot,
  SwarmStore,
  SwarmTaskRecord,
} from '../types/swarm';
import {
  decodeSwarm,
  encodeSwarm,
  makeSwarmEvents,
  nextSwarmRun,
  planPosts,
  postEvents,
  SwarmConflictError,
  validateChannelName,
  validateEventCursor,
  validateRunQuery,
  validateSpawn,
  validateSwarmSnapshot,
  validateTaskChange,
} from '../swarm/store';

export interface PostgresSwarmStoreOptions {
  client: PgClientLike;
  /** Schema holding the `deuz_swarm_*` tables. Default `'public'`; must already exist. */
  schema?: string;
}

const SCHEMA_VERSION = 1;
const IDENTIFIER = /^[a-z_][a-z0-9_]{0,62}$/;

/** Shared by the Postgres swarm and ops stores: the schema is the one unbound identifier. */
export function postgresSchemaName(schema: string | undefined): string {
  const name = schema ?? 'public';
  if (!IDENTIFIER.test(name))
    throw new TypeError(
      `Invalid Postgres schema name '${name}': it must match /^[a-z_][a-z0-9_]*$/ and be at most 63 characters`,
    );
  return name;
}

type Row = Record<string, unknown>;

export function createPostgresSwarmStore(options: PostgresSwarmStoreOptions): SwarmStore {
  const schema = postgresSchemaName(options.schema);
  const runs = `${schema}.deuz_swarm_runs`;
  const tasks = `${schema}.deuz_swarm_tasks`;
  const events = `${schema}.deuz_swarm_events`;
  const channels = `${schema}.deuz_swarm_channels`;
  const meta = `${schema}.deuz_swarm_pg_schema`;
  const query = async (sql: string, params: unknown[] = []): Promise<Row[]> =>
    (await options.client.query(sql, params)).rows;

  let ready: Promise<void> | undefined;
  const migrate = async (): Promise<void> => {
    await query(
      `CREATE TABLE IF NOT EXISTS ${meta} (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), version INTEGER NOT NULL)`,
    );
    await query(
      `INSERT INTO ${meta} (singleton, version) VALUES (1, ${SCHEMA_VERSION}) ON CONFLICT (singleton) DO NOTHING`,
    );
    const [row] = await query(`SELECT version FROM ${meta} WHERE singleton = 1`);
    if (Number(row?.version) !== SCHEMA_VERSION)
      throw new Error('Unsupported Postgres swarm schema version');
    await query(`CREATE TABLE IF NOT EXISTS ${runs} (
      scope TEXT NOT NULL, run_id TEXT NOT NULL, payload TEXT NOT NULL, status TEXT NOT NULL,
      updated_at DOUBLE PRECISION NOT NULL, revision BIGINT NOT NULL, last_sequence BIGINT NOT NULL,
      PRIMARY KEY (scope, run_id))`);
    await query(
      `CREATE INDEX IF NOT EXISTS deuz_swarm_runs_status ON ${runs} (status, updated_at)`,
    );
    await query(
      `CREATE INDEX IF NOT EXISTS deuz_swarm_runs_scope_status ON ${runs} (scope, status, updated_at)`,
    );
    await query(`CREATE TABLE IF NOT EXISTS ${tasks} (
      scope TEXT NOT NULL, run_id TEXT NOT NULL, task_id TEXT NOT NULL, ordinal INTEGER NOT NULL,
      payload TEXT NOT NULL, PRIMARY KEY (scope, run_id, task_id))`);
    await query(`CREATE TABLE IF NOT EXISTS ${events} (
      scope TEXT NOT NULL, run_id TEXT NOT NULL, sequence BIGINT NOT NULL, payload TEXT NOT NULL,
      PRIMARY KEY (scope, run_id, sequence))`);
    await query(`CREATE TABLE IF NOT EXISTS ${channels} (
      scope TEXT NOT NULL, run_id TEXT NOT NULL, channel TEXT NOT NULL, sequence BIGINT NOT NULL,
      entry_id TEXT NOT NULL, payload TEXT NOT NULL,
      PRIMARY KEY (scope, run_id, channel, sequence), UNIQUE (scope, run_id, entry_id))`);
  };
  const use = async (): Promise<void> => {
    ready ??= migrate().catch((error: unknown) => {
      // A concurrent first migration may race; the next call tries again.
      ready = undefined;
      throw error;
    });
    await ready;
  };

  const decodeRun = (payload: unknown, key?: SwarmKey): SwarmRunRecord => {
    const run = decodeSwarm<SwarmRunRecord>(String(payload));
    validateSwarmSnapshot({ run, tasks: [] }, key);
    return run;
  };
  const readRun = async (key: SwarmKey): Promise<SwarmRunRecord | undefined> => {
    const [row] = await query(`SELECT payload FROM ${runs} WHERE scope = $1 AND run_id = $2`, [
      key.scope,
      key.runId,
    ]);
    return row ? decodeRun(row.payload, key) : undefined;
  };
  const json = (value: unknown): string => JSON.stringify(value);
  const eventRows = (list: readonly SwarmEvent[]) =>
    list.map((event) => ({ sequence: event.sequence, payload: encodeSwarm(event) }));

  return {
    capabilities: Object.freeze(['spawn', 'channels', 'list'] as const),
    async create(snapshot, inputs) {
      validateSwarmSnapshot(snapshot);
      if (snapshot.run.revision !== 0 || snapshot.run.lastSequence !== 0)
        throw new Error('New swarm counters must start at zero');
      await use();
      const list = makeSwarmEvents(snapshot.run, 0, inputs);
      const run = { ...snapshot.run, lastSequence: list.length };
      const taskRows = snapshot.tasks.map((task, ordinal) => ({
        task_id: task.task.id,
        ordinal,
        payload: encodeSwarm(task),
      }));
      const [row] = await query(
        `WITH run AS (
          INSERT INTO ${runs} (scope, run_id, payload, status, updated_at, revision, last_sequence)
          VALUES ($1, $2, $3, $4, $5, 0, $6)
          ON CONFLICT (scope, run_id) DO NOTHING
          RETURNING 1
        ), new_tasks AS (
          INSERT INTO ${tasks} (scope, run_id, task_id, ordinal, payload)
          SELECT $1, $2, x.task_id, x.ordinal, x.payload
          FROM jsonb_to_recordset($7::jsonb) AS x(task_id TEXT, ordinal INTEGER, payload TEXT)
          WHERE EXISTS (SELECT 1 FROM run)
        ), new_events AS (
          INSERT INTO ${events} (scope, run_id, sequence, payload)
          SELECT $1, $2, x.sequence, x.payload
          FROM jsonb_to_recordset($8::jsonb) AS x(sequence BIGINT, payload TEXT)
          WHERE EXISTS (SELECT 1 FROM run)
        )
        SELECT COUNT(*) AS n FROM run`,
        [
          run.scope,
          run.runId,
          encodeSwarm(run),
          run.status,
          run.updatedAt,
          run.lastSequence,
          json(taskRows),
          json(eventRows(list)),
        ],
      );
      if (Number(row?.n) !== 1) throw new SwarmConflictError();
      return run;
    },
    async load(key) {
      await use();
      // One statement is one snapshot: the run and its tasks always agree.
      const [row] = await query(
        `SELECT r.payload AS run,
          COALESCE((SELECT json_agg(t.payload ORDER BY t.ordinal)::text FROM ${tasks} t
            WHERE t.scope = r.scope AND t.run_id = r.run_id), '[]') AS tasks
        FROM ${runs} r WHERE r.scope = $1 AND r.run_id = $2`,
        [key.scope, key.runId],
      );
      if (!row) return undefined;
      const snapshot: SwarmSnapshot = {
        run: decodeRun(row.run, key),
        tasks: (JSON.parse(String(row.tasks)) as string[]).map((payload) =>
          decodeSwarm<SwarmTaskRecord>(payload),
        ),
      };
      validateSwarmSnapshot(snapshot, key);
      return snapshot;
    },
    async head(key) {
      await use();
      return readRun(key);
    },
    async commit(change) {
      await use();
      const previous = await readRun(change);
      if (!previous) throw new Error('Swarm run not found');
      if (previous.revision !== change.expectedRevision) throw new SwarmConflictError();
      const key = [change.scope, change.runId];

      // Validation reads, all at `previous.revision`; the write re-checks it.
      const changed = change.tasks ?? [];
      const spawn = change.spawn ?? [];
      const posts = change.posts ?? [];
      const known = new Set<string>([
        ...changed.map((task) => task.task.id),
        ...posts.map((post) => post.taskId),
        ...spawn.flatMap((task) => [
          task.task.id,
          ...(task.task.dependsOn ?? []),
          ...(task.task.after ?? []),
        ]),
      ]);
      const stored = new Map<string, string>();
      if (known.size)
        for (const row of await query(
          `SELECT task_id, payload FROM ${tasks} WHERE scope = $1 AND run_id = $2
            AND task_id IN (SELECT jsonb_array_elements_text($3::jsonb))`,
          [...key, json([...known])],
        ))
          stored.set(String(row.task_id), String(row.payload));
      for (const task of changed) {
        const exists = stored.get(task.task.id);
        if (exists === undefined) throw new Error('Cannot add tasks to a fixed swarm DAG');
        validateTaskChange(decodeSwarm<SwarmTaskRecord>(exists), task, previous);
      }
      let last = -1;
      if (spawn.length) {
        const [count] = await query(
          `SELECT COUNT(*) AS n, COALESCE(MAX(ordinal), -1) AS last FROM ${tasks}
            WHERE scope = $1 AND run_id = $2`,
          key,
        );
        last = Number(count?.last);
        validateSpawn({
          run: previous,
          tasks: changed,
          spawn,
          count: Number(count?.n),
          exists: (taskId) => stored.has(taskId),
        });
      }
      const entries = new Map<string, SwarmChannelPost>();
      const lastSequence = new Map<string, number>();
      if (posts.length) {
        for (const row of await query(
          `SELECT payload FROM ${channels} WHERE scope = $1 AND run_id = $2
            AND entry_id IN (SELECT jsonb_array_elements_text($3::jsonb))`,
          [...key, json(posts.map((post) => post.entryId))],
        )) {
          const entry = decodeSwarm<SwarmChannelEntry>(String(row.payload));
          entries.set(entry.entryId, entry);
        }
        for (const row of await query(
          `SELECT channel, MAX(sequence) AS last FROM ${channels} WHERE scope = $1 AND run_id = $2
            AND channel IN (SELECT jsonb_array_elements_text($3::jsonb)) GROUP BY channel`,
          [...key, json([...new Set(posts.map((post) => post.channel))])],
        ))
          lastSequence.set(String(row.channel), Number(row.last));
      }
      const posted = planPosts({
        posts,
        taskExists: (taskId) => stored.has(taskId),
        find: (entryId) => entries.get(entryId),
        last: (channel) => lastSequence.get(channel) ?? 0,
      });
      const inputs = [...(change.events ?? []), ...postEvents(posted)];
      const run = nextSwarmRun(previous, { ...change, events: inputs });
      const journal = makeSwarmEvents(change, previous.lastSequence, inputs);

      const [row] = await query(
        `WITH run AS (
          UPDATE ${runs} SET payload = $3, status = $4, updated_at = $5, revision = $6,
            last_sequence = $7
          WHERE scope = $1 AND run_id = $2 AND revision = $8
          RETURNING 1
        ), changed AS (
          UPDATE ${tasks} t SET payload = x.payload
          FROM jsonb_to_recordset($9::jsonb) AS x(task_id TEXT, payload TEXT)
          WHERE t.scope = $1 AND t.run_id = $2 AND t.task_id = x.task_id
            AND EXISTS (SELECT 1 FROM run)
        ), spawned AS (
          INSERT INTO ${tasks} (scope, run_id, task_id, ordinal, payload)
          SELECT $1, $2, x.task_id, x.ordinal, x.payload
          FROM jsonb_to_recordset($10::jsonb) AS x(task_id TEXT, ordinal INTEGER, payload TEXT)
          WHERE EXISTS (SELECT 1 FROM run)
        ), notes AS (
          INSERT INTO ${channels} (scope, run_id, channel, sequence, entry_id, payload)
          SELECT $1, $2, x.channel, x.sequence, x.entry_id, x.payload
          FROM jsonb_to_recordset($11::jsonb)
            AS x(channel TEXT, sequence BIGINT, entry_id TEXT, payload TEXT)
          WHERE EXISTS (SELECT 1 FROM run)
        ), journal AS (
          INSERT INTO ${events} (scope, run_id, sequence, payload)
          SELECT $1, $2, x.sequence, x.payload
          FROM jsonb_to_recordset($12::jsonb) AS x(sequence BIGINT, payload TEXT)
          WHERE EXISTS (SELECT 1 FROM run)
        )
        SELECT COUNT(*) AS n FROM run`,
        [
          ...key,
          encodeSwarm(run),
          run.status,
          run.updatedAt,
          run.revision,
          run.lastSequence,
          previous.revision,
          json(changed.map((task) => ({ task_id: task.task.id, payload: encodeSwarm(task) }))),
          json(
            spawn.map((task, index) => ({
              task_id: task.task.id,
              ordinal: last + 1 + index,
              payload: encodeSwarm(task),
            })),
          ),
          json(
            posted.map((entry) => ({
              channel: entry.channel,
              sequence: entry.sequence,
              entry_id: entry.entryId,
              payload: encodeSwarm(entry),
            })),
          ),
          json(eventRows(journal)),
        ],
      );
      if (Number(row?.n) !== 1) throw new SwarmConflictError();
      return run;
    },
    async readChannel(key, channel, afterSequence, limit) {
      validateChannelName(channel);
      validateEventCursor(afterSequence, limit);
      await use();
      return (
        await query(
          `SELECT payload FROM ${channels} WHERE scope = $1 AND run_id = $2 AND channel = $3
            AND sequence > $4 ORDER BY sequence LIMIT $5`,
          [key.scope, key.runId, channel, afterSequence, limit],
        )
      ).map((row) => decodeSwarm<SwarmChannelEntry>(String(row.payload)));
    },
    async readEvents(key, afterSequence, limit) {
      validateEventCursor(afterSequence, limit);
      await use();
      return (
        await query(
          `SELECT payload FROM ${events} WHERE scope = $1 AND run_id = $2 AND sequence > $3
            ORDER BY sequence LIMIT $4`,
          [key.scope, key.runId, afterSequence, limit],
        )
      ).map((row) => decodeSwarm<SwarmEvent>(String(row.payload)));
    },
    async listRuns(query_) {
      validateRunQuery(query_);
      await use();
      const after = query_.after;
      // The cursor compares in the ORDER BY's own collation (2.2).
      return (
        await query(
          `SELECT payload FROM ${runs}
            WHERE ($1::text IS NULL OR status = $1) AND ($2::text IS NULL OR scope = $2)
              AND ($4::double precision IS NULL OR updated_at > $4 OR (updated_at = $4
                AND (scope COLLATE "C" > $5::text
                  OR (scope COLLATE "C" = $5::text AND run_id COLLATE "C" > $6::text))))
            ORDER BY updated_at, scope COLLATE "C", run_id COLLATE "C" LIMIT $3`,
          [
            query_.status ?? null,
            query_.scope ?? null,
            query_.limit,
            after?.updatedAt ?? null,
            after?.scope ?? null,
            after?.runId ?? null,
          ],
        )
      ).map((row) => decodeRun(row.payload));
    },
  };
}
