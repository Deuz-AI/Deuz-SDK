/**
 * The accounted-call contract (2.4, spec §3.1): helper calls that 2.3 never
 * charged to a ledger (memory LLM callbacks, embeddings, the RAG embedder,
 * createVerifier) get an accounted form. A host callback declares that it
 * reports usage with `accounted: true`, so a strict budget can admit it before
 * it runs; a callback without the mark is "unaccounted", never free.
 */
import { describe, expect, it } from 'vitest';
import {
  defineAccountedEmbedder,
  defineAccountedMemoryLLM,
  isAccounted,
} from '../src/internal/accounting';
import type { Usage } from '../src/index';

const usage: Usage = {
  inputTokens: 12,
  outputTokens: 3,
  reasoningTokens: 0,
  cachedReadTokens: 0,
  cacheWriteTokens: 0,
  cacheWrite1hTokens: 0,
  totalTokens: 15,
};

describe('accounted callbacks', () => {
  it('marks a memory LLM that reports usage, and keeps its behaviour', async () => {
    const llm = defineAccountedMemoryLLM(async (prompt) => ({
      text: `${prompt.system}|${prompt.user}`,
      usage,
      modelId: 'judge-1',
    }));
    expect(isAccounted(llm)).toBe(true);
    expect(llm.accounted).toBe(true);
    await expect(llm({ system: 's', user: 'u' })).resolves.toEqual({
      text: 's|u',
      usage,
      modelId: 'judge-1',
    });
  });

  it('marks a RAG embedder that reports usage, keeping its dimensions', async () => {
    const embedder = defineAccountedEmbedder({
      dims: 2,
      embed: async (texts) => ({
        vectors: texts.map(() => [1, 0]),
        usage,
        modelId: 'embed-1',
      }),
    });
    expect(isAccounted(embedder)).toBe(true);
    expect(embedder.dims).toBe(2);
    await expect(embedder.embed(['a', 'b'])).resolves.toMatchObject({
      vectors: [
        [1, 0],
        [1, 0],
      ],
    });
  });

  it('treats every unmarked callback as unaccounted', () => {
    const plain = async () => 'text';
    expect(isAccounted(plain)).toBe(false);
    expect(isAccounted({ embed: async () => [[1]], dims: 1 })).toBe(false);
    expect(isAccounted({ accounted: 'yes' })).toBe(false);
    expect(isAccounted(undefined)).toBe(false);
    expect(isAccounted(null)).toBe(false);
  });

  it('refuses to mark something that is not callable / has no embed', () => {
    expect(() => defineAccountedMemoryLLM('nope' as never)).toThrow(TypeError);
    expect(() => defineAccountedEmbedder({ dims: 1 } as never)).toThrow(TypeError);
  });
});
