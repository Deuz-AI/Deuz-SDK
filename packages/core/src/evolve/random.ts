/**
 * evolve/random.ts — counter-based seeded randomness for `./evolve` (2.2).
 *
 * Every draw is keyed by (seed, generation, island, slot, purpose) instead of
 * advancing one shared stream, so a slot's choices do not depend on how many
 * other slots ran first, on concurrency, or on whether the run was resumed —
 * the replay is identical with no PRNG state to persist. Edge-safe: no
 * `Math.random`.
 */

/** 32-bit FNV-1a. */
export function hashSeed(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** A mulberry32 stream in [0, 1) seeded by the hash of the key parts. */
export function createRng(...parts: readonly (string | number)[]): () => number {
  let state = hashSeed(parts.join('\u0000'));
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
