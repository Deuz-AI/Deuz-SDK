/**
 * retention-2-4.test.ts (2.4, spec §4.4 "Saklama, temizlik ve forget") —
 * what the explicit retention calls of the 2.4 stores share, on every
 * backend that has them, beyond each store's own conformance suite:
 *
 * - a malformed cutoff is refused before anything is deleted (process
 *   operations and conditional chats checked none before);
 * - a cutoff is exclusive: a record stamped exactly at it stays;
 * - what guards dedupe and forgetting outlives retention: versioned memory
 *   receipts (content-free) survive `pruneHistory` and a forgotten id's
 *   tombstone survives `pruneOperations`; a V3 store's forget tombstones
 *   survive `prune`, so a package put later is still stored redacted;
 * - `pruneOperations` warns the same way on every backend;
 * - a versioned memory `forget` deletes memory only: the chat a record cites,
 *   its transcript search hit and the source reference stay, also when the
 *   chats and the memory share one SQLite database or Postgres schema.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import pg from 'pg';
import { createInMemoryAgentRunStoreV3 } from '../src/agent-run-v3-store';
import {
  createInMemoryConditionalChatStore,
  createInMemoryTranscriptIndex,
} from '../src/chat-conditional';
import { createInMemoryProcessOperationStore } from '../src/compute/docker';
import type { ProcessOperationStore } from '../src/compute/docker/types';
import { InvalidRequestError } from '../src/errors';
import { sha256Digest } from '../src/internal/digest';
import { createInMemoryVersionedMemoryStore, createMemorySession } from '../src/memory/versioned';
import type { MemorySourceRef, VersionedMemoryStore } from '../src/memory/versioned/types';
import { createPostgresConditionalChatStore } from '../src/node/chat-conditional-postgres';
import { createSqliteConditionalChatStore } from '../src/node/chat-conditional-sqlite';
import type { PgPoolLike } from '../src/node/pg-tx';
import { createSqliteProcessOperationStore } from '../src/node/process-ops-sqlite';
import { createPostgresAgentRunStoreV3 } from '../src/node/runs-v3-postgres';
import { createSqliteAgentRunStoreV3 } from '../src/node/runs-v3-sqlite';
import type { SqliteDatabaseLike } from '../src/node/store-sqlite';
import { createPostgresVersionedMemoryStore } from '../src/node/vmem-postgres';
import { createSqliteVersionedMemoryStore } from '../src/node/vmem-sqlite';
import {
  createInMemoryDurableStreamStateStore,
  DEFAULT_DURABLE_STREAM_RETAIN_MS,
} from '../src/stream-durable';
import type { AgentRunStoreV3 } from '../src/types/agent-run-v3';
import type { ConditionalChatStore, TranscriptIndex } from '../src/types/chat-conditional';
import type { Clock } from '../src/types/deps';
import { chat } from './fixtures/conditional-chat-store-conformance';
import { envelopeV3 } from './fixtures/agent-run-v3';
import { manualClock } from './fixtures/manual-clock';
import { pglitePool } from './fixtures/pg-pool';
import { newRecord } from './fixtures/process-ops-store-conformance';
import {
  checkForgetOutlivesPrune,
  checkMemoryRetention,
  loggerWith,
  type MemoryRetentionHarness,
} from './fixtures/retention-2-4';
import { postgresUrl } from './fixtures/services';
import { SLOW_HOOK_TIMEOUT_MS, SLOW_TEST_TIMEOUT_MS } from './fixtures/timeouts';

const SLOW = { timeout: SLOW_TEST_TIMEOUT_MS };
const BAD_CUTOFFS: unknown[] = [Number.NaN, Number.POSITIVE_INFINITY, '5', null, undefined];

/** Calls `fn` so that a synchronous throw becomes a rejection. */
const attempt = (fn: () => unknown) => Promise.resolve().then(fn);

// ===================================================================
// Argument checks
// ===================================================================

