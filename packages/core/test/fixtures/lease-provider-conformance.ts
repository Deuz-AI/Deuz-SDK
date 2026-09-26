import { describe, expect, it } from 'vitest';
import type { LeaseProvider } from '../../src/types/lease';

/**
 * The lease contract (2.2). `make` returns a provider plus `advance`, which
 * moves the provider's notion of time forward: an injected clock for memory
 * and SQLite, a real wait for providers that use database time.
 */
export function leaseProviderContracts(
  name: string,
  make: () => Promise<{ provider: LeaseProvider; advance(ms: number): Promise<void>; ttl: number }>,
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
}
