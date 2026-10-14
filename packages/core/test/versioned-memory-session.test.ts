/**
 * createMemorySession (2.4, spec §2.1–§2.2): every write is one operation
 * with a receipt; reconciliation and embedding run outside the store, on the
 * final text; a revision conflict is re-read and reconciled up to three
 * times; the same operation id replays; forget commits and then tells every
 * onForget listener.
 */
import { describe, expect, it } from 'vitest';
import {
  EmbeddingMismatchError,
  InvalidRequestError,
  OperationConflictError,
  RevisionConflictError,
} from '../src/errors';
import { sha256Digest } from '../src/internal/digest';
import { createMemoryObserver } from '../src/observe';
import { createInMemoryVersionedMemoryStore, createMemorySession } from '../src/memory/versioned';
import type { MemoryForgetEvent } from '../src/memory/versioned';
import type { MemoryScope } from '../src/memory';
import type { ObserveEvent } from '../src/index';
import {
  interceptedStore,
  keywordEmbedder,
  scriptedLLM,
  seed,
} from './fixtures/versioned-memory-session';

const USER: MemoryScope = { userId: 'u1' };

function deps(start = 10_000) {
  let now = start;
  let ids = 0;
  return {
    clock: { now: () => now, setTimeout: () => () => {} },
    generateId: () => `id-${++ids}`,
    tick: (ms: number) => (now += ms),
  };
}

