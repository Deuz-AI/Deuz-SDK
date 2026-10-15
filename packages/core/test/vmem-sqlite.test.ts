/**
 * The SQLite versioned memory store (2.4): the shared contract on `:memory:`
 * (FTS5 and the LIKE fallback), plus what only this backend owes: its own
 * `deuz_vmem_schema` version table beside the legacy pack, connection
 * ownership, the FTS index kept in step across processes with and without
 * FTS5, and a commit that dies half way leaving nothing behind.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { afterEach, describe, expect, it } from 'vitest';
import type { VersionedMemoryCommit } from '../src/memory/versioned/types';
import type { ObserveEvent } from '../src/types/observe';
import { digestJson, sha256Digest } from '../src/internal/digest';
import type { SqliteDatabaseLike, SqliteStatementLike } from '../src/node/store-sqlite';
import { createSqliteStores } from '../src/node/store-sqlite';
import { createSqliteVersionedMemoryStore } from '../src/node/vmem-sqlite';
import { SLOW_TEST_TIMEOUT_MS } from './fixtures/timeouts';
import { assertVersionedMemoryStoreContract } from './fixtures/versioned-memory-store-conformance';

assertVersionedMemoryStoreContract('sqlite (fts5)', async ({ clock, logger }) => {
  const store = createSqliteVersionedMemoryStore({ path: ':memory:', clock, logger });
  return { store, cleanup: () => store.close() };
});

assertVersionedMemoryStoreContract('sqlite (LIKE fallback)', async ({ clock, logger }) => {
  const store = createSqliteVersionedMemoryStore({ path: ':memory:', fts: false, clock, logger });
  return { store, cleanup: () => store.close() };
});

const SCOPE = { userId: 'u1' };

async function createOp(
  operationId: string,
  id: string,
  text: string,
  vector?: number[],
): Promise<VersionedMemoryCommit> {
  const request = {
    scope: SCOPE,
    actor: 'host' as const,
    mutations: [
      {
        type: 'create' as const,
        record: {
          id,
          text,
          origin: 'asserted' as const,
          sources: [{ kind: 'host' as const, digest: await sha256Digest(text) }],
        },
        ...(vector
          ? { embedding: { vector, modelId: 'model-a', textDigest: await sha256Digest(text) } }
          : {}),
      },
    ],
  };
  return { operationId, ...request, requestDigest: await digestJson(request) };
}

/** A real handle whose statements starting with `prefix` throw while `fail.on` is set. */
function failingHandle(
  db: DatabaseSync,
  prefix: string,
): SqliteDatabaseLike & { fail: { on: boolean } } {
  const fail = { on: false };
  return {
    fail,
    prepare(sql: string): SqliteStatementLike {
      const statement = db.prepare(sql) as unknown as SqliteStatementLike;
      if (!sql.startsWith(prefix)) return statement;
      const guard =
        <K extends keyof SqliteStatementLike>(key: K) =>
        (...params: unknown[]) => {
          if (fail.on) throw new Error('injected failure');
          return (statement[key] as (...p: unknown[]) => unknown)(...params);
        };
      return { run: guard('run'), get: guard('get'), all: guard('all') } as SqliteStatementLike;
    },
    exec: (sql: string) => db.exec(sql),
    close: () => db.close(),
  };
}

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'deuz-vmem-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('createSqliteVersionedMemoryStore: schema and connection', () => {
  it(
    'keeps its version in deuz_vmem_schema and leaves the legacy pack alone',
    { timeout: SLOW_TEST_TIMEOUT_MS },
    async () => {
      const path = join(tempDir(), 'shared.db');
      const legacy = createSqliteStores({ path });
      await legacy.memory.upsert([
        {
          id: 'm1',
          text: 'legacy fact',
          hash: 'h1',
          kind: 'semantic',
          scope: SCOPE,
          createdAt: 1,
          updatedAt: 1,
        },
      ]);
      const before = new DatabaseSync(path);
      const userVersion = before.prepare('PRAGMA user_version').get() as { user_version: number };
      before.close();

      const store = createSqliteVersionedMemoryStore({ path });
      await store.commit(await createOp('op-1', 'r1', 'versioned fact'));
      await store.close();

      const db = new DatabaseSync(path);
      expect(db.prepare('SELECT version FROM deuz_vmem_schema').get()).toEqual({ version: 1 });
      expect(db.prepare('PRAGMA user_version').get()).toEqual(userVersion);
      db.close();
      expect((await legacy.memory.get('m1'))?.text).toBe('legacy fact');
      await legacy.close();
    },
  );

  it('refuses a database a newer build wrote', async () => {
    const db = new DatabaseSync(':memory:');
    db.exec(
      'CREATE TABLE deuz_vmem_schema (singleton INTEGER PRIMARY KEY, version INTEGER NOT NULL)',
    );
    db.exec('INSERT INTO deuz_vmem_schema (singleton, version) VALUES (1, 2)');
    const store = createSqliteVersionedMemoryStore({
      database: db as unknown as SqliteDatabaseLike,
    });
    await expect(store.scopeRevision(SCOPE)).rejects.toThrow(/newer than this build reads/);
    db.close();
  });

  it('leaves a borrowed handle open and closes one it opened', async () => {
    const db = new DatabaseSync(':memory:');
    const borrowed = createSqliteVersionedMemoryStore({
      database: db as unknown as SqliteDatabaseLike,
    });
    await borrowed.commit(await createOp('op-1', 'r1', 'fact'));
    await borrowed.close();
    expect(db.prepare('SELECT COUNT(*) AS n FROM deuz_vmem_records').get()).toEqual({ n: 1 });
    db.close();

    const owned = createSqliteVersionedMemoryStore({ path: ':memory:' });
    await owned.scopeRevision(SCOPE);
    await owned.close();
    await expect(owned.scopeRevision(SCOPE)).rejects.toThrow(/closed/);
  });

  it(
    'rebuilds the FTS index after a process without FTS5 wrote to the file',
    { timeout: SLOW_TEST_TIMEOUT_MS },
    async () => {
      const path = join(tempDir(), 'mixed.db');
      const withFts = createSqliteVersionedMemoryStore({ path });
      await withFts.commit(await createOp('op-1', 'r1', 'indexed apple fact'));
      await withFts.close();
      // A Node without FTS5 (22.14) writes and forgets behind the index's back.
      const without = createSqliteVersionedMemoryStore({ path, fts: false });
      await without.commit(await createOp('op-2', 'r2', 'unindexed apple fact'));
      await without.forget(SCOPE, 'r1', 'forget-1');
      await without.close();

      const again = createSqliteVersionedMemoryStore({ path });
      const hits = await again.search({ scope: SCOPE, text: 'apple' });
      expect(hits.map((hit) => hit.record.id)).toEqual(['r2']);
      await again.close();
      const db = new DatabaseSync(path);
      db.exec("INSERT INTO deuz_vmem_fts(deuz_vmem_fts) VALUES('integrity-check')");
      db.close();
    },
  );
});

