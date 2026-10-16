/**
 * importLegacyMemory (2.4, spec §2.2): an explicit, re-runnable import from
 * any legacy MemoryStore into a versioned store. The current snapshot becomes
 * revision 1 under operation `<prefix>:<legacy id>`, so a re-run replays
 * instead of duplicating; no history is invented and no vector is carried.
 */
import { describe, expect, it } from 'vitest';
import { sha256Digest } from '../src/internal/digest';
import { createInMemoryMemoryStore } from '../src/memory';
import type { MemoryRecord, MemoryScope, MemoryStore } from '../src/memory';
import { createSqliteStores } from '../src/node/store-sqlite';
import { createMemoryObserver } from '../src/observe';
import { createInMemoryVersionedMemoryStore, importLegacyMemory } from '../src/memory/versioned';
import type { ObserveEvent } from '../src/index';

const USER: MemoryScope = { userId: 'u1' };
const NOW = 100_000;
const clock = { now: () => NOW, setTimeout: () => () => {} };

function legacy(id: string, text: string, extra: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id,
    text,
    hash: `h-${id}`,
    kind: 'semantic',
    scope: USER,
    createdAt: 1_000,
    updatedAt: 2_000,
    ...extra,
  };
}

async function legacyStore(records: MemoryRecord[]): Promise<MemoryStore> {
  const store = createInMemoryMemoryStore();
  await store.upsert(records);
  return store;
}