describe('remember', () => {
  it('writes an asserted record with a host source by default (no LLM: add)', async () => {
    const d = deps();
    const store = createInMemoryVersionedMemoryStore({ deps: d });
    const session = createMemorySession({ store, scope: USER, deps: d });
    expect(session.scope).toEqual(USER);
    const result = await session.remember({
      text: 'prefers green tea',
      ttlMs: 60_000,
      importance: 0.7,
      links: [{ recordId: 'r0', relation: 'about' }],
      metadata: { tag: 'drink' },
    });
    expect(result.replayed).toBe(false);
    expect(result.conflictRetries).toBe(0);
    expect(result.receipt).toMatchObject({
      scope: USER,
      actor: 'host',
      scopeRevision: 1,
      entries: [{ type: 'create', revision: 1 }],
    });
    expect(result.records).toHaveLength(1);
    expect(result.records[0]).toMatchObject({
      text: 'prefers green tea',
      origin: 'asserted',
      kind: 'semantic',
      status: 'active',
      importance: 0.7,
      expiresAt: 70_000,
      links: [{ recordId: 'r0', relation: 'about' }],
      metadata: { tag: 'drink' },
      sources: [{ kind: 'host', digest: await sha256Digest('prefers green tea') }],
    });
    expect(await store.receipt(result.receipt.operationId)).toEqual(result.receipt);
  });

  it('embeds the final text and binds the vector to revision, text digest and generation', async () => {
    const store = createInMemoryVersionedMemoryStore();
    const embedder = keywordEmbedder();
    const session = createMemorySession({ store, scope: USER, embedder });
    const { records } = await session.remember({ text: 'drinks coffee', supersede: 'add' });
    expect(embedder.calls).toEqual([{ texts: ['drinks coffee'], action: 'add' }]);
    expect(records[0]!.embedding).toEqual({
      generation: 1,
      modelId: 'kw-1',
      dims: 5,
      revision: 1,
      textDigest: await sha256Digest('drinks coffee'),
    });
  });

  it('replays the same operation id and refuses it for another request', async () => {
    const store = createInMemoryVersionedMemoryStore();
    const script = scriptedLLM();
    const embedder = keywordEmbedder();
    const session = createMemorySession({ store, scope: USER, llm: script.llm, embedder });
    const first = await session.remember({ text: 'likes tea' }, { operationId: 'op-1' });
    const calls = [script.calls.length, embedder.calls.length];
    const again = await session.remember({ text: 'likes tea' }, { operationId: 'op-1' });
    expect(again.replayed).toBe(true);
    expect(again.receipt).toEqual(first.receipt);
    expect(again.records.map((record) => record.id)).toEqual(first.records.map((r) => r.id));
    expect([script.calls.length, embedder.calls.length]).toEqual(calls);
    expect(await store.scopeRevision(USER)).toBe(1);
    await expect(
      session.remember({ text: 'likes coffee' }, { operationId: 'op-1' }),
    ).rejects.toBeInstanceOf(OperationConflictError);
  });

  it('reconciles with the LLM outside the store, then embeds the reconciled text', async () => {
    const store = interceptedStore();
    await seed(store, USER, { id: 'r1', text: 'lives in London' });
    const script = scriptedLLM({
      onCall: () => {
        expect(store.open).toBe(0);
      },
      reconcile: (_prompt, existing) => ({
        memory: [{ id: existing[0]!.id, event: 'UPDATE', text: 'lives in Paris since 2024' }],
      }),
    });
    const embedder = keywordEmbedder();
    const session = createMemorySession({ store, scope: USER, llm: script.llm, embedder });
    const result = await session.remember({ text: 'I moved to Paris in 2024' });
    expect(script.reconciliations()).toHaveLength(1);
    expect(script.reconciliations()[0]!.user).toContain('lives in London');
    expect(result.receipt.entries).toEqual([{ type: 'revise', id: 'r1', revision: 2 }]);
    expect(result.records[0]).toMatchObject({
      id: 'r1',
      revision: 2,
      text: 'lives in Paris since 2024',
      origin: 'asserted',
      embedding: { revision: 2, textDigest: await sha256Digest('lives in Paris since 2024') },
    });
    // The revision rests on the old sources and the new one.
    expect(result.records[0]!.sources.map((source) => source.digest)).toEqual([
      await sha256Digest('lives in London'),
      await sha256Digest('I moved to Paris in 2024'),
    ]);
    expect(embedder.calls.at(-1)).toEqual({
      texts: ['lives in Paris since 2024'],
      action: 'update',
    });
    // The plan was made against the scope revision it read.
    expect(store.commits.at(-1)!.expectedScopeRevision).toBe(1);
  });

  it('skips the reconciliation call when nothing similar exists', async () => {
    const store = createInMemoryVersionedMemoryStore();
    const script = scriptedLLM();
    const session = createMemorySession({ store, scope: USER, llm: script.llm });
    const { records } = await session.remember({ text: 'likes tea' });
    expect(script.calls).toHaveLength(0);
    expect(records[0]).toMatchObject({ text: 'likes tea', revision: 1 });
  });

  it('records a durable empty operation when reconciliation keeps everything', async () => {
    const store = createInMemoryVersionedMemoryStore();
    await seed(store, USER, { id: 'r1', text: 'likes tea' });
    const script = scriptedLLM({
      reconcile: (_prompt, existing) => ({ memory: [{ id: existing[0]!.id, event: 'NOOP' }] }),
    });
    const session = createMemorySession({ store, scope: USER, llm: script.llm });
    const result = await session.remember({ text: 'likes tea a lot' }, { operationId: 'op-noop' });
    expect(result.records).toEqual([]);
    expect(result.receipt.entries).toEqual([]);
    expect(await store.receipt('op-noop')).toMatchObject({ entries: [] });
  });

  it('never adds a second record with the text of an existing one', async () => {
    const store = createInMemoryVersionedMemoryStore();
    await seed(store, USER, { id: 'r1', text: 'Likes tea' });
    const script = scriptedLLM({
      reconcile: () => ({ memory: [{ event: 'ADD', text: 'likes tea ' }] }),
    });
    const session = createMemorySession({ store, scope: USER, llm: script.llm });
    const result = await session.remember({ text: 'I like tea' });
    expect(result.receipt.entries).toEqual([]);
    expect(await session.recall({ text: 'tea', topK: 10 })).toHaveLength(1);
  });

  it('retracts a contradicted record and links the new one as superseding it', async () => {
    const store = createInMemoryVersionedMemoryStore();
    await seed(store, USER, { id: 'r1', text: 'eats no fish (vegetarian)' });
    const script = scriptedLLM({
      reconcile: (_prompt, existing) => ({
        memory: [
          { id: existing[0]!.id, event: 'DELETE' },
          { event: 'ADD', text: 'eats fish (pescatarian)' },
        ],
      }),
    });
    const session = createMemorySession({ store, scope: USER, llm: script.llm });
    const result = await session.remember({ text: 'eats fish now' });
    expect(result.receipt.entries.map((entry) => entry.type).sort()).toEqual(['create', 'retract']);
    expect(await store.get(USER, 'r1')).toBeUndefined();
    const created = result.records.find((record) => record.text.startsWith('eats fish'));
    expect(created!.links).toEqual([{ recordId: 'r1', relation: 'supersedes' }]);
  });

  it('never lets an inferred write change an asserted record', async () => {
    const store = createInMemoryVersionedMemoryStore();
    await seed(store, USER, { id: 'host-fact', text: 'lives in London', origin: 'asserted' });
    await seed(store, USER, { id: 'host-other', text: 'lives near London Bridge' });
    const script = scriptedLLM({
      reconcile: (_prompt, existing) => ({
        memory: [
          {
            id: existing.find((e) => e.text === 'lives in London')!.id,
            event: 'UPDATE',
            text: 'lives in Rome',
          },
          { id: existing.find((e) => e.text !== 'lives in London')!.id, event: 'DELETE' },
        ],
      }),
    });
    const session = createMemorySession({ store, scope: USER, llm: script.llm });
    const result = await session.remember({ text: 'lives in Rome London', origin: 'inferred' });
    expect(await store.get(USER, 'host-fact')).toMatchObject({
      revision: 1,
      text: 'lives in London',
    });
    expect(await store.get(USER, 'host-other')).toMatchObject({ revision: 1 });
    expect(result.records).toHaveLength(1);
    expect(result.records[0]).toMatchObject({
      text: 'lives in Rome',
      origin: 'inferred',
      links: [{ recordId: 'host-fact', relation: 'about' }],
    });
  });

  it('an asserted write supersedes an inferred record instead of relabelling it', async () => {
    const store = createInMemoryVersionedMemoryStore();
    await seed(store, USER, { id: 'guess', text: 'lives in London', origin: 'inferred' });
    const script = scriptedLLM({
      reconcile: (_prompt, existing) => ({
        memory: [{ id: existing[0]!.id, event: 'UPDATE', text: 'lives in London (confirmed)' }],
      }),
    });
    const session = createMemorySession({ store, scope: USER, llm: script.llm });
    const result = await session.remember({ text: 'I live in London' });
    expect(await store.get(USER, 'guess')).toBeUndefined();
    expect(await store.get(USER, 'guess', { includeRetracted: true })).toMatchObject({
      origin: 'inferred',
      status: 'retracted',
    });
    const created = result.records.find((record) => record.status === 'active');
    expect(created).toMatchObject({
      text: 'lives in London (confirmed)',
      origin: 'asserted',
      links: [{ recordId: 'guess', relation: 'supersedes' }],
    });
  });

  it('re-reads and reconciles again on a concurrent change (three attempts)', async () => {
    const store = interceptedStore();
    await seed(store, USER, { id: 'r1', text: 'likes tea' });
    const script = scriptedLLM({
      reconcile: (_prompt, existing) => ({
        memory: [{ id: existing[0]!.id, event: 'UPDATE', text: 'likes green tea' }],
      }),
    });
    const session = createMemorySession({ store, scope: USER, llm: script.llm });
    let other = 0;
    store.beforeCommit(1, () => seed(store, USER, { id: `other-${++other}`, text: 'unrelated' }));
    const result = await session.remember({ text: 'loves green tea' });
    expect(result.conflictRetries).toBe(1);
    expect(script.reconciliations()).toHaveLength(2);
    expect(await store.get(USER, 'r1')).toMatchObject({ revision: 2, text: 'likes green tea' });

    store.beforeCommit(3, () => seed(store, USER, { id: `other-${++other}`, text: 'unrelated' }));
    const error = await session
      .remember({ text: 'adores green tea' })
      .catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(RevisionConflictError);
    expect(error).toMatchObject({ code: 'revision_conflict', subsystem: 'memory', attempts: 3 });
    expect((await store.get(USER, 'r1'))!.revision).toBe(2);
  });

  it('honours maxConflictRetries', async () => {
    const store = interceptedStore();
    await seed(store, USER, { id: 'r1', text: 'likes tea' });
    const script = scriptedLLM({
      reconcile: (_prompt, existing) => ({
        memory: [{ id: existing[0]!.id, event: 'UPDATE', text: 'likes green tea' }],
      }),
    });
    const session = createMemorySession({
      store,
      scope: USER,
      llm: script.llm,
      maxConflictRetries: 1,
    });
    store.beforeCommit(1, () => seed(store, USER, { id: 'x', text: 'x' }));
    await expect(session.remember({ text: 'green tea' })).rejects.toMatchObject({
      attempts: 1,
    });
  });

  it('needs an LLM only for an explicit reconcile', async () => {
    const session = createMemorySession({
      store: createInMemoryVersionedMemoryStore(),
      scope: USER,
    });
    await expect(session.remember({ text: 'x', supersede: 'reconcile' })).rejects.toBeInstanceOf(
      InvalidRequestError,
    );
    await expect(session.remember({ text: '' })).rejects.toBeInstanceOf(InvalidRequestError);
    expect(() =>
      createMemorySession({ store: createInMemoryVersionedMemoryStore(), scope: {} }),
    ).toThrow(InvalidRequestError);
  });

  it('throws EmbeddingMismatchError for another model or size, and writes nothing', async () => {
    const store = createInMemoryVersionedMemoryStore();
    await createMemorySession({ store, scope: USER, embedder: keywordEmbedder() }).remember({
      text: 'tea',
      supersede: 'add',
    });
    for (const embedder of [
      keywordEmbedder(['tea', 'coffee', 'paris', 'london'], 'kw-2'),
      keywordEmbedder(['tea'], 'kw-1'),
    ]) {
      const session = createMemorySession({ store, scope: USER, embedder });
      await expect(session.remember({ text: 'coffee', supersede: 'add' })).rejects.toBeInstanceOf(
        EmbeddingMismatchError,
      );
      await expect(session.recall({ text: 'coffee' })).rejects.toBeInstanceOf(
        EmbeddingMismatchError,
      );
    }
    expect(await store.scopeRevision(USER)).toBe(1);
  });
});