describe('process operation retention refuses a malformed cutoff', () => {
  const stores: [string, () => ProcessOperationStore][] = [
    ['in-memory', () => createInMemoryProcessOperationStore()],
    ['SQLite', () => createSqliteProcessOperationStore({ path: ':memory:' })],
  ];
  for (const [name, make] of stores)
    it(name, async () => {
      const store = make();
      await store.create(newRecord({ operationId: 'done', state: 'exited' }));
      for (const terminalBefore of BAD_CUTOFFS)
        await expect(
          attempt(() => store.prune({ terminalBefore } as never)),
          String(terminalBefore),
        ).rejects.toThrow(TypeError);
      await expect(attempt(() => store.prune(undefined as never))).rejects.toThrow(TypeError);
      expect(await store.get('tenant-a', 'done')).toBeDefined();
      await store.close?.();
    });
});

describe('conditional chat retention refuses a malformed cutoff', () => {
  const check = async (store: ConditionalChatStore) => {
    await store.deleteChat('gone');
    for (const before of BAD_CUTOFFS)
      await expect(
        attempt(() => store.pruneTombstones(before as never)),
        String(before),
      ).rejects.toThrow(InvalidRequestError);
    expect((await store.readChat('gone')).status).toBe('deleted');
  };
  it('in-memory', () => check(createInMemoryConditionalChatStore()));
  it('SQLite', async () => {
    const store = createSqliteConditionalChatStore({ path: ':memory:' });
    await check(store);
    await store.close();
  });
  it('Postgres (PGlite)', SLOW, async () => {
    const db = new PGlite();
    try {
      const store = createPostgresConditionalChatStore({ pool: pglitePool(db) });
      await check(store);
      await store.close();
    } finally {
      await db.close();
    }
  });
});

// ===================================================================
// Exclusive cutoffs (stores with an injectable clock)
// ===================================================================

describe('a record stamped exactly at the cutoff stays', () => {
  it('process operations (in-memory and SQLite)', async () => {
    for (const make of [
      (clock: Clock) => createInMemoryProcessOperationStore({ deps: { clock } }),
      (clock: Clock) => createSqliteProcessOperationStore({ path: ':memory:', clock }),
    ]) {
      const { clock, advance } = manualClock();
      const store = make(clock);
      await store.create(newRecord({ operationId: 'old', state: 'exited' }));
      await advance(10);
      const cut = clock.now();
      await store.create(newRecord({ operationId: 'at-cut', state: 'failed' }));
      expect(await store.prune({ terminalBefore: cut })).toBe(1);
      expect(await store.get('tenant-a', 'at-cut')).toBeDefined();
      expect(await store.prune({ terminalBefore: cut + 1 })).toBe(1);
      await store.close?.();
    }
  });

  it('V3 runs (in-memory and SQLite)', async () => {
    for (const make of [
      (clock: Clock) => createInMemoryAgentRunStoreV3({ deps: { clock } }),
      (clock: Clock) => createSqliteAgentRunStoreV3({ path: ':memory:', clock }),
    ]) {
      const { clock, advance } = manualClock();
      const store = make(clock);
      await store.save(envelopeV3('old', 1, { phase: 'terminal' }));
      await advance(10);
      const cut = clock.now();
      await store.save(envelopeV3('at-cut', 1, { phase: 'terminal' }));
      expect(await store.prune({ terminalBefore: cut })).toBe(1);
      expect(await store.load('at-cut')).toBeDefined();
      await store.close?.();
    }
  });
});

describe('the durable stream default retention', () => {
  it('is 24 hours: a terminal stream younger than that stays, an older one goes', async () => {
    expect(DEFAULT_DURABLE_STREAM_RETAIN_MS).toBe(86_400_000);
    const { clock, advance } = manualClock();
    const store = createInMemoryDurableStreamStateStore({ deps: { clock } });
    const done = { seq: 0, part: { type: 'done' } } as never;
    await store.commit({ streamId: 'old', token: 1, records: [done] });
    await advance(3_600_000);
    await store.commit({ streamId: 'young', token: 1, records: [done] });
    await advance(DEFAULT_DURABLE_STREAM_RETAIN_MS - 1_800_000);
    // old: 24.5 h without activity; young: 23.5 h.
    expect(
      await store.prune({ terminalBefore: clock.now() - DEFAULT_DURABLE_STREAM_RETAIN_MS }),
    ).toBe(1);
    expect(await store.lastSeq('old')).toBeUndefined();
    expect(await store.lastSeq('young')).toBe(0);
  });
});

