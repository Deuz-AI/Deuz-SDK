import { describe, expect, it } from 'vitest';

/** A claim that can give a key back: `createInMemoryClaim()` and the ops stores' `claims`. */
export interface ReleasableClaim {
  (key: string): Promise<boolean>;
  release(key: string): Promise<void>;
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
  });
}