describe('recall', () => {
  it('searches the scope by text and, once a generation exists, by vector', async () => {
    const store = createInMemoryVersionedMemoryStore();
    const embedder = keywordEmbedder();
    const plain = createMemorySession({ store, scope: USER, embedder });
    await seed(store, USER, { id: 'r1', text: 'likes tea' });
    expect((await plain.recall({ text: 'tea' })).map((hit) => hit.record.id)).toEqual(['r1']);
    // No generation yet: no query embedding is paid for.
    expect(embedder.calls).toEqual([]);
    await plain.remember({ text: 'drinks coffee', supersede: 'add' });
    const hits = await plain.recall({ text: 'coffee', topK: 3 });
    expect(embedder.calls.at(-1)).toEqual({ texts: ['coffee'], action: 'search' });
    expect(hits[0]).toMatchObject({ record: { text: 'drinks coffee' }, match: 'hybrid' });
    await seed(store, { userId: 'u2' }, { id: 'r9', text: 'likes tea too' });
    const ids = (await plain.recall({ text: 'tea', topK: 10 })).map((hit) => hit.record.id);
    expect(ids).toContain('r1');
    expect(ids).not.toContain('r9');
  });

  it('reads what the store knew at recordedAsOf, and retracted records on request', async () => {
    const d = deps();
    const store = createInMemoryVersionedMemoryStore({ deps: d });
    const session = createMemorySession({ store, scope: USER, deps: d });
    const { records } = await session.remember({ text: 'lives in London' });
    const before = d.tick(10);
    d.tick(10);
    await session.revise(records[0]!.id, { text: 'lives in Paris' }, { expectedRevision: 1 });
    expect((await session.recall({ text: 'lives', recordedAsOf: before }))[0]!.record.text).toBe(
      'lives in London',
    );
    await session.retract(records[0]!.id, { expectedRevision: 2 });
    expect(await session.recall({ text: 'lives' })).toEqual([]);
    expect(
      (await session.recall({ text: 'lives', includeRetracted: true }))[0]!.record.status,
    ).toBe('retracted');
  });
});

