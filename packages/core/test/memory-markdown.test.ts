import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMarkdownMemoryStore } from '../src/memory-markdown';
import type { MemoryRecord } from '../src/memory';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'deuz-mem-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function rec(over: Partial<MemoryRecord> & { id: string; text: string }): MemoryRecord {
  return {
    hash: `h:${over.text}`,
    kind: 'semantic',
    scope: { userId: 'u1' },
    createdAt: 1000,
    updatedAt: 1000,
    ...over,
  };
}

describe('createMarkdownMemoryStore — Obsidian-style backend', () => {
  it('writes one human-readable .md file per record (frontmatter + body)', async () => {
    const store = createMarkdownMemoryStore({ dir });
    await store.upsert([
      rec({
        id: 'a1',
        text: 'The user is vegetarian.',
        metadata: { tags: ['diet'], links: ['[[food]]'] },
      }),
    ]);
    const files = (await readdir(dir)).filter((f) => f.endsWith('.md'));
    expect(files).toEqual(['a1.md']);
    const raw = await readFile(join(dir, 'a1.md'), 'utf-8');
    expect(raw).toMatch(/^---\n/);
    expect(raw).toContain('id: "a1"');
    expect(raw).toContain('kind: "semantic"');
    expect(raw).toContain('userId: "u1"');
    expect(raw).toContain('tags: ["diet"]');
    expect(raw).toContain('The user is vegetarian.'); // body stays readable
  });

  it('round-trips a record through get()', async () => {
    const store = createMarkdownMemoryStore({ dir });
    await store.upsert([rec({ id: 'a1', text: 'hi', importance: 0.5, metadata: { tags: ['x'] } })]);
    const got = await store.get('a1');
    expect(got).toMatchObject({
      id: 'a1',
      text: 'hi',
      kind: 'semantic',
      scope: { userId: 'u1' },
      importance: 0.5,
      metadata: { tags: ['x'] },
    });
  });

  it('get() honors scope filtering', async () => {
    const store = createMarkdownMemoryStore({ dir });
    await store.upsert([rec({ id: 'a1', text: 'hi', scope: { userId: 'u1' } })]);
    expect(await store.get('a1', { userId: 'u2' })).toBeNull();
    expect(await store.get('a1', { userId: 'u1' })).not.toBeNull();
  });

  it('grep search() ranks substring matches, scoped', async () => {
    const store = createMarkdownMemoryStore({ dir, vectors: false });
    await store.upsert([
      rec({ id: 'a1', text: 'likes hiking' }),
      rec({ id: 'a2', text: 'likes cooking' }),
      rec({ id: 'b1', text: 'likes hiking', scope: { userId: 'other' } }),
    ]);
    const hits = await store.search({ scope: { userId: 'u1' }, text: 'hiking' });
    expect(hits.map((h) => h.record.id)).toEqual(['a1']); // a2 no match, b1 wrong scope
  });

  it('HYBRID: cosine search when records carry embeddings (sidecar)', async () => {
    const store = createMarkdownMemoryStore({ dir });
    await store.upsert([
      rec({ id: 'cat', text: 'about cats', embedding: [1, 0] }),
      rec({ id: 'dog', text: 'about dogs', embedding: [0, 1] }),
    ]);
    // sidecar exists and keeps .md clean (no embedding in frontmatter)
    const md = await readFile(join(dir, 'cat.md'), 'utf-8');
    expect(md).not.toContain('embedding');
    const files = await readdir(dir);
    expect(files).toContain('.deuz-vectors.json');

    const hits = await store.search({ scope: { userId: 'u1' }, embedding: [1, 0], topK: 1 });
    expect(hits[0]!.record.id).toBe('cat');
    expect(hits[0]!.score).toBeCloseTo(1, 5);
  });

  it('embeddings persist across a fresh store instance (sidecar reload)', async () => {
    const s1 = createMarkdownMemoryStore({ dir });
    await s1.upsert([rec({ id: 'cat', text: 'cats', embedding: [1, 0] })]);
    const s2 = createMarkdownMemoryStore({ dir }); // new instance, cold cache
    const hits = await s2.search({ scope: { userId: 'u1' }, embedding: [1, 0], topK: 1 });
    expect(hits[0]!.record.id).toBe('cat');
    expect(hits[0]!.score).toBeCloseTo(1, 5);
  });

  it('list() excludes soft-deleted (invalidAt) records', async () => {
    const store = createMarkdownMemoryStore({ dir });
    await store.upsert([
      rec({ id: 'live', text: 'alive' }),
      rec({ id: 'dead', text: 'gone', invalidAt: 500 }),
    ]);
    const listed = await store.list({ userId: 'u1' });
    expect(listed.map((r) => r.id)).toEqual(['live']);
  });

  it('delete() removes the file and its sidecar vector', async () => {
    const store = createMarkdownMemoryStore({ dir });
    await store.upsert([rec({ id: 'a1', text: 'x', embedding: [1, 0] })]);
    await store.delete(['a1']);
    expect(await store.get('a1')).toBeNull();
    const vraw = JSON.parse(await readFile(join(dir, '.deuz-vectors.json'), 'utf-8'));
    expect(vraw.a1).toBeUndefined();
  });

  it('update() patches frontmatter in place', async () => {
    const store = createMarkdownMemoryStore({ dir });
    await store.upsert([rec({ id: 'a1', text: 'old' })]);
    await store.update!('a1', { text: 'new', updatedAt: 2000 });
    const got = await store.get('a1');
    expect(got).toMatchObject({ text: 'new', updatedAt: 2000 });
  });
});
