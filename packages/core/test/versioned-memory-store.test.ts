/**
 * The in-memory VersionedMemoryStore (2.4, spec §2.1): the reference semantics
 * of the store contract. One operation commits the active record, its
 * immutable revision, the index entries and a receipt together, or nothing;
 * expected revisions are compare-and-set; an operation id replays with the
 * same request and conflicts with another; forget keeps content-free receipts.
 */
import { describe, expect, it } from 'vitest';
import { EmbeddingMismatchError, InvalidRequestError, OperationConflictError } from '../src/errors';
import { digestJson, sha256Digest } from '../src/internal/digest';
import { createInMemoryVersionedMemoryStore } from '../src/memory/versioned';
import type {
  VersionedMemoryCommit,
  VersionedMemoryMutation,
  VersionedMemoryStore,
} from '../src/memory/versioned';
import type { MemoryScope } from '../src/memory';

const USER: MemoryScope = { userId: 'u1' };
const OTHER: MemoryScope = { userId: 'u2' };

function setup(start = 1_000) {
  let now = start;
  const warnings: string[] = [];
  const store = createInMemoryVersionedMemoryStore({
    deps: {
      clock: { now: () => now, setTimeout: () => () => {} },
      logger: {
        debug: () => {},
        info: () => {},
        warn: (message) => warnings.push(message),
        error: () => {},
      },
    },
  });
  return {
    store,
    warnings,
    tick(ms = 1) {
      now += ms;
      return now;
    },
    get now() {
      return now;
    },
  };
}

async function source(text: string) {
  return { kind: 'host' as const, digest: await sha256Digest(text) };
}

async function create(
  id: string,
  text: string,
  extra: Partial<Extract<VersionedMemoryMutation, { type: 'create' }>['record']> = {},
): Promise<VersionedMemoryMutation> {
  return {
    type: 'create',
    record: { id, text, origin: 'asserted', sources: [await source(text)], ...extra },
  };
}

async function op(
  operationId: string,
  mutations: VersionedMemoryMutation[],
  extra: Partial<VersionedMemoryCommit> = {},
): Promise<VersionedMemoryCommit> {
  const scope = extra.scope ?? USER;
  return {
    operationId,
    scope,
    actor: 'host',
    mutations,
    requestDigest: await digestJson({
      scope,
      mutations: mutations.map((m) => m.type),
      operationId,
    }),
    ...extra,
  };
}

async function committed(store: VersionedMemoryStore, operation: VersionedMemoryCommit) {
  const result = await store.commit(operation);
  if (result.status !== 'committed') throw new Error(`expected committed, got ${result.status}`);
  return result.receipt;
}

