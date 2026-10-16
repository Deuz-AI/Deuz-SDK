/**
 * chat-conditional-sqlite.test.ts (2.4) — the SQLite conditional chat store
 * and its transcript index (`@deuz-sdk/core/stores/sqlite`): both shared
 * contracts with FTS5 and with the LIKE fallback, plus what only this backend
 * owes — its own `deuz_chat_conditional_schema` table beside an untouched
 * legacy pack, a borrowed handle left open, durability across a restart, a
 * chat write and its index update as one transaction, compare-and-set across
 * two connections on one file, and an FTS5 index a process without FTS5 wrote
 * past, rebuilt before use.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, describe, expect, it } from 'vitest';
import { createSqliteConditionalChatStore } from '../src/node/chat-conditional-sqlite';
import { createSqliteStores, type SqliteDatabaseLike } from '../src/node/store-sqlite';
import { chat, conditionalChatStoreContracts } from './fixtures/conditional-chat-store-conformance';
import { SLOW_TEST_TIMEOUT_MS } from './fixtures/timeouts';
import { transcriptIndexContracts } from './fixtures/transcript-index-conformance';

/** Whether this runtime's SQLite has FTS5 (Node 22.14's does not). */
const HAS_FTS5 = (() => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('CREATE VIRTUAL TABLE probe USING fts5(x)');
    return true;
  } catch {
    return false;
  } finally {
    db.close();
  }
})();

const dirs: string[] = [];
const tempFile = (name: string): string => {
  const dir = mkdtempSync(join(tmpdir(), 'deuz-chat-cond-'));
  dirs.push(dir);
  return join(dir, name);
};
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

for (const fts of [true, false]) {
  const label = fts ? 'FTS5' : 'LIKE';
  conditionalChatStoreContracts(`SQLite conditional chat store (${label})`, (clock) => {
    const store = createSqliteConditionalChatStore({ path: ':memory:', fts, clock });
    return { store, transcript: store.transcript, close: () => store.close() };
  });
  transcriptIndexContracts(
    `SQLite transcript index (${label})`,
    (clock) => {
      const store = createSqliteConditionalChatStore({ path: ':memory:', fts, clock });
      return { index: store.transcript, close: () => store.close() };
    },
    { matching: fts && HAS_FTS5 ? 'token' : 'substring' },
  );
}

const scope = { userId: 'ada' };

