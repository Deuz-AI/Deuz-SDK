/**
 * store-sqlite.test.ts — the SQLite store pack against a REAL `node:sqlite`
 * database (`:memory:` plus a temp file for the things only a file can prove:
 * WAL, reopen, migration idempotency).
 *
 * Availability is decided by TRYING the import, never by parsing
 * `process.version` — `--experimental-sqlite` makes 22.5 work and a stripped
 * build could make 24 not work, so the version string is not the question the
 * suite is asking. Everything that needs the module hangs off `describe.skipIf`;
 * the "module is missing" test does not, because that is exactly the path a
 * runtime WITHOUT it takes.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createSqliteStores,
  type SqliteDatabaseLike,
  type SqliteStatementLike,
} from '../src/node/store-sqlite';
import type { MemoryRecord, MemoryScope } from '../src/memory';
import type { AgentCheckpoint } from '../src/types/session';
import type { RunRecord } from '../src/types/runtime';
import {
  assertMemoryStoreContract,
  assertChatStoreContract,
  assertSessionStoreContract,
} from './fixtures/store-conformance';

type DatabaseSyncCtor = new (path: string) => SqliteDatabaseLike;

let DatabaseSync: DatabaseSyncCtor | undefined;
try {
  // Same lazy import the store itself uses; `as string` keeps the type checker
  // from needing a `node:sqlite` declaration that older @types/node lacks.
  const mod = (await import('node:sqlite' as string)) as { DatabaseSync?: DatabaseSyncCtor };
  if (typeof mod.DatabaseSync === 'function') DatabaseSync = mod.DatabaseSync;
} catch {
  /* runtime without node:sqlite — every describe below skips */
}
const hasSqlite = DatabaseSync !== undefined;

const T0 = 1_700_000_000_000;
const SCOPE: MemoryScope = { userId: 'user-a', chatId: 'chat-1' };

function rec(
  id: string,
  text: string,
  extra: Partial<MemoryRecord> = {},
  scope: MemoryScope = SCOPE,
): MemoryRecord {
  return {
    id,
    text,
    hash: `hash-${id}`,
    kind: 'semantic',
    scope,
    createdAt: T0,
    updatedAt: T0,
    ...extra,
  };
}

function userVersion(db: SqliteDatabaseLike): number {
  const row = db.prepare('PRAGMA user_version').get() as { user_version?: number } | undefined;
  return row?.user_version ?? -1;
}

function tableNames(db: SqliteDatabaseLike): string[] {
  return (
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as {
      name: string;
    }[]
  )
    .map((r) => r.name)
    .sort();
}

/**
 * A hand-written `SqliteDatabaseLike` that forwards to a real handle while
 * counting calls. This is the better-sqlite3 injection story in miniature: the
 * store only ever touches `prepare`/`exec`/`close` and `run`/`get`/`all`, so
 * anything structurally shaped like this drives it.
 */
function recordingDatabase(inner: SqliteDatabaseLike): {
  db: SqliteDatabaseLike;
  prepared: string[];
  execs: string[];
} {
  const prepared: string[] = [];
  const execs: string[] = [];
  const db: SqliteDatabaseLike = {
    prepare(sql: string): SqliteStatementLike {
      prepared.push(sql);
      const statement = inner.prepare(sql);
      return {
        run: (...params: unknown[]) => statement.run(...params),
        get: (...params: unknown[]) => statement.get(...params),
        all: (...params: unknown[]) => statement.all(...params),
      };
    },
    exec(sql: string) {
      execs.push(sql);
      inner.exec(sql);
    },
    close() {
      inner.close();
    },
  };
  return { db, prepared, execs };
}

// ===================================================================
// The shared contract suites
// ===================================================================

