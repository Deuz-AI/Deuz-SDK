import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPostgresBudgetStore } from '../src/node/budget-postgres';
import { createPostgresOpsStore } from '../src/node/ops-postgres';
import { createPostgresSwarmStore } from '../src/node/swarm-postgres';
import { createPostgresStores } from '../src/node/store-postgres';
import type { PgClientLike } from '../src/node/store-postgres';
import { SwarmConflictError } from '../src/swarm/store';
import { envelope } from './fixtures/agent-run-store-conformance';
import { initialSnapshot } from './fixtures/swarm-store-conformance';

// PGlite is one connection, so two transactions never really contend here.
// A contended client stands in for that: it fails chosen write statements with
// what REPEATABLE READ or SERIALIZABLE answers a write whose rows a concurrent
// transaction changed (40001), or a deadlock victim (40P01).
const db = new PGlite();
// Start-up is slow under load; keep it out of the first test's time budget.
beforeAll(() => db.waitReady, 60_000);
afterAll(async () => {
  await db.close();
});
const client: PgClientLike = {
  async query(sql, params) {
    // The 2.0 pack's migration is a parameterless multi-statement batch.
    if (params === undefined && sql.includes(';')) {
      const results = await db.exec(sql);
      return { rows: (results.at(-1)?.rows ?? []) as Record<string, unknown>[] };
    }
    return db.query<Record<string, unknown>>(sql, params);
  },
};

let schemas = 0;
async function freshSchema(): Promise<string> {
  const schema = `retry_${++schemas}`;
  await client.query(`CREATE SCHEMA ${schema}`);
  return schema;
}

function contended() {
  let armed: { pattern: RegExp; times: number; code: string } | undefined;
  let attempts = 0;
  const contendedClient: PgClientLike = {
    async query(sql, params) {
      if (armed?.pattern.test(sql)) {
        attempts++;
        if (armed.times > 0) {
          armed.times--;
          throw Object.assign(new Error(`could not serialize access (${armed.code})`), {
            code: armed.code,
          });
        }
      }
      return client.query(sql, params);
    },
  };
  return {
    client: contendedClient,
    /** Fail the next statements that match, `times` times, with `code`. */
    fail(pattern: RegExp, times = 1, code = '40001') {
      armed = { pattern, times, code };
      attempts = 0;
    },
    /** Matching statements sent since the last fail(). */
    attempts: () => attempts,
  };
}

const CODES = ['40001', '40P01'];

describe('Postgres ops store retries (2.3)', () => {
  it.each(CODES)('runs every lease write again after %s', async (code) => {
    const schema = await freshSchema();
    const pg = contended();
    const ops = createPostgresOpsStore({ client: pg.client, schema });
    pg.fail(/INSERT INTO \S+\.deuz_leases\b/, 1, code);
    const lease = (await ops.leases.acquire({ key: 'run', owner: 'a', ttlMs: 60_000 }))!;
    expect(lease).toMatchObject({ owner: 'a', token: 1 });
    expect(pg.attempts()).toBe(2);

    pg.fail(/UPDATE \S+\.deuz_leases SET signals = CASE/, 1, code);
    expect(await ops.leases.signal('run', 'cancel')).toBe(true);
    expect(pg.attempts()).toBe(2);

    pg.fail(/UPDATE \S+\.deuz_leases l SET expires_at/, 1, code);
    expect(await ops.leases.renew(lease, 60_000, { acknowledge: true })).toMatchObject({
      held: true,
      signals: ['cancel'],
    });
    expect(pg.attempts()).toBe(2);

    pg.fail(/SET signals = signals - 'cancel'/, 1, code);
    expect(await ops.leases.ack!(lease, 'cancel')).toBe(true);
    expect(pg.attempts()).toBe(2);

    pg.fail(/UPDATE \S+\.deuz_leases SET expires_at = 0/, 1, code);
    await ops.leases.release(lease);
    expect(pg.attempts()).toBe(2);
    expect(await ops.leases.acquire({ key: 'run', owner: 'b', ttlMs: 60_000 })).toMatchObject({
      token: 2,
    });
  });

  it.each(CODES)('runs an agent run save and a claim again after %s', async (code) => {
    const schema = await freshSchema();
    const pg = contended();
    const ops = createPostgresOpsStore({ client: pg.client, schema });
    pg.fail(/INSERT INTO \S+\.deuz_agent_runs\b/, 1, code);
    await ops.agentRuns.save(envelope('run', 1));
    expect(pg.attempts()).toBe(2);
    expect(await ops.agentRuns.load('run')).toMatchObject({ revision: 1 });

    pg.fail(/INSERT INTO \S+\.deuz_claims\b/, 1, code);
    expect(await ops.claims('digest@1')).toBe(true);
    expect(pg.attempts()).toBe(2);
  });

  it('still fences a stale revision when the retried save finds it moved on', async () => {
    const schema = await freshSchema();
    const plain = createPostgresOpsStore({ client, schema });
    await plain.agentRuns.save(envelope('run', 1));
    // The zombie's save loses a serialization race; the winner wrote revision 2.
    let raced = false;
    const racing: PgClientLike = {
      async query(sql, params) {
        if (!raced && /INSERT INTO \S+\.deuz_agent_runs\b/.test(sql)) {
          raced = true;
          await plain.agentRuns.save(envelope('run', 2, { modelSteps: 9 }));
          throw Object.assign(new Error('could not serialize access'), { code: '40001' });
        }
        return client.query(sql, params);
      },
    };
    const stale = createPostgresOpsStore({ client: racing, schema });
    await expect(Promise.resolve(stale.agentRuns.save(envelope('run', 2)))).rejects.toThrow(
      /revision/,
    );
    expect(await plain.agentRuns.load('run')).toMatchObject({ revision: 2, modelSteps: 9 });
  });

  it('gives up after five attempts with the driver error, and never retries another code', async () => {
    const schema = await freshSchema();
    const pg = contended();
    const ops = createPostgresOpsStore({ client: pg.client, schema });
    pg.fail(/INSERT INTO \S+\.deuz_leases\b/, Infinity);
    await expect(
      ops.leases.acquire({ key: 'run', owner: 'a', ttlMs: 1_000 }),
    ).rejects.toMatchObject({ code: '40001' });
    expect(pg.attempts()).toBe(5);
    pg.fail(/INSERT INTO \S+\.deuz_leases\b/, Infinity, '57014');
    await expect(
      ops.leases.acquire({ key: 'run', owner: 'a', ttlMs: 1_000 }),
    ).rejects.toMatchObject({ code: '57014' });
    expect(pg.attempts()).toBe(1);
  });

  it('sends its schema statement again after a deadlock', async () => {
    const schema = await freshSchema();
    const pg = contended();
    pg.fail(/^\s*DO\b/, 1, '40P01');
    const ops = createPostgresOpsStore({ client: pg.client, schema });
    expect(await ops.agentRuns.load('missing')).toBeUndefined();
    expect(pg.attempts()).toBe(2);
  });
});

