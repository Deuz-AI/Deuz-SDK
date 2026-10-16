/**
 * MemorySession.reembed (2.4, spec §2.2): a resumable job that prepares the
 * vectors of a new embedding generation aside (batches of 64, one at a time
 * by default) while search keeps the old generation, embeds records that
 * changed meanwhile again, never puts an old text's vector on a new revision,
 * and switches the generation atomically once every current record is ready.
 */
import { describe, expect, it } from 'vitest';
import { EmbeddingMismatchError } from '../src/errors';
import { digestJson, sha256Digest } from '../src/internal/digest';
import { createMemoryObserver } from '../src/observe';
import { createInMemoryVersionedMemoryStore, createMemorySession } from '../src/memory/versioned';
import type { VersionedMemoryStore } from '../src/memory/versioned';
import { createSqliteVersionedMemoryStore } from '../src/node/vmem-sqlite';
import type { Embedder, MemoryScope } from '../src/memory';
import type { ObserveEvent } from '../src/index';
import { keywordEmbedder } from './fixtures/versioned-memory-session';

const USER: MemoryScope = { userId: 'u1' };

/** An embedder of the new generation that records batches and how many ran at once. */
function trackingEmbedder(
  model = 'new-1',
  dims = 2,
  hooks: { onBatch?: (texts: string[], call: number) => void | Promise<void> } = {},
) {
  const batches: string[][] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const embedder: Embedder = {
    async embed(texts) {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      try {
        batches.push([...texts]);
        await new Promise((resolve) => setTimeout(resolve, 1));
        await hooks.onBatch?.(texts, batches.length);
        return {
          vectors: texts.map((text) => [text.length, dims === 2 ? 1 : 0].slice(0, dims)),
          model,
        };
      } finally {
        inFlight--;
      }
    },
  };
  return {
    embedder,
    batches,
    get maxInFlight() {
      return maxInFlight;
    },
  };
}

async function fill(store: VersionedMemoryStore, count: number, vectors = true) {
  const session = createMemorySession({
    store,
    scope: USER,
    ...(vectors ? { embedder: keywordEmbedder() } : {}),
  });
  const texts = Array.from(
    { length: count },
    (_, index) => `tea note ${String(index).padStart(3, '0')}`,
  );
  for (const text of texts) await session.remember({ text, supersede: 'add' });
  return session;
}