describe('SQLite conditional chat store', () => {
  it(
    'keeps its version in its own table and leaves the legacy pack untouched',
    { timeout: SLOW_TEST_TIMEOUT_MS },
    async () => {
      const path = tempFile('shared.db');
      const legacy = createSqliteStores({ path });
      await legacy.chats.saveChat(chat('legacy', ['kept as is']));
      const store = createSqliteConditionalChatStore({ path });
      await store.saveChat(chat('conditional', ['new tables']));
      await store.close();
      await legacy.close();

      const db = new DatabaseSync(path);
      expect(db.prepare('SELECT version FROM deuz_chat_conditional_schema').get()).toEqual({
        version: 1,
      });
      expect(db.prepare('PRAGMA user_version').get()).toEqual({ user_version: 1 });
      expect(db.prepare('SELECT chat_id FROM deuz_chats').all()).toEqual([{ chat_id: 'legacy' }]);
      db.close();
      // The legacy pack reopens the file and still reads its chat.
      const reopened = createSqliteStores({ path });
      expect((await reopened.chats.loadChat('legacy'))!.messages).toHaveLength(1);
      expect(await reopened.chats.loadChat('conditional')).toBeUndefined();
      await reopened.close();
    },
  );

  it(
    'never sets PRAGMA user_version on a database of its own',
    { timeout: SLOW_TEST_TIMEOUT_MS },
    async () => {
      const path = tempFile('alone.db');
      const store = createSqliteConditionalChatStore({ path });
      await store.saveChat(chat('c', ['x']));
      await store.close();
      const db = new DatabaseSync(path);
      expect(db.prepare('PRAGMA user_version').get()).toEqual({ user_version: 0 });
      db.close();
    },
  );

  it('borrows a handle it is given and leaves it open on close', async () => {
    const database = new DatabaseSync(':memory:');
    const store = createSqliteConditionalChatStore({ database });
    await store.saveChat(chat('c', ['x']));
    await store.close();
    expect(database.prepare('SELECT revision FROM deuz_chat_conditional').get()).toEqual({
      revision: 1,
    });
    database.close();
    await expect(store.loadChat('c')).rejects.toThrow(/closed/);
  });

  it(
    'keeps revisions, tombstones and the index across a restart',
    { timeout: SLOW_TEST_TIMEOUT_MS },
    async () => {
      const path = tempFile('restart.db');
      const first = createSqliteConditionalChatStore({ path });
      await first.writeChat(chat('kept', ['ferry to bodrum'], { messageIds: ['m'] }), {
        expectedRevision: 0,
      });
      await first.writeChat(chat('gone', ['x']), { expectedRevision: 0 });
      await first.tombstoneChat('gone', { expectedRevision: 1 });
      await first.close();

      const second = createSqliteConditionalChatStore({ path });
      expect(await second.readChat('kept')).toMatchObject({
        status: 'found',
        record: { revision: 1 },
      });
      expect(await second.readChat('gone')).toMatchObject({
        status: 'deleted',
        tombstone: { revision: 2 },
      });
      expect((await second.transcript.search(scope, 'bodrum')).map((hit) => hit.messageId)).toEqual(
        ['m'],
      );
      expect((await second.writeChat(chat('gone', ['late']), { expectedRevision: 0 })).status).toBe(
        'conflict',
      );
      await second.close();
    },
  );

  it('commits a chat write and its index update together, or neither', async () => {
    const inner = new DatabaseSync(':memory:');
    let failIndex = false;
    const database: SqliteDatabaseLike = {
      exec: (sql) => inner.exec(sql),
      close: () => inner.close(),
      prepare(sql) {
        const statement = inner.prepare(sql);
        if (!sql.startsWith('INSERT INTO deuz_chat_transcript ')) return statement;
        return {
          run: (...params: unknown[]) => {
            if (failIndex) throw new Error('disk full');
            return statement.run(...(params as []));
          },
          get: (...params: unknown[]) => statement.get(...(params as [])),
          all: (...params: unknown[]) => statement.all(...(params as [])),
        };
      },
    };
    const store = createSqliteConditionalChatStore({ database });
    await store.writeChat(chat('c', ['first words']), { expectedRevision: 0 });
    failIndex = true;
    await expect(
      store.writeChat(chat('c', ['second words']), { expectedRevision: 1 }),
    ).rejects.toThrow('disk full');
    failIndex = false;
    expect(await store.readChat('c')).toMatchObject({ record: { revision: 1 } });
    expect(await store.transcript.search(scope, 'first')).toHaveLength(1);
    expect(await store.transcript.search(scope, 'second')).toEqual([]);
    await store.close();
    inner.close();
  });

  it(
    'compares and sets across two connections on one file',
    { timeout: SLOW_TEST_TIMEOUT_MS },
    async () => {
      const path = tempFile('two.db');
      const a = createSqliteConditionalChatStore({ path });
      const b = createSqliteConditionalChatStore({ path });
      expect((await a.writeChat(chat('c', ['from a']), { expectedRevision: 0 })).status).toBe(
        'committed',
      );
      const refused = await b.writeChat(chat('c', ['from b']), { expectedRevision: 0 });
      expect(refused).toMatchObject({ status: 'conflict', current: { record: { revision: 1 } } });
      expect((await b.writeChat(chat('c', ['from b']), { expectedRevision: 1 })).status).toBe(
        'committed',
      );
      await b.tombstoneChat('c', { expectedRevision: 2 });
      expect((await a.writeChat(chat('c', ['late a']), { expectedRevision: 2 })).status).toBe(
        'conflict',
      );
      expect(await a.transcript.search(scope, 'from')).toEqual([]);
      await a.close();
      await b.close();
    },
  );

  it.runIf(HAS_FTS5)(
    'rebuilds an FTS5 index a process without it wrote past',
    { timeout: SLOW_TEST_TIMEOUT_MS },
    async () => {
      const path = tempFile('fts.db');
      const withFts = createSqliteConditionalChatStore({ path });
      await withFts.saveChat(chat('c', ['original ferry'], { messageIds: ['m0'] }));
      expect(await withFts.transcript.search(scope, 'ferry')).toHaveLength(1);
      // Another process, without FTS5, rewrites the chat and adds one.
      const withoutFts = createSqliteConditionalChatStore({ path, fts: false });
      await withoutFts.saveChat(chat('c', ['replaced bus'], { messageIds: ['m1'] }));
      await withoutFts.saveChat(chat('d', ['another bus'], { messageIds: ['m2'] }));
      await withoutFts.close();
      expect(
        (await withFts.transcript.search(scope, 'bus')).map((hit) => hit.messageId).sort(),
      ).toEqual(['m1', 'm2']);
      expect(await withFts.transcript.search(scope, 'ferry')).toEqual([]);
      // Writes through the FTS5 index go on cleanly after the rebuild.
      await withFts.saveChat(chat('c', ['third tram'], { messageIds: ['m3'] }));
      expect((await withFts.transcript.search(scope, 'tram')).map((hit) => hit.messageId)).toEqual([
        'm3',
      ]);
      await withFts.close();
      const db = new DatabaseSync(path);
      db.exec(
        "INSERT INTO deuz_chat_transcript_fts(deuz_chat_transcript_fts) VALUES('integrity-check')",
      );
      db.close();
    },
  );

  it('a backfill never puts a tombstoned chat back into search', async () => {
    const store = createSqliteConditionalChatStore({ path: ':memory:' });
    await store.saveChat(chat('c', ['private plans']));
    await store.deleteChat('c');
    await store.transcript.index(chat('c', ['private plans']));
    expect(await store.transcript.search(scope, 'private')).toEqual([]);
    // A chat this store never held can be backfilled.
    await store.transcript.index(chat('legacy', ['private notes']));
    expect((await store.transcript.search(scope, 'private')).map((hit) => hit.chatId)).toEqual([
      'legacy',
    ]);
    await store.close();
  });
});