// ===================================================================
// Versioned memory: dedupe and forgetting outlive retention
// ===================================================================

interface MemoryHarness extends MemoryRetentionHarness {
  cleanup?(): Promise<void>;
}

function memoryRetention(name: string, make: () => Promise<MemoryHarness>, slow = false): void {
  it(
    `${name}: receipts outlive pruneHistory, a forgotten id outlives pruneOperations`,
    slow ? SLOW : {},
    async () => {
      const harness = await make();
      try {
        await checkMemoryRetention(harness);
      } finally {
        await harness.cleanup?.();
      }
    },
  );
}

describe('versioned memory retention', () => {
  memoryRetention('in-memory', async () => {
    const { clock, advance } = manualClock(1_000_000);
    const warn = vi.fn();
    return {
      store: createInMemoryVersionedMemoryStore({ deps: { clock, logger: loggerWith(warn) } }),
      clock,
      advance,
      warn,
    };
  });

  memoryRetention(
    'SQLite',
    async () => {
      const { clock, advance } = manualClock(1_000_000);
      const warn = vi.fn();
      const store = createSqliteVersionedMemoryStore({
        path: ':memory:',
        clock,
        logger: loggerWith(warn),
      });
      return { store, clock, advance, warn, cleanup: () => store.close() };
    },
    true,
  );

  describe('Postgres (PGlite)', SLOW, () => {
    const db = new PGlite();
    beforeAll(() => db.waitReady, SLOW_HOOK_TIMEOUT_MS);
    afterAll(async () => {
      await db.close();
    });
    const pool = pglitePool(db);
    memoryRetention(
      'PGlite',
      async () => {
        const { clock, advance } = manualClock(1_000_000);
        const warn = vi.fn();
        await pool.query('CREATE SCHEMA IF NOT EXISTS e2_vmem_retention');
        const store = createPostgresVersionedMemoryStore({
          pool,
          schema: 'e2_vmem_retention',
          clock,
          logger: loggerWith(warn),
          pgvector: 'off',
        });
        return { store, clock, advance, warn, cleanup: () => store.close() };
      },
      true,
    );
  });
});

// ===================================================================
// A memory forget leaves chats and the transcript index alone
// ===================================================================

const SAID = 'The deploy key is under the mat.';

interface ForgetSparesChatsHarness {
  chats: ConditionalChatStore;
  transcript: TranscriptIndex;
  memory: VersionedMemoryStore;
  /** Every row of every table but the memory store's own, when both share a database. */
  rows?(): Promise<string[]>;
  cleanup?(): Promise<void>;
}

/**
 * Forgets a record that cites a chat message (spec §2.1: `forget` never
 * touches chats, the transcript index, host files or exported drafts).
 */
async function checkForgetSparesChats(harness: ForgetSparesChatsHarness): Promise<void> {
  const { chats, transcript, memory } = harness;
  const said = chat('c-1', [SAID, 'Noted.'], { messageIds: ['m-1', 'm-2'] });
  expect((await chats.writeChat(said, { expectedRevision: 0 })).status).toBe('committed');
  const ref: MemorySourceRef = {
    kind: 'user',
    chatId: 'c-1',
    messageId: 'm-1',
    digest: await sha256Digest(SAID),
  };
  const session = createMemorySession({ store: memory, scope: said.scope });
  const { id } = (await session.remember({ text: SAID, sources: [ref] })).records[0]!;
  const before = await chats.readChat('c-1');
  const rowsBefore = await harness.rows?.();
  if (rowsBefore)
    expect(rowsBefore.filter((row) => row.startsWith('deuz_chat_transcript '))).toHaveLength(2);

  expect((await session.forget(id)).revisions).toHaveLength(1);
  expect(await session.history(id)).toEqual([]);

  expect(await chats.readChat('c-1')).toEqual(before);
  expect(await chats.listChats(said.scope)).toEqual(['c-1']);
  const hits = await transcript.search(said.scope, 'deploy key');
  expect(hits.map((hit) => [hit.chatId, hit.messageId])).toEqual([['c-1', 'm-1']]);
  expect(await transcript.resolveSource(said.scope, ref)).toMatchObject({
    chatId: 'c-1',
    messageId: 'm-1',
    message: { content: SAID },
  });
  if (rowsBefore) expect(await harness.rows!()).toEqual(rowsBefore);
}