describe('revise, retract, forget, history', () => {
  it('revise writes a new revision; a new text gets a new vector, an unchanged one keeps it', async () => {
    const store = createInMemoryVersionedMemoryStore();
    const embedder = keywordEmbedder();
    const session = createMemorySession({ store, scope: USER, embedder });
    const { records } = await session.remember({ text: 'likes tea', supersede: 'add' });
    const id = records[0]!.id;
    const revised = await session.revise(id, { text: 'likes coffee' }, { expectedRevision: 1 });
    expect(revised.records[0]).toMatchObject({
      revision: 2,
      text: 'likes coffee',
      embedding: { revision: 2, textDigest: await sha256Digest('likes coffee') },
    });
    expect(embedder.calls.at(-1)).toEqual({ texts: ['likes coffee'], action: 'update' });
    const calls = embedder.calls.length;
    const touched = await session.revise(id, { importance: 0.4 }, { expectedRevision: 2 });
    expect(embedder.calls.length).toBe(calls);
    expect(touched.records[0]).toMatchObject({ revision: 3, embedding: { revision: 3 } });
    const vectorHits = await session.recall({ text: 'coffee' });
    expect(vectorHits[0]!.record).toMatchObject({ id, revision: 3 });
  });

  it('revise and retract are compare-and-set: a stale revision throws at once', async () => {
    const store = interceptedStore();
    const session = createMemorySession({ store, scope: USER });
    const { records } = await session.remember({ text: 'likes tea' });
    const id = records[0]!.id;
    await session.revise(id, { text: 'likes green tea' }, { expectedRevision: 1 });
    const commits = store.commits.length;
    const error = await session
      .revise(id, { text: 'likes black tea' }, { expectedRevision: 1 })
      .catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(RevisionConflictError);
    expect(error).toMatchObject({ key: id, expectedRevision: 1, actualRevision: 2, attempts: 1 });
    expect(store.commits.length).toBe(commits + 1);
    await expect(session.retract(id, { expectedRevision: 1 })).rejects.toBeInstanceOf(
      RevisionConflictError,
    );
    await expect(session.retract('missing', { expectedRevision: 1 })).rejects.toMatchObject({
      key: 'missing',
    });
  });

  it('retract leaves normal retrieval and keeps the history', async () => {
    const session = createMemorySession({
      store: createInMemoryVersionedMemoryStore(),
      scope: USER,
    });
    const { records } = await session.remember({ text: 'likes tea' });
    const id = records[0]!.id;
    const retracted = await session.retract(id, { expectedRevision: 1, reason: 'wrong' });
    expect(retracted.records[0]).toMatchObject({ revision: 2, status: 'retracted' });
    expect(await session.recall({ text: 'tea' })).toEqual([]);
    expect((await session.history(id)).map((record) => [record.revision, record.status])).toEqual([
      [1, 'active'],
      [2, 'retracted'],
    ]);
  });

  it('forget commits, then awaits every onForget listener in order', async () => {
    const store = createInMemoryVersionedMemoryStore();
    const seen: string[] = [];
    const events: MemoryForgetEvent[] = [];
    const session = createMemorySession({
      store,
      scope: USER,
      onForget: [
        async (event) => {
          expect(await store.get(USER, event.recordId)).toBeUndefined();
          seen.push('first');
          events.push(event);
        },
        () => {
          seen.push('second');
        },
      ],
    });
    const { records } = await session.remember({ text: 'secret' });
    const id = records[0]!.id;
    await session.revise(id, { text: 'secret 2' }, { expectedRevision: 1 });
    const result = await session.forget(id, { operationId: 'forget-1' });
    expect(result).toEqual({
      scope: USER,
      recordId: id,
      revisions: [1, 2],
      operationId: 'forget-1',
      redaction: 'complete',
    });
    expect(seen).toEqual(['first', 'second']);
    expect(events).toEqual([
      { scope: USER, recordId: id, revisions: [1, 2], operationId: 'forget-1' },
    ]);
    expect(await session.history(id)).toEqual([]);
    expect((await session.forget(id, { operationId: 'forget-1' })).redaction).toBe('none');
  });

  it('a failing listener leaves redaction failed and never undoes the forget', async () => {
    const warnings: string[] = [];
    const store = createInMemoryVersionedMemoryStore();
    const later: string[] = [];
    const session = createMemorySession({
      store,
      scope: USER,
      onForget: [
        () => {
          throw new Error('redaction store down');
        },
        () => {
          later.push('ran');
        },
      ],
      deps: {
        logger: {
          debug: () => {},
          info: () => {},
          warn: (message) => warnings.push(message),
          error: () => {},
        },
      },
    });
    const { records } = await session.remember({ text: 'secret' });
    const result = await session.forget(records[0]!.id);
    expect(result.redaction).toBe('failed');
    expect(result.revisions).toEqual([1]);
    expect(later).toEqual(['ran']);
    expect(await store.get(USER, records[0]!.id, { includeRetracted: true })).toBeUndefined();
    expect(warnings.length).toBeGreaterThan(0);
    // Without listeners nothing is redacted.
    const quiet = createMemorySession({ store, scope: USER });
    const other = await quiet.remember({ text: 'other' });
    expect((await quiet.forget(other.records[0]!.id)).redaction).toBe('none');
  });
});

