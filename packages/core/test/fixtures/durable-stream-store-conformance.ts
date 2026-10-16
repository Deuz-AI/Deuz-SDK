import { describe, expect, it } from 'vitest';
import type { DurableStreamStateStore, StreamStateRecord } from '../../src/ui';

/**
 * The durable stream state contract (2.4, spec §3.4), shared by the memory,
 * SQLite, Postgres and Redis stores. `make` returns a fresh, empty store and
 * its clock: `now` is the store's time in epoch ms (an injected clock, or the
 * server's, estimated) and `advance` moves it forward (a manual clock, or a
 * real wait for a server clock).
 */
export interface DurableStreamStoreHarness {
  store: DurableStreamStateStore;
  now(): number;
  advance(ms: number): Promise<void>;
}

type Part = StreamStateRecord['part'];

const text = (value: string): Part => ({ type: 'text-delta', text: value });
const done: Part = { type: 'done' };
const start: Part = { type: 'start', messageId: 'm' };

/** Records `first`, `first + 1`, … carrying `parts`. */
export const records = (first: number, parts: Part[]): StreamStateRecord[] =>
  parts.map((part, index) => ({ seq: first + index, part }));

export async function readAll(
  store: DurableStreamStateStore,
  streamId: string,
  fromSeq?: number,
): Promise<StreamStateRecord[]> {
  const out: StreamStateRecord[] = [];
  for await (const record of store.read(streamId, fromSeq)) out.push(record);
  return out;
}

