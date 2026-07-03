import { describe, it, expect } from 'vitest';
import { parsePartialJson } from '../src/internal/partial-json';

describe('parsePartialJson — curated cases', () => {
  it('returns undefined when nothing is emittable yet', () => {
    expect(parsePartialJson('')).toBeUndefined();
    expect(parsePartialJson('   \n\t')).toBeUndefined();
    expect(parsePartialJson('-')).toBeUndefined();
    expect(parsePartialJson('tru')).toBeUndefined();
    expect(parsePartialJson('fals')).toBeUndefined();
    expect(parsePartialJson('nul')).toBeUndefined();
  });

  it('parses complete documents via the fast path (complete: true)', () => {
    expect(parsePartialJson('{"a":1}')).toEqual({ value: { a: 1 }, complete: true });
    expect(parsePartialJson('true')).toEqual({ value: true, complete: true });
    expect(parsePartialJson('null')).toEqual({ value: null, complete: true });
    expect(parsePartialJson(' [1,2] ')).toEqual({ value: [1, 2], complete: true });
    expect(parsePartialJson('"hi"')).toEqual({ value: 'hi', complete: true });
  });

  it('completes unclosed objects', () => {
    expect(parsePartialJson('{')).toEqual({ value: {}, complete: false });
    expect(parsePartialJson('{"a"')).toEqual({ value: {}, complete: false }); // dangling key dropped
    expect(parsePartialJson('{"a":')).toEqual({ value: {}, complete: false });
    expect(parsePartialJson('{"a":1,"b"')).toEqual({ value: { a: 1 }, complete: false });
    expect(parsePartialJson('{"a":1,"b":')).toEqual({ value: { a: 1 }, complete: false });
    expect(parsePartialJson('{"a": null, "b": fal')).toEqual({
      value: { a: null },
      complete: false,
    });
  });

  it('completes unclosed arrays (partial trailing element kept)', () => {
    expect(parsePartialJson('[')).toEqual({ value: [], complete: false });
    expect(parsePartialJson('[1,2,')).toEqual({ value: [1, 2], complete: false });
    expect(parsePartialJson('[1,{"x":"y')).toEqual({ value: [1, { x: 'y' }], complete: false });
    expect(parsePartialJson('[tru')).toEqual({ value: [], complete: false });
  });

  it('streams truncated string values', () => {
    expect(parsePartialJson('"hel')).toEqual({ value: 'hel', complete: false });
    expect(parsePartialJson('{"city":"Par')).toEqual({ value: { city: 'Par' }, complete: false });
  });

  it('drops trailing incomplete escapes from truncated strings', () => {
    expect(parsePartialJson('"ab\\')).toEqual({ value: 'ab', complete: false });
    expect(parsePartialJson('"ab\\u12')).toEqual({ value: 'ab', complete: false });
    expect(parsePartialJson('"a\\n')).toEqual({ value: 'a\n', complete: false }); // complete escape decodes
    expect(parsePartialJson('"a\\u0041')).toEqual({ value: 'aA', complete: false });
  });

  it('trims numbers to the longest valid prefix', () => {
    expect(parsePartialJson('12.')).toEqual({ value: 12, complete: false });
    expect(parsePartialJson('1e')).toEqual({ value: 1, complete: false });
    expect(parsePartialJson('-3.')).toEqual({ value: -3, complete: false });
    expect(parsePartialJson('{"n":1.5e')).toEqual({ value: { n: 1.5 }, complete: false });
  });

  it('handles nested structures cut mid-way', () => {
    expect(parsePartialJson('{"a":{"b":{"c":[1,"x')).toEqual({
      value: { a: { b: { c: [1, 'x'] } } },
      complete: false,
    });
  });

  it('never throws on malformed input (stops at the malformed point)', () => {
    expect(parsePartialJson('{"a":1} trailing')).toEqual({ value: { a: 1 }, complete: false });
    expect(parsePartialJson('[1 x]')).toEqual({ value: [1], complete: false });
    expect(parsePartialJson('{a:1}')).toEqual({ value: {}, complete: false });
    expect(parsePartialJson('@@@')).toBeUndefined();
  });

  it('caps recursion depth without throwing', () => {
    const deep = '['.repeat(500);
    expect(() => parsePartialJson(deep)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Generative: every prefix of a random JSON document must parse without
// throwing, and the full document must round-trip complete:true.
// Deterministic seeded PRNG (mulberry32) — no Math.random.
// ---------------------------------------------------------------------------

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const STRINGS = [
  'plain',
  'with "quotes" inside',
  'esc\\ape\nnewline\ttab',
  'emoji 🎉🚀 ünïcödé',
  '',
  'back\\slash \\u0041',
];

function randomValue(rnd: () => number, depth: number): unknown {
  const pick = rnd();
  if (depth >= 4 || pick < 0.2) {
    const leaf = rnd();
    if (leaf < 0.25) return STRINGS[Math.floor(rnd() * STRINGS.length)];
    if (leaf < 0.5) {
      const n = (rnd() - 0.5) * 2e6;
      return rnd() < 0.5 ? Math.round(n) : Number(n.toExponential(3));
    }
    if (leaf < 0.65) return true;
    if (leaf < 0.8) return false;
    return null;
  }
  const width = 1 + Math.floor(rnd() * 4);
  if (pick < 0.6) {
    const obj: Record<string, unknown> = {};
    for (let i = 0; i < width; i++)
      obj[`k${i}_${Math.floor(rnd() * 100)}`] = randomValue(rnd, depth + 1);
    return obj;
  }
  const arr: unknown[] = [];
  for (let i = 0; i < width; i++) arr.push(randomValue(rnd, depth + 1));
  return arr;
}

describe('parsePartialJson — generative prefixes', () => {
  it('never throws on any prefix; full document round-trips', { timeout: 20_000 }, () => {
    const rnd = mulberry32(0xde02);
    for (let doc = 0; doc < 200; doc++) {
      const value = randomValue(rnd, 0);
      const full = JSON.stringify(value);
      const stride = full.length > 300 ? 7 : 1;
      for (let cut = 1; cut <= full.length; cut += stride) {
        parsePartialJson(full.slice(0, cut)); // a throw here fails the test
      }
      const final = parsePartialJson(full);
      expect(final).toBeDefined();
      expect(final!.complete).toBe(true);
      expect(final!.value).toEqual(JSON.parse(full));
    }
  });
});
