/**
 * Lane L1B's acceptance scenarios (new.txt §5.1, versioned memory): the SQL
 * stores' atomic commit under a crash, a same-size embedding model switch
 * (legacy recall leaves the old vectors out and warns once; the versioned
 * stores refuse the new model until a re-embed swaps generations
 * atomically), and the import from the legacy SQLite and PostgreSQL memory
 * tables. Every run builds its own stores.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { build } from 'esbuild';
import { describe, expect } from 'vitest';
import {
  createInMemoryMemoryStore,
  recall,
  type MemoryRecord,
  type MemorySeams,
  type MemoryStore,
} from '../../src/memory';
import { importLegacyMemory } from '../../src/memory/versioned';
import type {
  VersionedMemoryCommit,
  VersionedMemoryMutation,
  VersionedMemoryStore,
} from '../../src/memory/versioned/types';
import { EmbeddingMismatchError } from '../../src/errors';
import { digestJson, sha256Digest } from '../../src/internal/digest';
import { NotImplementedError } from '../../src/internal/not-implemented';
import type { PgPoolClientLike, PgPoolLike } from '../../src/node/pg-tx';
import { createPostgresStores } from '../../src/node/store-postgres';
import {
  createSqliteStores,
  type SqliteDatabaseLike,
  type SqliteStatementLike,
} from '../../src/node/store-sqlite';
import { createPostgresVersionedMemoryStore } from '../../src/node/vmem-postgres';
import { createSqliteVersionedMemoryStore } from '../../src/node/vmem-sqlite';
import type { CallWarning } from '../../src/types/methods';
import { pglitePool } from '../fixtures/pg-pool';
import { SLOW_TEST_TIMEOUT_MS } from '../fixtures/timeouts';
import { scenario } from './registry';

const SCOPE = { userId: 'scenario-user' };

async function create(id: string, text: string, vector?: number[], modelId = 'model-a') {
  return {
    type: 'create' as const,
    record: {
      id,
      text,
      origin: 'asserted' as const,
      sources: [{ kind: 'host' as const, digest: await sha256Digest(text) }],
    },
    ...(vector ? { embedding: { vector, modelId, textDigest: await sha256Digest(text) } } : {}),
  };
}

async function operation(
  operationId: string,
  mutations: VersionedMemoryMutation[],
): Promise<VersionedMemoryCommit> {
  const request = { scope: SCOPE, actor: 'host' as const, mutations };
  return { operationId, ...request, requestDigest: await digestJson(request) };
}

/** Nothing of operation `op-1` (record `r1`) is visible: the all-or-nothing half of the scenario. */
async function expectNothingOf(store: VersionedMemoryStore): Promise<void> {
  expect(await store.get(SCOPE, 'r1', { includeRetracted: true })).toBeUndefined();
  expect(await store.history(SCOPE, 'r1')).toEqual([]);
  expect(await store.receipt('op-1')).toBeUndefined();
  expect(await store.scopeRevision(SCOPE)).toBe(0);
  expect(await store.embeddings.active()).toBeUndefined();
  expect(await store.search({ scope: SCOPE, text: 'written' })).toEqual([]);
}

/** A SQLite handle whose receipt insert throws while `fail.on`: the last write of a commit. */
function failingSqlite(db: DatabaseSync): SqliteDatabaseLike & { fail: { on: boolean } } {
  const fail = { on: false };
  return {
    fail,
    prepare(sql: string): SqliteStatementLike {
      const statement = db.prepare(sql) as unknown as SqliteStatementLike;
      if (!sql.startsWith('INSERT INTO deuz_vmem_receipts')) return statement;
      const guard =
        (key: keyof SqliteStatementLike) =>
        (...params: unknown[]) => {
          if (fail.on) throw new Error('crash before COMMIT');
          return (statement[key] as (...p: unknown[]) => unknown)(...params);
        };
      return { run: guard('run'), get: guard('get'), all: guard('all') } as SqliteStatementLike;
    },
    exec: (sql: string) => db.exec(sql),
    close: () => db.close(),
  };
}

