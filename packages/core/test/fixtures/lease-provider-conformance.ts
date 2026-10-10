import { describe, expect, it } from 'vitest';
import type { LeaseProvider } from '../../src/types/lease';

/**
 * The lease contract (2.2). `make` returns a provider plus `advance`, which
 * moves the provider's notion of time forward: an injected clock for memory
 * and SQLite, a real wait for providers that use database time. `now` reads
 * that time.
 */
export function leaseProviderContracts(
  name: string,
  make: () => Promise<{
    provider: LeaseProvider;
    advance(ms: number): Promise<void>;
    ttl: number;
    now(): number;
  }>,
): void {
  describe(name, () => {
    it('grants a free key and refuses it to another owner', async () => {
      const { provider, ttl } = await make();
      const lease = await provider.acquire({ key: 'run', owner: 'a', ttlMs: ttl });
      expect(lease).toMatchObject({ key: 'run', owner: 'a', token: 1 });
      expect(await provider.acquire({ key: 'run', owner: 'b', ttlMs: ttl })).toBeUndefined();
      expect(await provider.acquire({ key: 'other', owner: 'b', ttlMs: ttl })).toMatchObject({
        token: 1,
      });
    });

    it('hands an expired lease to another owner with a higher token', async () => {
      const { provider, advance, ttl } = await make();
      const first = (await provider.acquire({ key: 'run', owner: 'a', ttlMs: ttl }))!;
      await advance(ttl * 2);
      const second = await provider.acquire({ key: 'run', owner: 'b', ttlMs: ttl });
      expect(second).toMatchObject({ owner: 'b', token: 2 });
      expect(await provider.renew(first, ttl)).toEqual({ held: false });
    });

    it('renews a held lease, delivers each signal once, and keeps a lapsed one nobody took', async () => {
      const { provider, advance, ttl } = await make();
      const lease = (await provider.acquire({ key: 'run', owner: 'a', ttlMs: ttl }))!;
      expect(await provider.signal('run', 'drain')).toBe(true);
      const renewed = await provider.renew(lease, ttl);
      expect(renewed).toMatchObject({ held: true, signals: ['drain'] });
      if (!renewed.held) throw new Error('unreachable');
      expect(renewed.lease.expiresAt).toBeGreaterThanOrEqual(lease.expiresAt);
      expect(await provider.renew(renewed.lease, ttl)).toMatchObject({ held: true, signals: [] });
      await advance(ttl * 2);
      expect(await provider.renew(renewed.lease, ttl)).toMatchObject({
        held: true,
        lease: { token: 1 },
      });
    });

    it('keeps a queued cancel for the next holder and delivers it once', async () => {
      const { provider, advance, ttl } = await make();
      const first = (await provider.acquire({ key: 'run', owner: 'a', ttlMs: ttl }))!;
      expect(await provider.signal('run', 'cancel')).toBe(true);
      expect(await provider.signal('run', 'drain')).toBe(true);
      // The holder dies before its next renewal and the key changes hands.
      await advance(ttl * 2);
      const second = (await provider.acquire({ key: 'run', owner: 'b', ttlMs: ttl }))!;
      expect(second).toMatchObject({ owner: 'b', token: 2 });
      // The cancel concerns the run and survives; the drain concerned the dead holder.
      expect(await provider.renew(second, ttl)).toMatchObject({ held: true, signals: ['cancel'] });
      expect(await provider.renew(second, ttl)).toMatchObject({ held: true, signals: [] });
      expect(await provider.renew(first, ttl)).toEqual({ held: false });
    });

    it('keeps a queued cancel across a release, but not a drain', async () => {
      const { provider, ttl } = await make();
      const first = (await provider.acquire({ key: 'run', owner: 'a', ttlMs: ttl }))!;
      expect(await provider.signal('run', 'drain')).toBe(true);
      expect(await provider.signal('run', 'cancel')).toBe(true);
      // The holder settles before its next renewal delivers the signals.
      await provider.release(first);
      expect(await provider.signal('run', 'cancel')).toBe(false);
      const second = (await provider.acquire({ key: 'run', owner: 'b', ttlMs: ttl }))!;
      expect(await provider.renew(second, ttl)).toMatchObject({ held: true, signals: ['cancel'] });
      // Delivered once: the next holder starts clean.
      await provider.release(second);
      const third = (await provider.acquire({ key: 'run', owner: 'c', ttlMs: ttl }))!;
      expect(await provider.renew(third, ttl)).toMatchObject({ held: true, signals: [] });
    });

    it('releases only its own token and keeps tokens increasing', async () => {
      const { provider, ttl } = await make();
      const lease = (await provider.acquire({ key: 'run', owner: 'a', ttlMs: ttl }))!;
      await provider.release({ ...lease, token: 99 });
      expect(await provider.acquire({ key: 'run', owner: 'b', ttlMs: ttl })).toBeUndefined();
      await provider.release(lease);
      expect(await provider.acquire({ key: 'run', owner: 'b', ttlMs: ttl })).toMatchObject({
        owner: 'b',
        token: 2,
      });
      expect(await provider.renew(lease, ttl)).toEqual({ held: false });
    });

    it('signals only a held key', async () => {
      const { provider, advance, ttl } = await make();
      expect(await provider.signal('nobody', 'cancel')).toBe(false);
      await provider.acquire({ key: 'run', owner: 'a', ttlMs: ttl });
      await advance(ttl * 2);
      expect(await provider.signal('run', 'cancel')).toBe(false);
    });

    it('rejects malformed requests', async () => {
      const { provider, ttl } = await make();
      await expect(provider.acquire({ key: '', owner: 'a', ttlMs: ttl })).rejects.toThrow();
      await expect(provider.acquire({ key: 'run', owner: '', ttlMs: ttl })).rejects.toThrow();
      await expect(provider.acquire({ key: 'run', owner: 'a', ttlMs: 0 })).rejects.toThrow();
      await expect(provider.acquire({ key: 'run', owner: 'a', ttlMs: 1.5 })).rejects.toThrow();
    });
  });

  describe(`${name}: acknowledged delivery (2.3)`, () => {
    const ack = (provider: LeaseProvider) => {
      if (!provider.ack) throw new Error('This provider cannot acknowledge a cancel');
      return provider.ack.bind(provider);
    };

    it('keeps a delivered cancel queued until the holder acknowledges it', async () => {
      const { provider, ttl } = await make();
      const lease = (await provider.acquire({ key: 'run', owner: 'a', ttlMs: ttl }))!;
      expect(await provider.signal('run', 'cancel')).toBe(true);
      const first = await provider.renew(lease, ttl, { acknowledge: true });
      expect(first).toMatchObject({ held: true, signals: ['cancel'], queued: ['cancel'] });
      // Delivered again on every renewal until it is acknowledged.
      expect(await provider.renew(lease, ttl, { acknowledge: true })).toMatchObject({
        held: true,
        signals: ['cancel'],
        queued: ['cancel'],
      });
      expect(await ack(provider)(lease, 'cancel')).toBe(true);
      expect(await provider.renew(lease, ttl, { acknowledge: true })).toMatchObject({
        held: true,
        signals: [],
        queued: [],
      });
    });

    it('hands a cancel its holder never acknowledged to the next holder', async () => {
      const { provider, advance, ttl } = await make();
      const first = (await provider.acquire({ key: 'run', owner: 'a', ttlMs: ttl }))!;
      expect(await provider.signal('run', 'cancel')).toBe(true);
      expect(await provider.renew(first, ttl, { acknowledge: true })).toMatchObject({
        signals: ['cancel'],
      });
      // The holder dies before it records the cancel; the key changes hands.
      await advance(ttl * 2);
      const second = (await provider.acquire({ key: 'run', owner: 'b', ttlMs: ttl }))!;
      expect(second).toMatchObject({ owner: 'b', token: 2 });
      expect(await provider.renew(second, ttl, { acknowledge: true })).toMatchObject({
        held: true,
        signals: ['cancel'],
      });
      // A stale holder's acknowledgement removes nothing.
      expect(await ack(provider)(first, 'cancel')).toBe(false);
      expect(await provider.renew(second, ttl, { acknowledge: true })).toMatchObject({
        signals: ['cancel'],
      });
    });

    it('keeps an unacknowledged cancel across a lapse and a release, with nobody to re-queue it', async () => {
      const { provider, advance, ttl } = await make();
      const first = (await provider.acquire({ key: 'run', owner: 'a', ttlMs: ttl }))!;
      expect(await provider.signal('run', 'cancel')).toBe(true);
      expect(await provider.renew(first, ttl, { acknowledge: true })).toMatchObject({
        signals: ['cancel'],
      });
      // The holder's lease lapses: nobody holds the key, so nobody can signal it.
      await advance(ttl * 2);
      expect(await provider.signal('run', 'cancel')).toBe(false);
      const second = (await provider.acquire({ key: 'run', owner: 'b', ttlMs: ttl }))!;
      expect(await provider.renew(second, ttl, { acknowledge: true })).toMatchObject({
        signals: ['cancel'],
      });
      // Released without an acknowledgement, it waits for the next holder too.
      await provider.release(second);
      const third = (await provider.acquire({ key: 'run', owner: 'c', ttlMs: ttl }))!;
      expect(await provider.renew(third, ttl, { acknowledge: true })).toMatchObject({
        signals: ['cancel'],
      });
    });

    it('accepts an acknowledgement from a lapsed lease nobody took over', async () => {
      const { provider, advance, ttl } = await make();
      const first = (await provider.acquire({ key: 'run', owner: 'a', ttlMs: ttl }))!;
      expect(await provider.signal('run', 'cancel')).toBe(true);
      await provider.renew(first, ttl, { acknowledge: true });
      await advance(ttl * 2);
      expect(await ack(provider)(first, 'cancel')).toBe(true);
      const second = (await provider.acquire({ key: 'run', owner: 'b', ttlMs: ttl }))!;
      expect(await provider.renew(second, ttl, { acknowledge: true })).toMatchObject({
        signals: [],
        queued: [],
      });
    });

    it('delivers a drain once, and an acknowledgement leaves a queued drain alone', async () => {
      const { provider, ttl } = await make();
      const lease = (await provider.acquire({ key: 'run', owner: 'a', ttlMs: ttl }))!;
      expect(await provider.signal('run', 'drain')).toBe(true);
      expect(await provider.renew(lease, ttl, { acknowledge: true })).toMatchObject({
        signals: ['drain'],
        queued: [],
      });
      expect(await provider.renew(lease, ttl, { acknowledge: true })).toMatchObject({
        signals: [],
      });
      expect(await provider.signal('run', 'cancel')).toBe(true);
      await provider.renew(lease, ttl, { acknowledge: true });
      expect(await provider.signal('run', 'drain')).toBe(true);
      expect(await ack(provider)(lease, 'cancel')).toBe(true);
      expect(await provider.renew(lease, ttl, { acknowledge: true })).toMatchObject({
        signals: ['drain'],
        queued: [],
      });
    });

    it('lets a renewal without acknowledgement consume a kept cancel, as in 2.2', async () => {
      const { provider, ttl } = await make();
      const lease = (await provider.acquire({ key: 'run', owner: 'a', ttlMs: ttl }))!;
      expect(await provider.signal('run', 'cancel')).toBe(true);
      await provider.renew(lease, ttl, { acknowledge: true });
      const consumed = await provider.renew(lease, ttl);
      expect(consumed).toMatchObject({ held: true, signals: ['cancel'] });
      expect(consumed).not.toHaveProperty('queued');
      expect(await provider.renew(lease, ttl, { acknowledge: true })).toMatchObject({
        signals: [],
      });
    });

    it('acknowledges only a cancel', async () => {
      const { provider, ttl } = await make();
      const lease = (await provider.acquire({ key: 'run', owner: 'a', ttlMs: ttl }))!;
      expect(await ack(provider)(lease, 'cancel')).toBe(true);
      await expect(ack(provider)(lease, 'drain' as 'cancel')).rejects.toThrow(TypeError);
      expect(await ack(provider)({ ...lease, key: 'nobody' }, 'cancel')).toBe(false);
    });
  });

  describe(`${name}: retention (2.3)`, () => {
    it('prunes the keys nobody holds, but not a held key or a queued cancel', async () => {
      const { provider, advance, ttl, now } = await make();
      if (!provider.prune) throw new Error('This provider cannot prune');
      const released = (await provider.acquire({ key: 'released', owner: 'a', ttlMs: ttl }))!;
      await provider.release(released);
      const lapsed = (await provider.acquire({ key: 'lapsed', owner: 'a', ttlMs: ttl }))!;
      const cancelled = (await provider.acquire({ key: 'cancelled', owner: 'a', ttlMs: ttl }))!;
      expect(await provider.signal('cancelled', 'cancel')).toBe(true);
      await provider.release(cancelled);
      await advance(ttl * 2);
      const held = (await provider.acquire({ key: 'held', owner: 'a', ttlMs: ttl * 10 }))!;
      expect(await provider.prune(now())).toBe(2);
      // A holder whose lease lapsed that long ago finds it lost; a new one starts over.
      expect(await provider.renew(lapsed, ttl)).toEqual({ held: false });
      expect(await provider.acquire({ key: 'released', owner: 'b', ttlMs: ttl })).toMatchObject({
        owner: 'b',
        token: 1,
      });
      // The queued cancel still reaches the next holder of its run.
      const next = (await provider.acquire({ key: 'cancelled', owner: 'b', ttlMs: ttl }))!;
      expect(await provider.renew(next, ttl)).toMatchObject({ held: true, signals: ['cancel'] });
      expect(await provider.renew(held, ttl)).toMatchObject({ held: true });
      expect(await provider.prune(now())).toBe(0);
      await expect(provider.prune(Number.NaN)).rejects.toThrow(TypeError);
    });
  });
}