describe('commit', () => {
  it('writes the record, its first revision and a receipt in one operation', async () => {
    const { store, now } = setup();
    const receipt = await committed(store, await op('op-1', [await create('r1', 'likes tea')]));
    expect(receipt).toEqual({
      operationId: 'op-1',
      scope: USER,
      actor: 'host',
      requestDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
      scopeRevision: 1,
      entries: [{ type: 'create', id: 'r1', revision: 1 }],
      committedAt: now,
    });
    const record = await store.get(USER, 'r1');
    expect(record).toMatchObject({
      id: 'r1',
      revision: 1,
      scope: USER,
      text: 'likes tea',
      kind: 'semantic',
      origin: 'asserted',
      status: 'active',
      operationId: 'op-1',
      recordedAt: now,
      createdAt: now,
    });
    expect(record!.digest).toBe(
      await digestJson({
        text: 'likes tea',
        kind: 'semantic',
        origin: 'asserted',
        sources: [await source('likes tea')],
      }),
    );
    expect(await store.receipt('op-1')).toEqual(receipt);
    expect(await store.scopeRevision(USER)).toBe(1);
  });

  it('copies in and out: callers cannot reach stored state', async () => {
    const { store } = setup();
    const mutation = await create('r1', 'likes tea', { metadata: { tags: ['drink'] } });
    await committed(store, await op('op-1', [mutation]));
    (mutation as { record: { text: string } }).record.text = 'changed';
    const read = await store.get(USER, 'r1');
    (read!.metadata!.tags as string[]).push('mutated');
    read!.text = 'mutated';
    expect(await store.get(USER, 'r1')).toMatchObject({
      text: 'likes tea',
      metadata: { tags: ['drink'] },
    });
  });

  it('revises and retracts with compare-and-set on the record revision', async () => {
    const { store, tick } = setup();
    await committed(store, await op('op-1', [await create('r1', 'likes tea')]));
    tick();
    const revised = await committed(
      store,
      await op('op-2', [
        {
          type: 'revise',
          id: 'r1',
          expectedRevision: 1,
          changes: { text: 'likes green tea', importance: 0.8 },
        },
      ]),
    );
    expect(revised.entries).toEqual([{ type: 'revise', id: 'r1', revision: 2 }]);
    expect(await store.get(USER, 'r1')).toMatchObject({
      revision: 2,
      text: 'likes green tea',
      importance: 0.8,
      sources: [await source('likes tea')],
      createdAt: 1_000,
      recordedAt: 1_001,
    });
    tick();
    const retracted = await committed(
      store,
      await op('op-3', [{ type: 'retract', id: 'r1', expectedRevision: 2, reason: 'wrong' }]),
    );
    expect(retracted.entries).toEqual([{ type: 'retract', id: 'r1', revision: 3 }]);
    expect(await store.get(USER, 'r1')).toBeUndefined();
    expect(await store.get(USER, 'r1', { includeRetracted: true })).toMatchObject({
      revision: 3,
      status: 'retracted',
      text: 'likes green tea',
    });
    expect(await store.get(USER, 'r1', { revision: 1 })).toMatchObject({ text: 'likes tea' });
    expect(await store.scopeRevision(USER)).toBe(3);
  });

  it('applies revise changes: null clears the TTL and the metadata, sources replace', async () => {
    const { store } = setup();
    await committed(
      store,
      await op('op-1', [
        await create('r1', 'a', {
          expiresAt: 5_000,
          metadata: { a: 1 },
          links: [{ recordId: 'x' }],
        }),
      ]),
    );
    const sources = [{ kind: 'user' as const, messageId: 'm1', digest: await sha256Digest('m1') }];
    await committed(
      store,
      await op('op-2', [
        {
          type: 'revise',
          id: 'r1',
          expectedRevision: 1,
          changes: { expiresAt: null, metadata: null, sources, kind: 'episodic' },
        },
      ]),
    );
    const record = await store.get(USER, 'r1');
    expect(record).toMatchObject({ kind: 'episodic', sources, links: [{ recordId: 'x' }] });
    expect(record).not.toHaveProperty('expiresAt');
    expect(record).not.toHaveProperty('metadata');
  });

  it('answers conflict and applies nothing when any expected revision fails', async () => {
    const { store } = setup();
    await committed(
      store,
      await op('op-1', [await create('r1', 'one'), await create('r2', 'two')]),
    );
    const result = await store.commit(
      await op('op-2', [
        { type: 'revise', id: 'r1', expectedRevision: 1, changes: { text: 'uno' } },
        { type: 'revise', id: 'r2', expectedRevision: 7, changes: { text: 'dos' } },
        await create('r3', 'three'),
      ]),
    );
    expect(result).toEqual({
      status: 'conflict',
      scopeRevision: 1,
      conflicts: [{ id: 'r2', expectedRevision: 7, actualRevision: 1 }],
    });
    expect(await store.get(USER, 'r1')).toMatchObject({ revision: 1, text: 'one' });
    expect(await store.get(USER, 'r3')).toBeUndefined();
    expect(await store.receipt('op-2')).toBeUndefined();
    expect(await store.scopeRevision(USER)).toBe(1);
  });

  it('checks the expected scope revision', async () => {
    const { store } = setup();
    await committed(store, await op('op-1', [await create('r1', 'one')]));
    const stale = await store.commit(
      await op('op-2', [await create('r2', 'two')], { expectedScopeRevision: 0 }),
    );
    expect(stale).toEqual({ status: 'conflict', scopeRevision: 1, conflicts: [] });
    const fresh = await store.commit(
      await op('op-3', [await create('r2', 'two')], { expectedScopeRevision: 1 }),
    );
    expect(fresh.status).toBe('committed');
  });

  it('a create conflicts with an existing id and a mutation of an unknown one conflicts', async () => {
    const { store } = setup();
    await committed(store, await op('op-1', [await create('r1', 'one')]));
    expect(await store.commit(await op('op-2', [await create('r1', 'again')]))).toEqual({
      status: 'conflict',
      scopeRevision: 1,
      conflicts: [{ id: 'r1', expectedRevision: 0, actualRevision: 1 }],
    });
    expect(
      await store.commit(await op('op-3', [{ type: 'retract', id: 'nope', expectedRevision: 1 }])),
    ).toEqual({
      status: 'conflict',
      scopeRevision: 1,
      conflicts: [{ id: 'nope', expectedRevision: 1 }],
    });
  });

  it('writes a durable receipt for an empty operation and for a retract-only one', async () => {
    const { store } = setup();
    const empty = await committed(store, await op('op-empty', []));
    expect(empty).toMatchObject({ scopeRevision: 1, entries: [] });
    expect(await store.receipt('op-empty')).toEqual(empty);
    await committed(store, await op('op-1', [await create('r1', 'one')]));
    const retract = await committed(
      store,
      await op('op-retract', [{ type: 'retract', id: 'r1', expectedRevision: 1 }]),
    );
    expect(retract).toMatchObject({
      scopeRevision: 3,
      entries: [{ type: 'retract', revision: 2 }],
    });
    expect((await store.commit(await op('op-empty', []))).status).toBe('replayed');
  });

  it('replays the same operation id and request without applying it again', async () => {
    const { store, tick } = setup();
    const operation = await op('op-1', [await create('r1', 'one')]);
    const first = await committed(store, operation);
    tick(50);
    // The record moved on meanwhile: the replay still answers the stored receipt.
    await committed(
      store,
      await op('op-2', [{ type: 'revise', id: 'r1', expectedRevision: 1, changes: { text: 'x' } }]),
    );
    expect(await store.commit(operation)).toEqual({ status: 'replayed', receipt: first });
    expect(await store.scopeRevision(USER)).toBe(2);
    expect((await store.history(USER, 'r1')).length).toBe(2);
  });

  it('throws OperationConflictError for the same id with another request digest', async () => {
    const { store } = setup();
    await committed(store, await op('op-1', [await create('r1', 'one')]));
    const other = await op('op-1', [await create('r9', 'nine')], {
      requestDigest: await sha256Digest('another request'),
    });
    const error = await store.commit(other).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(OperationConflictError);
    expect(error).toMatchObject({
      code: 'operation_conflict',
      subsystem: 'memory',
      operationId: 'op-1',
    });
    expect(await store.get(USER, 'r9')).toBeUndefined();
  });

  it('refuses to replay an operation id under another scope', async () => {
    const { store } = setup();
    const operation = await op('op-1', [await create('r1', 'one')]);
    await committed(store, operation);
    await expect(store.commit({ ...operation, scope: OTHER })).rejects.toBeInstanceOf(
      OperationConflictError,
    );
  });

  it('serializes concurrent commits: exactly one CAS winner', async () => {
    const { store } = setup();
    await committed(store, await op('op-0', [await create('r1', 'one')]));
    const attempts = await Promise.all(
      ['a', 'b', 'c'].map(async (name) =>
        store.commit(
          await op(`op-${name}`, [
            { type: 'revise', id: 'r1', expectedRevision: 1, changes: { text: name } },
          ]),
        ),
      ),
    );
    expect(attempts.filter((result) => result.status === 'committed')).toHaveLength(1);
    expect(attempts.filter((result) => result.status === 'conflict')).toHaveLength(2);
    expect((await store.get(USER, 'r1'))!.revision).toBe(2);
  });

  it('validates operations before touching anything', async () => {
    const { store } = setup();
    const valid = await create('r1', 'one');
    const bad: VersionedMemoryCommit[] = [
      await op('', [valid]),
      await op('op-1', [valid], { scope: {} }),
      { ...(await op('op-2', [valid])), requestDigest: 'md5:abc' as never },
      await op('op-3', [
        { type: 'create', record: { id: 'r1', text: 'x', origin: 'asserted', sources: [] } },
      ]),
      await op('op-4', [
        {
          type: 'create',
          record: { id: 'r1', text: 'x', origin: 'guess' as never, sources: [await source('x')] },
        },
      ]),
      await op('op-5', [
        {
          type: 'create',
          record: {
            id: 'r1',
            text: 'x',
            origin: 'inferred',
            sources: [{ kind: 'web' as never, digest: await sha256Digest('x') }],
          },
        },
      ]),
      await op('op-6', [valid, await create('r1', 'twice')]),
      await op('op-7', [await create('', 'no id')]),
    ];
    for (const operation of bad) {
      await expect(store.commit(operation), operation.operationId).rejects.toBeInstanceOf(
        InvalidRequestError,
      );
    }
    expect(await store.scopeRevision(USER)).toBe(0);
  });

  it('keeps scopes apart: reads match the scope exactly, ids are unique store-wide', async () => {
    const { store } = setup();
    await committed(store, await op('op-1', [await create('r1', 'u1 fact')]));
    await committed(store, await op('op-2', [await create('r2', 'u2 fact')], { scope: OTHER }));
    expect((await store.get(USER, 'r1'))!.text).toBe('u1 fact');
    expect(await store.get(OTHER, 'r1')).toBeUndefined();
    expect(await store.get(USER, 'r2')).toBeUndefined();
    expect(await store.get({ userId: 'u1', chatId: 'c1' }, 'r1')).toBeUndefined();
    expect(await store.history(OTHER, 'r1')).toEqual([]);
    expect(await store.scopeRevision(USER)).toBe(1);
    expect(await store.scopeRevision(OTHER)).toBe(1);
    // Another scope can neither take the id nor learn its revision.
    expect(
      await store.commit(await op('op-3', [await create('r1', 'x')], { scope: OTHER })),
    ).toEqual({
      status: 'conflict',
      scopeRevision: 1,
      conflicts: [{ id: 'r1', expectedRevision: 0 }],
    });
    expect(
      await store.commit(
        await op('op-4', [{ type: 'retract', id: 'r1', expectedRevision: 1 }], { scope: OTHER }),
      ),
    ).toMatchObject({ status: 'conflict', conflicts: [{ id: 'r1', expectedRevision: 1 }] });
    expect((await store.get(USER, 'r1'))!.revision).toBe(1);
    // Field order does not change the scope's identity.
    await committed(
      store,
      await op('op-5', [await create('r3', 'chat fact')], { scope: { chatId: 'c', userId: 'u3' } }),
    );
    expect(await store.get({ userId: 'u3', chatId: 'c' }, 'r3')).toMatchObject({
      text: 'chat fact',
    });
  });
});