function forgetSparesChats(
  name: string,
  make: () => Promise<ForgetSparesChatsHarness>,
  slow = false,
): void {
  it(`${name}: the chat and its transcript hit stay`, slow ? SLOW : {}, async () => {
    const harness = await make();
    try {
      await checkForgetSparesChats(harness);
    } finally {
      await harness.cleanup?.();
    }
  });
}

/** Neither the memory store's own tables nor SQLite's internal ones. */
const outsideMemory = (table: string) =>
  !table.startsWith('deuz_vmem_') && !table.startsWith('sqlite_');

/** The rows of a Postgres schema's tables but the memory store's, sorted. */
async function pgRowsOutsideMemory(pool: PgPoolLike, schema: string): Promise<string[]> {
  const { rows: tables } = await pool.query(
    'SELECT table_name FROM information_schema.tables WHERE table_schema = $1',
    [schema],
  );
  const rows: string[] = [];
  for (const table of tables.map((row) => String(row.table_name)).filter(outsideMemory))
    for (const row of (await pool.query(`SELECT * FROM ${schema}.${table}`)).rows)
      rows.push(`${table} ${JSON.stringify(row)}`);
  return rows.sort();
}

type DatabaseSyncConstructor = new (path: string) => SqliteDatabaseLike & { close(): void };
let DatabaseSync: DatabaseSyncConstructor | undefined;
try {
  const mod = (await import('node:sqlite' as string)) as { DatabaseSync?: DatabaseSyncConstructor };
  DatabaseSync = typeof mod.DatabaseSync === 'function' ? mod.DatabaseSync : undefined;
} catch {
  /* runtime without node:sqlite */
}

describe('a versioned memory forget leaves chats and the transcript index alone', () => {
  forgetSparesChats('in-memory', async () => {
    const transcript = createInMemoryTranscriptIndex();
    return {
      chats: createInMemoryConditionalChatStore({ transcript }),
      transcript,
      memory: createInMemoryVersionedMemoryStore(),
    };
  });

  describe.skipIf(!DatabaseSync)('SQLite', () => {
    forgetSparesChats(
      'one database',
      async () => {
        const db = new DatabaseSync!(':memory:');
        const chats = createSqliteConditionalChatStore({ database: db });
        const memory = createSqliteVersionedMemoryStore({ database: db });
        return {
          chats,
          transcript: chats.transcript,
          memory,
          async rows() {
            const tables = db
              .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
              .all() as { name: string }[];
            const rows: string[] = [];
            for (const table of tables.map((row) => row.name).filter(outsideMemory))
              for (const row of db.prepare(`SELECT * FROM "${table}"`).all())
                rows.push(`${table} ${JSON.stringify(row)}`);
            return rows.sort();
          },
          async cleanup() {
            await memory.close();
            await chats.close();
            db.close();
          },
        };
      },
      true,
    );
  });

  describe('Postgres (PGlite)', SLOW, () => {
    const db = new PGlite();
    beforeAll(() => db.waitReady, SLOW_HOOK_TIMEOUT_MS);
    afterAll(async () => {
      await db.close();
    });
    const pool = pglitePool(db);
    forgetSparesChats(
      'one schema',
      async () => {
        const schema = 'he_forget_spares_chats';
        await pool.query(`CREATE SCHEMA ${schema}`);
        const chats = createPostgresConditionalChatStore({ pool, schema });
        const memory = createPostgresVersionedMemoryStore({ pool, schema, pgvector: 'off' });
        return {
          chats,
          transcript: chats.transcript,
          memory,
          rows: () => pgRowsOutsideMemory(pool, schema),
          async cleanup() {
            await memory.close();
            await chats.close();
          },
        };
      },
      true,
    );
  });
});

