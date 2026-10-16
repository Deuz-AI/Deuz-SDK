/**
 * `/rag` in 2.4 (spec §2.3 "Tek token sayacı" and §3.1 muhasebe): the 4
 * characters per token default stays, so chunk boundaries do not move, and
 * an optional estimator counts through the one shared counter instead. The
 * RAG embedder joins the accounted-call contract: with `accounting`, an
 * embedding is reserved before the call and settled after it; an embedder
 * that reports no usage is recorded as unknown, never as free, with an
 * `unaccounted-usage` warning. Without `accounting` nothing changes.
 */
import { describe, expect, it } from 'vitest';
import { createExecutionContext } from '../src/execution-policy';
import { defineAccountedEmbedder } from '../src/internal/accounting';
import { createTokenEstimator } from '../src/internal/estimate-tokens';
import {
  chunkBlocks,
  chunkFixed,
  chunkRecursive,
  createBm25Index,
  createMemoryVectorStore,
  estimateTokens,
  hybridRetrieve,
  indexChunks,
  retrieve,
  type Embedder,
} from '../src/rag';
import type { CallAccounting } from '../src/types/accounting';
import type { NativeExecutionContext } from '../src/types/execution';
import type { CallWarning } from '../src/types/methods';
import type { Usage } from '../src/types/usage';

const text = Array.from({ length: 120 }, (_, i) => `Sentence number ${i} is here.`).join(' ');

describe('chunk boundaries and the optional estimator', () => {
  it('keeps the 2.3 boundaries by default', () => {
    // Pinned from 2.3.0: 4 characters per token.
    expect(chunkFixed(text, { size: 100, overlap: 10 }).map((chunk) => chunk.endOffset)).toEqual([
      399, 758, 1117, 1476, 1835, 2194, 2553, 2912, 3271, 3369,
    ]);
    expect(
      chunkRecursive(text, { size: 100, overlap: 0 }).map((chunk) => chunk.text.length),
    ).toEqual([382, 392, 392, 392, 392, 392, 392, 375, 260]);
    expect(estimateTokens('x'.repeat(40))).toBe(10);
  });

  it('counts through the shared estimator when one is given', () => {
    const estimator = createTokenEstimator();
    expect(estimateTokens('x'.repeat(36), estimator)).toBe(10);
    const sized = chunkFixed(text, { size: 100, overlap: 0, estimator });
    // About 3.6 characters per token: smaller windows than the 4-character default.
    expect(sized[0]!.endOffset).toBeLessThan(399);
    expect(sized[0]!.endOffset).toBeGreaterThan(350);
    expect(chunkRecursive(text, { size: 100, overlap: 0, estimator }).length).toBeGreaterThan(9);
    const blocks = [
      { type: 'paragraph' as const, text: 'a'.repeat(180) },
      { type: 'paragraph' as const, text: 'b'.repeat(180) },
    ];
    expect(chunkBlocks(blocks, { size: 100 })).toHaveLength(1);
    expect(chunkBlocks(blocks, { size: 100, estimator })).toHaveLength(2);
  });

  it('lets countTokens win over the estimator', () => {
    const estimator = createTokenEstimator();
    const countTokens = (s: string) => s.length;
    expect(chunkFixed('abcdefghij', { size: 5, overlap: 0, countTokens, estimator })).toHaveLength(
      2,
    );
  });
});

const usage: Usage = {
  inputTokens: 7,
  outputTokens: 0,
  reasoningTokens: 0,
  cachedReadTokens: 0,
  cacheWriteTokens: 0,
  cacheWrite1hTokens: 0,
  totalTokens: 7,
};

const plain: Embedder = {
  dims: 2,
  embed: async (texts) => texts.map((t) => (t.includes('cat') ? [1, 0] : [0, 1])),
};

const accounted = defineAccountedEmbedder({
  dims: 2,
  embed: async (texts) => ({
    vectors: texts.map((t) => (t.includes('cat') ? [1, 0] : [0, 1])),
    usage,
    modelId: 'embed-small',
  }),
});

/** An execution context that records what the call asks of it. */
function recordingExecution() {
  const calls: Array<[string, unknown]> = [];
  const execution = {
    reserve: async (input: unknown) => {
      calls.push(['reserve', input]);
      return {};
    },
    ledger: {
      settle: async (input: unknown) => {
        calls.push(['settle', input]);
        return {};
      },
      markUnknown: async (requestId: string) => {
        calls.push(['markUnknown', requestId]);
        return {};
      },
    },
  } as unknown as NativeExecutionContext;
  return { execution, calls };
}