describe.skipIf(!hasSqlite)('sqlite store pack — conformance', () => {
  assertMemoryStoreContract('sqlite', async () => {
    const pack = createSqliteStores({ path: ':memory:' });
    return { store: pack.memory, cleanup: () => pack.close() };
  });

  assertChatStoreContract('sqlite', async () => {
    const pack = createSqliteStores({ path: ':memory:' });
    return { store: pack.chats, cleanup: () => pack.close() };
  });

  assertSessionStoreContract('sqlite', async () => {
    const pack = createSqliteStores({ path: ':memory:' });
    return { store: pack.sessions, cleanup: () => pack.close() };
  });
});

// ===================================================================
// Schema + migration
// ===================================================================

describe.skipIf(!hasSqlite)('sqlite store pack — schema v1 migration', () => {
  it('opens lazily: no statement runs until a store method is called', async () => {
    const inner = new DatabaseSync!(':memory:');
    const { db, prepared, execs } = recordingDatabase(inner);

    const pack = createSqliteStores({ path: ':memory:', database: db });
    expect(prepared).toEqual([]);
    expect(execs).toEqual([]);

    await pack.memory.list(SCOPE);
    expect(prepared.length).toBeGreaterThan(0);
    await pack.close();
  });

  it('stamps user_version 0 → 1 and creates the four tables', async () => {
    const inner = new DatabaseSync!(':memory:');
    const { db } = recordingDatabase(inner);
    expect(userVersion(db)).toBe(0);

    const pack = createSqliteStores({ path: ':memory:', database: db });
    await pack.memory.list(SCOPE);

    expect(userVersion(db)).toBe(1);
    const tables = tableNames(db);
    expect(tables).toContain('deuz_memory');
    expect(tables).toContain('deuz_chats');
    expect(tables).toContain('deuz_sessions');
    expect(tables).toContain('deuz_runs');
    await pack.close();
  });

  it('is idempotent on reopen: a second pack over the same file re-uses the schema and the rows', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'deuz-sqlite-'));
    const file = join(dir, 'agent.db');
    try {
      const first = createSqliteStores({ path: file });
      await first.memory.upsert([rec('m1', 'survives a restart')]);
      await first.close();

      const second = createSqliteStores({ path: file });
      // No DDL re-run, no "table already exists" — and the row is still there.
      expect((await second.memory.get('m1'))?.text).toBe('survives a restart');
      await second.memory.upsert([rec('m2', 'written by the second process')]);
      expect((await second.memory.list(SCOPE)).map((r) => r.id).sort()).toEqual(['m1', 'm2']);
      await second.close();

      const raw = new DatabaseSync!(file);
      expect(userVersion(raw)).toBe(1);
      // WAL is the default for a file database.
      const journal = raw.prepare('PRAGMA journal_mode').get() as { journal_mode?: string };
      expect(journal.journal_mode).toBe('wal');
      raw.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('close() is idempotent and a never-opened pack closes without touching a handle', async () => {
    const pack = createSqliteStores({ path: ':memory:' });
    await expect(pack.close()).resolves.toBeUndefined(); // never opened
    const opened = createSqliteStores({ path: ':memory:' });
    await opened.memory.list(SCOPE);
    await opened.close();
    await expect(opened.close()).resolves.toBeUndefined();
  });
});

// ===================================================================
// Vector search
// ===================================================================