export function durableStreamStoreContracts(
  name: string,
  make: () => Promise<DurableStreamStoreHarness>,
  options: { timeout?: number } = {},
): void {
  describe(name, { timeout: options.timeout }, () => {
    it('is a durable StreamStateStore', async () => {
      const { store } = await make();
      expect(store.durable).toBe(true);
      for (const method of ['open', 'commit', 'append', 'read', 'lastSeq', 'delete', 'prune'])
        expect(typeof (store as unknown as Record<string, unknown>)[method]).toBe('function');
    });

    it('opens an empty stream at lastSeq -1 and continues a stored one', async () => {
      const { store } = await make();
      expect(await store.open('s', 1)).toEqual({ status: 'opened', lastSeq: -1 });
      expect(await store.lastSeq('s')).toBeUndefined();
      expect(
        await store.commit({ streamId: 's', token: 1, records: records(0, [start, text('a')]) }),
      ).toEqual({ status: 'committed', lastSeq: 1 });
      // The same producer may open again; a reconnecting one continues after seq 1.
      expect(await store.open('s', 1)).toEqual({ status: 'opened', lastSeq: 1 });
      expect(await store.lastSeq('s')).toBe(1);
      expect(await readAll(store, 's')).toEqual(records(0, [start, text('a')]));
    });

    it('commits a batch whole and refuses one that does not continue the log', async () => {
      const { store } = await make();
      await store.open('s', 1);
      expect(
        await store.commit({
          streamId: 's',
          token: 1,
          records: records(0, [text('a'), text('b')]),
        }),
      ).toEqual({ status: 'committed', lastSeq: 1 });
      // A gap and an overlap: nothing of either batch is stored.
      expect(
        await store.commit({
          streamId: 's',
          token: 1,
          records: records(3, [text('x'), text('y')]),
        }),
      ).toEqual({ status: 'conflict', lastSeq: 1 });
      expect(
        await store.commit({
          streamId: 's',
          token: 1,
          records: records(1, [text('x'), text('y')]),
        }),
      ).toEqual({ status: 'conflict', lastSeq: 1 });
      expect(await store.commit({ streamId: 's', token: 1, records: [] })).toEqual({
        status: 'committed',
        lastSeq: 1,
      });
      expect(await readAll(store, 's')).toEqual(records(0, [text('a'), text('b')]));
      // A first batch must start at seq 0.
      expect(
        await store.commit({ streamId: 'fresh', token: 1, records: records(1, [text('a')]) }),
      ).toEqual({ status: 'conflict', lastSeq: -1 });
      expect(await readAll(store, 'fresh')).toEqual([]);
    });

    it('fences a stale producer: a lower token is refused at open and at commit', async () => {
      const { store } = await make();
      await store.open('s', 1);
      await store.commit({ streamId: 's', token: 1, records: records(0, [text('a')]) });
      // A newer producer takes over and continues after seq 0.
      expect(await store.open('s', 2)).toEqual({ status: 'opened', lastSeq: 0 });
      expect(
        await store.commit({ streamId: 's', token: 1, records: records(1, [text('stale')]) }),
      ).toEqual({ status: 'fenced', token: 2 });
      expect(await store.open('s', 1)).toEqual({ status: 'fenced', token: 2 });
      expect(await readAll(store, 's')).toEqual(records(0, [text('a')]));
      expect(
        await store.commit({ streamId: 's', token: 2, records: records(1, [text('b')]) }),
      ).toEqual({ status: 'committed', lastSeq: 1 });
    });

    it('raises the fence with a commit that carries a higher token than any opener', async () => {
      const { store } = await make();
      await store.open('s', 1);
      expect(
        await store.commit({ streamId: 's', token: 3, records: records(0, [text('a')]) }),
      ).toEqual({ status: 'committed', lastSeq: 0 });
      expect(await store.open('s', 2)).toEqual({ status: 'fenced', token: 3 });
      expect(
        await store.commit({ streamId: 's', token: 1, records: records(1, [text('b')]) }),
      ).toEqual({ status: 'fenced', token: 3 });
    });

    it('reads what follows a seq, in order', async () => {
      const { store } = await make();
      const log = records(0, [start, text('a'), text('b'), text('c'), done]);
      await store.commit({ streamId: 's', token: 1, records: log });
      expect(await readAll(store, 's')).toEqual(log);
      expect(await readAll(store, 's', -1)).toEqual(log);
      expect(await readAll(store, 's', 2)).toEqual(log.slice(3));
      expect(await readAll(store, 's', 4)).toEqual([]);
      expect(await readAll(store, 'missing')).toEqual([]);
    });

    it('reads a long log in order, from any seq', async () => {
      const { store } = await make();
      for (let batch = 0; batch < 4; batch++)
        await store.commit({
          streamId: 's',
          token: 1,
          records: records(
            batch * 300,
            Array.from({ length: 300 }, (_, index) => text(`t${batch * 300 + index}`)),
          ),
        });
      const all = await readAll(store, 's');
      expect(all.map((record) => record.seq)).toEqual(Array.from({ length: 1200 }, (_, i) => i));
      expect(all[1199]).toEqual({ seq: 1199, part: text('t1199') });
      const tail = await readAll(store, 's', 599);
      expect(tail).toHaveLength(600);
      expect(tail[0]!.seq).toBe(600);
    });

    it('keeps every part byte for byte', async () => {
      const { store } = await make();
      const parts = [
        { type: 'data-chart', id: 'c1', payload: { z: 1, a: [3, { y: null, b: 'é 🙂 "q"' }] } },
        { type: 'tool-call', toolCallId: 't', toolName: 'x', input: { b: 2, a: 1 } },
        { type: 'text-delta', text: '\n line\\' },
        done,
      ] as Part[];
      await store.commit({ streamId: 's', token: 1, records: records(0, parts) });
      const back = await readAll(store, 's');
      expect(back.map((record) => JSON.stringify(record.part))).toEqual(
        parts.map((part) => JSON.stringify(part)),
      );
    });

    it('keeps streams apart, ids with separators included', async () => {
      const { store } = await make();
      const ids = ['a', 'a:b', 'a%3Ab', 'a b', '{tag}', 'ü/x', 'a:b:'];
      for (const [index, id] of ids.entries())
        await store.commit({ streamId: id, token: index + 1, records: records(0, [text(id)]) });
      for (const id of ids) expect(await readAll(store, id)).toEqual(records(0, [text(id)]));
      // A fence is per stream.
      expect(await store.open('a', 0)).toEqual({ status: 'fenced', token: 1 });
      expect(await store.open('a:b:', 6)).toEqual({ status: 'fenced', token: 7 });
      expect(await store.open('a:b', 2)).toEqual({ status: 'opened', lastSeq: 0 });
      await store.delete('a');
      expect(await readAll(store, 'a:b')).toEqual(records(0, [text('a:b')]));
    });

    it('answers the legacy methods: append replaces a seq and is not fenced', async () => {
      const { store } = await make();
      await store.append('s', 0, start);
      await store.append('s', 1, text('a'));
      await store.append('s', 1, text('b'));
      expect(await readAll(store, 's')).toEqual(records(0, [start, text('b')]));
      expect(await store.lastSeq('s')).toBe(1);
      await store.open('s', 9);
      await store.append('s', 2, done);
      expect(await store.lastSeq('s')).toBe(2);
      expect(await readAll(store, 's', 1)).toEqual(records(2, [done]));
      // Continued after an append: the next batch starts past the highest seq.
      expect(
        await store.commit({ streamId: 's', token: 9, records: records(3, [text('c')]) }),
      ).toEqual({ status: 'committed', lastSeq: 3 });
      expect(await store.lastSeq('missing')).toBeUndefined();
    });

    it('deletes a stream with its records and its fence', async () => {
      const { store } = await make();
      await store.open('s', 4);
      await store.commit({ streamId: 's', token: 4, records: records(0, [text('a'), done]) });
      await store.delete('s');
      expect(await store.lastSeq('s')).toBeUndefined();
      expect(await readAll(store, 's')).toEqual([]);
      expect(await store.open('s', 1)).toEqual({ status: 'opened', lastSeq: -1 });
      await expect(store.delete('never-written')).resolves.toBeUndefined();
    });

    it('prunes terminal streams older than the cutoff, never a live one', async () => {
      const { store, now } = await make();
      await store.commit({ streamId: 'done', token: 1, records: records(0, [start, done]) });
      await store.commit({ streamId: 'live', token: 1, records: records(0, [start, text('a')]) });
      await store.commit({ streamId: 'continued', token: 1, records: records(0, [start, done]) });
      await store.commit({ streamId: 'continued', token: 1, records: records(2, [text('b')]) });
      await store.append('legacy', 0, start);
      await store.append('legacy', 1, done);
      await store.open('opened-only', 1);
      expect(await store.prune({ terminalBefore: now() - 60_000 })).toBe(0);
      expect(await store.prune({ terminalBefore: now() + 60_000 })).toBe(2);
      expect(await readAll(store, 'done')).toEqual([]);
      expect(await store.lastSeq('legacy')).toBeUndefined();
      expect(await readAll(store, 'live')).toHaveLength(2);
      expect(await readAll(store, 'continued')).toHaveLength(3);
      expect(await store.open('opened-only', 1)).toEqual({ status: 'opened', lastSeq: -1 });
      expect(await store.prune({ terminalBefore: now() + 60_000 })).toBe(0);
    });

    it('counts a later open as activity, so a reopened stream outlives the cutoff', async () => {
      const { store, now, advance } = await make();
      await store.commit({ streamId: 'old', token: 1, records: records(0, [done]) });
      await store.commit({ streamId: 'reopened', token: 1, records: records(0, [done]) });
      await advance(600);
      await store.open('reopened', 2);
      expect(await store.prune({ terminalBefore: now() - 300 })).toBe(1);
      expect(await store.lastSeq('old')).toBeUndefined();
      expect(await store.lastSeq('reopened')).toBe(0);
    });

    it('serializes concurrent commits: one continues the log, the other conflicts', async () => {
      const { store } = await make();
      await store.open('s', 1);
      const results = await Promise.all([
        store.commit({ streamId: 's', token: 1, records: records(0, [text('a'), text('b')]) }),
        store.commit({ streamId: 's', token: 1, records: records(0, [text('c'), text('d')]) }),
      ]);
      expect(results.map((result) => result.status).sort()).toEqual(['committed', 'conflict']);
      const stored = await readAll(store, 's');
      expect(stored).toHaveLength(2);
      const winner = results.findIndex((result) => result.status === 'committed');
      expect(stored).toEqual(
        records(0, winner === 0 ? [text('a'), text('b')] : [text('c'), text('d')]),
      );
    });

    it('never stores a stale commit that races a newer opener', async () => {
      const { store } = await make();
      await store.open('s', 1);
      const [opened, committed] = await Promise.all([
        store.open('s', 2),
        store.commit({ streamId: 's', token: 1, records: records(0, [text('stale?')]) }),
      ]);
      expect(opened.status).toBe('opened');
      const stored = await readAll(store, 's');
      if (committed.status === 'committed') {
        // The commit ran first: the opener saw it.
        expect(stored).toHaveLength(1);
        expect(opened).toEqual({ status: 'opened', lastSeq: 0 });
      } else {
        expect(committed).toEqual({ status: 'fenced', token: 2 });
        expect(stored).toEqual([]);
      }
      expect(
        await store.commit({ streamId: 's', token: 1, records: records(1, [text('x')]) }),
      ).toMatchObject({ status: 'fenced', token: 2 });
    });

    it('refuses malformed input', async () => {
      const { store } = await make();
      await expect(store.open('', 1)).rejects.toThrow(TypeError);
      for (const token of [-1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 2])
        await expect(store.open('s', token)).rejects.toThrow(TypeError);
      await expect(
        store.commit({
          streamId: 's',
          token: 1,
          records: [records(0, [text('a')])[0]!, records(2, [text('b')])[0]!],
        }),
      ).rejects.toThrow(TypeError);
      await expect(
        store.commit({ streamId: 's', token: 1, records: [{ seq: 0.5, part: text('a') }] }),
      ).rejects.toThrow(TypeError);
      await expect(
        store.commit({ streamId: 's', token: 1, records: [{ seq: 0, part: null as never }] }),
      ).rejects.toThrow(TypeError);
      await expect(store.append('s', -1, text('a'))).rejects.toThrow(TypeError);
      await expect(store.prune({ terminalBefore: Number.NaN })).rejects.toThrow(TypeError);
      expect(await readAll(store, 's')).toEqual([]);
    });
  });
}
