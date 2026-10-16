/**
 * The built-in context sources (2.4, spec §2.3 "Kaynakların bugünkü durumu"
 * and §2.4): memory (a versioned session, or a read adapter over a legacy
 * store), RAG (the first link between `/rag` and the loop), the transcript
 * index (search plus `resolveSource`) and the skill catalog (catalog lines
 * only; a body only once the model loaded it). Every candidate carries a
 * `sha256:<hex>` digest of its text, and a source never reads outside the
 * scope the host pinned.
 */
import { describe, expect, it } from 'vitest';
import { sha256Digest } from '../src/internal/digest';
import { createInMemoryMemoryStore, type MemoryRecord, type MemoryScope } from '../src/memory';
import {
  createMemoryContextSource,
  createRagContextSource,
  createSkillsContextSource,
  createTranscriptContextSource,
} from '../src/context/sources';
import type { ContextSourceRequest } from '../src/context/types';
import type {
  MemoryRecallInput,
  MemorySession,
  VersionedMemoryHit,
} from '../src/memory/versioned/types';
import { createSkillRegistry, staticSkillSource } from '../src/skills';
import type {
  TranscriptHit,
  TranscriptIndex,
  TranscriptMessage,
} from '../src/types/chat-conditional';

function request(overrides: Partial<ContextSourceRequest> = {}): ContextSourceRequest {
  return { text: 'units', limit: 20, budgetTokens: 1000, ...overrides };
}

const digest = await sha256Digest('');

function versionedHit(
  id: string,
  text: string,
  revision: number,
  score: number,
): VersionedMemoryHit {
  return {
    record: {
      id,
      revision,
      scope: { userId: 'u1' },
      text,
      kind: 'semantic',
      origin: 'inferred',
      sources: [
        { kind: 'user', digest },
        { kind: 'tool', digest, toolCallId: 'call-1' },
        { kind: 'user', digest },
      ],
      status: 'active',
      operationId: 'op-1',
      recordedAt: 10,
      createdAt: 1,
      digest,
    },
    score,
    match: 'hybrid',
  };
}

function fakeSession(scope: MemoryScope, hits: VersionedMemoryHit[]) {
  const calls: MemoryRecallInput[] = [];
  const unused = () => {
    throw new Error('not used by the context source');
  };
  const session = {
    scope,
    recall: async (input: MemoryRecallInput) => {
      calls.push(input);
      return hits.slice(0, input.topK);
    },
    remember: unused,
    extract: unused,
    revise: unused,
    retract: unused,
    forget: unused,
    history: unused,
    reembed: unused,
  } as unknown as MemorySession;
  return { session, calls };
}

describe('createMemoryContextSource over a versioned session', () => {
  it('recalls with the request and labels origin, source kinds and revision', async () => {
    const { session, calls } = fakeSession({ userId: 'u1' }, [
      versionedHit('m1', 'Prefers metric units', 3, 0.9),
      versionedHit('m2', 'Lives in Ankara', 1, 0.4),
    ]);
    const source = createMemoryContextSource({ session });
    expect(source).toMatchObject({ id: 'memory', kind: 'memory', required: false });
    const candidates = await source.query(request({ limit: 5, recordedAsOf: 42 }));
    expect(calls).toEqual([{ text: 'units', topK: 5, recordedAsOf: 42 }]);
    expect(candidates[0]).toEqual({
      recordId: 'm1',
      revision: 3,
      text: 'Prefers metric units',
      digest: await sha256Digest('Prefers metric units'),
      score: 0.9,
      provenance: { origin: 'inferred', sourceKinds: ['tool', 'user'] },
      query: 'units',
      match: 'hybrid',
    });
    expect(candidates).toHaveLength(2);
  });

  it('takes its id and required flag from the options', () => {
    const { session } = fakeSession({ userId: 'u1' }, []);
    expect(createMemoryContextSource({ session, id: 'facts', required: true })).toMatchObject({
      id: 'facts',
      required: true,
    });
  });

  it('refuses to read a session wider than the pinned scope', async () => {
    const { session } = fakeSession({ userId: 'u1' }, []);
    const source = createMemoryContextSource({ session });
    await expect(source.query(request({ scope: { userId: 'u1' } }))).resolves.toEqual([]);
    await expect(
      source.query(request({ scope: { userId: 'u1', agentId: 'child' } })),
    ).rejects.toThrow(TypeError);
    await expect(source.query(request({ scope: { userId: 'u2' } }))).rejects.toThrow(TypeError);
  });
});