describe.skipIf(!hasSqlite)('sqlite store pack — vector search', () => {
  it('round-trips an embedding through the Float32 BLOB codec', async () => {
    const pack = createSqliteStores({ path: ':memory:' });
    await pack.memory.upsert([rec('v1', 'has a vector', { embedding: [1, -0.5, 0.25, 0] })]);

    const got = await pack.memory.get('v1');
    expect(got?.embedding).toHaveLength(4);
    // Exact in float32: 1, -0.5, 0.25 and 0 are all representable.
    expect(got?.embedding).toEqual([1, -0.5, 0.25, 0]);
    await pack.close();
  });

  it('stores the embedding as bytes, not as JSON (4 bytes per dimension)', async () => {
    const inner = new DatabaseSync!(':memory:');
    const { db } = recordingDatabase(inner);
    const pack = createSqliteStores({ path: ':memory:', database: db });
    await pack.memory.upsert([rec('v1', 'x', { embedding: [1, 2, 3] })]);

    const row = db.prepare('SELECT embedding FROM deuz_memory WHERE id = ?').get('v1') as {
      embedding: Uint8Array;
    };
    expect(row.embedding).toBeInstanceOf(Uint8Array);
    expect(row.embedding.byteLength).toBe(12);
    await pack.close();
  });

  it('ranks by cosine similarity and tolerates float32 rounding', async () => {
    const pack = createSqliteStores({ path: ':memory:' });
    await pack.memory.upsert([
      rec('far', 'orthogonal', { embedding: [0, 0, 1] }),
      rec('mid', 'related', { embedding: [0.6, 0.8, 0] }),
      rec('near', 'exact', { embedding: [1, 0, 0] }),
      rec('novec', 'no embedding at all'),
    ]);

    const hits = await pack.memory.search({ scope: SCOPE, embedding: [1, 0, 0], topK: 4 });
    expect(hits.map((h) => h.record.id).slice(0, 3)).toEqual(['near', 'mid', 'far']);
    expect(hits[0]!.score).toBeCloseTo(1, 5);
    expect(hits[1]!.score).toBeCloseTo(0.6, 5); // float32 of 0.6/0.8, not float64
    // A record with no vector scores 0 — it never outranks a real match.
    expect(hits[3]!.record.id).toBe('novec');
    expect(hits[3]!.score).toBe(0);
    await pack.close();
  });
});

// ===================================================================
// Lexical search: FTS5, phrase escaping, LIKE fallback, hybrid
// ===================================================================