async function embedded(
  id: string,
  text: string,
  vector: number[],
  modelId = 'emb-1',
  extra: Partial<Extract<VersionedMemoryMutation, { type: 'create' }>['record']> = {},
): Promise<VersionedMemoryMutation> {
  return {
    ...(await create(id, text, extra)),
    embedding: { vector, modelId, textDigest: await sha256Digest(text) },
  } as VersionedMemoryMutation;
}

describe('search', () => {
  it('matches text within the scope, best first, and drops non-matching records', async () => {
    const { store } = setup();
    await committed(
      store,
      await op('op-1', [
        await create('r1', 'likes green tea'),
        await create('r2', 'drives a red car'),
        await create('r3', 'a tea ceremony expert who likes cake'),
      ]),
    );
    await committed(store, await op('op-2', [await create('r9', 'likes tea')], { scope: OTHER }));
    const hits = await store.search({ scope: USER, text: 'likes tea' });
    expect(hits.map((hit) => [hit.record.id, hit.match])).toEqual([
      ['r1', 'lexical'],
      ['r3', 'lexical'],
    ]);
    expect(hits[0]!.score).toBeGreaterThanOrEqual(hits[1]!.score);
  });

  it('ranks by cosine over the active generation; records without a vector stay out', async () => {
    const { store } = setup();
    await committed(
      store,
      await op('op-1', [
        await embedded('r1', 'north', [1, 0, 0]),
        await embedded('r2', 'north-east', [0.7, 0.7, 0]),
        await create('r3', 'no vector'),
      ]),
    );
    expect(await store.embeddings.active()).toMatchObject({
      generation: 1,
      modelId: 'emb-1',
      dims: 3,
      status: 'active',
    });
    const hits = await store.search({
      scope: USER,
      embedding: { vector: [1, 0.1, 0], modelId: 'emb-1' },
    });
    expect(hits.map((hit) => [hit.record.id, hit.match])).toEqual([
      ['r1', 'vector'],
      ['r2', 'vector'],
    ]);
    expect(hits[0]!.record.embedding).toMatchObject({
      generation: 1,
      modelId: 'emb-1',
      dims: 3,
      revision: 1,
      textDigest: await sha256Digest('north'),
    });
  });

  it('fuses text and vector ranks (RRF) and labels the hits', async () => {
    const { store } = setup();
    await committed(
      store,
      await op('op-1', [
        await embedded('r1', 'green tea', [1, 0]),
        await embedded('r2', 'black coffee', [0.9, 0.1]),
        await create('r3', 'tea without vector'),
      ]),
    );
    const hits = await store.search({
      scope: USER,
      text: 'tea',
      embedding: { vector: [1, 0], modelId: 'emb-1' },
    });
    expect(Object.fromEntries(hits.map((hit) => [hit.record.id, hit.match]))).toEqual({
      r1: 'hybrid',
      r2: 'vector',
      r3: 'lexical',
    });
    expect(hits[0]!.record.id).toBe('r1');
  });

  it('refuses a query vector of another model or size', async () => {
    const { store } = setup();
    await committed(store, await op('op-1', [await embedded('r1', 'north', [1, 0, 0])]));
    for (const embedding of [
      { vector: [1, 0, 0], modelId: 'emb-2' },
      { vector: [1, 0], modelId: 'emb-1' },
    ]) {
      const error = await store
        .search({ scope: USER, embedding })
        .catch((reason: unknown) => reason);
      expect(error).toBeInstanceOf(EmbeddingMismatchError);
      expect(error).toMatchObject({
        code: 'embedding_mismatch',
        expected: { modelId: 'emb-1', dims: 3, generation: 1 },
      });
    }
  });

  it('filters kind, retracted and expired records, and caps at topK (default 5)', async () => {
    const { store, tick } = setup();
    const many = await Promise.all(
      Array.from({ length: 7 }, (_, index) => create(`n${index}`, `note ${index}`)),
    );
    await committed(
      store,
      await op('op-1', [
        ...many,
        await create('k1', 'note as procedure', { kind: 'procedural' }),
        await create('e1', 'note that expires', { expiresAt: 1_005 }),
      ]),
    );
    await committed(store, await op('op-2', [{ type: 'retract', id: 'n0', expectedRevision: 1 }]));
    expect(await store.search({ scope: USER, text: 'note' })).toHaveLength(5);
    const all = await store.search({ scope: USER, text: 'note', topK: 50 });
    expect(all.map((hit) => hit.record.id).sort()).toEqual(
      ['e1', 'k1', 'n1', 'n2', 'n3', 'n4', 'n5', 'n6'].sort(),
    );
    const procedural = await store.search({ scope: USER, text: 'note', kind: 'procedural' });
    expect(procedural.map((hit) => hit.record.id)).toEqual(['k1']);
    tick(10);
    const later = await store.search({ scope: USER, text: 'note', topK: 50 });
    expect(later.map((hit) => hit.record.id)).not.toContain('e1');
    const withExpired = await store.search({
      scope: USER,
      text: 'note',
      topK: 50,
      includeExpired: true,
    });
    expect(withExpired.map((hit) => hit.record.id)).toContain('e1');
    const judgedEarlier = await store.search({ scope: USER, text: 'expires', now: 1_001 });
    expect(judgedEarlier.map((hit) => hit.record.id)).toEqual(['e1']);
    const retracted = await store.search({ scope: USER, text: 'note 0', includeRetracted: true });
    expect(retracted[0]).toMatchObject({ record: { id: 'n0', status: 'retracted' } });
  });

  it('answers what the store knew at recordedAsOf', async () => {
    const { store, tick } = setup();
    await committed(store, await op('op-1', [await create('r1', 'lives in London')]));
    const before = tick(5);
    tick(5);
    await committed(
      store,
      await op('op-2', [
        { type: 'revise', id: 'r1', expectedRevision: 1, changes: { text: 'lives in Paris' } },
      ]),
    );
    tick(10);
    await committed(store, await op('op-3', [await create('r2', 'lives near a park')]));
    const retractedAt = tick(10);
    await committed(store, await op('op-4', [{ type: 'retract', id: 'r1', expectedRevision: 2 }]));

    const then = await store.search({ scope: USER, text: 'lives', recordedAsOf: before, topK: 10 });
    expect(then.map((hit) => [hit.record.id, hit.record.revision, hit.record.text])).toEqual([
      ['r1', 1, 'lives in London'],
    ]);
    const beforeRetract = await store.search({
      scope: USER,
      text: 'lives',
      recordedAsOf: retractedAt - 1,
      topK: 10,
    });
    expect(beforeRetract.map((hit) => `${hit.record.id}@${hit.record.revision}`).sort()).toEqual([
      'r1@2',
      'r2@1',
    ]);
    const now = await store.search({ scope: USER, text: 'lives', topK: 10 });
    expect(now.map((hit) => hit.record.id)).toEqual(['r2']);
    expect(await store.search({ scope: USER, text: 'lives', recordedAsOf: 999 })).toEqual([]);
  });

  it('never carries a vector to a revised text, but keeps it for an unchanged one', async () => {
    const { store } = setup();
    await committed(
      store,
      await op('op-1', [
        await embedded('r1', 'north', [1, 0]),
        await embedded('r2', 'east', [0, 1]),
      ]),
    );
    await committed(
      store,
      await op('op-2', [
        { type: 'revise', id: 'r1', expectedRevision: 1, changes: { text: 'south' } },
        { type: 'revise', id: 'r2', expectedRevision: 1, changes: { importance: 0.9 } },
      ]),
    );
    expect((await store.get(USER, 'r1'))!.embedding).toBeUndefined();
    expect((await store.get(USER, 'r2'))!.embedding).toMatchObject({ revision: 2 });
    const hits = await store.search({
      scope: USER,
      embedding: { vector: [1, 0], modelId: 'emb-1' },
    });
    expect(hits.map((hit) => hit.record.id)).toEqual(['r2']);
    const lexical = await store.search({ scope: USER, text: 'south' });
    expect(lexical.map((hit) => hit.record.id)).toEqual(['r1']);
  });

  it('refuses a commit vector of another model or size, or of another text', async () => {
    const { store } = setup();
    await committed(store, await op('op-1', [await embedded('r1', 'north', [1, 0])]));
    await expect(
      store.commit(await op('op-2', [await embedded('r2', 'east', [0, 1], 'emb-2')])),
    ).rejects.toBeInstanceOf(EmbeddingMismatchError);
    await expect(
      store.commit(await op('op-3', [await embedded('r2', 'east', [0, 1, 0])])),
    ).rejects.toBeInstanceOf(EmbeddingMismatchError);
    const stale = {
      type: 'revise' as const,
      id: 'r1',
      expectedRevision: 1,
      changes: { text: 'south' },
      embedding: { vector: [1, 0], modelId: 'emb-1', textDigest: await sha256Digest('north') },
    };
    await expect(store.commit(await op('op-4', [stale]))).rejects.toBeInstanceOf(
      InvalidRequestError,
    );
    expect(await store.scopeRevision(USER)).toBe(1);
    expect(await store.get(USER, 'r2')).toBeUndefined();
  });

  it('lists the most recent records when the query has neither text nor vector', async () => {
    const { store, tick } = setup();
    await committed(store, await op('op-1', [await create('r1', 'one')]));
    tick();
    await committed(store, await op('op-2', [await create('r2', 'two')]));
    const hits = await store.search({ scope: USER });
    expect(hits.map((hit) => hit.record.id)).toEqual(['r2', 'r1']);
  });
});

