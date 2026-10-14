/**
 * A child process that dies in the middle of a versioned memory commit (2.4):
 * bundled by the test with esbuild and run with `node`, it opens the SQLite
 * store on the file in argv[2] and commits one operation whose transaction
 * calls `process.exit(7)` on the statement named in argv[3], after the
 * revision, index and vector writes and before COMMIT. Nothing is rolled back
 * by the process: SQLite's recovery on the next open must drop it all.
 */
import { DatabaseSync } from 'node:sqlite';
import { createSqliteVersionedMemoryStore } from '../../src/node/vmem-sqlite';
import { digestJson, sha256Digest } from '../../src/internal/digest';
import type { SqliteDatabaseLike, SqliteStatementLike } from '../../src/node/store-sqlite';

const [, , path, dieOn] = process.argv as [string, string, string, string];

const db = new DatabaseSync(path);
db.exec('PRAGMA journal_mode = WAL');
const handle: SqliteDatabaseLike = {
  prepare(sql: string): SqliteStatementLike {
    const statement = db.prepare(sql) as unknown as SqliteStatementLike;
    if (!sql.startsWith(dieOn)) return statement;
    return {
      run: () => process.exit(7),
      get: () => process.exit(7),
      all: () => process.exit(7),
    };
  },
  exec: (sql: string) => db.exec(sql),
  close: () => db.close(),
};

const store = createSqliteVersionedMemoryStore({ database: handle });
const text = 'a fact that must never be half written';
const request = {
  scope: { userId: 'crash' },
  actor: 'host' as const,
  mutations: [
    {
      type: 'create' as const,
      record: {
        id: 'r1',
        text,
        origin: 'asserted' as const,
        sources: [{ kind: 'host' as const, digest: await sha256Digest(text) }],
      },
      embedding: { vector: [1, 0, 0], modelId: 'model-a', textDigest: await sha256Digest(text) },
    },
  ],
};
await store.commit({ operationId: 'op-1', ...request, requestDigest: await digestJson(request) });
// Reaching this line means the statement never ran: the test fails on exit code 0.
process.exit(0);