/** A pool whose connections throw on the receipt insert while `fail.on`. */
function failingPool(inner: PgPoolLike): PgPoolLike & { fail: { on: boolean } } {
  const fail = { on: false };
  return {
    fail,
    query: (sql, params) => inner.query(sql, params),
    async connect(): Promise<PgPoolClientLike> {
      const connection = await inner.connect();
      return {
        query: (sql, params) =>
          fail.on && sql.startsWith('INSERT INTO public.deuz_vmem_receipts')
            ? Promise.reject(new Error('crash before COMMIT'))
            : connection.query(sql, params),
        release: (destroy) => connection.release(destroy),
      };
    },
  };
}

/** The child process that dies inside a commit (bundled once per file: an artifact, not a store). */
let child: Promise<string> | undefined;
function crashChild(dir: string): Promise<string> {
  child ??= (async () => {
    const out = join(dir, 'vmem-crash-child.mjs');
    await build({
      entryPoints: [fileURLToPath(new URL('../fixtures/vmem-crash-child.ts', import.meta.url))],
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node22',
      outfile: out,
      logLevel: 'silent',
    });
    return out;
  })();
  return child;
}
const childDir = mkdtempSync(join(tmpdir(), 'deuz-l1b-scenario-'));
process.on('exit', () => rmSync(childDir, { recursive: true, force: true }));

scenario(
  'versioned-memory',
  'sql-atomic-commit',
  async () => {
    const op = await operation('op-1', [
      await create('r1', 'written all at once or not at all', [1, 0, 0]),
    ]);

    // SQLite: a failure inside the transaction rolls back revision, index, vector,
    // generation, scope revision and receipt together; the retry commits once.
    const db = new DatabaseSync(':memory:');
    const handle = failingSqlite(db);
    const sqlite = createSqliteVersionedMemoryStore({ database: handle });
    handle.fail.on = true;
    await expect(sqlite.commit(op)).rejects.toThrow('crash before COMMIT');
    await expectNothingOf(sqlite);
    handle.fail.on = false;
    expect((await sqlite.commit(op)).status).toBe('committed');
    expect((await sqlite.commit(op)).status).toBe('replayed');
    expect((await sqlite.history(SCOPE, 'r1')).map((r) => r.revision)).toEqual([1]);
    await sqlite.close();
    db.close();

    // SQLite file: the process dies before COMMIT; the next open sees nothing of it.
    const dir = mkdtempSync(join(tmpdir(), 'deuz-l1b-crash-'));
    try {
      const path = join(dir, 'crash.db');
      const died = spawnSync(
        process.execPath,
        [await crashChild(childDir), path, 'INSERT INTO deuz_vmem_receipts'],
        { encoding: 'utf8', windowsHide: true },
      );
      expect(died.status, died.stderr).toBe(7);
      const reopened = createSqliteVersionedMemoryStore({ path });
      expect(await reopened.receipt('op-1')).toBeUndefined();
      expect(
        await reopened.get({ userId: 'crash' }, 'r1', { includeRetracted: true }),
      ).toBeUndefined();
      expect(await reopened.scopeRevision({ userId: 'crash' })).toBe(0);
      expect(await reopened.embeddings.active()).toBeUndefined();
      await reopened.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }

    // PostgreSQL: the same on one pinned connection.
    const pg = new PGlite();
    try {
      const pool = failingPool(pglitePool(pg));
      const postgres = createPostgresVersionedMemoryStore({ pool });
      pool.fail.on = true;
      await expect(postgres.commit(op)).rejects.toThrow('crash before COMMIT');
      await expectNothingOf(postgres);
      pool.fail.on = false;
      expect((await postgres.commit(op)).status).toBe('committed');
      expect((await postgres.commit(op)).status).toBe('replayed');
      expect((await postgres.history(SCOPE, 'r1')).map((r) => r.revision)).toEqual([1]);
    } finally {
      await pg.close();
    }
  },
  { fault: true, timeout: SLOW_TEST_TIMEOUT_MS },
);