describe('forget', () => {
  it('deletes every revision and vector and keeps content-free receipts', async () => {
    const { store, now } = setup();
    await committed(store, await op('op-1', [await embedded('r1', 'secret', [1, 0])]));
    await committed(
      store,
      await op('op-2', [{ type: 'retract', id: 'r1', expectedRevision: 1, reason: 'stale' }]),
    );
    await committed(store, await op('op-3', [await embedded('r2', 'kept', [0, 1])]));
    const event = await store.forget(USER, 'r1', 'op-forget');
    expect(event).toEqual({
      scope: USER,
      recordId: 'r1',
      revisions: [1, 2],
      operationId: 'op-forget',
    });
    expect(await store.get(USER, 'r1', { includeRetracted: true })).toBeUndefined();
    expect(await store.get(USER, 'r1', { revision: 1, includeRetracted: true })).toBeUndefined();
    expect(await store.history(USER, 'r1')).toEqual([]);
    const searches = await Promise.all([
      store.search({ scope: USER, text: 'secret', includeRetracted: true, includeExpired: true }),
      store.search({ scope: USER, text: 'secret', includeRetracted: true, recordedAsOf: now }),
      store.search({
        scope: USER,
        embedding: { vector: [1, 0], modelId: 'emb-1' },
        includeRetracted: true,
      }),
    ]);
    for (const hits of searches) expect(hits.map((hit) => hit.record.id)).not.toContain('r1');
    // The receipts that wrote it stay, content-free, so a redelivery replays.
    expect(await store.receipt('op-1')).toMatchObject({
      operationId: 'op-1',
      redacted: true,
      entries: [{ type: 'create', id: 'r1', revision: 1 }],
    });
    expect(await store.receipt('op-2')).toMatchObject({ redacted: true });
    expect((await store.receipt('op-3'))!.redacted).toBeUndefined();
    expect(JSON.stringify(await store.receipt('op-1'))).not.toContain('secret');
    // The forget is an operation with its own content-free receipt.
    expect(await store.receipt('op-forget')).toMatchObject({
      operationId: 'op-forget',
      actor: 'host',
      entries: [],
      scopeRevision: 4,
    });
    expect(await store.scopeRevision(USER)).toBe(4);
    expect(await store.get(USER, 'r2')).toMatchObject({ text: 'kept' });
  });

  it('a redelivered operation cannot bring a forgotten record back', async () => {
    const { store } = setup();
    const write = await op('op-1', [await create('r1', 'secret')]);
    await committed(store, write);
    await store.forget(USER, 'r1', 'op-forget');
    expect(await store.commit(write)).toMatchObject({ status: 'replayed' });
    expect(await store.get(USER, 'r1')).toBeUndefined();
    // Even under a new operation id the id is never recreated, and nothing revises it.
    expect(await store.commit(await op('op-2', [await create('r1', 'secret again')]))).toEqual({
      status: 'conflict',
      scopeRevision: 2,
      conflicts: [{ id: 'r1', expectedRevision: 0 }],
    });
    expect(
      await store.commit(
        await op('op-3', [
          { type: 'revise', id: 'r1', expectedRevision: 1, changes: { text: 'x' } },
        ]),
      ),
    ).toMatchObject({ status: 'conflict', conflicts: [{ id: 'r1', expectedRevision: 1 }] });
    expect(await store.history(USER, 'r1')).toEqual([]);
  });

  it('replays a repeated forget and refuses its id for another record', async () => {
    const { store } = setup();
    await committed(store, await op('op-1', [await create('r1', 'a'), await create('r2', 'b')]));
    await store.forget(USER, 'r1', 'op-forget');
    expect(await store.forget(USER, 'r1', 'op-forget')).toEqual({
      scope: USER,
      recordId: 'r1',
      revisions: [],
      operationId: 'op-forget',
    });
    expect(await store.scopeRevision(USER)).toBe(2);
    await expect(store.forget(USER, 'r2', 'op-forget')).rejects.toBeInstanceOf(
      OperationConflictError,
    );
    expect(await store.get(USER, 'r2')).toMatchObject({ text: 'b' });
  });

  it('forgets nothing for an unknown record or another scope', async () => {
    const { store } = setup();
    await committed(store, await op('op-1', [await create('r1', 'mine')]));
    expect(await store.forget(OTHER, 'r1', 'op-forget')).toEqual({
      scope: OTHER,
      recordId: 'r1',
      revisions: [],
      operationId: 'op-forget',
    });
    expect(await store.get(USER, 'r1')).toMatchObject({ text: 'mine' });
    expect(await store.history(USER, 'r1')).toHaveLength(1);
    // Nothing was forgotten, so an unknown id stays free.
    await store.forget(USER, 'never-written', 'op-forget-2');
    expect(
      (await store.commit(await op('op-2', [await create('never-written', 'now it is')]))).status,
    ).toBe('committed');
  });
});