/** Whether this Node's SQLite has FTS5 (22.14's does not). */
function hasFts5(): boolean {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('CREATE VIRTUAL TABLE probe USING fts5(text)');
    return true;
  } catch {
    return false;
  } finally {
    db.close();
  }
}

/** Every byte the FTS5 index holds in its shadow b-tree. */
function ftsShadow(db: DatabaseSync): Buffer {
  const rows = db.prepare('SELECT block FROM deuz_vmem_fts_data').all() as { block: unknown }[];
  return Buffer.concat(
    rows.map((row) => (row.block instanceof Uint8Array ? Buffer.from(row.block) : Buffer.alloc(0))),
  );
}

async function changeOp(
  operationId: string,
  mutation: VersionedMemoryCommit['mutations'][number],
): Promise<VersionedMemoryCommit> {
  const request = { scope: SCOPE, actor: 'host' as const, mutations: [mutation] };
  return { operationId, ...request, requestDigest: await digestJson(request) };
}

describe.skipIf(!hasFts5())(
  'createSqliteVersionedMemoryStore: deleted text leaves the index',
  () => {
    it('forget and pruneHistory remove the tokens from the FTS shadow table itself', async () => {
      const db = new DatabaseSync(':memory:');
      const store = createSqliteVersionedMemoryStore({
        database: db as unknown as SqliteDatabaseLike,
      });
      await store.commit(await createOp('op-1', 'r1', 'my secret password is zebracornxyz'));
      await store.commit(await createOp('op-2', 'r2', 'an unrelated kept fact'));
      await store.commit(await createOp('op-3', 'r3', 'an old quokkaflamingo note'));
      await store.commit(
        await changeOp('op-4', {
          type: 'revise',
          id: 'r3',
          expectedRevision: 1,
          changes: { text: 'a plain note' },
        }),
      );
      await store.commit(
        await changeOp('op-5', { type: 'retract', id: 'r3', expectedRevision: 2 }),
      );
      expect(ftsShadow(db).includes('zebracornxyz')).toBe(true);
      expect(ftsShadow(db).includes('quokkaflamingo')).toBe(true);

      await store.forget(SCOPE, 'r1', 'forget-1');
      expect(await store.pruneHistory({ olderThan: Date.now() + 60_000 })).toBe(2);

      const shadow = ftsShadow(db);
      expect(shadow.includes('zebracornxyz')).toBe(false);
      expect(shadow.includes('quokkaflamingo')).toBe(false);
      expect(shadow.includes('unrelated')).toBe(true);
      expect(
        (await store.search({ scope: SCOPE, text: 'unrelated' })).map((h) => h.record.id),
      ).toEqual(['r2']);
      db.exec("INSERT INTO deuz_vmem_fts(deuz_vmem_fts) VALUES('integrity-check')");
      await store.close();
      db.close();
    });

    it(
      'a forget by a process without FTS5 leaves the index once a process with it opens the file',
      { timeout: SLOW_TEST_TIMEOUT_MS },
      async () => {
        const path = join(tempDir(), 'mixed-forget.db');
        const withFts = createSqliteVersionedMemoryStore({ path });
        await withFts.commit(await createOp('op-1', 'r1', 'my secret password is zebracornxyz'));
        await withFts.commit(await createOp('op-2', 'r2', 'an unrelated kept fact'));
        await withFts.close();
        const without = createSqliteVersionedMemoryStore({ path, fts: false });
        await without.forget(SCOPE, 'r1', 'forget-1');
        await without.close();

        const again = createSqliteVersionedMemoryStore({ path });
        await again.scopeRevision(SCOPE);
        await again.close();
        const db = new DatabaseSync(path);
        const shadow = ftsShadow(db);
        expect(shadow.includes('zebracornxyz')).toBe(false);
        expect(shadow.includes('unrelated')).toBe(true);
        db.close();
      },
    );
  },
);