describe('importLegacyMemory', () => {
  it('imports the live snapshot as revision 1, keeping ids, scopes and fields', async () => {
    const from = await legacyStore([
      legacy('a', 'likes tea', {
        kind: 'procedural',
        importance: 0.8,
        expiresAt: NOW + 5_000,
        embedding: [1, 2, 3],
        embeddingModelId: 'old-model',
        metadata: { links: ['tea'], source: 'chat' },
      }),
      legacy('b', 'lives in Paris', { scope: { userId: 'u1', chatId: 'c9' } }),
      legacy('expired', 'old news', { expiresAt: NOW - 1 }),
      legacy('other', 'not mine', { scope: { userId: 'u2' } }),
    ]);
    const to = createInMemoryVersionedMemoryStore({ deps: { clock } });
    const result = await importLegacyMemory({ from, to, scope: USER, deps: { clock } });
    expect(result).toEqual({ scanned: 3, imported: 2, skipped: 1 });

    const a = await to.get(USER, 'a');
    expect(a).toMatchObject({
      id: 'a',
      revision: 1,
      text: 'likes tea',
      kind: 'procedural',
      importance: 0.8,
      expiresAt: NOW + 5_000,
      origin: 'inferred',
      status: 'active',
      operationId: 'import:a',
      createdAt: NOW,
      sources: [{ kind: 'host', digest: await sha256Digest('likes tea') }],
      metadata: {
        links: ['tea'],
        source: 'chat',
        legacyImport: { id: 'a', createdAt: 1_000, updatedAt: 2_000 },
      },
    });
    expect(a!.embedding).toBeUndefined();
    expect(await to.embeddings.active()).toBeUndefined();
    expect(await to.history(USER, 'a')).toHaveLength(1);
    expect(await to.receipt('import:a')).toMatchObject({ actor: 'import', scope: USER });
    // A record keeps its own legacy scope.
    expect(await to.get(USER, 'b')).toBeUndefined();
    expect(await to.get({ userId: 'u1', chatId: 'c9' }, 'b')).toMatchObject({
      text: 'lives in Paris',
    });
    expect(await to.get({ userId: 'u2' }, 'other')).toBeUndefined();
    expect(await to.get(USER, 'expired')).toBeUndefined();
  });

  it('re-runs as a replay: nothing is duplicated', async () => {
    const from = await legacyStore([legacy('a', 'likes tea'), legacy('b', 'likes coffee')]);
    const to = createInMemoryVersionedMemoryStore();
    expect(await importLegacyMemory({ from, to, scope: USER })).toMatchObject({ imported: 2 });
    expect(await importLegacyMemory({ from, to, scope: USER })).toEqual({
      scanned: 2,
      imported: 0,
      skipped: 2,
    });
    expect(await to.scopeRevision(USER)).toBe(2);
    expect(await to.history(USER, 'a')).toHaveLength(1);
  });

  it('skips a record that changed since the first import, with a warning', async () => {
    const from = await legacyStore([legacy('a', 'likes tea')]);
    const to = createInMemoryVersionedMemoryStore();
    await importLegacyMemory({ from, to, scope: USER });
    await from.update!('a', { text: 'likes green tea' });
    const warnings: string[] = [];
    const result = await importLegacyMemory({
      from,
      to,
      scope: USER,
      deps: {
        logger: {
          debug: () => {},
          info: () => {},
          warn: (message) => warnings.push(message),
          error: () => {},
        },
      },
    });
    expect(result).toEqual({ scanned: 1, imported: 0, skipped: 1 });
    expect(warnings).toHaveLength(1);
    expect((await to.get(USER, 'a'))!.text).toBe('likes tea');
  });

  it('skips invalidated records a custom store still lists, and honours prefix, origin and batches', async () => {
    const records = [
      legacy('a', 'one'),
      legacy('b', 'two', { invalidAt: 5_000 }),
      legacy('c', 'three'),
      legacy('d', 'four'),
    ];
    let lists = 0;
    const from: MemoryStore = {
      ...(await legacyStore([])),
      async list() {
        lists++;
        return records;
      },
    };
    const to = createInMemoryVersionedMemoryStore();
    const result = await importLegacyMemory({
      from,
      to,
      scope: USER,
      operationPrefix: 'mig-7',
      origin: 'asserted',
      batchSize: 2,
    });
    expect(result).toEqual({ scanned: 4, imported: 3, skipped: 1 });
    expect(lists).toBe(1);
    expect(await to.get(USER, 'c')).toMatchObject({ origin: 'asserted', operationId: 'mig-7:c' });
    expect(await to.get(USER, 'b')).toBeUndefined();
  });

  it('stops between batches when aborted', async () => {
    const from = await legacyStore(
      Array.from({ length: 5 }, (_, index) => legacy(`r${index}`, `fact ${index}`)),
    );
    const to = createInMemoryVersionedMemoryStore();
    const controller = new AbortController();
    controller.abort(new Error('stop'));
    await expect(
      importLegacyMemory({ from, to, scope: USER, signal: controller.signal }),
    ).rejects.toThrow('stop');
    expect(await to.scopeRevision(USER)).toBe(0);
  });

  it('imports from the legacy SQLite deuz_memory table', async () => {
    const stores = createSqliteStores({ path: ':memory:' });
    try {
      await stores.memory.upsert([legacy('s1', 'from sqlite'), legacy('s2', 'also from sqlite')]);
      const to = createInMemoryVersionedMemoryStore();
      expect(await importLegacyMemory({ from: stores.memory, to, scope: USER })).toEqual({
        scanned: 2,
        imported: 2,
        skipped: 0,
      });
      expect(await to.get(USER, 's1')).toMatchObject({ text: 'from sqlite', revision: 1 });
      expect(await importLegacyMemory({ from: stores.memory, to, scope: USER })).toMatchObject({
        imported: 0,
        skipped: 2,
      });
    } finally {
      await stores.close?.();
    }
  });

  it('reports a deuz.memory.op import span', async () => {
    const observer = createMemoryObserver();
    const from = await legacyStore([legacy('a', 'secret fact')]);
    await importLegacyMemory({
      from,
      to: createInMemoryVersionedMemoryStore(),
      scope: USER,
      deps: { observer },
    });
    const events = observer.events() as ObserveEvent[];
    const completed = events.find(
      (event): event is Extract<ObserveEvent, { type: 'operation.completed' }> =>
        event.type === 'operation.completed' && event.operation === 'deuz.memory.op',
    );
    expect(completed!.attributes).toMatchObject({
      'deuz.memory.operation': 'import',
      'deuz.memory.record_count': 1,
    });
    expect(JSON.stringify(events)).not.toContain('secret');
  });
});