describe('embedding generations', () => {
  it('prepares a new generation aside and switches atomically once complete', async () => {
    const { store } = setup();
    await committed(
      store,
      await op('op-1', [
        await embedded('b', 'bravo', [1, 0]),
        await embedded('a', 'alpha', [0, 1]),
        await create('c', 'charlie'),
      ]),
    );
    await committed(store, await op('op-2', [await create('z', 'zulu')], { scope: OTHER }));
    await committed(store, await op('op-3', [{ type: 'retract', id: 'c', expectedRevision: 1 }]));

    const next = await store.embeddings.begin({ modelId: 'emb-2', dims: 3 });
    expect(next).toMatchObject({ generation: 2, modelId: 'emb-2', dims: 3, status: 'pending' });
    expect(await store.embeddings.begin({ modelId: 'emb-2', dims: 3 })).toEqual(next);
    expect((await store.embeddings.active())!.generation).toBe(1);

    const firstPage = await store.embeddings.pending(2, { limit: 2 });
    expect(firstPage).toEqual([
      { id: 'a', revision: 1, scope: USER, text: 'alpha', textDigest: await sha256Digest('alpha') },
      { id: 'b', revision: 1, scope: USER, text: 'bravo', textDigest: await sha256Digest('bravo') },
    ]);
    const secondPage = await store.embeddings.pending(2, { limit: 10, after: 'b' });
    expect(secondPage.map((item) => [item.id, item.revision, item.scope])).toEqual([
      ['c', 2, USER],
      ['z', 1, OTHER],
    ]);

    expect(
      await store.embeddings.put(
        2,
        firstPage.map((item, index) => ({
          id: item.id,
          revision: item.revision,
          textDigest: item.textDigest,
          vector: [index, 1, 0],
        })),
      ),
    ).toBe(2);
    expect(await store.embeddings.activate(2)).toBe(false);
    // Search keeps the old generation meanwhile.
    const old = await store.search({
      scope: USER,
      embedding: { vector: [1, 0], modelId: 'emb-1' },
    });
    expect(old.map((hit) => hit.record.id)).toEqual(['b', 'a']);
    await expect(
      store.search({ scope: USER, embedding: { vector: [1, 0, 0], modelId: 'emb-2' } }),
    ).rejects.toBeInstanceOf(EmbeddingMismatchError);

    await store.embeddings.put(
      2,
      secondPage.map((item) => ({
        id: item.id,
        revision: item.revision,
        textDigest: item.textDigest,
        vector: [0, 0, 1],
      })),
    );
    expect(await store.embeddings.pending(2, { limit: 10 })).toEqual([]);
    expect(await store.embeddings.activate(2)).toBe(true);
    expect(await store.embeddings.active()).toMatchObject({ generation: 2, status: 'active' });
    expect(await store.embeddings.activate(2)).toBe(true);
    const switched = await store.search({
      scope: USER,
      embedding: { vector: [0, 1, 0], modelId: 'emb-2' },
      includeRetracted: true,
    });
    expect(switched.map((hit) => hit.record.id).sort()).toEqual(['a', 'b', 'c']);
    expect(switched[0]!.record.embedding).toMatchObject({
      generation: 2,
      modelId: 'emb-2',
      dims: 3,
    });
    await expect(
      store.search({ scope: USER, embedding: { vector: [1, 0], modelId: 'emb-1' } }),
    ).rejects.toBeInstanceOf(EmbeddingMismatchError);
  });

  it('skips a vector whose revision moved and lists the new revision instead', async () => {
    const { store } = setup();
    await committed(store, await op('op-1', [await embedded('a', 'alpha', [1, 0])]));
    const { generation } = await store.embeddings.begin({ modelId: 'emb-2', dims: 2 });
    const [item] = await store.embeddings.pending(generation, { limit: 10 });
    await committed(
      store,
      await op('op-2', [
        {
          type: 'revise',
          id: 'a',
          expectedRevision: 1,
          changes: { text: 'alpha two' },
          embedding: {
            vector: [1, 0],
            modelId: 'emb-1',
            textDigest: await sha256Digest('alpha two'),
          },
        },
      ]),
    );
    const stale = [{ id: 'a', revision: 1, textDigest: item!.textDigest, vector: [0, 1] }];
    expect(await store.embeddings.put(generation, stale)).toBe(0);
    const wrongText = [{ id: 'a', revision: 2, textDigest: item!.textDigest, vector: [0, 1] }];
    expect(await store.embeddings.put(generation, wrongText)).toBe(0);
    expect(await store.embeddings.activate(generation)).toBe(false);
    const [fresh] = await store.embeddings.pending(generation, { limit: 10 });
    expect(fresh).toMatchObject({ id: 'a', revision: 2, text: 'alpha two' });
    await expect(
      store.embeddings.put(generation, [{ ...fresh!, vector: [0, 1, 0] }]),
    ).rejects.toBeInstanceOf(EmbeddingMismatchError);
    expect(await store.embeddings.put(generation, [{ ...fresh!, vector: [0, 1] }])).toBe(1);
    // A metadata-only revise keeps the text, so its prepared vector carries over.
    await committed(
      store,
      await op('op-3', [
        { type: 'revise', id: 'a', expectedRevision: 2, changes: { importance: 1 } },
      ]),
    );
    expect(await store.embeddings.pending(generation, { limit: 10 })).toEqual([]);
    expect(await store.embeddings.activate(generation)).toBe(true);
    expect((await store.get(USER, 'a'))!.embedding).toMatchObject({ generation, revision: 3 });
  });

  it('starts from nothing: begin, fill and activate a first generation', async () => {
    const { store } = setup();
    expect(await store.embeddings.active()).toBeUndefined();
    await committed(store, await op('op-1', [await create('a', 'alpha')]));
    const first = await store.embeddings.begin({ modelId: 'emb-1', dims: 2 });
    expect(first).toMatchObject({ generation: 1, status: 'pending' });
    // Another model replaces the pending generation.
    const second = await store.embeddings.begin({ modelId: 'emb-9', dims: 2 });
    expect(second.generation).toBe(2);
    expect(await store.embeddings.pending(1, { limit: 10 })).toEqual([]);
    expect(await store.embeddings.activate(1)).toBe(false);
    const [item] = await store.embeddings.pending(2, { limit: 10 });
    await store.embeddings.put(2, [{ ...item!, vector: [1, 1] }]);
    expect(await store.embeddings.activate(2)).toBe(true);
    expect(await store.embeddings.active()).toMatchObject({ generation: 2, modelId: 'emb-9' });
  });
});