scenario(
  'versioned-memory',
  'reembed-generation-swap',
  async () => {
    // Legacy recall (review focus 3): the embedder moves to another model of the
    // SAME size. Old vectors leave the vector ranking, are still found by text,
    // and the run hears about it once.
    const pack = createSqliteStores({ path: ':memory:' });
    const legacy: MemoryRecord = {
      id: 'old',
      text: 'The user lives in Istanbul',
      hash: 'h-old',
      kind: 'semantic',
      scope: SCOPE,
      createdAt: 1,
      updatedAt: 1,
      embedding: [1, 0, 0],
      embeddingModelId: 'model-a',
    };
    await pack.memory.upsert([legacy]);
    const seams: MemorySeams = {
      store: pack.memory,
      embedder: {
        embed: async (texts) => ({ vectors: texts.map(() => [1, 0, 0]), model: 'model-b' }),
      },
      llm: async () => '',
      clock: { now: () => 1, setTimeout: () => () => {} },
      generateId: () => 'id',
    };
    const warnings: CallWarning[] = [];
    const onWarning = (warning: CallWarning) => warnings.push(warning);
    expect(await recall({ scope: SCOPE, text: 'what about me?' }, seams, { onWarning })).toEqual(
      [],
    );
    expect(
      (await recall({ scope: SCOPE, text: 'Istanbul' }, seams, { onWarning })).map(
        (h) => h.record.id,
      ),
    ).toEqual(['old']);
    expect(new Set(warnings.map((w) => `${w.type}|${w.message}`))).toEqual(
      new Set([`embedding-mismatch|${warnings[0]!.message}`]),
    );
    await pack.close();

    // The versioned stores refuse the new model outright, then re-embed into a
    // pending generation and switch atomically once every current revision has
    // its vector there; a revision written meanwhile is embedded again.
    const pg = new PGlite();
    try {
      for (const store of [
        createSqliteVersionedMemoryStore({ path: ':memory:' }),
        createPostgresVersionedMemoryStore({ pool: pglitePool(pg) }),
      ]) {
        await store.commit(
          await operation('op-1', [
            await create('r1', 'The user lives in Istanbul', [1, 0, 0]),
            await create('r2', 'The user drinks tea', [0, 1, 0]),
          ]),
        );
        const query = (modelId: string, vector: number[]) =>
          store.search({ scope: SCOPE, embedding: { vector, modelId } });
        await expect(query('model-b', [1, 0, 0])).rejects.toBeInstanceOf(EmbeddingMismatchError);

        const next = await store.embeddings.begin({ modelId: 'model-b', dims: 3 });
        for (const item of await store.embeddings.pending(next.generation, { limit: 64 }))
          await store.embeddings.put(next.generation, [
            {
              id: item.id,
              revision: item.revision,
              textDigest: item.textDigest,
              vector: item.id === 'r1' ? [0, 0, 1] : [0, 1, 0],
            },
          ]);
        // r1 changes while the job runs: its new revision lacks a model-b vector.
        await store.commit({
          ...(await (async () => {
            const request = {
              scope: SCOPE,
              actor: 'host' as const,
              mutations: [
                {
                  type: 'revise' as const,
                  id: 'r1',
                  expectedRevision: 1,
                  changes: { text: 'The user moved to Ankara' },
                  embedding: {
                    vector: [1, 0, 0],
                    modelId: 'model-a',
                    textDigest: await sha256Digest('The user moved to Ankara'),
                  },
                },
              ],
            };
            return { operationId: 'op-2', ...request, requestDigest: await digestJson(request) };
          })()),
        });
        expect(await store.embeddings.activate(next.generation)).toBe(false);
        // The old generation keeps answering until the swap.
        expect((await query('model-a', [1, 0, 0]))[0]?.record.id).toBe('r1');
        const again = await store.embeddings.pending(next.generation, { limit: 64 });
        expect(again.map((item) => [item.id, item.revision])).toEqual([['r1', 2]]);
        await store.embeddings.put(next.generation, [
          { id: 'r1', revision: 2, textDigest: again[0]!.textDigest, vector: [0, 0, 1] },
        ]);
        expect(await store.embeddings.activate(next.generation)).toBe(true);
        expect((await query('model-b', [0, 0, 1]))[0]?.record).toMatchObject({
          id: 'r1',
          revision: 2,
        });
        await expect(query('model-a', [1, 0, 0])).rejects.toBeInstanceOf(EmbeddingMismatchError);
        await store.close();
      }
    } finally {
      await pg.close();
    }
  },
  { timeout: SLOW_TEST_TIMEOUT_MS },
);