describe.skipIf(!hasSqlite)('sqlite store pack — lexical search', () => {
  it('treats the query as ONE phrase, so FTS operators are literal text', async () => {
    const pack = createSqliteStores({ path: ':memory:' });
    await pack.memory.upsert([
      rec('phrase', 'the user prefers dark AND mode'),
      rec('split', 'dark themes and light mode'),
    ]);

    const hits = await pack.memory.search({ scope: SCOPE, text: 'dark AND mode', topK: 5 });
    // As a bare FTS expression this would be a boolean AND and match both rows.
    expect(hits.map((h) => h.record.id)).toEqual(['phrase']);
    await pack.close();
  });

  it('escapes embedded double quotes instead of producing a syntax error', async () => {
    const pack = createSqliteStores({ path: ':memory:' });
    await pack.memory.upsert([
      rec('quoted', 'the user said "hello" to Bob'),
      rec('plain', 'the user waved at Bob'),
    ]);

    const hits = await pack.memory.search({ scope: SCOPE, text: 'said "hello"', topK: 5 });
    expect(hits.map((h) => h.record.id)).toEqual(['quoted']);
    expect(hits[0]!.score).toBeGreaterThan(0);

    // A dangling quote is escaped too — a query is data, never syntax.
    const dangling = await pack.memory.search({ scope: SCOPE, text: 'waved at "', topK: 5 });
    expect(dangling.map((h) => h.record.id)).toEqual(['plain']);
    await pack.close();
  });

  it('normalizes bm25 so the best hit scores 1 and every score is positive', async () => {
    const pack = createSqliteStores({ path: ':memory:' });
    await pack.memory.upsert([
      rec('short', 'Istanbul'),
      rec('long', 'the user has lived in Istanbul for a very long time indeed'),
    ]);

    const hits = await pack.memory.search({ scope: SCOPE, text: 'Istanbul', topK: 5 });
    expect(hits).toHaveLength(2);
    expect(hits[0]!.record.id).toBe('short'); // bm25 favors the shorter document
    expect(hits[0]!.score).toBeCloseTo(1, 6);
    expect(hits[1]!.score).toBeGreaterThan(0);
    expect(hits[1]!.score).toBeLessThan(hits[0]!.score);
    await pack.close();
  });

  it('falls back to LIKE with fts: false, escaping the LIKE wildcards', async () => {
    const pack = createSqliteStores({ path: ':memory:', fts: false });
    await pack.memory.upsert([
      rec('pct', 'the discount is 50% off'),
      rec('other', 'the discount is 50 percent off'),
      rec('under', 'the flag is snake_case'),
    ]);

    const pct = await pack.memory.search({ scope: SCOPE, text: '50%', topK: 5 });
    expect(pct.map((h) => h.record.id)).toEqual(['pct']); // `%` is data, not a wildcard
    expect(pct[0]!.score).toBe(1);

    const under = await pack.memory.search({ scope: SCOPE, text: 'snake_case', topK: 5 });
    expect(under.map((h) => h.record.id)).toEqual(['under']);

    // Substring, not phrase: LIKE has no tokenizer.
    const partial = await pack.memory.search({ scope: SCOPE, text: 'discount is 50', topK: 5 });
    expect(partial.map((h) => h.record.id).sort()).toEqual(['other', 'pct']);
    await pack.close();
  });

  it('fuses dense and lexical rankings when the query carries both', async () => {
    const pack = createSqliteStores({ path: ':memory:' });
    await pack.memory.upsert([
      rec('both', 'Istanbul cafe', { embedding: [1, 0, 0] }),
      rec('vec-only', 'nothing relevant here', { embedding: [0.95, 0.31, 0] }),
      rec('lex-only', 'Istanbul is nice'),
      rec('noise-a', 'unrelated chatter'),
      rec('noise-b', 'more unrelated chatter'),
    ]);

    const hits = await pack.memory.search({
      scope: SCOPE,
      embedding: [1, 0, 0],
      text: 'Istanbul',
      topK: 3,
    });
    // `both` wins both lists. `lex-only` is invisible to cosine but tops a SHORT
    // lexical list, so RRF lifts it over `vec-only`, which only ever placed
    // second on one list — that lift is the whole point of fusing ranks.
    expect(hits[0]!.record.id).toBe('both');
    const order = hits.map((h) => h.record.id);
    expect(order.indexOf('lex-only')).toBeGreaterThanOrEqual(0);
    expect(order.indexOf('lex-only')).toBeLessThan(
      order.indexOf('vec-only') === -1 ? Number.MAX_SAFE_INTEGER : order.indexOf('vec-only'),
    );
    await pack.close();
  });

  it('keeps the FTS index consistent across INSERT OR REPLACE upserts', async () => {
    const inner = new DatabaseSync!(':memory:');
    const { db } = recordingDatabase(inner);
    const pack = createSqliteStores({ path: ':memory:', database: db });
    await pack.memory.upsert([rec('m1', 'the user lives in Istanbul')]);
    await pack.memory.upsert([rec('m1', 'the user lives in Ankara')]);

    expect((await pack.memory.search({ scope: SCOPE, text: 'Istanbul', topK: 5 })).length).toBe(0);
    expect(
      (await pack.memory.search({ scope: SCOPE, text: 'Ankara', topK: 5 })).map((h) => h.record.id),
    ).toEqual(['m1']);
    // The external-content index must still agree with the content table: with
    // recursive triggers off, REPLACE would have orphaned the old rowid here.
    expect(() =>
      db.exec("INSERT INTO deuz_memory_fts(deuz_memory_fts, rank) VALUES('integrity-check', 1)"),
    ).not.toThrow();
    await pack.close();
  });
});

// ===================================================================
// Bi-temporal, hashes, TTL
// ===================================================================