describe('deuz.memory.op spans', () => {
  it('reports each operation with counts only, never content', async () => {
    const observer = createMemoryObserver();
    const store = interceptedStore();
    await seed(store, USER, { id: 'r1', text: 'likes tea' });
    const script = scriptedLLM({
      reconcile: (_prompt, existing) => ({
        memory: [{ id: existing[0]!.id, event: 'UPDATE', text: 'likes green tea' }],
      }),
    });
    const session = createMemorySession({
      store,
      scope: USER,
      llm: script.llm,
      deps: { observer },
    });
    store.beforeCommit(1, () => seed(store, USER, { id: 'x', text: 'unrelated' }));
    const { records } = await session.remember({ text: 'secret green tea' });
    await session.retract(records[0]!.id, { expectedRevision: records[0]!.revision });
    await session.forget(records[0]!.id);
    const events = observer.events() as ObserveEvent[];
    const completed = events.filter(
      (event): event is Extract<ObserveEvent, { type: 'operation.completed' }> =>
        event.type === 'operation.completed' && event.operation === 'deuz.memory.op',
    );
    expect(completed.map((event) => event.attributes?.['deuz.memory.operation'])).toEqual([
      'remember',
      'retract',
      'forget',
    ]);
    expect(completed[0]!.attributes).toMatchObject({
      'deuz.memory.record_count': 1,
      'deuz.memory.conflict_retries': 1,
    });
    expect(completed[0]!.subsystem).toBe('memory');
    expect(JSON.stringify(events)).not.toContain('secret');
  });
});
