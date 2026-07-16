import { describe, it, expect } from 'vitest';
import { createApprovalSigner } from '../src/durable';
import type { ToolApprovalRequest } from '../src/types/tool';
import type { Clock } from '../src/types/deps';

const REQUEST: ToolApprovalRequest = {
  approvalId: 'toolu_1',
  toolCallId: 'toolu_1',
  toolName: 'deleteFile',
  input: { path: '/tmp/x' },
};

function fixedClock(now: number): Clock {
  return { now: () => now, setTimeout: () => () => {} };
}

describe('createApprovalSigner (WebCrypto HMAC-SHA256)', () => {
  it('sign → verify round-trips the payload (approval + runId + issuedAt)', async () => {
    const signer = createApprovalSigner({ secret: 's3cret', clock: fixedClock(1000) });
    const token = await signer.sign(REQUEST, { runId: 'run-1' });
    expect(typeof token).toBe('string');
    const payload = await signer.verify(token);
    expect(payload).toMatchObject({
      approvalId: 'toolu_1',
      toolCallId: 'toolu_1',
      toolName: 'deleteFile',
      input: { path: '/tmp/x' },
      runId: 'run-1',
      issuedAt: 1000,
    });
  });

  it('is deterministic for the same payload, secret, and clock', async () => {
    const a = createApprovalSigner({ secret: 's', clock: fixedClock(5) });
    const b = createApprovalSigner({ secret: 's', clock: fixedClock(5) });
    expect(await a.sign(REQUEST)).toBe(await b.sign(REQUEST));
  });

  it('rejects a tampered payload', async () => {
    const signer = createApprovalSigner({ secret: 's3cret', clock: fixedClock(0) });
    const token = await signer.sign(REQUEST);
    const [head, body, sig] = token.split('.');
    // Flip the payload to approve a DIFFERENT tool with the same signature.
    const forged = JSON.parse(atob(body!.replace(/-/g, '+').replace(/_/g, '/')));
    forged.toolName = 'transferMoney';
    const forgedB64 = btoa(JSON.stringify(forged))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    expect(await signer.verify(`${head}.${forgedB64}.${sig}`)).toBeNull();
  });

  it('rejects a token signed with a different secret', async () => {
    const alice = createApprovalSigner({ secret: 'alice', clock: fixedClock(0) });
    const mallory = createApprovalSigner({ secret: 'mallory', clock: fixedClock(0) });
    const token = await mallory.sign(REQUEST);
    expect(await alice.verify(token)).toBeNull();
  });

  it('rejects garbage tokens without throwing', async () => {
    const signer = createApprovalSigner({ secret: 's' });
    expect(await signer.verify('')).toBeNull();
    expect(await signer.verify('not-a-token')).toBeNull();
    expect(await signer.verify('a.b.c')).toBeNull();
    expect(await signer.verify('v1.%%%.###')).toBeNull();
  });

  it('enforces maxAgeMs against the injected clock', async () => {
    const signer = createApprovalSigner({ secret: 's', clock: fixedClock(1000) });
    const token = await signer.sign(REQUEST);
    const later = createApprovalSigner({ secret: 's', clock: fixedClock(61_000) });
    expect(await later.verify(token, { maxAgeMs: 60_000 })).toBeNull(); // expired
    expect(await later.verify(token, { maxAgeMs: 120_000 })).not.toBeNull(); // still valid
    expect(await later.verify(token)).not.toBeNull(); // no expiry by default
  });

  it('signs large payloads without a RangeError (loop-based base64, no spread)', async () => {
    const signer = createApprovalSigner({ secret: 's', clock: fixedClock(0) });
    const big: ToolApprovalRequest = { ...REQUEST, input: { body: 'x'.repeat(300_000) } };
    const token = await signer.sign(big);
    const payload = await signer.verify(token);
    expect((payload?.input as { body: string }).body).toHaveLength(300_000);
  });

  it('throws synchronously on an empty secret (no unhandled importKey rejection)', () => {
    expect(() => createApprovalSigner({ secret: '' })).toThrow(/secret/);
  });

  it('rejects tokens with trailing segments (strict three-part shape)', async () => {
    const signer = createApprovalSigner({ secret: 's', clock: fixedClock(0) });
    const token = await signer.sign(REQUEST);
    expect(await signer.verify(`${token}.extra`)).toBeNull();
    expect(await signer.verify(`${token}.`)).toBeNull();
  });
});