async function storeWith(embedder: Embedder) {
  const store = createMemoryVectorStore();
  await indexChunks(
    [
      { text: 'the cat sat', index: 0 },
      { text: 'a dog ran', index: 1 },
    ],
    { embedder, store },
  );
  return store;
}

describe('RAG embedder accounting', () => {
  it('accepts an accounted embedder anywhere a plain one goes', async () => {
    const store = createMemoryVectorStore();
    await indexChunks([{ text: 'the cat sat', index: 0 }], { embedder: accounted, store });
    const hits = await retrieve('cat', { embedder: accounted, store }, { topK: 1 });
    expect(hits[0]!.text).toBe('the cat sat');
    const bm25 = createBm25Index([{ text: 'the cat sat', index: 0 }]);
    const fused = await hybridRetrieve('cat', { embedder: accounted, store, bm25 });
    expect(fused[0]!.text).toBe('the cat sat');
  });

  it('reserves before the call and settles the reported usage', async () => {
    const { execution, calls } = recordingExecution();
    const store = await storeWith(plain);
    const accounting: CallAccounting = { execution, requestId: 'q-1' };
    await retrieve('cat', { embedder: accounted, store }, { accounting });
    expect(calls).toEqual([
      [
        'reserve',
        { requestId: 'q-1', modelId: 'rag-embedder', kind: 'embedding', tokens: 1, unpriced: true },
      ],
      ['settle', { requestId: 'q-1', usage }],
    ]);
  });

  it('takes the estimates and kind the caller gives', async () => {
    const { execution, calls } = recordingExecution();
    const store = await storeWith(plain);
    await retrieve(
      'cat',
      { embedder: accounted, store },
      { accounting: { execution, requestId: 'q-2', kind: 'rag-query', tokens: 50, usd: 0.001 } },
    );
    expect(calls[0]).toEqual([
      'reserve',
      { requestId: 'q-2', modelId: 'rag-embedder', kind: 'rag-query', tokens: 50, usd: 0.001 },
    ]);
  });

  it('records an embedder without usage as unaccounted and warns once', async () => {
    const { execution, calls } = recordingExecution();
    const warnings: CallWarning[] = [];
    const store = await storeWith(plain);
    const bm25 = createBm25Index([{ text: 'the cat sat', index: 0 }]);
    await hybridRetrieve(
      'cat',
      { embedder: plain, store, bm25 },
      { accounting: { execution, requestId: 'q-3' }, onWarning: (w) => warnings.push(w) },
    );
    expect(calls).toEqual([
      [
        'reserve',
        {
          requestId: 'q-3',
          modelId: 'rag-embedder',
          kind: 'embedding',
          tokens: 1,
          unpriced: true,
          unaccounted: true,
        },
      ],
      ['markUnknown', 'q-3'],
    ]);
    expect(warnings).toEqual([{ type: 'unaccounted-usage', message: expect.any(String) }]);
  });

  it('marks the reservation unknown when the call fails', async () => {
    const { execution, calls } = recordingExecution();
    const failing: Embedder = {
      dims: 2,
      embed: async () => {
        throw new Error('embedding service down');
      },
    };
    await expect(
      indexChunks(
        [{ text: 'x', index: 0 }],
        { embedder: failing, store: createMemoryVectorStore() },
        { accounting: { execution, requestId: 'ix-1' } },
      ),
    ).rejects.toThrow('embedding service down');
    expect(calls.map(([name]) => name)).toEqual(['reserve', 'markUnknown']);
  });

  it('charges a real ledger', async () => {
    const execution = createExecutionContext({ budget: { tokens: 1_000 } });
    const store = await storeWith(plain);
    await retrieve(
      'cat',
      { embedder: accounted, store },
      { accounting: { execution, requestId: 'q-9', tokens: 10 } },
    );
    expect(execution.ledger.get('q-9')).toMatchObject({ kind: 'embedding', actual: { tokens: 7 } });
  });

  it('reserves nothing without accounting', async () => {
    const { execution, calls } = recordingExecution();
    void execution;
    const store = await storeWith(plain);
    await retrieve('cat', { embedder: plain, store });
    expect(calls).toEqual([]);
  });
});
