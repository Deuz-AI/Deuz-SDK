import { describe, expect, it } from 'vitest';
import type { BudgetStore, PersistentBudgetScope } from '../../src/types/budget-store';

export interface BudgetStoreHarness {
  store: BudgetStore;
  /** Move the store's notion of time forward (a manual clock, or a real wait for database time). */
  advance(ms: number): Promise<void>;
  /** The store's current time in epoch milliseconds. */
  now(): number;
}

export interface BudgetStoreContractOptions {
  /** `advance` moves hours at no cost (a manual clock), which lifetime history needs. */
  hours?: boolean;
}

/** Window used by the expiry tests: four 100 ms buckets. */
const WINDOW = { ms: 400, buckets: 4 } as const;
const BUCKET = 100;
const PAST_WINDOW = 600;
/** A lifetime scope's history bucket (LIFETIME_BUCKET_MS). */
const HOUR = 3_600_000;

const user = (
  tokens: number,
  extra: Partial<PersistentBudgetScope> = {},
): PersistentBudgetScope => ({
  key: 'user:1',
  limits: { tokens },
  ...extra,
});

/** The BudgetStore contract (2.2), shared by the memory, SQLite and Postgres stores. */
export function budgetStoreContracts(
  name: string,
  make: () => Promise<BudgetStoreHarness>,
  options: BudgetStoreContractOptions = {},
): void {
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

    it('prunes finished request records before a time, never an open hold (2.3)', async () => {
      const { store, advance, now } = await make();
      const scope = user(100, { key: 'user:p', window: WINDOW });
      await store.reserve({ requestId: 'settled', modelId: 'm', tokens: 10, scopes: [scope] });
      await store.settle('settled', { tokens: 5, usd: 0 });
      await store.reserve({ requestId: 'released', modelId: 'm', tokens: 10, scopes: [scope] });
      await store.release('released');
      await store.reserve({ requestId: 'open', modelId: 'm', tokens: 80, scopes: [scope] });
      expect(
        await store.reserve({ requestId: 'denied', modelId: 'm', tokens: 50, scopes: [scope] }),
      ).toMatchObject({ admitted: false });
      await advance(PAST_WINDOW);
      const cut = now();
      await store.reserve({ requestId: 'late', modelId: 'm', tokens: 1, scopes: [scope] });
      expect(await store.prune!({ before: cut })).toMatchObject({ requests: 3 });
      // The open hold keeps its record: its settlement still corrects the usage.
      await store.settle('open', { tokens: 20, usd: 0 });
      expect(await store.usage('user:p')).toEqual({ tokens: 26, usd: 0 });
      // A pruned request is forgotten: a late settlement of it changes nothing.
      await store.settle('settled', { tokens: 99, usd: 0 });
      expect(await store.usage('user:p')).toEqual({ tokens: 26, usd: 0 });
      expect(await store.prune!({ before: cut })).toMatchObject({ requests: 1 });
    });

    it('folds closed history without changing usage or admission (2.3)', async () => {
      const { store, advance, now } = await make();
      const scope = user(100, { key: 'user:f', window: WINDOW });
      const settled = async (requestId: string, modelId: string, tokens: number, usd: number) => {
        await store.reserve({ requestId, modelId, tokens, usd, scopes: [scope] });
        await store.settle(requestId, { tokens, usd });
      };
      await settled('a', 'alpha', 10, 1);
      await advance(BUCKET);
      await settled('b', 'alpha', 20, 2);
      await advance(BUCKET);
      await settled('c', 'beta', 30, 0);
      await advance(PAST_WINDOW);
      const before = await store.usage('user:f', { byModel: true });
      // alpha's two buckets fold into one; beta has one bucket to keep.
      expect(await store.prune!({ before: now() })).toEqual({ requests: 3, buckets: 1 });
      expect(await store.usage('user:f', { byModel: true })).toEqual(before);
      expect(
        await store.reserve({ requestId: 'd', modelId: 'm', tokens: 100, scopes: [scope] }),
      ).toMatchObject({ admitted: true });
      expect(await store.prune!({ before: now() })).toEqual({ requests: 0, buckets: 0 });
    });

    it('leaves the bucket of an open hold for its settlement (2.3)', async () => {
      const { store, advance, now } = await make();
      const scope = user(100, { key: 'user:k', window: WINDOW });
      await store.reserve({ requestId: 'open', modelId: 'm', tokens: 10, scopes: [scope] });
      await advance(BUCKET);
      await store.reserve({ requestId: 'b', modelId: 'm', tokens: 20, scopes: [scope] });
      await store.settle('b', { tokens: 20, usd: 0 });
      await advance(BUCKET);
      await store.reserve({ requestId: 'c', modelId: 'm', tokens: 30, scopes: [scope] });
      await store.settle('c', { tokens: 30, usd: 0 });
      await advance(PAST_WINDOW);
      expect(await store.prune!({ before: now() })).toEqual({ requests: 2, buckets: 1 });
      await store.settle('open', { tokens: 1, usd: 0 });
      expect(await store.usage('user:k')).toEqual({ tokens: 51, usd: 0 });
    });

    it('never prunes what admission still counts (2.3)', async () => {
      const { store, now } = await make();
      const scope = user(100, { key: 'user:n', window: { ms: 60_000, buckets: 60 } });
      await store.reserve({ requestId: 'a', modelId: 'm', tokens: 60, scopes: [scope] });
      await store.settle('a', { tokens: 60, usd: 0 });
      await store.reserve({ requestId: 'b', modelId: 'm', tokens: 40, scopes: [scope] });
      await store.settle('b', { tokens: 40, usd: 0 });
      await store.reserve({ requestId: 'l', modelId: 'm', tokens: 100, scopes: [user(100)] });
      await store.settle('l', { tokens: 100, usd: 0 });
      // A `before` in the future still spares the open window and the lifetime total.
      expect(await store.prune!({ before: now() + 86_400_000 })).toEqual({
        requests: 3,
        buckets: 0,
      });
      expect(
        await store.reserve({ requestId: 'c', modelId: 'm', tokens: 1, scopes: [scope] }),
      ).toMatchObject({ admitted: false, committed: 100 });
      expect(
        await store.reserve({ requestId: 'd', modelId: 'm', tokens: 1, scopes: [user(100)] }),
      ).toMatchObject({ admitted: false, committed: 100 });
      await expect(store.prune!({ before: Number.NaN })).rejects.toThrow(/before/);
      await expect(store.prune!(undefined as never)).rejects.toThrow();
    });

    it.skipIf(!options.hours)(
      'folds lifetime history per model and keeps its total (2.3)',
      async () => {
        const { store, advance, now } = await make();
        for (let hour = 0; hour < 4; hour++) {
          const requestId = `h${hour}`;
          const modelId = hour % 2 ? 'beta' : 'alpha';
          await store.reserve({ requestId, modelId, tokens: 10, usd: 0.1, scopes: [user(1_000)] });
          await store.settle(requestId, { tokens: 10, usd: 0.1 });
          await advance(HOUR);
        }
        await advance(HOUR);
        const before = await store.usage('user:1', { byModel: true });
        expect(await store.prune!({ before: now() })).toEqual({ requests: 4, buckets: 2 });
        expect(await store.usage('user:1', { byModel: true })).toEqual(before);
        expect(
          await store.reserve({ requestId: 'x', modelId: 'm', tokens: 961, scopes: [user(1_000)] }),
        ).toMatchObject({ admitted: false, committed: 40 });
      },
    );

    it('lists the holds still open before a time, oldest first, a page at a time (2.3)', async () => {
      const { store, advance, now } = await make();
      const scope = user(1_000, { key: 'user:h' });
      const org = { key: 'org:h', limits: { tokens: 10_000 } };
      await store.reserve({
        requestId: 'b',
        modelId: 'm1',
        tokens: 10,
        usd: 0.5,
        scopes: [scope, org],
      });
      await advance(10);
      await store.reserve({ requestId: 'a', modelId: 'm2', tokens: 20, scopes: [scope] });
      await store.reserve({ requestId: 'settled', modelId: 'm', tokens: 5, scopes: [scope] });
      await store.settle('settled', { tokens: 5, usd: 0 });
      expect(
        await store.reserve({ requestId: 'denied', modelId: 'm', tokens: 5_000, scopes: [scope] }),
      ).toMatchObject({ admitted: false });
      await advance(10);
      const cut = now();
      await store.reserve({ requestId: 'late', modelId: 'm', tokens: 1, scopes: [scope] });

      const holds = await store.holds!({ before: cut });
      expect(holds).toEqual([
        {
          requestId: 'b',
          modelId: 'm1',
          tokens: 10,
          usd: 0.5,
          reservedAt: expect.any(Number),
          keys: ['user:h', 'org:h'],
        },
        {
          requestId: 'a',
          modelId: 'm2',
          tokens: 20,
          usd: 0,
          reservedAt: expect.any(Number),
          keys: ['user:h'],
        },
      ]);
      expect(holds[0]!.reservedAt).toBeLessThan(holds[1]!.reservedAt);
      expect(holds[1]!.reservedAt).toBeLessThan(cut);
      const [first] = await store.holds!({ before: cut, limit: 1 });
      expect(first?.requestId).toBe('b');
      expect(
        (await store.holds!({ before: cut, limit: 1, after: first })).map((hold) => hold.requestId),
      ).toEqual(['a']);
      expect(await store.holds!({ before: cut, after: holds[1] })).toEqual([]);
      expect((await store.holds!({ before: now() + 1 })).map((hold) => hold.requestId)).toEqual([
        'b',
        'a',
        'late',
      ]);
      await expect(store.holds!({ before: Number.NaN })).rejects.toThrow(/before/);
      await expect(store.holds!({ before: cut, limit: 0 })).rejects.toThrow(/limit/);
    });

    it('sweeps stale holds: settles their estimate by default, or as a resolver says (2.3)', async () => {
      const { store, advance, now } = await make();
      const scope = user(1_000, { key: 'user:s' });
      for (const requestId of ['crashed', 'unsent', 'known']) {
        await store.reserve({ requestId, modelId: 'm', tokens: 30, scopes: [scope] });
        await advance(10);
      }
      const cut = now();
      await store.reserve({ requestId: 'fresh', modelId: 'm', tokens: 10, scopes: [scope] });
      const seen: string[] = [];
      expect(
        await store.sweep!({
          before: cut,
          resolve: (hold) => {
            seen.push(hold.requestId);
            if (hold.requestId === 'unsent') return 'release';
            return hold.requestId === 'known' ? { tokens: 12, usd: 0 } : 'settle';
          },
        }),
      ).toEqual({ settled: 2, released: 1, skipped: 0 });
      expect(seen).toEqual(['crashed', 'unsent', 'known']);
      expect(await store.usage('user:s')).toEqual({ tokens: 30 + 12 + 10, usd: 0 });
      expect((await store.holds!({ before: now() + 1 })).map((hold) => hold.requestId)).toEqual([
        'fresh',
      ]);
      expect(await store.sweep!({ before: cut })).toEqual({ settled: 0, released: 0, skipped: 0 });
      expect(await store.sweep!({ before: now() + 1 })).toEqual({
        settled: 1,
        released: 0,
        skipped: 0,
      });
      expect(await store.usage('user:s')).toEqual({ tokens: 52, usd: 0 });
      expect(await store.holds!({ before: now() + 1 })).toEqual([]);
    });

    it('recovers a lifetime budget from a hold leaked by a crash (2.3)', async () => {
      const { store, now } = await make();
      await store.reserve({ requestId: 'leaked', modelId: 'm', tokens: 100, scopes: [user(100)] });
      expect(
        await store.reserve({ requestId: 'r', modelId: 'm', tokens: 1, scopes: [user(100)] }),
      ).toMatchObject({ admitted: false, committed: 100 });
      // The call never reached the provider, so its hold is released.
      expect(await store.sweep!({ before: now() + 1, resolve: 'release' })).toEqual({
        settled: 0,
        released: 1,
        skipped: 0,
      });
      expect(
        await store.reserve({ requestId: 'r2', modelId: 'm', tokens: 1, scopes: [user(100)] }),
      ).toMatchObject({ admitted: true });
    });

    it('skips holds a resolver keeps or their caller closes meanwhile, up to its limit (2.3)', async () => {
      const { store, advance, now } = await make();
      const scope = user(1_000, { key: 'user:r' });
      for (const requestId of ['a', 'b', 'c', 'd']) {
        await store.reserve({ requestId, modelId: 'm', tokens: 10, scopes: [scope] });
        await advance(10);
      }
      const cut = now();
      expect(
        await store.sweep!({
          before: cut,
          limit: 3,
          resolve: async (hold) => {
            // 'b' is settled by its own caller while the sweep looks at 'a'.
            if (hold.requestId === 'a') {
              await store.settle('b', { tokens: 1, usd: 0 });
              return 'keep';
            }
            return 'release';
          },
        }),
      ).toEqual({ settled: 0, released: 1, skipped: 2 });
      expect((await store.holds!({ before: cut })).map((hold) => hold.requestId)).toEqual([
        'a',
        'd',
      ]);
      await expect(store.sweep!({ before: Number.NaN })).rejects.toThrow(/before/);
      await expect(store.sweep!({ before: cut, limit: 0 })).rejects.toThrow(/limit/);
      await expect(store.sweep!({ before: cut, resolve: 'drop' as never })).rejects.toThrow(
        /resolve/,
      );
      await expect(
        store.sweep!({ before: cut, resolve: () => ({ tokens: -1, usd: 0 }) }),
      ).rejects.toThrow();
    });
  });
}
