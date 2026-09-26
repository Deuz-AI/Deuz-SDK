import { describe, expect, it } from 'vitest';
import type { BudgetStore, PersistentBudgetScope } from '../../src/types/budget-store';

export interface BudgetStoreHarness {
  store: BudgetStore;
  /** Move the store's notion of time forward (a manual clock, or a real wait for database time). */
  advance(ms: number): Promise<void>;
  /** The store's current time in epoch milliseconds. */
  now(): number;
}

/** Window used by the expiry tests: four 100 ms buckets. */
const WINDOW = { ms: 400, buckets: 4 } as const;
const PAST_WINDOW = 600;

const user = (
  tokens: number,
  extra: Partial<PersistentBudgetScope> = {},
): PersistentBudgetScope => ({
  key: 'user:1',
  limits: { tokens },
  ...extra,
});

/** The BudgetStore contract (2.2), shared by the memory, SQLite and Postgres stores. */
export function budgetStoreContracts(name: string, make: () => Promise<BudgetStoreHarness>): void {
  describe(name, () => {
    it('admits within every scope and reports committed usage', async () => {
      const { store } = await make();
      const org: PersistentBudgetScope = { key: 'org:1', limits: { tokens: 1_000, usd: 5 } };
      expect(
        await store.reserve({
          requestId: 'r1',
          modelId: 'm',
          tokens: 40,
          usd: 1,
          scopes: [user(100), org],
        }),
      ).toEqual({
        admitted: true,
        scopes: [
          { key: 'user:1', tokens: 40, usd: 1 },
          { key: 'org:1', tokens: 40, usd: 1 },
        ],
      });
      expect(await store.usage('user:1')).toEqual({ tokens: 40, usd: 1 });
    });

    it('is all-or-nothing across scopes', async () => {
      const { store } = await make();
      await store.reserve({ requestId: 'a', modelId: 'm', tokens: 80, scopes: [user(100)] });
      const denied = await store.reserve({
        requestId: 'b',
        modelId: 'm',
        tokens: 30,
        scopes: [{ key: 'org:1', limits: { tokens: 1_000 } }, user(100)],
      });
      expect(denied).toEqual({
        admitted: false,
        key: 'user:1',
        dimension: 'tokens',
        limit: 100,
        committed: 80,
      });
      // The scope that had room was not charged either.
      expect(await store.usage('org:1')).toEqual({ tokens: 0, usd: 0 });
      expect(await store.usage('user:1')).toEqual({ tokens: 80, usd: 0 });
    });

    it('denies on USD as well as tokens', async () => {
      const { store } = await make();
      const scope = { key: 'user:usd', limits: { usd: 1 } };
      expect(
        await store.reserve({ requestId: 'a', modelId: 'm', usd: 0.75, scopes: [scope] }),
      ).toMatchObject({ admitted: true });
      expect(
        await store.reserve({ requestId: 'b', modelId: 'm', usd: 0.5, scopes: [scope] }),
      ).toMatchObject({ admitted: false, key: 'user:usd', dimension: 'usd', limit: 1 });
    });

    it('reports USD without floating-point residue', async () => {
      const { store } = await make();
      const scope = { key: 'user:cents', limits: { usd: 1 } };
      await store.reserve({ requestId: 'a', modelId: 'm', usd: 0.1, scopes: [scope] });
      await store.settle('a', { tokens: 0, usd: 0.01 });
      expect(await store.usage('user:cents')).toEqual({ tokens: 0, usd: 0.01 });
      expect(
        await store.reserve({ requestId: 'b', modelId: 'm', usd: 0.2, scopes: [scope] }),
      ).toEqual({ admitted: true, scopes: [{ key: 'user:cents', tokens: 0, usd: 0.21 }] });
      expect(
        await store.reserve({ requestId: 'b', modelId: 'm', usd: 0.2, scopes: [scope] }),
      ).toEqual({ admitted: true, scopes: [{ key: 'user:cents', tokens: 0, usd: 0.21 }] });
    });

    it('is idempotent by requestId and rejects a conflicting repeat', async () => {
      const { store } = await make();
      const input = { requestId: 'r', modelId: 'm', tokens: 60, scopes: [user(100)] };
      const first = await store.reserve(input);
      expect(await store.reserve({ ...input, scopes: [user(100)] })).toEqual(first);
      expect(await store.usage('user:1')).toEqual({ tokens: 60, usd: 0 });
      await expect(store.reserve({ ...input, tokens: 61 })).rejects.toThrow(/conflict/i);
      await expect(store.reserve({ ...input, modelId: 'other' })).rejects.toThrow(/conflict/i);
    });

    it('returns a recorded denial on repeat even after room frees up', async () => {
      const { store } = await make();
      await store.reserve({ requestId: 'a', modelId: 'm', tokens: 90, scopes: [user(100)] });
      const denial = await store.reserve({
        requestId: 'b',
        modelId: 'm',
        tokens: 20,
        scopes: [user(100)],
      });
      expect(denial).toMatchObject({ admitted: false });
      await store.release('a');
      expect(
        await store.reserve({ requestId: 'b', modelId: 'm', tokens: 20, scopes: [user(100)] }),
      ).toEqual(denial);
      expect(
        await store.reserve({ requestId: 'c', modelId: 'm', tokens: 20, scopes: [user(100)] }),
      ).toMatchObject({ admitted: true });
    });

    it('settles to actual amounts, idempotently', async () => {
      const { store } = await make();
      await store.reserve({
        requestId: 'r',
        modelId: 'm',
        tokens: 90,
        usd: 1,
        scopes: [user(100)],
      });
      await store.settle('r', { tokens: 15, usd: 0.25 });
      await store.settle('r', { tokens: 15, usd: 0.25 });
      expect(await store.usage('user:1')).toEqual({ tokens: 15, usd: 0.25 });
      await expect(store.settle('r', { tokens: 16, usd: 0.25 })).rejects.toThrow(/conflict/i);
      await expect(store.release('r')).rejects.toThrow(/billed/i);
      expect(
        await store.reserve({ requestId: 'next', modelId: 'm', tokens: 85, scopes: [user(100)] }),
      ).toMatchObject({ admitted: true });
    });

    it('releases unbilled holds once and refuses to settle a released request', async () => {
      const { store } = await make();
      await store.reserve({ requestId: 'r', modelId: 'm', tokens: 90, scopes: [user(100)] });
      await store.release('r');
      await store.release('r');
      expect(await store.usage('user:1')).toEqual({ tokens: 0, usd: 0 });
      await expect(store.settle('r', { tokens: 1, usd: 0 })).rejects.toThrow(/released/i);
      // A settled request with zero cost may still be released.
      await store.reserve({ requestId: 'z', modelId: 'm', tokens: 5, scopes: [user(100)] });
      await store.settle('z', { tokens: 0, usd: 0 });
      await store.release('z');
    });

    it('ignores settlement and release of requests it never admitted', async () => {
      const { store } = await make();
      await store.settle('missing', { tokens: 1, usd: 1 });
      await store.release('missing');
      await store.reserve({ requestId: 'a', modelId: 'm', tokens: 100, scopes: [user(100)] });
      await store.reserve({ requestId: 'denied', modelId: 'm', tokens: 1, scopes: [user(100)] });
      await store.settle('denied', { tokens: 1, usd: 0 });
      await store.release('denied');
      expect(await store.usage('user:1')).toEqual({ tokens: 100, usd: 0 });
    });

    it('frees windowed usage once it leaves the window, including leaked holds', async () => {
      const { store, advance } = await make();
      const scope = user(100, { key: 'user:w', window: WINDOW });
      await store.reserve({ requestId: 'settled', modelId: 'm', tokens: 50, scopes: [scope] });
      await store.settle('settled', { tokens: 50, usd: 0 });
      // Never settled or released: a hold leaked by a crash.
      await store.reserve({ requestId: 'leaked', modelId: 'm', tokens: 50, scopes: [scope] });
      expect(
        await store.reserve({ requestId: 'full', modelId: 'm', tokens: 1, scopes: [scope] }),
      ).toMatchObject({ admitted: false, committed: 100 });
      await advance(PAST_WINDOW);
      expect(
        await store.reserve({ requestId: 'later', modelId: 'm', tokens: 100, scopes: [scope] }),
      ).toEqual({ admitted: true, scopes: [{ key: 'user:w', tokens: 100, usd: 0 }] });
      // History still reports everything ever committed.
      expect(await store.usage('user:w')).toEqual({ tokens: 200, usd: 0 });
    });

    it('keeps a lifetime hold charged: leaked holds fail closed', async () => {
      const { store, advance } = await make();
      await store.reserve({ requestId: 'leaked', modelId: 'm', tokens: 100, scopes: [user(100)] });
      await advance(PAST_WINDOW);
      expect(
        await store.reserve({ requestId: 'r', modelId: 'm', tokens: 1, scopes: [user(100)] }),
      ).toMatchObject({ admitted: false, committed: 100 });
    });

    it('charges a late settlement to the reservation bucket, not the current window', async () => {
      const { store, advance } = await make();
      const scope = user(100, { key: 'user:late', window: WINDOW });
      await store.reserve({ requestId: 'slow', modelId: 'm', tokens: 10, scopes: [scope] });
      await advance(PAST_WINDOW);
      await store.settle('slow', { tokens: 90, usd: 0 });
      expect(
        await store.reserve({ requestId: 'r', modelId: 'm', tokens: 100, scopes: [scope] }),
      ).toMatchObject({ admitted: true });
      expect(await store.usage('user:late')).toEqual({ tokens: 190, usd: 0 });
    });

    it('reports usage since a point in time and by model', async () => {
      const { store, advance, now } = await make();
      const scope = user(1_000, { key: 'user:h', window: WINDOW });
      await store.reserve({
        requestId: 'a',
        modelId: 'alpha',
        tokens: 10,
        usd: 1,
        scopes: [scope],
      });
      await advance(PAST_WINDOW);
      const since = now();
      await store.reserve({ requestId: 'b', modelId: 'beta', tokens: 20, usd: 2, scopes: [scope] });
      await store.reserve({ requestId: 'c', modelId: 'alpha', tokens: 5, usd: 0, scopes: [scope] });
      expect(await store.usage('user:h', { byModel: true })).toEqual({
        tokens: 35,
        usd: 3,
        byModel: { alpha: { tokens: 15, usd: 1 }, beta: { tokens: 20, usd: 2 } },
      });
      expect(await store.usage('user:h', { since, byModel: true })).toEqual({
        tokens: 25,
        usd: 2,
        byModel: { alpha: { tokens: 5, usd: 0 }, beta: { tokens: 20, usd: 2 } },
      });
      expect(await store.usage('nobody')).toEqual({ tokens: 0, usd: 0 });
    });

    it('never over-admits concurrent reservations', async () => {
      const { store } = await make();
      const outcomes = await Promise.all(
        Array.from({ length: 10 }, (_, index) =>
          store.reserve({
            requestId: `c${index}`,
            modelId: 'm',
            tokens: 30,
            scopes: [user(100), { key: 'org:c', limits: { tokens: 1_000 } }],
          }),
        ),
      );
      expect(outcomes.filter((outcome) => outcome.admitted)).toHaveLength(3);
      expect(await store.usage('user:1')).toEqual({ tokens: 90, usd: 0 });
      expect(await store.usage('org:c')).toEqual({ tokens: 90, usd: 0 });
    });

    it('fixes a key to its first window', async () => {
      const { store } = await make();
      await store.reserve({
        requestId: 'a',
        modelId: 'm',
        tokens: 1,
        scopes: [user(100, { window: WINDOW })],
      });
      await expect(
        store.reserve({ requestId: 'b', modelId: 'm', tokens: 1, scopes: [user(100)] }),
      ).rejects.toThrow(/window/i);
      await expect(
        store.reserve({
          requestId: 'c',
          modelId: 'm',
          tokens: 1,
          scopes: [user(100, { window: { ms: 400, buckets: 2 } })],
        }),
      ).rejects.toThrow(/window/i);
    });

    it('rejects malformed requests', async () => {
      const { store } = await make();
      const ok = { requestId: 'r', modelId: 'm', tokens: 1, scopes: [user(100)] };
      await expect(store.reserve({ ...ok, requestId: '' })).rejects.toThrow();
      await expect(store.reserve({ ...ok, modelId: '' })).rejects.toThrow();
      await expect(store.reserve({ ...ok, scopes: [] })).rejects.toThrow();
      await expect(store.reserve({ ...ok, scopes: [user(100), user(50)] })).rejects.toThrow(
        /duplicate/i,
      );
      await expect(store.reserve({ ...ok, tokens: undefined })).rejects.toThrow(/estimate/i);
      await expect(store.reserve({ ...ok, tokens: -1 })).rejects.toThrow();
      await expect(
        store.reserve({ ...ok, scopes: [user(100, { window: { ms: 0 } })] }),
      ).rejects.toThrow();
      await expect(store.settle('r', { tokens: 1.5, usd: 0 })).rejects.toThrow();
      await expect(store.usage('')).rejects.toThrow();
    });
  });
}
