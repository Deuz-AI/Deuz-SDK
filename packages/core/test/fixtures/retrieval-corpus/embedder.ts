/**
 * A deterministic offline embedder for the retrieval corpus (2.4, spec
 * §5.2): hashed bags of stemmed words and word pairs, L2-normalized. It has
 * no notion of meaning beyond shared stems, so its numbers measure the
 * retrieval plumbing, never a real model.
 */
import { tokenize, type Embedder } from '../../../src/rag';

const STOPWORDS = new Set(
  'a an and are as at be by can do does for from get how i in is it my of on or should the to we what when where which who will with within you your'.split(
    ' ',
  ),
);

/** A light stemmer: plural, -ing, -ed and -ly endings off. */
export function stem(word: string): string {
  for (const suffix of ['ing', 'ed', 'ly', 'es', 's'])
    if (word.length > suffix.length + 3 && word.endsWith(suffix))
      return word.slice(0, -suffix.length);
  return word;
}

/** The terms of a text: stemmed words without stopwords. */
export function terms(text: string): string[] {
  return tokenize(text)
    .filter((word) => !STOPWORDS.has(word))
    .map(stem);
}

/** FNV-1a, 32 bit. */
function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}

/** One text as a unit vector of `dims` hashed features (words 1.0, word pairs 0.5). */
export function embedText(text: string, dims: number): number[] {
  const vector = new Array<number>(dims).fill(0);
  const words = terms(text);
  const add = (feature: string, weight: number): void => {
    const hash = fnv1a(feature);
    vector[hash % dims]! += hash & 0x80000000 ? -weight : weight;
  };
  words.forEach((word, index) => {
    add(word, 1);
    if (index > 0) add(`${words[index - 1]} ${word}`, 0.5);
  });
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  return norm === 0 ? vector : vector.map((value) => value / norm);
}

/** The deterministic RAG embedder (default 256 dimensions). */
export function createDeterministicEmbedder(dims = 256): Embedder {
  return { dims, embed: async (texts) => texts.map((text) => embedText(text, dims)) };
}
