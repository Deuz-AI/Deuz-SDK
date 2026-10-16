/**
 * The RAG unaccounted-usage warning and the AccountedEmbedder JSDoc tell users
 * to wrap their embedder with defineAccountedEmbedder, so a public entry must
 * export it (found by docs lane D2 in 2.4).
 */
import { expect, it } from 'vitest';
import * as rag from '../src/rag';

it('exports defineAccountedEmbedder from @deuz-sdk/core/rag', () => {
  expect(typeof rag.defineAccountedEmbedder).toBe('function');
});
