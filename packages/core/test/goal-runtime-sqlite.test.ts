/**
 * goal-runtime-sqlite.test.ts (2.4, spec §3.1) — the SQLite goal runtime
 * store: the 2.3 goal-store fixture and the goal runtime store fixture on
 * `:memory:`, and what only a file database shows: everything survives a
 * restart, the store keeps its own `deuz_goal_runtime_schema` version beside
 * the 2.3 stores, a borrowed handle stays open, and a multi-part write that
 * fails half way leaves nothing behind.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { transitionGoal } from '../src/goal';
import { goalInboxKey } from '../src/goal/runtime';
import { createSqliteGoalRuntimeStore } from '../src/node/goal-runtime-sqlite';
import { openSqliteDatabase } from '../src/node/sqlite-handle';
import { createSqliteOpsStore } from '../src/node/ops-sqlite';
import { createSqliteStores, type SqliteDatabaseLike } from '../src/node/store-sqlite';
import {
  T0,
  delivery,
  goalRuntimeStoreContracts,
  nextGoal,
  occurrence,
  runIntent,
  runtimeGoal,
  runtimeState,
  scheduleInput,
} from './fixtures/goal-runtime-store-conformance';
import { goalStoreContracts } from './fixtures/goal-store-conformance';
import { SLOW_TEST_TIMEOUT_MS } from './fixtures/timeouts';

goalStoreContracts('sqlite goal runtime store (GoalStore)', () =>
  createSqliteGoalRuntimeStore({ path: ':memory:' }),
);

goalRuntimeStoreContracts('sqlite goal runtime store', ({ clock }) => {
  const store = createSqliteGoalRuntimeStore({ path: ':memory:', clock });
  return { store, cleanup: () => store.close() };
});

const directories: string[] = [];
afterAll(async () => {
  for (const directory of directories) await rm(directory, { recursive: true, force: true });
});

async function databaseFile(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'deuz-goal-runtime-'));
  directories.push(directory);
  return join(directory, 'goals.sqlite');
}

/** A handle whose statements starting with `prefix` throw while `fail.on` is set. */
function failing(
  inner: SqliteDatabaseLike,
  prefix: string,
): SqliteDatabaseLike & { fail: { on: boolean } } {
  const fail = { on: false };
  return {
    fail,
    exec: (sql) => inner.exec(sql),
    close: () => inner.close(),
    prepare(sql) {
      const statement = inner.prepare(sql);
      if (!sql.trimStart().startsWith(prefix)) return statement;
      return {
        run: (...params) => {
          if (fail.on) throw new Error('injected failure');
          return statement.run(...params);
        },
        get: (...params) => statement.get(...params),
        all: (...params) => statement.all(...params),
      };
    },
  };
}