describe('createSqliteVersionedMemoryStore: embedding generations', () => {
  it('drops the vectors of a pending generation that another model replaces', async () => {
    const db = new DatabaseSync(':memory:');
    const store = createSqliteVersionedMemoryStore({ database: db });
    await store.commit(await createOp('op-1', 'r1', 'a fact', [1, 0, 0]));
    const abandoned = await store.embeddings.begin({ modelId: 'model-b', dims: 2 });
    const vectors = (generation: number) =>
      db
        .prepare('SELECT COUNT(*) AS n FROM deuz_vmem_vectors WHERE generation = ?')
        .get(generation);
    expect(
      await store.embeddings.put(abandoned.generation, [
        { id: 'r1', revision: 1, textDigest: await sha256Digest('a fact'), vector: [1, 0] },
      ]),
    ).toBe(1);
    expect(vectors(abandoned.generation)).toEqual({ n: 1 });
    const next = await store.embeddings.begin({ modelId: 'model-c', dims: 2 });
    expect(vectors(abandoned.generation)).toEqual({ n: 0 });
    expect(
      db
        .prepare("SELECT generation, status FROM deuz_vmem_generations WHERE status <> 'active'")
        .all(),
    ).toEqual([
      { generation: abandoned.generation, status: 'retired' },
      { generation: next.generation, status: 'pending' },
    ]);
    await store.close();
    db.close();
  });
});

