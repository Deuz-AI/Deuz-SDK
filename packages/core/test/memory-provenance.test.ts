import { describe, expect, it } from 'vitest';
import { createInMemoryMemoryStore, remember, type MemorySeams } from '../src/memory';

let id = 0;
function seams(llm: MemorySeams['llm'] = async () => '{"facts":[]}'): MemorySeams {
  return {
    store: createInMemoryMemoryStore(),
    llm,
    clock: { now: () => 1_000, setTimeout: (fn: () => void) => (fn(), () => {}) },
    generateId: () => `m${id++}`,
    hashFn: async (text) => `h:${text}`,
  };
}

describe('remember(): base metadata (2.3, provenance of a write)', () => {
  it('stamps every raw record it writes', async () => {
    const s = seams();
    const metadata = { deuz: { runId: 'r1', operationId: 'op-1' } };
    await remember([{ role: 'user', content: 'my name is Ada' }], { userId: 'u' }, s, {
      infer: false,
      metadata,
    });
    const [record] = await s.store.list({ userId: 'u' });
    expect(record?.metadata).toEqual(metadata);
  });

  it('stamps every inferred record under its extraction links', async () => {
    const s = seams(async ({ system }) =>
      system.includes('extract')
        ? '{"facts":[{"text":"is vegetarian","links":["diet"]}]}'
        : '{"memory":[{"event":"ADD","text":"is vegetarian"}]}',
    );
    await remember([{ role: 'user', content: 'I went vegetarian' }], { userId: 'u' }, s, {
      links: true,
      metadata: { deuz: { operationId: 'op-2' } },
    });
    const [record] = await s.store.list({ userId: 'u' });
    expect(record?.metadata).toEqual({ deuz: { operationId: 'op-2' }, links: ['diet'] });
  });
});