// ===================================================================
// V3 runs: forget tombstones outlive prune
// ===================================================================

function runsRetention(name: string, make: () => Promise<AgentRunStoreV3>, slow = false): void {
  it(
    `${name}: a forget outlives the prune of every run that held the record`,
    slow ? SLOW : {},
    async () => {
      const store = await make();
      try {
        // Past the last save, a database clock included.
        await checkForgetOutlivesPrune(store, () => Date.now() + 60_000);
      } finally {
        await store.close?.();
      }
    },
  );
}

describe('V3 run retention', () => {
  runsRetention('in-memory', async () => createInMemoryAgentRunStoreV3());
  runsRetention('SQLite', async () => createSqliteAgentRunStoreV3({ path: ':memory:' }), true);
  describe('Postgres (PGlite)', SLOW, () => {
    const db = new PGlite();
    beforeAll(() => db.waitReady, SLOW_HOOK_TIMEOUT_MS);
    afterAll(async () => {
      await db.close();
    });
    const pool = pglitePool(db);
    runsRetention(
      'PGlite',
      async () => {
        await pool.query('CREATE SCHEMA IF NOT EXISTS e2_runs_retention');
        return createPostgresAgentRunStoreV3({ pool, schema: 'e2_runs_retention' });
      },
      true,
    );
  });
});

// ===================================================================
// Live servers
// ===================================================================

const liveUrl = postgresUrl();

describe.skipIf(!liveUrl)('retention on a live Postgres server', () => {
  let pool: pg.Pool;
  const prefix = `deuz_e2_retention_${Date.now().toString(36)}`;
  const schemas: string[] = [];
  const freshSchema = async () => {
    const schema = `${prefix}_${schemas.length + 1}`;
    schemas.push(schema);
    await pool.query(`CREATE SCHEMA ${schema}`);
    return schema;
  };
  beforeAll(() => {
    pool = new pg.Pool({ connectionString: liveUrl, max: 4 });
  }, SLOW_HOOK_TIMEOUT_MS);
  afterAll(async () => {
    try {
      for (const schema of schemas) await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    } finally {
      await pool.end();
    }
  }, SLOW_HOOK_TIMEOUT_MS);

  memoryRetention(
    'versioned memory',
    async () => {
      const { clock, advance } = manualClock(1_000_000);
      const warn = vi.fn();
      const store = createPostgresVersionedMemoryStore({
        pool: pool as unknown as PgPoolLike,
        schema: await freshSchema(),
        clock,
        logger: loggerWith(warn),
      });
      return { store, clock, advance, warn, cleanup: () => store.close() };
    },
    true,
  );

  runsRetention(
    'V3 runs',
    async () =>
      createPostgresAgentRunStoreV3({
        pool: pool as unknown as PgPoolLike,
        schema: await freshSchema(),
      }),
    true,
  );

  forgetSparesChats(
    'a memory forget in a schema shared with conditional chats',
    async () => {
      const schema = await freshSchema();
      const client = pool as unknown as PgPoolLike;
      const chats = createPostgresConditionalChatStore({ pool: client, schema });
      const memory = createPostgresVersionedMemoryStore({ pool: client, schema });
      return {
        chats,
        transcript: chats.transcript,
        memory,
        rows: () => pgRowsOutsideMemory(client, schema),
        async cleanup() {
          await memory.close();
          await chats.close();
        },
      };
    },
    true,
  );

  it('conditional chats refuse a malformed cutoff', SLOW, async () => {
    const store = createPostgresConditionalChatStore({
      pool: pool as unknown as PgPoolLike,
      schema: await freshSchema(),
    });
    await store.writeChat(chat('live', ['hi']), { expectedRevision: 0 });
    await store.deleteChat('gone');
    for (const before of BAD_CUTOFFS)
      await expect(attempt(() => store.pruneTombstones(before as never))).rejects.toThrow(
        InvalidRequestError,
      );
    expect((await store.readChat('gone')).status).toBe('deleted');
    await store.close();
  });
});