describe.skipIf(!hasSqlite)('sqlite store pack — bi-temporal + dedup + TTL', () => {
  it('asOf sees the world as it was, while a plain search sees only the present', async () => {
    const pack = createSqliteStores({ path: ':memory:' });
    await pack.memory.upsert([
      rec('superseded', 'the user lives in Istanbul', {
        validAt: T0,
        invalidAt: T0 + 1_000,
      }),
      rec('current', 'the user lives in Ankara', { validAt: T0 + 1_000 }),
    ]);

    const now = await pack.memory.search({ scope: SCOPE, topK: 10 });
    expect(now.map((h) => h.record.id)).toEqual(['current']);

    const before = await pack.memory.search({ scope: SCOPE, topK: 10, asOf: T0 + 500 });
    expect(before.map((h) => h.record.id)).toEqual(['superseded']);

    const after = await pack.memory.search({ scope: SCOPE, topK: 10, asOf: T0 + 2_000 });
    expect(after.map((h) => h.record.id)).toEqual(['current']);
    await pack.close();
  });

  it('findByHash uses the hash index, honors scope, and skips soft-deleted rows', async () => {
    const pack = createSqliteStores({ path: ':memory:' });
    await pack.memory.upsert([
      rec('m1', 'dedupe me', { hash: 'h-shared' }),
      rec('m2', 'other', { hash: 'h-other' }),
      rec('gone', 'superseded copy', { hash: 'h-shared', invalidAt: T0 + 1 }),
      rec('b1', 'dedupe me elsewhere', { hash: 'h-shared' }, { userId: 'user-b' }),
    ]);

    const found = await pack.memory.findByHash!(['h-shared', 'h-missing'], SCOPE);
    expect(found.map((r) => r.id)).toEqual(['m1']);
    expect(await pack.memory.findByHash!([], SCOPE)).toEqual([]);
    await pack.close();
  });

  it('findByHash de-duplicates across padded IN chunks for large hash lists', async () => {
    const pack = createSqliteStores({ path: ':memory:' });
    const records = Array.from({ length: 120 }, (_, i) =>
      rec(`m${i}`, `fact ${i}`, { hash: `h-${i}` }),
    );
    await pack.memory.upsert(records);

    const hashes = records.map((r) => r.hash);
    const found = await pack.memory.findByHash!(hashes, SCOPE);
    expect(found).toHaveLength(120);
    expect(new Set(found.map((r) => r.id)).size).toBe(120);
    await pack.close();
  });

  it('sweepExpiredMemories clears every scope at once', async () => {
    const pack = createSqliteStores({ path: ':memory:' });
    await pack.memory.upsert([
      rec('a', 'past due', { expiresAt: T0 - 1 }),
      rec('b', 'past due elsewhere', { expiresAt: T0 - 1 }, { userId: 'user-b' }),
      // Far future on purpose: the last leg of this test sweeps with the REAL
      // host clock, which is years past T0.
      rec('c', 'not due yet', { expiresAt: 4_000_000_000_000 }),
      rec('d', 'no ttl'),
    ]);

    expect(await pack.sweepExpiredMemories(T0)).toBe(2);
    expect(await pack.memory.get('a')).toBeNull();
    expect(await pack.memory.get('b')).toBeNull();
    expect(await pack.memory.get('c')).not.toBeNull();
    expect(await pack.sweepExpiredMemories(T0)).toBe(0);

    // No argument = the host clock, which is far past a 1970 TTL.
    await pack.memory.upsert([rec('e', 'expired in 1970', { expiresAt: 1 })]);
    expect(await pack.sweepExpiredMemories()).toBe(1);
    expect(await pack.memory.get('d')).not.toBeNull();
    await pack.close();
  });
});

// ===================================================================
// Chats, sessions, runs
// ===================================================================