describe('createSqliteVersionedMemoryStore: a commit that fails half way', () => {
  it('rolls back the revision, index, vector, scope revision and receipt together', async () => {
    const db = new DatabaseSync(':memory:');
    const handle = failingHandle(db, 'INSERT INTO deuz_vmem_receipts');
    const store = createSqliteVersionedMemoryStore({ database: handle });
    const op = await createOp('op-1', 'r1', 'a fact that must never be half written', [1, 0, 0]);

    handle.fail.on = true;
    await expect(store.commit(op)).rejects.toThrow('injected failure');

    expect(await store.get(SCOPE, 'r1', { includeRetracted: true })).toBeUndefined();
    expect(await store.history(SCOPE, 'r1')).toEqual([]);
    expect(await store.receipt('op-1')).toBeUndefined();
    expect(await store.scopeRevision(SCOPE)).toBe(0);
    expect(await store.search({ scope: SCOPE, text: 'fact' })).toEqual([]);
    expect(await store.embeddings.active()).toBeUndefined();
    for (const table of [
      'deuz_vmem_revisions',
      'deuz_vmem_records',
      'deuz_vmem_vectors',
      'deuz_vmem_fts',
    ])
      expect(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()).toEqual({ n: 0 });

    handle.fail.on = false;
    expect((await store.commit(op)).status).toBe('committed');
    expect((await store.commit(op)).status).toBe('replayed');
    expect((await store.history(SCOPE, 'r1')).map((r) => r.revision)).toEqual([1]);
    await store.close();
    db.close();
  });

  it(
    'leaves nothing after the process dies before COMMIT',
    { timeout: SLOW_TEST_TIMEOUT_MS },
    async () => {
      const dir = tempDir();
      const path = join(dir, 'crash.db');
      const child = join(dir, 'child.mjs');
      await build({
        entryPoints: [fileURLToPath(new URL('./fixtures/vmem-crash-child.ts', import.meta.url))],
        bundle: true,
        platform: 'node',
        format: 'esm',
        target: 'node22',
        outfile: child,
        logLevel: 'silent',
      });
      const result = spawnSync(process.execPath, [child, path, 'INSERT INTO deuz_vmem_receipts'], {
        encoding: 'utf8',
        windowsHide: true,
      });
      expect(result.status, result.stderr).toBe(7);

      const store = createSqliteVersionedMemoryStore({ path });
      expect(await store.get(SCOPE, 'r1', { includeRetracted: true })).toBeUndefined();
      expect(
        await store.get({ userId: 'crash' }, 'r1', { includeRetracted: true }),
      ).toBeUndefined();
      expect(await store.receipt('op-1')).toBeUndefined();
      expect(await store.scopeRevision({ userId: 'crash' })).toBe(0);
      expect(await store.embeddings.active()).toBeUndefined();
      expect(await store.search({ scope: { userId: 'crash' }, text: 'fact' })).toEqual([]);
      await store.close();
      const db = new DatabaseSync(path);
      expect(db.prepare('SELECT COUNT(*) AS n FROM deuz_vmem_revisions').get()).toEqual({ n: 0 });
      db.exec("INSERT INTO deuz_vmem_fts(deuz_vmem_fts) VALUES('integrity-check')");
      db.close();
    },
  );
});

describe('createSqliteVersionedMemoryStore: telemetry', () => {
  it('reports deuz.memory.op spans for the retention calls, with counts only', async () => {
    const events: ObserveEvent[] = [];
    const store = createSqliteVersionedMemoryStore({
      path: ':memory:',
      observer: { emit: (event) => events.push(event) },
    });
    await store.commit(await createOp('op-1', 'r1', 'secret fact'));
    await store.pruneHistory({ olderThan: Date.now() + 1 });
    await store.pruneOperations({ olderThan: Date.now() + 1 });
    const completed = events.filter(
      (event) => event.type === 'operation.completed' && event.operation === 'deuz.memory.op',
    );
    expect(completed.map((event) => (event as { attributes?: unknown }).attributes)).toEqual([
      { 'deuz.memory.operation': 'prune-history', 'deuz.memory.record_count': 0 },
      { 'deuz.memory.operation': 'prune-operations', 'deuz.memory.record_count': 1 },
    ]);
    expect(JSON.stringify(events)).not.toContain('secret');
    await store.close();
  });
});
