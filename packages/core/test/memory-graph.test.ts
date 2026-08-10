/**
 * memory-graph.test.ts — the 2.0 graph half of `./memory`: `extractLinks` and
 * `recall({ expandLinks })`.
 *
 * The links were always WRITTEN (markdown `[[wikilinks]]`, `metadata.links`)
 * and never read; these lock the traversal's contract — appended-after-primaries
 * ordering, `0.5 ** hop` decay, the id-then-text resolution order, the cycle /
 * fan-out / total caps, and the best-effort failure mode.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  extractLinks,
  recall,
  createInMemoryMemoryStore,
  type MemoryHit,
  type MemoryRecord,
  type MemorySeams,
  type MemoryStore,
} from '../src/memory';

const NOW = 1_000_000;
const fixedClock = { now: () => NOW, setTimeout: (fn: () => void) => (fn(), () => {}) };
const SCOPE = { userId: 'g1' };

function rec(id: string, text: string, over: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id,
    text,
    hash: `h:${id}`,
    kind: 'semantic',
    scope: SCOPE,
    createdAt: 1,
    updatedAt: 1,
    ...over,
  };
}

/**
 * The reference store with ONE realistic tweak: a search returns only records
 * it actually matched. `createInMemoryMemoryStore` pads the page with score-0
 * rows, which would make every record a "primary" and hide the expansion.
 */
async function graphStore(records: MemoryRecord[]): Promise<MemoryStore> {
  const base = createInMemoryMemoryStore();
  await base.upsert(records);
  return {
    ...base,
    async search(query) {
      return (await base.search(query)).filter((h) => h.score > 0);
    },
  };
}

function seams(store: MemoryStore, over: Partial<MemorySeams> = {}): MemorySeams {
  return {
    store,
    llm: async () => '',
    clock: fixedClock,
    generateId: () => 'gen',
    hashFn: async (t) => `h:${t}`,
    ...over,
  };
}

const ids = (hits: MemoryHit[]): string[] => hits.map((h) => h.record.id);

describe('extractLinks()', () => {
  it('unions metadata.links with the body [[wikilinks]], deduped', () => {
    expect(
      extractLinks(
        rec('a', 'Ships [[compiler]] and [[linker]]', { metadata: { links: ['project-x'] } }),
      ),
    ).toEqual(['project-x', 'compiler', 'linker']);
  });

  it('normalizes bracketed metadata links so both spellings are one node', () => {
    expect(
      extractLinks(
        rec('a', 'Ships [[compiler]]', { metadata: { links: ['[[compiler]]', ' spaced '] } }),
      ),
    ).toEqual(['compiler', 'spaced']);
  });

  it('ignores non-string entries, a non-array links field, and records with none', () => {
    expect(extractLinks(rec('a', 'no links here'))).toEqual([]);
    expect(extractLinks(rec('a', 'x', { metadata: { links: 'compiler' } }))).toEqual([]);
    expect(extractLinks(rec('a', 'x', { metadata: { links: [42, null, 'ok', ''] } }))).toEqual([
      'ok',
    ]);
    expect(extractLinks(rec('a', 'empty [[]] and [[good]]'))).toEqual(['good']);
  });
});