describe('retention', () => {
  it('pruneHistory deletes past revisions of retracted or expired records only', async () => {
    const { store, tick } = setup();
    await committed(
      store,
      await op('op-1', [
        await create('gone', 'v1'),
        await create('live', 'v1'),
        await create('ttl', 'v1', { expiresAt: 1_050 }),
      ]),
    );
    tick(10);
    const revise = (id: string, expectedRevision: number, text: string) => ({
      type: 'revise' as const,
      id,
      expectedRevision,
      changes: { text },
    });
    await committed(
      store,
      await op('op-2', [revise('gone', 1, 'v2'), revise('live', 1, 'v2'), revise('ttl', 1, 'v2')]),
    );
    tick(10);
    await committed(
      store,
      await op('op-3', [{ type: 'retract', id: 'gone', expectedRevision: 2 }]),
    );
    tick(100);
    expect(await store.pruneHistory({ olderThan: 1_015 })).toBe(3);
    expect((await store.history(USER, 'gone')).map((record) => record.revision)).toEqual([3]);
    expect((await store.history(USER, 'ttl')).map((record) => record.revision)).toEqual([2]);
    expect((await store.history(USER, 'live')).map((record) => record.revision)).toEqual([1, 2]);
    expect(await store.receipt('op-1')).toBeDefined();
    expect(await store.pruneHistory({ olderThan: 5_000 })).toBe(0);
  });

  it('pruneHistory can be narrowed to one scope', async () => {
    const { store, tick } = setup();
    for (const scope of [USER, OTHER]) {
      await committed(
        store,
        await op(`c-${scope.userId}`, [await create(`r-${scope.userId}`, 'v1')], { scope }),
      );
      await committed(
        store,
        await op(
          `x-${scope.userId}`,
          [{ type: 'retract', id: `r-${scope.userId}`, expectedRevision: 1 }],
          {
            scope,
          },
        ),
      );
    }
    tick(10);
    expect(await store.pruneHistory({ olderThan: 2_000, scope: OTHER })).toBe(1);
    expect(await store.history(USER, 'r-u1')).toHaveLength(2);
    expect(await store.history(OTHER, 'r-u2')).toHaveLength(1);
  });

  it('pruneOperations deletes old receipts and warns that dedupe is lost for them', async () => {
    const { store, tick, warnings } = setup();
    const empty = await op('op-old', []);
    await committed(store, empty);
    tick(100);
    await committed(store, await op('op-new', []));
    expect(await store.pruneOperations({ olderThan: 1_050 })).toBe(1);
    expect(await store.receipt('op-old')).toBeUndefined();
    expect(await store.receipt('op-new')).toBeDefined();
    expect(warnings.some((message) => /dedupe|applied again/i.test(message))).toBe(true);
    // The pruned id is no longer protected: a redelivery is applied again.
    expect((await store.commit(empty)).status).toBe('committed');
  });
});