describe('createMemoryContextSource over a legacy store', () => {
  function record(id: string, text: string, extra: Partial<MemoryRecord> = {}): MemoryRecord {
    return {
      id,
      text,
      hash: id,
      kind: 'semantic',
      scope: { userId: 'u1' },
      createdAt: 0,
      updatedAt: 0,
      ...extra,
    };
  }

  it('reads search hits, skipping expired and invalidated records', async () => {
    const store = createInMemoryMemoryStore();
    await store.upsert([
      record('a', 'metric units please'),
      record('b', 'old units fact', { expiresAt: 5 }),
      record('c', 'retired units fact', { invalidAt: 3 }),
      record('d', 'units for another user', { scope: { userId: 'u2' } }),
    ]);
    const source = createMemoryContextSource({ store, scope: { userId: 'u1' } });
    const candidates = await source.query(request({ recordedAsOf: 10 }));
    expect(candidates.map((candidate) => candidate.recordId)).toEqual(['a']);
    expect(candidates[0]).toMatchObject({ text: 'metric units please', match: 'lexical' });
    expect(candidates[0]).not.toHaveProperty('revision');
  });

  it('embeds the query with the configured embedder', async () => {
    const store = createInMemoryMemoryStore();
    await store.upsert([
      record('x', 'far', { embedding: [0, 1] }),
      record('y', 'near', { embedding: [1, 0] }),
    ]);
    const actions: string[] = [];
    const embedder = {
      embed: async (texts: string[], action: 'add' | 'search' | 'update') => {
        actions.push(action);
        return { vectors: texts.map(() => [1, 0]), model: 'm' };
      },
    };
    const source = createMemoryContextSource({ store, scope: { userId: 'u1' }, embedder });
    const candidates = await source.query(request({ text: 'anything' }));
    expect(actions).toEqual(['search']);
    expect(candidates[0]!.recordId).toBe('y');
  });

  it('narrows its scope to the pinned one and refuses a conflict', async () => {
    const store = createInMemoryMemoryStore();
    await store.upsert([
      record('a', 'units one', { scope: { userId: 'u1', agentId: 'a1' } }),
      record('b', 'units two', { scope: { userId: 'u1', agentId: 'a2' } }),
    ]);
    const source = createMemoryContextSource({ store, scope: { userId: 'u1' } });
    const narrowed = await source.query(request({ scope: { userId: 'u1', agentId: 'a2' } }));
    expect(narrowed.map((candidate) => candidate.recordId)).toEqual(['b']);
    await expect(source.query(request({ scope: { userId: 'u9' } }))).rejects.toThrow(TypeError);
  });
});

describe('createRagContextSource', () => {
  it('turns retrieved chunks into candidates', async () => {
    const seen: Array<[string, number]> = [];
    const source = createRagContextSource({
      retrieve: async (query, topK) => {
        seen.push([query, topK]);
        return [
          { text: 'Refunds take five days', index: 3, score: 0.8, meta: { id: 'faq#refunds' } },
          { text: 'Shipping is free', index: 7, score: 0.5 },
        ];
      },
    });
    expect(source).toMatchObject({ id: 'rag', kind: 'rag' });
    const candidates = await source.query(request({ text: 'refund', limit: 4 }));
    expect(seen).toEqual([['refund', 4]]);
    expect(candidates).toEqual([
      {
        recordId: 'faq#refunds',
        text: 'Refunds take five days',
        digest: await sha256Digest('Refunds take five days'),
        score: 0.8,
        query: 'refund',
      },
      {
        recordId: '7',
        text: 'Shipping is free',
        digest: await sha256Digest('Shipping is free'),
        score: 0.5,
        query: 'refund',
      },
    ]);
  });

  it('keeps at most limit candidates', async () => {
    const source = createRagContextSource({
      retrieve: async () =>
        Array.from({ length: 9 }, (_, index) => ({ text: `chunk ${index}`, index, score: 1 })),
    });
    expect(await source.query(request({ limit: 3 }))).toHaveLength(3);
  });
});

