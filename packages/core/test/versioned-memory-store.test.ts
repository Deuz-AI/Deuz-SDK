/**
 * The in-memory VersionedMemoryStore (2.4, spec §2.1): the reference semantics
 * of the store contract. One operation commits the active record, its
 * immutable revision, the index entries and a receipt together, or nothing;
 * expected revisions are compare-and-set; an operation id replays with the
 * same request and conflicts with another; forget keeps content-free receipts.
 */
import { describe, expect, it } from 'vitest';
import { InvalidRequestError, OperationConflictError } from '../src/errors';
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

  it('keeps scopes apart: same id in two scopes, reads never cross', async () => {
    const { store } = setup();
    await committed(store, await op('op-1', [await create('r1', 'u1 fact')]));
    await committed(store, await op('op-2', [await create('r1', 'u2 fact')], { scope: OTHER }));
    expect((await store.get(USER, 'r1'))!.text).toBe('u1 fact');
    expect((await store.get(OTHER, 'r1'))!.text).toBe('u2 fact');
    expect(await store.get({ userId: 'u1', chatId: 'c1' }, 'r1')).toBeUndefined();
    expect(await store.scopeRevision(USER)).toBe(1);
    expect(await store.scopeRevision(OTHER)).toBe(1);
    expect(await store.history(OTHER, 'r1')).toHaveLength(1);
    // Field order does not change the scope's identity.
    expect(
      (await store.get({ chatId: 'c', userId: 'u3' }, 'x')) ===
        (await store.get({ userId: 'u3', chatId: 'c' }, 'x')),
    ).toBe(true);
  });
});