describe.skipIf(!hasSqlite)('sqlite store pack — chats / sessions / runs', () => {
  it('persists chats through the $deuzBytes codec, not plain JSON', async () => {
    const inner = new DatabaseSync!(':memory:');
    const { db } = recordingDatabase(inner);
    const pack = createSqliteStores({ path: ':memory:', database: db });
    const bytes = new Uint8Array([0, 127, 128, 255]);

    await pack.chats.saveChat({
      chatId: 'c1',
      scope: SCOPE,
      parentId: 'c0',
      updatedAt: T0,
      messages: [
        { role: 'user', content: [{ type: 'image', image: bytes, mediaType: 'image/png' }] },
      ],
    });

    const stored = db.prepare('SELECT record, scope_chat_id, parent_id FROM deuz_chats').get() as {
      record: string;
      scope_chat_id: string;
      parent_id: string;
    };
    expect(stored.record).toContain('$deuzBytes');
    // The scope's chatId lives in its own column so listChats can filter on it
    // without parsing the record blob.
    expect(stored.scope_chat_id).toBe('chat-1');
    expect(stored.parent_id).toBe('c0');

    const loaded = await pack.chats.loadChat('c1');
    const content = loaded!.messages[0]!.content as { type: string; image: Uint8Array }[];
    expect(content[0]!.image).toBeInstanceOf(Uint8Array);
    expect([...content[0]!.image]).toEqual([...bytes]);
    await pack.close();
  });

  it('projects checkpoint status and step index into their own columns', async () => {
    const inner = new DatabaseSync!(':memory:');
    const { db } = recordingDatabase(inner);
    const pack = createSqliteStores({ path: ':memory:', database: db });
    const checkpoint: AgentCheckpoint = {
      version: 1,
      runId: 'run-1',
      stepId: 'run-1#2',
      stepIndex: 2,
      status: 'suspended',
      messages: [{ role: 'user', content: 'go' }],
      usage: {
        inputTokens: 1,
        outputTokens: 1,
        reasoningTokens: 0,
        cachedReadTokens: 0,
        cacheWriteTokens: 0,
        cacheWrite1hTokens: 0,
        totalTokens: 2,
      },
      handoff: { to: 'specialist', count: 1 },
      createdAt: T0,
    };
    await pack.sessions.save(checkpoint);

    const row = db
      .prepare('SELECT status, step_index FROM deuz_sessions WHERE run_id = ?')
      .get('run-1') as { status: string; step_index: number };
    expect(row.status).toBe('suspended');
    expect(row.step_index).toBe(2);

    const loaded = await pack.sessions.load('run-1');
    expect(loaded!.handoff).toEqual({ to: 'specialist', count: 1 });
    expect(loaded!.stepId).toBe('run-1#2');
    await pack.close();
  });

  it('runs: create / update / get / list(status) / delete', async () => {
    const pack = createSqliteStores({ path: ':memory:' });
    const record = (runId: string, extra: Partial<RunRecord> = {}): RunRecord => ({
      runId,
      status: 'running',
      goal: `goal ${runId}`,
      createdAt: T0,
      updatedAt: T0,
      ...extra,
    });

    await pack.runs.create(record('r1'));
    await pack.runs.create(record('r2', { status: 'completed', createdAt: T0 + 1 }));
    expect((await pack.runs.get('r1'))?.goal).toBe('goal r1');

    await pack.runs.update('r1', {
      status: 'failed',
      error: 'boom',
      updatedAt: T0 + 5,
      plan: { goal: 'g', tasks: [] },
    });
    const updated = await pack.runs.get('r1');
    expect(updated?.status).toBe('failed');
    expect(updated?.error).toBe('boom');
    expect(updated?.goal).toBe('goal r1'); // merge, not replace
    expect(updated?.plan).toEqual({ goal: 'g', tasks: [] });

    expect((await pack.runs.list()).map((r) => r.runId)).toEqual(['r1', 'r2']);
    expect((await pack.runs.list({ status: 'completed' })).map((r) => r.runId)).toEqual(['r2']);

    await pack.runs.update('never-created', { status: 'completed' }); // no-op, no throw
    expect(await pack.runs.get('never-created')).toBeUndefined();

    await pack.runs.delete('r1');
    expect(await pack.runs.get('r1')).toBeUndefined();
    expect((await pack.runs.list()).map((r) => r.runId)).toEqual(['r2']);
    await pack.close();
  });

  it('keeps the four stores in ONE file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'deuz-sqlite-'));
    const file = join(dir, 'agent.db');
    try {
      const pack = createSqliteStores({ path: file });
      await pack.memory.upsert([rec('m1', 'a fact')]);
      await pack.chats.saveChat({
        chatId: 'c1',
        scope: SCOPE,
        messages: [{ role: 'user', content: 'hi' }],
        updatedAt: T0,
      });
      await pack.sessions.save({
        version: 1,
        runId: 'run-1',
        stepId: 'run-1#0',
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
        createdAt: T0,
      });
      await pack.runs.create({
        runId: 'run-1',
        status: 'running',
        createdAt: T0,
        updatedAt: T0,
      });
      await pack.close();

      const reopened = createSqliteStores({ path: file });
      expect(await reopened.memory.get('m1')).not.toBeNull();
      expect(await reopened.chats.loadChat('c1')).toBeDefined();
      expect(await reopened.sessions.load('run-1')).toBeDefined();
      expect(await reopened.runs.get('run-1')).toBeDefined();
      expect(await reopened.sessions.list()).toEqual(['run-1']);
      expect(await reopened.chats.listChats({ userId: 'user-a' })).toEqual(['c1']);
      await reopened.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

// ===================================================================
// The injection seam
// ===================================================================

describe.skipIf(!hasSqlite)('sqlite store pack — injected SqliteDatabaseLike', () => {
  it('drives a hand-written handle and prepares every statement exactly once', async () => {
    const inner = new DatabaseSync!(':memory:');
    const { db, prepared } = recordingDatabase(inner);
    const pack = createSqliteStores({ path: ':memory:', database: db });

    // Warm-up: schema + FTS + one of each statement shape.
    await pack.memory.upsert([rec('m0', 'warm up')]);
    await pack.memory.get('m0');
    await pack.memory.search({ scope: SCOPE, text: 'warm', topK: 3 });
    await pack.memory.list(SCOPE);
    const afterWarmUp = prepared.length;

    for (let i = 1; i <= 10; i++) {
      await pack.memory.upsert([rec(`m${i}`, `fact ${i}`)]);
      await pack.memory.get(`m${i}`);
      await pack.memory.search({ scope: SCOPE, text: 'fact', topK: 3 });
      await pack.memory.list(SCOPE);
    }
    // Same SQL text → same cached statement, so the count never moves.
    expect(prepared.length).toBe(afterWarmUp);
    expect(new Set(prepared).size).toBe(prepared.length);

    expect((await pack.memory.list(SCOPE)).length).toBe(11);
    await pack.close();
  });

  it('close() releases the injected handle', async () => {
    const inner = new DatabaseSync!(':memory:');
    let closed = 0;
    const db: SqliteDatabaseLike = {
      prepare: (sql) => inner.prepare(sql),
      exec: (sql) => inner.exec(sql),
      close: () => {
        closed++;
        inner.close();
      },
    };
    const pack = createSqliteStores({ path: ':memory:', database: db });
    await pack.memory.list(SCOPE);
    await pack.close();
    await pack.close();
    expect(closed).toBe(1);
  });
});

// ===================================================================
// The unsupported runtime — runs everywhere, including where sqlite exists
// ===================================================================

describe('createSqliteStores without node:sqlite', () => {
  beforeAll(() => {
    vi.resetModules();
  });
  afterAll(() => {
    vi.doUnmock('node:sqlite');
    vi.resetModules();
  });

  const EXPECTED =
    'createSqliteStores: node:sqlite is unavailable. It ships unflagged from Node 22.13 / 23.4; ' +
    'on Node 22.5–22.12 run node with --experimental-sqlite, or pass options.database ' +
    '(a better-sqlite3-compatible handle).';

  it('rejects the first store call with the version matrix, the flag, and the escape hatch', async () => {
    // A module present but without DatabaseSync is the same failure as no module
    // at all — both must reach the caller as one actionable sentence.
    vi.doMock('node:sqlite', () => ({}));
    vi.resetModules();
    const { createSqliteStores: create } = await import('../src/node/store-sqlite');

    const pack = create({ path: ':memory:' });
    await expect(pack.memory.list({ userId: 'u' })).rejects.toThrow(EXPECTED);
    // The factory itself never throws — the failure is lazy, like the open.
    await expect(pack.chats.loadChat('c1')).rejects.toThrow('node:sqlite is unavailable');
    // Closing a pack whose open failed is a no-op, not a second failure.
    await expect(pack.close()).resolves.toBeUndefined();
  });
});