describe('createTranscriptContextSource', () => {
  const message = (
    chatId: string,
    messageId: string,
    index: number,
    role: 'user' | 'assistant',
    text: string,
  ): TranscriptMessage => ({
    chatId,
    messageId,
    index,
    message: { role, content: text },
  });

  function fakeIndex() {
    const searches: Array<{ scope: MemoryScope; query: string; options: unknown }> = [];
    const index: TranscriptIndex = {
      index: async () => {},
      remove: async () => {},
      search: async (scope, query, options) => {
        searches.push({ scope, query, options });
        if (scope.userId !== 'u1') return [];
        const hit: TranscriptHit = {
          ...message('c1', 'm2', 1, 'assistant', 'We agreed on metric units.'),
          score: 0.7,
          ...(options?.around ? { around: [message('c1', 'm1', 0, 'user', 'Which units?')] } : {}),
        };
        return [hit];
      },
      resolveSource: async (scope, ref) =>
        scope.userId === 'u1' && ref.chatId === 'c0' && ref.messageId === 'm9'
          ? message('c0', 'm9', 4, 'user', 'Call me Ada.')
          : undefined,
    };
    return { index, searches };
  }

  it('searches the pinned scope and renders hits with their surrounding messages', async () => {
    const { index, searches } = fakeIndex();
    const source = createTranscriptContextSource({
      index,
      scope: { userId: 'u1' },
      chatIds: ['c1'],
      around: 1,
    });
    expect(source).toMatchObject({ id: 'transcript', kind: 'transcript', required: false });
    const candidates = await source.query(request({ limit: 6 }));
    expect(searches).toEqual([
      {
        scope: { userId: 'u1' },
        query: 'units',
        options: { limit: 6, around: 1, chatIds: ['c1'] },
      },
    ]);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      recordId: 'c1/m2',
      score: 0.7,
      match: 'lexical',
      provenance: { sourceKinds: ['assistant', 'user'] },
    });
    expect(candidates[0]!.text).toBe('user: Which units?\nassistant: We agreed on metric units.');
  });

  it('resolves cited message references under the same scope check', async () => {
    const { index } = fakeIndex();
    const refs = [
      { kind: 'user' as const, chatId: 'c0', messageId: 'm9', digest },
      { kind: 'user' as const, chatId: 'other', messageId: 'mx', digest },
      { kind: 'tool' as const, toolCallId: 'call-1', digest },
    ];
    const source = createTranscriptContextSource({
      index,
      scope: { userId: 'u1' },
      refs: () => refs,
    });
    const candidates = await source.query(request());
    expect(candidates.map((candidate) => [candidate.recordId, candidate.match])).toEqual([
      ['c0/m9', 'source-ref'],
      ['c1/m2', 'lexical'],
    ]);
    expect(candidates[0]!.score).toBeGreaterThan(candidates[1]!.score);
    const outside = createTranscriptContextSource({
      index,
      scope: { userId: 'u2' },
      refs: () => refs,
    });
    expect(await outside.query(request())).toEqual([]);
  });

  it('never widens the pinned scope', async () => {
    const { index, searches } = fakeIndex();
    const source = createTranscriptContextSource({ index, scope: { userId: 'u1' } });
    await source.query(request({ scope: { userId: 'u1', chatId: 'c1' } }));
    expect(searches[0]!.scope).toEqual({ userId: 'u1', chatId: 'c1' });
    await expect(source.query(request({ scope: { userId: 'u2' } }))).rejects.toThrow(TypeError);
  });
});

describe('createSkillsContextSource', () => {
  const skill = (name: string, description: string, body: string) =>
    `---\nname: ${name}\ndescription: ${description}\n---\n${body}`;
  const registry = createSkillRegistry({
    source: staticSkillSource({
      'pdf-forms': { raw: skill('pdf-forms', 'Fill PDF forms and units tables', 'PDF BODY steps') },
      'unit-convert': {
        raw: skill('unit-convert', 'Convert metric and imperial units', 'CONVERT BODY'),
      },
      'git-flow': { raw: skill('git-flow', 'Branching with git', 'GIT BODY') },
    }),
  });

  it('offers catalog lines only, never a body retrieval matched', async () => {
    const source = createSkillsContextSource({ registry });
    expect(source).toMatchObject({ id: 'skills', kind: 'skills' });
    const candidates = await source.query(request({ text: 'convert units' }));
    expect(candidates.map((candidate) => candidate.recordId)).toEqual([
      'unit-convert',
      'pdf-forms',
    ]);
    expect(candidates[0]).toMatchObject({
      text: 'unit-convert (unit-convert): Convert metric and imperial units',
      match: 'catalog',
    });
    for (const candidate of candidates) {
      expect(candidate.text).not.toContain('BODY');
      expect(candidate.mandatory).toBeUndefined();
    }
  });

  it('keeps the bodies the model loaded, as mandatory', async () => {
    const source = createSkillsContextSource({ registry, loaded: () => ['git-flow', 'git-flow'] });
    const candidates = await source.query(request({ text: 'convert units' }));
    const loaded = candidates.filter((candidate) => candidate.mandatory);
    expect(loaded).toEqual([
      {
        recordId: 'git-flow/SKILL.md',
        text: 'GIT BODY',
        digest: await sha256Digest('GIT BODY'),
        score: 0,
        mandatory: true,
        match: 'loaded',
      },
    ]);
  });

  it('offers no catalog line for an empty query', async () => {
    expect(await createSkillsContextSource({ registry }).query(request({ text: ' ' }))).toEqual([]);
  });
});