describe('reembed', () => {
  it('fills a new generation in batches of 64, one at a time, then switches', async () => {
    const store = createInMemoryVersionedMemoryStore();
    const session = await fill(store, 130);
    const next = trackingEmbedder();
    const result = await session.reembed({ embedder: next.embedder, modelId: 'new-1', dims: 2 });
    expect(result).toEqual({ generation: 2, embedded: 130, skipped: 0, activated: true });
    expect(next.batches.map((batch) => batch.length)).toEqual([64, 64, 2]);
    expect(next.maxInFlight).toBe(1);
    expect(await store.embeddings.active()).toMatchObject({
      generation: 2,
      modelId: 'new-1',
      dims: 2,
    });
    // The session now embeds with the new generation's embedder.
    const hits = await session.recall({ text: 'tea note 007', topK: 200 });
    expect(hits.find((hit) => hit.record.text === 'tea note 007')!.record).toMatchObject({
      text: 'tea note 007',
      embedding: { generation: 2, modelId: 'new-1' },
    });
    const written = await session.remember({ text: 'fresh fact', supersede: 'add' });
    expect(written.records[0]!.embedding).toMatchObject({ generation: 2, modelId: 'new-1' });
  });

  it('keeps search on the old generation until the switch', async () => {
    const store = createInMemoryVersionedMemoryStore();
    const session = await fill(store, 5);
    const during: string[] = [];
    const next = trackingEmbedder('new-1', 2, {
      onBatch: async () => {
        const active = await store.embeddings.active();
        during.push(active!.modelId);
        // The old session embedder still matches the active generation.
        const hits = await session.recall({ text: 'tea' });
        expect(hits.length).toBeGreaterThan(0);
      },
    });
    await session.reembed({ embedder: next.embedder, modelId: 'new-1', dims: 2, batchSize: 2 });
    expect(during).toEqual(['kw-1', 'kw-1', 'kw-1']);
  });

  it('resumes an interrupted job without embedding finished batches again', async () => {
    const store = createInMemoryVersionedMemoryStore();
    const session = await fill(store, 10);
    const failing = trackingEmbedder('new-1', 2, {
      onBatch: (_texts, call) => {
        if (call === 2) throw new Error('rate limited');
      },
    });
    await expect(
      session.reembed({ embedder: failing.embedder, modelId: 'new-1', dims: 2, batchSize: 4 }),
    ).rejects.toThrow('rate limited');
    expect((await store.embeddings.active())!.modelId).toBe('kw-1');
    const resumed = trackingEmbedder();
    const result = await session.reembed({
      embedder: resumed.embedder,
      modelId: 'new-1',
      dims: 2,
      batchSize: 4,
    });
    expect(result).toMatchObject({ generation: 2, embedded: 6, activated: true });
    expect(resumed.batches.flat()).toHaveLength(6);
    for (const text of failing.batches[0]!) expect(resumed.batches.flat()).not.toContain(text);
  });

  it('stops on an aborted signal and can be continued', async () => {
    const store = createInMemoryVersionedMemoryStore();
    const session = await fill(store, 6);
    const controller = new AbortController();
    const first = trackingEmbedder('new-1', 2, {
      onBatch: () => controller.abort(new Error('shutdown')),
    });
    await expect(
      session.reembed({
        embedder: first.embedder,
        modelId: 'new-1',
        dims: 2,
        batchSize: 2,
        signal: controller.signal,
      }),
    ).rejects.toThrow('shutdown');
    expect(first.batches).toHaveLength(1);
    const result = await session.reembed({
      embedder: trackingEmbedder().embedder,
      modelId: 'new-1',
      dims: 2,
      batchSize: 2,
    });
    expect(result).toMatchObject({ embedded: 4, activated: true });
  });

  it('embeds a record that changed meanwhile again, never with its old text', async () => {
    const store = createInMemoryVersionedMemoryStore();
    const session = await fill(store, 3);
    const target = (await session.recall({ text: 'tea note 000', topK: 10 })).find(
      (hit) => hit.record.text === 'tea note 000',
    );
    const next = trackingEmbedder('new-1', 2, {
      onBatch: async (_texts, call) => {
        if (call !== 1) return;
        // A writer revises the record while its old text is being embedded.
        await session.revise(
          target!.record.id,
          { text: 'tea note zero, revised' },
          { expectedRevision: 1 },
        );
      },
    });
    const result = await session.reembed({
      embedder: next.embedder,
      modelId: 'new-1',
      dims: 2,
      batchSize: 10,
    });
    expect(result).toMatchObject({ embedded: 3, skipped: 1, activated: true });
    expect(next.batches.at(-1)).toEqual(['tea note zero, revised']);
    const current = await store.get(USER, target!.record.id);
    expect(current!.embedding).toEqual({
      generation: 2,
      modelId: 'new-1',
      dims: 2,
      revision: 2,
      textDigest: await sha256Digest('tea note zero, revised'),
    });
  });

  it('includes records written without a vector, in every scope of the store', async () => {
    const store = createInMemoryVersionedMemoryStore();
    const session = await fill(store, 2, false);
    const other = createMemorySession({ store, scope: { userId: 'u2' } });
    await other.remember({ text: 'other scope fact' });
    const result = await session.reembed({
      embedder: trackingEmbedder().embedder,
      modelId: 'new-1',
      dims: 2,
    });
    expect(result).toEqual({ generation: 1, embedded: 3, skipped: 0, activated: true });
  });

  it('runs batches in parallel only when asked', async () => {
    const store = createInMemoryVersionedMemoryStore();
    const session = await fill(store, 12);
    const next = trackingEmbedder();
    await session.reembed({
      embedder: next.embedder,
      modelId: 'new-1',
      dims: 2,
      batchSize: 3,
      concurrency: 2,
    });
    expect(next.maxInFlight).toBe(2);
    expect(next.batches.flat()).toHaveLength(12);
  });

  for (const [name, make] of [
    ['in-memory', () => createInMemoryVersionedMemoryStore()],
    ['SQLite', () => createSqliteVersionedMemoryStore({ path: ':memory:' })],
  ] as Array<[string, () => VersionedMemoryStore]>)
    it(`loses quietly when another model replaces its pending generation (${name})`, async () => {
      const store = make();
      try {
        const session = await fill(store, 6);
        // Another job begins a generation of another model mid-way: one is
        // prepared at a time, so this job's generation is retired under it.
        let replaced: number | undefined;
        const racing = trackingEmbedder('new-1', 2, {
          onBatch: async (_texts, call) => {
            if (call === 1)
              replaced = (await store.embeddings.begin({ modelId: 'new-2', dims: 3 })).generation;
          },
        });
        const result = await session.reembed({
          embedder: racing.embedder,
          modelId: 'new-1',
          dims: 2,
          batchSize: 4,
        });
        expect(result).toMatchObject({ embedded: 0, skipped: 4, activated: false });
        // The retired generation listed nothing more after the first batch.
        expect(racing.batches.map((batch) => batch.length)).toEqual([4]);
        expect(await store.embeddings.activate(result.generation)).toBe(false);
        expect((await store.embeddings.active())!.modelId).toBe('kw-1');
        expect(
          (await store.embeddings.pending(replaced!, { limit: 10 })).map((item) => item.text),
        ).toHaveLength(6);
      } finally {
        await store.close?.();
      }
    });

  it('refuses vectors of another model or size than the generation it fills', async () => {
    const store = createInMemoryVersionedMemoryStore();
    const session = await fill(store, 2);
    for (const embedder of [trackingEmbedder('other', 2), trackingEmbedder('new-1', 1)]) {
      await expect(
        session.reembed({ embedder: embedder.embedder, modelId: 'new-1', dims: 2 }),
      ).rejects.toBeInstanceOf(EmbeddingMismatchError);
    }
    expect((await store.embeddings.active())!.modelId).toBe('kw-1');
  });

  it('reports a deuz.memory.op reembed span with the generation', async () => {
    const observer = createMemoryObserver();
    const store = createInMemoryVersionedMemoryStore();
    await fill(store, 2);
    const session = createMemorySession({ store, scope: USER, deps: { observer } });
    await session.reembed({ embedder: trackingEmbedder().embedder, modelId: 'new-1', dims: 2 });
    const completed = (observer.events() as ObserveEvent[]).find(
      (event): event is Extract<ObserveEvent, { type: 'operation.completed' }> =>
        event.type === 'operation.completed' && event.operation === 'deuz.memory.op',
    );
    expect(completed!.attributes).toMatchObject({
      'deuz.memory.operation': 'reembed',
      'deuz.memory.embedding_generation': 2,
      'deuz.memory.record_count': 2,
    });
    expect(await digestJson(completed!.attributes)).toMatch(/^sha256:/);
  });
});
