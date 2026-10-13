import { describe, expect, it } from 'vitest';

/** A claim that can give a key back: `createInMemoryClaim()` and the ops stores' `claims`. */
export interface ReleasableClaim {
  (key: string): Promise<boolean>;
  release(key: string): Promise<void>;
}

/**
 * A deterministic key of `length` printable characters that does not compress:
 * Postgres compresses a repetitive key into its btree row, so only a key like
 * this one reaches the index row size limit.
 */
export function incompressibleKey(seed: number, length = 8000): string {
  let state = seed >>> 0;
  let key = '';
  for (let i = 0; i < length; i++) {
    state = (Math.imul(state, 1103515245) + 12345) >>> 0;
    key += String.fromCharCode(33 + ((state >>> 16) % 94));
  }
  return key;
}

/** A durable claim that also drops old keys (2.3): the ops stores' `claims`. */
export interface PrunableClaim extends ReleasableClaim {
  prune(before: number): Promise<number>;
}

/**
 * Claim retention (2.3), shared by the SQLite and Postgres ops stores:
 * `prune` deletes the keys granted before a time, which can then be claimed
 * again. `advance` moves the store's time forward and `now` reads it.
 */
export function scheduleClaimPruneContracts(
  name: string,
  make: () => Promise<{ claim: PrunableClaim; advance(ms: number): Promise<void>; now(): number }>,
): void {
  describe(name, () => {
    it('prunes the keys granted before a time, and only those', async () => {
      const { claim, advance, now } = await make();
      const old = ['nightly@1', 'nightly@2', 'delivery\u0000a', incompressibleKey(3)];
      for (const key of old) expect(await claim(key)).toBe(true);
      await advance(50);
      const cut = now();
      await advance(50);
      expect(await claim('nightly@3')).toBe(true);
      expect(await claim.prune(cut)).toBe(4);
      // A pruned key can be claimed again; a newer one is still taken.
      for (const key of old) expect(await claim(key)).toBe(true);
      expect(await claim('nightly@3')).toBe(false);
      expect(await claim.prune(cut)).toBe(0);
      await expect(claim.prune(Number.NaN)).rejects.toThrow(TypeError);
    });
  });
}

/**
 * The schedule claim contract (2.2), shared by the in-memory claim and the
 * SQLite and Postgres ops stores: a key is granted once, to exactly one of any
 * number of concurrent callers, until `release` gives it back.
 */
export function scheduleClaimContracts(
  name: string,
  make: () => ReleasableClaim | Promise<ReleasableClaim>,
): void {
  describe(name, () => {
    it('grants a key once and other keys independently', async () => {
      const claim = await make();
      expect(await claim('digest@1')).toBe(true);
      expect(await claim('digest@1')).toBe(false);
      expect(await claim('digest@2')).toBe(true);
    });

    it('grants one of several concurrent claims of a key', async () => {
      const claim = await make();
      const results = await Promise.all(Array.from({ length: 8 }, () => claim('race')));
      expect(results.filter(Boolean)).toHaveLength(1);
    });

    it('gives a released key to the next claim, once', async () => {
      const claim = await make();
      expect(await claim('delivery-1')).toBe(true);
      await claim.release('delivery-1');
      expect(await claim('delivery-1')).toBe(true);
      expect(await claim('delivery-1')).toBe(false);
    });

    it('ignores the release of a key nobody claimed', async () => {
      const claim = await make();
      await claim.release('never');
      expect(await claim('never')).toBe(true);
      expect(await claim('never')).toBe(false);
    });

    it('compares keys exactly', async () => {
      const claim = await make();
      expect(await claim('a')).toBe(true);
      expect(await claim('A')).toBe(true);
      expect(await claim('a ')).toBe(true);
      expect(await claim('sha256:ab')).toBe(true);
      expect(await claim('sha256:ab')).toBe(false);
    });

    it('grants and releases a key holding a NUL, exactly', async () => {
      const claim = await make();
      expect(await claim('delivery\u0000a')).toBe(true);
      expect(await claim('delivery\u0000a')).toBe(false);
      expect(await claim('delivery\u0000b')).toBe(true);
      expect(await claim('delivery')).toBe(true);
      await claim.release('delivery\u0000a');
      expect(await claim('delivery\u0000a')).toBe(true);
      expect(await claim('delivery\u0000a')).toBe(false);
    });

    it('grants and releases an 8000-character key, exactly', async () => {
      const claim = await make();
      const key = incompressibleKey(1);
      const sibling = `${key.slice(0, -1)}${key.endsWith('!') ? '"' : '!'}`;
      expect(await claim(key)).toBe(true);
      expect(await claim(key)).toBe(false);
      expect(await claim(sibling)).toBe(true);
      await claim.release(key);
      expect(await claim(key)).toBe(true);
      expect(await claim(key)).toBe(false);
    });
  });
}