describe('createSqliteGoalRuntimeStore', { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  it('keeps goals, inbox, state, schedules, intents and watermarks across a restart', async () => {
    const path = await databaseFile();
    const goal = runtimeGoal('g');
    const first = createSqliteGoalRuntimeStore({ path });
    try {
      await first.runtime.save(runtimeState(goal, 1, { cancel: { requestedAt: T0 } }), goal);
      await first.inbox.enqueue(delivery(goal, 'd1'));
      await first.schedules.put(scheduleInput(goal, 's1'), {
        expectedRevision: 0,
        effectiveFrom: T0,
      });
      await first.schedules.advance({
        scope: 'tenant',
        scheduleId: 's1',
        expectedRevision: 1,
        fromCursor: T0,
        toCursor: T0 + 60_000,
        occurrences: [occurrence(goal, 's1', T0 + 60_000)],
      });
      await first.intents.record(runIntent(goal, 'i1'));
      await first.watermarks.advance({
        scope: 'tenant',
        goalId: 'g',
        runId: 'r1',
        expectedRevision: 0,
        next: { tokens: 5, usd: 0, reservedTokens: 0, reservedUsd: 0 },
        goal: transitionGoal(goal, { type: 'charge', tokens: 5 }, { now: T0 + 1 }).record,
      });
    } finally {
      await first.close();
    }
    const second = createSqliteGoalRuntimeStore({ path });
    try {
      expect((await second.load('g', { scope: 'tenant' }))?.spent.tokens).toBe(5);
      expect((await second.runtime.get('tenant', 'g'))?.cancel).toEqual({ requestedAt: T0 });
      const entry = await second.inbox.get(
        'tenant',
        goalInboxKey('tenant', 'webhook:github', 'd1'),
      );
      expect(entry?.payload?.body).toBe('{"delivery":"d1"}');
      expect((await second.schedules.get('tenant', 's1'))?.scheduleCursor).toBe(T0 + 60_000);
      expect((await second.schedules.occurrences({ scope: 'tenant' })).occurrences).toHaveLength(1);
      expect((await second.inbox.list({ scope: 'tenant' })).entries).toHaveLength(2);
      expect((await second.intents.get('tenant', 'i1'))?.status).toBe('pending');
      expect((await second.watermarks.get('tenant', 'g', 'r1'))?.tokens).toBe(5);
      // The duplicate check reads the stored entry, not a cache.
      expect((await second.inbox.enqueue(delivery(goal, 'd1'))).status).toBe('duplicate');
    } finally {
      await second.close();
    }
  });

  it('shares one file between stores: each sees what the other committed', async () => {
    const path = await databaseFile();
    const a = createSqliteGoalRuntimeStore({ path });
    const b = createSqliteGoalRuntimeStore({ path });
    try {
      const goal = runtimeGoal('g');
      await a.runtime.save(runtimeState(goal), goal);
      expect(await b.runtime.save(runtimeState(goal, 1))).toEqual({
        status: 'conflict',
        reason: 'runtime-revision',
      });
      expect(await b.runtime.save(runtimeState(goal, 2), nextGoal(goal))).toEqual({
        status: 'committed',
      });
      expect((await a.load('g'))?.revision).toBe(2);
    } finally {
      await a.close();
      await b.close();
    }
  });

  it('keeps its own schema version and leaves the 2.3 stores on the file alone', async () => {
    const path = await databaseFile();
    const legacy = createSqliteStores({ path });
    const ops = createSqliteOpsStore({ path });
    await legacy.chats.loadChat('nothing');
    await ops.leases.acquire({ key: 'k', owner: 'o', ttlMs: 1_000 });
    await legacy.close();
    await ops.close();
    const versions = async () => {
      const db = await openSqliteDatabase(path);
      try {
        return [
          db.prepare('PRAGMA user_version').get(),
          db.prepare('SELECT version FROM deuz_ops_schema').all(),
        ];
      } finally {
        db.close();
      }
    };
    const before = await versions();
    const store = createSqliteGoalRuntimeStore({ path });
    await store.save(runtimeGoal('g'));
    await store.close();
    expect(await versions()).toEqual(before);
    const db = await openSqliteDatabase(path);
    try {
      expect(db.prepare('SELECT version FROM deuz_goal_runtime_schema').all()).toEqual([
        { version: 1 },
      ]);
      const tables = (
        db
          .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'deuz_goal_runtime%' ORDER BY name",
          )
          .all() as { name: string }[]
      ).map((row) => row.name);
      expect(tables).toEqual([
        'deuz_goal_runtime_goals',
        'deuz_goal_runtime_inbox',
        'deuz_goal_runtime_intents',
        'deuz_goal_runtime_occurrences',
        'deuz_goal_runtime_schedules',
        'deuz_goal_runtime_schema',
        'deuz_goal_runtime_states',
        'deuz_goal_runtime_watermarks',
      ]);
    } finally {
      db.close();
    }
  });

  it('refuses a schema a newer build wrote', async () => {
    const path = await databaseFile();
    const first = createSqliteGoalRuntimeStore({ path });
    await first.save(runtimeGoal('g'));
    await first.close();
    const db = await openSqliteDatabase(path);
    db.exec('UPDATE deuz_goal_runtime_schema SET version = 2');
    db.close();
    const second = createSqliteGoalRuntimeStore({ path });
    await expect(second.load('g')).rejects.toThrow(
      /deuz_goal_runtime_schema holds schema version 2/,
    );
    await second.close();
  });

  it('borrows a handle it is given and closes only one it opened', async () => {
    const database = await openSqliteDatabase(':memory:');
    const borrowed = createSqliteGoalRuntimeStore({ database });
    await borrowed.save(runtimeGoal('g'));
    await borrowed.close();
    expect(database.prepare('SELECT COUNT(*) AS n FROM deuz_goal_runtime_goals').get()).toEqual({
      n: 1,
    });
    database.close();
    await expect(borrowed.load('g')).rejects.toThrow(/closed/);
  });

  it('rolls a half-written inbox apply back whole', async () => {
    const database = failing(
      await openSqliteDatabase(':memory:'),
      'INSERT INTO deuz_goal_runtime_intents',
    );
    const store = createSqliteGoalRuntimeStore({ database });
    try {
      const goal = runtimeGoal('g');
      await store.runtime.save(runtimeState(goal), goal);
      const { entry } = await store.inbox.enqueue(delivery(goal, 'd1'));
      const application = {
        scope: 'tenant',
        goalId: 'g',
        entryId: entry.id,
        disposition: 'applied' as const,
        goal: nextGoal(goal),
        runtime: runtimeState(goal, 2, { phase: 'dispatching' }),
        intent: runIntent(goal, 'g#2'),
      };
      database.fail.on = true;
      await expect(store.inbox.apply(application)).rejects.toThrow('injected failure');
      expect(await store.inbox.get('tenant', entry.id)).toEqual(entry);
      expect((await store.load('g'))?.revision).toBe(1);
      expect((await store.runtime.get('tenant', 'g'))?.revision).toBe(1);
      database.fail.on = false;
      expect(await store.inbox.apply(application)).toEqual({ status: 'committed' });
      expect((await store.intents.get('tenant', 'g#2'))?.status).toBe('pending');
    } finally {
      await store.close();
      database.close();
    }
  });

  it('rolls a half-written schedule advance back whole', async () => {
    const database = failing(
      await openSqliteDatabase(':memory:'),
      'INSERT INTO deuz_goal_runtime_occurrences',
    );
    const store = createSqliteGoalRuntimeStore({ database });
    try {
      const goal = runtimeGoal('g');
      await store.save(goal);
      await store.schedules.put(scheduleInput(goal, 's1'), {
        expectedRevision: 0,
        effectiveFrom: T0,
      });
      const step = {
        scope: 'tenant',
        scheduleId: 's1',
        expectedRevision: 1,
        fromCursor: T0,
        toCursor: T0 + 60_000,
        occurrences: [occurrence(goal, 's1', T0 + 60_000)],
      };
      database.fail.on = true;
      await expect(store.schedules.advance(step)).rejects.toThrow('injected failure');
      expect((await store.schedules.get('tenant', 's1'))?.scheduleCursor).toBe(T0);
      expect((await store.inbox.list({ scope: 'tenant' })).entries).toEqual([]);
      database.fail.on = false;
      expect((await store.schedules.advance(step)).status).toBe('advanced');
      expect((await store.inbox.list({ scope: 'tenant' })).entries).toHaveLength(1);
    } finally {
      await store.close();
      database.close();
    }
  });
});
