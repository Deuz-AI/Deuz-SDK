/**
 * Regression tests for the 6 issues surfaced by the Faz 3 adversarial review
 * (5 confirmed fixes + the chunkFixed coverage guard).
 */
import { describe, it, expect } from 'vitest';
import { embedMany } from '../src/inference/embed';
import { createOpenAIEmbedding } from '../src/openai';
import { createInMemoryMemoryStore } from '../src/memory';
import type { MemoryRecord } from '../src/memory';
import { toGeminiSchema } from '../src/schema/gemini';
import { chunkRecursive, chunkFixed } from '../src/rag';
import { mergeSkillSources, staticSkillSource } from '../src/skills';

describe('fix #1 — embedMany fires usage once even on empty input (G10)', () => {
  it('calls onUsage with zero usage for an empty values array', async () => {
    const calls: number[] = [];
    const { usage } = await embedMany({
      model: createOpenAIEmbedding({ apiKey: 'sk' })('text-embedding-3-small'),
      values: [],
      onUsage: (u) => calls.push(u.totalTokens),
    });
    expect(usage.totalTokens).toBe(0);
    expect(calls).toEqual([0]); // fired exactly once
  });
});

describe('fix #2 — in-memory list() excludes soft-deleted records', () => {
  it('omits records with invalidAt set (consistent with search)', async () => {
    const store = createInMemoryMemoryStore();
    const base = (id: string, over: Partial<MemoryRecord>): MemoryRecord => ({
      id,
      text: id,
      hash: id,
      kind: 'semantic',
      scope: { userId: 'u1' },
      createdAt: 1,
      updatedAt: 1,
      ...over,
    });
    await store.upsert([base('live', {}), base('dead', { invalidAt: 5 })]);
    const listed = await store.list({ userId: 'u1' });
    expect(listed.map((r) => r.id)).toEqual(['live']);
  });
});

describe('fix #3 — toGeminiSchema preserves integer enum values', () => {
  it('keeps integer enums as numbers under an INTEGER type', () => {
    const g = toGeminiSchema({ type: 'integer', enum: [1, 2, 3] });
    expect(g.type).toBe('INTEGER');
    expect(g.enum).toEqual([1, 2, 3]); // NOT ["1","2","3"]
  });
  it('still defaults a bare string enum to STRING', () => {
    const g = toGeminiSchema({ enum: ['a', 'b'] });
    expect(g.type).toBe('STRING');
    expect(g.enum).toEqual(['a', 'b']);
  });
});

describe('fix #4 — chunkRecursive does not append a spurious trailing separator', () => {
  it('the final chunk has no extra separator that was not in the source', () => {
    // size small enough to keep pieces separate; recursion splits on \n\n.
    const chunks = chunkRecursive('alpha\n\nbeta', { size: 3, overlap: 0 });
    const joined = chunks.map((c) => c.text).join('');
    // No chunk should end with the separator that the last piece never had.
    expect(joined.endsWith('\n\n')).toBe(false);
    expect(chunks.some((c) => c.text.includes('beta'))).toBe(true);
  });
});

describe('fix #6 — chunkFixed covers the whole text (no dropped tail)', () => {
  it('last chunk ends exactly at text.length for non-dividing size/overlap', () => {
    const text = 'x'.repeat(1003);
    const chunks = chunkFixed(text, { size: 100, overlap: 17 });
    expect(chunks[chunks.length - 1]!.endOffset).toBe(text.length);
    // Every character index is covered by at least one chunk window.
    const covered = new Array(text.length).fill(false);
    for (const c of chunks) for (let i = c.startOffset!; i < c.endOffset!; i++) covered[i] = true;
    expect(covered.every(Boolean)).toBe(true);
  });
});

describe('fix #5 — mergeSkillSources.readResource falls through unprefixed sources', () => {
  it('finds a resource that only exists in the second unprefixed source', async () => {
    const s1 = staticSkillSource({
      'skill-a': { raw: `---\nname: skill-a\ndescription: a\n---\nbody` },
    });
    const s2 = staticSkillSource({
      'skill-b': {
        raw: `---\nname: skill-b\ndescription: b\n---\nbody`,
        resources: { 'data.json': '{"ok":true}' },
      },
    });
    const merged = mergeSkillSources([{ source: s1 }, { source: s2 }]);
    // skill-b lives only in s2 — readResource must fall through past s1.
    expect(await merged.readResource!('skill-b', 'data.json')).toBe('{"ok":true}');
  });
});
