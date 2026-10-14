/**
 * The in-memory durable stream state store (2.4, spec §3.4): the shared
 * contract, plus what only the memory store shows — its clock seam and that
 * a stored record is a copy, never the caller's object.
 */
import { describe, expect, it } from 'vitest';
import { createInMemoryDurableStreamStateStore } from '../src/stream-durable';
import {
  durableStreamStoreContracts,
  readAll,
  records,
} from './fixtures/durable-stream-store-conformance';
import { manualClock } from './fixtures/manual-clock';

durableStreamStoreContracts('createInMemoryDurableStreamStateStore', async () => {
  const time = manualClock(1_700_000_000_000);
  return {
    store: createInMemoryDurableStreamStateStore({ deps: { clock: time.clock } }),
    now: () => time.clock.now(),
    advance: (ms) => time.advance(ms),
  };
});

describe('createInMemoryDurableStreamStateStore', () => {
  it('stores a copy: mutating a committed or read part changes nothing', async () => {
    const store = createInMemoryDurableStreamStateStore();
    const part = { type: 'data-x', payload: { n: 1 } } as const;
    const batch = records(0, [part as never]);
    await store.commit({ streamId: 's', token: 1, records: batch });
    (batch[0]!.part as unknown as { payload: { n: number } }).payload.n = 2;
    const [first] = await readAll(store, 's');
    expect(first!.part).toEqual({ type: 'data-x', payload: { n: 1 } });
    (first!.part as unknown as { payload: { n: number } }).payload.n = 3;
    expect((await readAll(store, 's'))[0]!.part).toEqual({ type: 'data-x', payload: { n: 1 } });
  });

  it('prunes on its injected clock', async () => {
    const time = manualClock(5_000);
    const store = createInMemoryDurableStreamStateStore({ deps: { clock: time.clock } });
    await store.commit({ streamId: 's', token: 1, records: records(0, [{ type: 'done' }]) });
    expect(await store.prune({ terminalBefore: 5_000 })).toBe(0);
    await time.advance(1);
    expect(await store.prune({ terminalBefore: 5_001 })).toBe(1);
  });
});