/** importLegacyMemory belongs to lane L1A; until it lands this file runs on its W0 stub. */
const importReady = await (async () => {
  const probe = createSqliteVersionedMemoryStore({ path: ':memory:' });
  try {
    await importLegacyMemory({ from: createInMemoryMemoryStore(), to: probe, scope: SCOPE });
    return true;
  } catch (error) {
    return !(error instanceof NotImplementedError);
  } finally {
    await probe.close();
  }
})();

describe.skipIf(!importReady)('legacy import (needs L1A importLegacyMemory)', () => {
  scenario(
    'versioned-memory',
    'legacy-import',
    async () => {
      const seed = async (legacyStore: MemoryStore) =>
        legacyStore.upsert([
          {
            id: 'live',
            text: 'The user lives in Istanbul',
            hash: 'h1',
            kind: 'semantic',
            scope: SCOPE,
            createdAt: 1,
            updatedAt: 1,
            embedding: [1, 0, 0],
            embeddingModelId: 'model-a',
          },
          {
            id: 'pref',
            text: 'The user prefers tea',
            hash: 'h2',
            kind: 'procedural',
            scope: SCOPE,
            createdAt: 2,
            updatedAt: 2,
          },
          {
            id: 'gone',
            text: 'The user lived in Izmir',
            hash: 'h3',
            kind: 'semantic',
            scope: SCOPE,
            createdAt: 3,
            updatedAt: 3,
            invalidAt: 4,
          },
          {
            id: 'stale',
            text: 'A short-lived fact',
            hash: 'h4',
            kind: 'working',
            scope: SCOPE,
            createdAt: 4,
            updatedAt: 4,
            expiresAt: 5,
          },
        ]);

      const sqliteLegacy = createSqliteStores({ path: ':memory:' });
      const pg = new PGlite();
      try {
        const pool = pglitePool(pg);
        const postgresLegacy = createPostgresStores({ client: pool, pgvector: 'off' });
        await seed(sqliteLegacy.memory);
        await seed(postgresLegacy.memory);
        const targets: [MemoryStore, VersionedMemoryStore][] = [
          [sqliteLegacy.memory, createSqliteVersionedMemoryStore({ path: ':memory:' })],
          // The versioned tables live beside the legacy pack in the same database.
          [postgresLegacy.memory, createPostgresVersionedMemoryStore({ pool })],
        ];
        for (const [from, to] of targets) {
          const first = await importLegacyMemory({ from, to, scope: SCOPE });
          expect(first.imported).toBe(2);
          for (const legacyId of ['live', 'pref']) {
            const receipt = await to.receipt(`import:${legacyId}`);
            expect(receipt?.actor).toBe('import');
            const entry = receipt!.entries[0]!;
            expect(entry).toMatchObject({ type: 'create', revision: 1 });
            const record = await to.get(SCOPE, entry.id);
            expect(record).toMatchObject({ revision: 1, origin: 'inferred', status: 'active' });
            expect(record!.text).toBe((await from.get(legacyId))!.text);
            // Vectors are not carried over: re-embed instead.
            expect(record!.embedding).toBeUndefined();
            expect(await to.history(SCOPE, entry.id)).toHaveLength(1);
          }
          expect(await to.receipt('import:gone')).toBeUndefined();
          expect(await to.receipt('import:stale')).toBeUndefined();
          expect(await to.embeddings.active()).toBeUndefined();

          // Re-runnable: the second pass replays, nothing is duplicated.
          const revision = await to.scopeRevision(SCOPE);
          const second = await importLegacyMemory({ from, to, scope: SCOPE });
          expect(second.imported).toBe(0);
          expect(second.skipped).toBe(second.scanned);
          expect(await to.scopeRevision(SCOPE)).toBe(revision);
          await to.close?.();
        }
      } finally {
        await sqliteLegacy.close();
        await pg.close();
      }
    },
    { timeout: SLOW_TEST_TIMEOUT_MS },
  );
});
