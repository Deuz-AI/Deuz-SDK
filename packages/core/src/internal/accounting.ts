/**
 * Accounted-callback helpers (2.4): mark a host callback as one that reports
 * its usage, and tell marked from unmarked ones. See `types/accounting.ts` for
 * the contract. Edge-safe.
 */
import type {
  AccountedEmbedder,
  AccountedMemoryLLM,
  AccountedMemoryLLMResult,
} from '../types/accounting';

/**
 * Whether `callback` declares that it reports usage (`accounted: true`). A
 * callback without the mark is unaccounted: its calls are never counted as
 * free (see `BudgetReservation.unaccounted`).
 */
export function isAccounted(callback: unknown): boolean {
  return (
    (typeof callback === 'function' || (typeof callback === 'object' && callback !== null)) &&
    (callback as { accounted?: unknown }).accounted === true
  );
}

/** Marks a memory LLM callback that returns its text with the call's usage. */
export function defineAccountedMemoryLLM(
  fn: (prompt: { system: string; user: string }) => Promise<AccountedMemoryLLMResult>,
): AccountedMemoryLLM {
  if (typeof fn !== 'function')
    throw new TypeError('defineAccountedMemoryLLM needs a function that returns { text, usage }');
  const llm = (prompt: { system: string; user: string }) => fn(prompt);
  return Object.defineProperty(llm, 'accounted', {
    value: true,
    enumerable: true,
  }) as AccountedMemoryLLM;
}

/** Marks a RAG embedder whose `embed` returns the vectors with the call's usage. */
export function defineAccountedEmbedder(
  embedder: Omit<AccountedEmbedder, 'accounted'>,
): AccountedEmbedder {
  if (typeof embedder?.embed !== 'function' || !Number.isSafeInteger(embedder.dims))
    throw new TypeError('defineAccountedEmbedder needs { embed, dims }');
  return { embed: (texts) => embedder.embed(texts), dims: embedder.dims, accounted: true };
}