describe('Postgres swarm store retries (2.3)', () => {
  it.each(CODES)('runs a create and a commit again after %s', async (code) => {
    const schema = await freshSchema();
    const pg = contended();
    const store = createPostgresSwarmStore({ client: pg.client, schema });
    const snapshot = initialSnapshot();
    pg.fail(/WITH run AS \(\s*INSERT/, 1, code);
    await store.create(snapshot, [{ type: 'run.started', timestamp: 1 }]);
    expect(pg.attempts()).toBe(2);
    pg.fail(/WITH run AS \(\s*UPDATE/, 1, code);
    await store.commit({
      ...snapshot.run,
      expectedRevision: 0,
      tasks: [{ ...snapshot.tasks[0]!, status: 'running', attempt: 1 }],
      events: [{ type: 'task.started', taskId: 'a', timestamp: 2 }],
    });
    expect(pg.attempts()).toBe(2);
    expect((await store.load(snapshot.run))?.run).toMatchObject({ revision: 1, lastSequence: 2 });
    expect((await store.readEvents(snapshot.run, 0, 10)).map((event) => event.type)).toEqual([
      'run.started',
      'task.started',
    ]);
  });

  it.each(CODES)(
    'rejects a commit whose %s retries ran out with SwarmConflictError',
    async (code) => {
      const schema = await freshSchema();
      const pg = contended();
      const store = createPostgresSwarmStore({ client: pg.client, schema });
      const snapshot = initialSnapshot();
      await store.create(snapshot, [{ type: 'run.started', timestamp: 1 }]);
      pg.fail(/WITH run AS \(\s*UPDATE/, Infinity, code);
      const error = await Promise.resolve(
        store.commit({
          ...snapshot.run,
          expectedRevision: 0,
          events: [{ type: 'task.started', taskId: 'a', timestamp: 2 }],
        }),
      ).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(SwarmConflictError);
      expect((error as Error).cause).toMatchObject({ code });
      expect(pg.attempts()).toBe(5);
      expect((await store.head!(snapshot.run))?.revision).toBe(0);
    },
  );

  it('rejects a create whose retries ran out with SwarmConflictError', async () => {
    const schema = await freshSchema();
    const pg = contended();
    const store = createPostgresSwarmStore({ client: pg.client, schema });
    pg.fail(/WITH run AS \(\s*INSERT/, Infinity);
    await expect(store.create(initialSnapshot(), [])).rejects.toBeInstanceOf(SwarmConflictError);
    expect(await store.load(initialSnapshot().run)).toBeUndefined();
  });

  it('keeps any other error as it is', async () => {
    const schema = await freshSchema();
    const pg = contended();
    const store = createPostgresSwarmStore({ client: pg.client, schema });
    await store.create(initialSnapshot(), []);
    pg.fail(/WITH run AS \(\s*UPDATE/, Infinity, '57014');
    await expect(
      store.commit({ ...initialSnapshot().run, expectedRevision: 0 }),
    ).rejects.toMatchObject({ code: '57014' });
    expect(pg.attempts()).toBe(1);
  });
});

describe('Postgres budget store retries (2.3)', () => {
  const scope = { key: 'user:1', limits: { tokens: 100 } };

  it.each(CODES)(
    'runs each statement of a reserve, a settle and a release again after %s',
    async (code) => {
      const schema = await freshSchema();
      const pg = contended();
      const store = createPostgresBudgetStore({ client: pg.client, schema });
      pg.fail(/WITH created AS/, 1, code);
      expect(
        await store.reserve({ requestId: 'a', modelId: 'm', tokens: 40, scopes: [scope] }),
      ).toMatchObject({ admitted: true });
      expect(pg.attempts()).toBe(2);
      pg.fail(/WITH now_ms AS/, 1, code);
      expect(
        await store.reserve({ requestId: 'b', modelId: 'm', tokens: 40, scopes: [scope] }),
      ).toMatchObject({ admitted: true, scopes: [{ key: 'user:1', tokens: 80 }] });
      expect(pg.attempts()).toBe(2);
      // Each request was charged once.
      expect(await store.usage('user:1')).toEqual({ tokens: 80, usd: 0 });

      pg.fail(/WITH target AS/, 1, code);
      await store.settle('a', { tokens: 10, usd: 0 });
      expect(pg.attempts()).toBe(2);
      pg.fail(/WITH target AS/, 1, code);
      await store.release('b');
      expect(pg.attempts()).toBe(2);
      expect(await store.usage('user:1')).toEqual({ tokens: 10, usd: 0 });
    },
  );

  it.each(CODES)('runs a prune again after %s', async (code) => {
    const schema = await freshSchema();
    const pg = contended();
    const store = createPostgresBudgetStore({ client: pg.client, schema });
    await store.reserve({ requestId: 'a', modelId: 'm', tokens: 40, scopes: [scope] });
    await store.settle('a', { tokens: 10, usd: 0 });
    pg.fail(/dropped AS \(/, 1, code);
    expect(await store.prune!({ before: Date.now() + 1_000 })).toEqual({
      requests: 1,
      buckets: 0,
    });
    expect(pg.attempts()).toBe(2);
    expect(await store.usage('user:1')).toEqual({ tokens: 10, usd: 0 });
  });

  it('gives up on a reserve after five attempts with the driver error', async () => {
    const schema = await freshSchema();
    const pg = contended();
    const store = createPostgresBudgetStore({ client: pg.client, schema });
    pg.fail(/WITH now_ms AS/, Infinity);
    await expect(
      store.reserve({ requestId: 'a', modelId: 'm', tokens: 1, scopes: [scope] }),
    ).rejects.toMatchObject({ code: '40001' });
    expect(pg.attempts()).toBe(5);
    expect(await store.usage('user:1')).toEqual({ tokens: 0, usd: 0 });
  });
});

describe('Postgres store pack retries (2.3)', () => {
  it.each(CODES)('runs each upsert and delete again after %s', async (code) => {
    const schema = await freshSchema();
    const pg = contended();
    const stores = createPostgresStores({ client: pg.client, schema, pgvector: 'off' });
    await stores.migrate();
    const writes: [RegExp, () => unknown][] = [
      [
        /INSERT INTO \S+\.deuz_memory\b/,
        () =>
          stores.memory.upsert([
            {
              id: 'm1',
              text: 'likes tea',
              hash: 'h1',
              kind: 'semantic',
              scope: { userId: 'u' },
              createdAt: 1,
              updatedAt: 1,
            },
          ]),
      ],
      [/UPDATE \S+\.deuz_memory\b/, () => stores.memory.update('m1', { text: 'likes green tea' })],
      [
        /INSERT INTO \S+\.deuz_chats\b/,
        () =>
          stores.chats.saveChat({
            chatId: 'c1',
            scope: { userId: 'u' },
            messages: [],
            updatedAt: 1,
          }),
      ],
      [
        /INSERT INTO \S+\.deuz_sessions\b/,
        () =>
          stores.sessions.save({
            version: 1,
            runId: 'r1',
            stepId: 'r1#0',
            stepIndex: 0,
            status: 'running',
            messages: [],
            usage: {
              inputTokens: 0,
              outputTokens: 0,
              reasoningTokens: 0,
              cachedReadTokens: 0,
              cacheWriteTokens: 0,
              cacheWrite1hTokens: 0,
              totalTokens: 0,
            },
            createdAt: 1,
          }),
      ],
      [
        /INSERT INTO \S+\.deuz_runs\b/,
        () => stores.runs.create({ runId: 'r1', status: 'running', createdAt: 1, updatedAt: 1 }),
      ],
      [/DELETE FROM \S+\.deuz_chats\b/, () => stores.chats.deleteChat('c1')],
      [/DELETE FROM \S+\.deuz_memory\b/, () => stores.memory.delete(['m1'])],
    ];
    for (const [pattern, write] of writes) {
      pg.fail(pattern, 1, code);
      await write();
      expect(pg.attempts(), String(pattern)).toBe(2);
    }
    expect(await stores.memory.get('m1')).toBeNull();
    expect(await stores.chats.loadChat('c1')).toBeUndefined();
    expect(await stores.sessions.load('r1')).toMatchObject({ runId: 'r1' });
    expect(await stores.runs.get('r1')).toMatchObject({ status: 'running' });
  });
});