describe('recall({ expandLinks }) — traversal', () => {
  it('is OFF by default: no link is resolved without the option', async () => {
    const store = await graphStore([
      rec('rec-a', 'Alice ships the compiler', { metadata: { links: ['rec-b'] } }),
      rec('rec-b', 'Bob reviews everything'),
    ]);
    const get = vi.spyOn(store, 'get');
    const hits = await recall({ scope: SCOPE, text: 'Alice' }, seams(store));
    expect(ids(hits)).toEqual(['rec-a']);
    expect(get).not.toHaveBeenCalled();
  });

  it('follows an ID-shaped link through store.get and appends it at half the score', async () => {
    const store = await graphStore([
      rec('rec-a', 'Alice ships the compiler', { metadata: { links: ['rec-b'] } }),
      rec('rec-b', 'Bob reviews everything'),
    ]);
    const hits = await recall({ scope: SCOPE, text: 'Alice' }, seams(store), { expandLinks: 1 });
    expect(ids(hits)).toEqual(['rec-a', 'rec-b']);
    expect(hits[0]!.score).toBe(1);
    expect(hits[1]!.score).toBe(0.5);
  });

  it('falls back to a text search when the link is not an id', async () => {
    const store = await graphStore([
      rec('rec-d', 'Ops runbook', { metadata: { links: ['Zephyr protocol'] } }),
      rec('rec-z', 'Zephyr protocol was retired in 2025'),
    ]);
    const get = vi.spyOn(store, 'get');
    const search = vi.spyOn(store, 'search');

    const hits = await recall({ scope: SCOPE, text: 'runbook' }, seams(store), { expandLinks: 1 });
    expect(ids(hits)).toEqual(['rec-d', 'rec-z']);
    // Id lookup FIRST, then the title search — never the other way round.
    expect(get).toHaveBeenCalledWith('Zephyr protocol', SCOPE);
    expect(search).toHaveBeenLastCalledWith({ scope: SCOPE, text: 'Zephyr protocol', topK: 1 });
  });

  it('ignores a text link that matches nothing (score 0 is not a hit)', async () => {
    const store = await graphStore([
      rec('rec-d', 'Ops runbook', { metadata: { links: ['ghost node'] } }),
      rec('rec-z', 'unrelated'),
    ]);
    const hits = await recall({ scope: SCOPE, text: 'runbook' }, seams(store), { expandLinks: 1 });
    expect(ids(hits)).toEqual(['rec-d']);
  });

  it('walks 2 hops and decays each by 0.5 ** hop off its parent', async () => {
    const store = await graphStore([
      rec('rec-a', 'Alice ships the compiler', { metadata: { links: ['rec-b'] } }),
      rec('rec-b', 'Bob reviews everything', { metadata: { links: ['rec-c'] } }),
      rec('rec-c', 'Carol runs the release'),
    ]);
    const one = await recall({ scope: SCOPE, text: 'Alice' }, seams(store), { expandLinks: 1 });
    expect(ids(one)).toEqual(['rec-a', 'rec-b']); // hop budget respected

    const two = await recall({ scope: SCOPE, text: 'Alice' }, seams(store), { expandLinks: 2 });
    expect(ids(two)).toEqual(['rec-a', 'rec-b', 'rec-c']);
    expect(two.map((h) => h.score)).toEqual([1, 0.5, 0.125]); // 1 → 1·0.5 → 0.5·0.25
  });

  it('terminates on an A↔B cycle and never revisits a primary', async () => {
    const store = await graphStore([
      rec('rec-a', 'Alice ships the compiler', { metadata: { links: ['rec-b'] } }),
      rec('rec-b', 'Bob reviews everything', { metadata: { links: ['rec-a'] } }),
    ]);
    const hits = await recall({ scope: SCOPE, text: 'Alice' }, seams(store), { expandLinks: 5 });
    expect(ids(hits)).toEqual(['rec-a', 'rec-b']);
  });

  it('does not re-add a link target that is already a primary hit', async () => {
    const store = await graphStore([
      rec('rec-a', 'shared topic: Alice', { metadata: { links: ['rec-b'] } }),
      rec('rec-b', 'shared topic: Bob'),
    ]);
    const hits = await recall({ scope: SCOPE, text: 'shared topic' }, seams(store), {
      expandLinks: 2,
    });
    expect(ids(hits)).toEqual(['rec-a', 'rec-b']);
    expect(hits[1]!.score).toBe(1); // still the PRIMARY score, not a decayed copy
  });

  it('caps the total expansion at 2 × topK', async () => {
    const store = await graphStore([
      rec('hub', 'Alice the hub', {
        metadata: { links: ['n1', 'n2', 'n3', 'n4', 'n5'] },
      }),
      ...['n1', 'n2', 'n3', 'n4', 'n5'].map((id) => rec(id, `node ${id}`)),
    ]);
    const hits = await recall({ scope: SCOPE, text: 'Alice', topK: 1 }, seams(store), {
      expandLinks: 1,
    });
    expect(ids(hits)).toEqual(['hub', 'n1', 'n2']); // 1 primary + 2×1 linked
  });

  it('caps the fan-out at 8 targets per hop', async () => {
    const many = Array.from({ length: 12 }, (_, i) => `n${i}`);
    const store = await graphStore([
      rec('hub', 'Alice the hub', { metadata: { links: many } }),
      ...many.map((id) => rec(id, `node ${id}`)),
    ]);
    const hits = await recall({ scope: SCOPE, text: 'Alice', topK: 20 }, seams(store), {
      expandLinks: 1,
    });
    expect(hits).toHaveLength(1 + 8);
    expect(ids(hits).slice(1)).toEqual(many.slice(0, 8));
  });

  it('skips linked records that are expired or soft-invalidated', async () => {
    const store = await graphStore([
      rec('rec-p', 'Alice the anchor', { metadata: { links: ['rec-exp', 'rec-inv', 'rec-ok'] } }),
      rec('rec-exp', 'stale note', { expiresAt: 5 }),
      rec('rec-inv', 'superseded note', { invalidAt: NOW - 1 }),
      rec('rec-ok', 'live note'),
    ]);
    const hits = await recall({ scope: SCOPE, text: 'Alice' }, seams(store), { expandLinks: 1 });
    expect(ids(hits)).toEqual(['rec-p', 'rec-ok']);
  });

  it('keeps linked hits AFTER every primary even when they outscore one', async () => {
    const a = rec('rec-a', 'strong primary', { metadata: { links: ['rec-x'] } });
    const b = rec('rec-b', 'weak primary');
    const x = rec('rec-x', 'linked neighbour');
    const store: MemoryStore = {
      ...(await graphStore([a, b, x])),
      async search() {
        return [
          { record: a, score: 1 },
          { record: b, score: 0.2 },
        ];
      },
    };
    const hits = await recall({ scope: SCOPE, text: 'anything' }, seams(store), { expandLinks: 1 });
    // rec-x scores 0.5 — above rec-b — and still lands last.
    expect(ids(hits)).toEqual(['rec-a', 'rec-b', 'rec-x']);
    expect(hits.map((h) => h.score)).toEqual([1, 0.2, 0.5]);
  });

  it('is best-effort: a store that throws mid-walk logs and yields the primaries', async () => {
    const warn = vi.fn();
    const base = await graphStore([
      rec('rec-a', 'Alice ships the compiler', { metadata: { links: ['rec-b'] } }),
      rec('rec-b', 'Bob reviews everything'),
    ]);
    const store: MemoryStore = {
      ...base,
      get: () => {
        throw new Error('store down');
      },
    };
    const hits = await recall({ scope: SCOPE, text: 'Alice' }, seams(store, { logger: { warn } }), {
      expandLinks: 2,
    });
    expect(ids(hits)).toEqual(['rec-a']);
    expect(warn).toHaveBeenCalledWith('memory link expansion failed', expect.anything());
  });
});
