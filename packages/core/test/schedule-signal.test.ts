import { createHash, createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  createInMemoryClaim,
  handleSignal,
  verifyGitHubWebhook,
  verifyHmacSignature,
  verifySlackRequest,
} from '../src/schedule';
import type { SignalVerification } from '../src/schedule';

const secret = "It's a Secret to Everybody";
const payload = '{"action":"opened","number":1}';
const hmac = (algorithm: string, key: string, data: string) =>
  createHmac(algorithm, key).update(data);

describe('verifyHmacSignature', () => {
  it('accepts a matching hex SHA-256 signature and returns the body', async () => {
    const signature = hmac('sha256', secret, payload).digest('hex');
    await expect(verifyHmacSignature({ body: payload, signature, secret })).resolves.toEqual({
      ok: true,
      body: payload,
    });
  });

  it('accepts upper-case hex', async () => {
    const signature = hmac('sha256', secret, payload).digest('hex').toUpperCase();
    const result = await verifyHmacSignature({ body: payload, signature, secret });
    expect(result.ok).toBe(true);
  });

  it('rejects a tampered body', async () => {
    const signature = hmac('sha256', secret, payload).digest('hex');
    const result = await verifyHmacSignature({ body: `${payload} `, signature, secret });
    expect(result).toEqual({ ok: false, reason: 'bad-signature' });
  });

  it('rejects the wrong secret', async () => {
    const signature = hmac('sha256', 'other', payload).digest('hex');
    const result = await verifyHmacSignature({ body: payload, signature, secret });
    expect(result).toEqual({ ok: false, reason: 'bad-signature' });
  });

  it('supports other algorithms and encodings', async () => {
    const b64 = hmac('sha1', secret, payload).digest('base64');
    const b64url = hmac('sha512', secret, payload).digest('base64url');
    const sha384 = hmac('sha384', secret, payload).digest('hex');
    await expect(
      verifyHmacSignature({
        body: payload,
        signature: b64,
        secret,
        algorithm: 'SHA-1',
        encoding: 'base64',
      }),
    ).resolves.toMatchObject({ ok: true });
    await expect(
      verifyHmacSignature({
        body: payload,
        signature: b64url,
        secret,
        algorithm: 'SHA-512',
        encoding: 'base64url',
      }),
    ).resolves.toMatchObject({ ok: true });
    await expect(
      verifyHmacSignature({ body: payload, signature: sha384, secret, algorithm: 'SHA-384' }),
    ).resolves.toMatchObject({ ok: true });
  });

  it('accepts byte bodies and byte secrets', async () => {
    const key = new Uint8Array([1, 2, 3, 4]);
    const body = new TextEncoder().encode(payload);
    const signature = createHmac('sha256', key).update(body).digest('hex');
    await expect(verifyHmacSignature({ body, signature, secret: key })).resolves.toEqual({
      ok: true,
      body: payload,
    });
  });

  it('requires the prefix when one is given', async () => {
    const hex = hmac('sha256', secret, payload).digest('hex');
    await expect(
      verifyHmacSignature({ body: payload, signature: `sha256=${hex}`, secret, prefix: 'sha256=' }),
    ).resolves.toMatchObject({ ok: true });
    await expect(
      verifyHmacSignature({ body: payload, signature: hex, secret, prefix: 'sha256=' }),
    ).resolves.toEqual({ ok: false, reason: 'malformed-signature' });
  });

  it.each([
    [null, 'missing-signature'],
    [undefined, 'missing-signature'],
    ['', 'missing-signature'],
    ['zz', 'malformed-signature'],
    ['abc', 'malformed-signature'],
    ['abcd', 'bad-signature'],
  ] as const)('classifies signature %j as %s', async (signature, reason) => {
    await expect(verifyHmacSignature({ body: payload, signature, secret })).resolves.toEqual({
      ok: false,
      reason,
    });
  });

  it('rejects malformed base64', async () => {
    await expect(
      verifyHmacSignature({ body: payload, signature: '***', secret, encoding: 'base64' }),
    ).resolves.toEqual({ ok: false, reason: 'malformed-signature' });
  });

  it('throws on an empty secret or an unknown algorithm', async () => {
    await expect(
      verifyHmacSignature({ body: payload, signature: 'ab', secret: '' }),
    ).rejects.toThrow(TypeError);
    await expect(
      verifyHmacSignature({
        body: payload,
        signature: 'ab',
        secret,
        algorithm: 'MD5' as unknown as 'SHA-1',
      }),
    ).rejects.toThrow(TypeError);
  });
});

function githubRequest(body: string, signature?: string): Request {
  const headers = new Headers({ 'content-type': 'application/json' });
  if (signature !== undefined) headers.set('x-hub-signature-256', signature);
  return new Request('https://example.test/hooks/github', { method: 'POST', body, headers });
}

describe('verifyGitHubWebhook', () => {
  it('accepts a correctly signed delivery and reads the body once', async () => {
    const request = githubRequest(
      payload,
      `sha256=${hmac('sha256', secret, payload).digest('hex')}`,
    );
    await expect(verifyGitHubWebhook(request, secret)).resolves.toEqual({
      ok: true,
      body: payload,
    });
    expect(request.bodyUsed).toBe(true);
  });

  it('matches the example in the GitHub documentation', async () => {
    const request = githubRequest(
      'Hello, World!',
      'sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17',
    );
    await expect(verifyGitHubWebhook(request, secret)).resolves.toMatchObject({ ok: true });
  });

  it('rejects a tampered body', async () => {
    const signature = `sha256=${hmac('sha256', secret, payload).digest('hex')}`;
    const request = githubRequest(payload.replace('opened', 'closed'), signature);
    await expect(verifyGitHubWebhook(request, secret)).resolves.toEqual({
      ok: false,
      reason: 'bad-signature',
    });
  });

  it('rejects a missing or unprefixed header', async () => {
    await expect(verifyGitHubWebhook(githubRequest(payload), secret)).resolves.toEqual({
      ok: false,
      reason: 'missing-signature',
    });
    const bare = hmac('sha256', secret, payload).digest('hex');
    await expect(verifyGitHubWebhook(githubRequest(payload, bare), secret)).resolves.toEqual({
      ok: false,
      reason: 'malformed-signature',
    });
  });

  it('refuses a request whose body was already read', async () => {
    const request = githubRequest(
      payload,
      `sha256=${hmac('sha256', secret, payload).digest('hex')}`,
    );
    await request.text();
    await expect(verifyGitHubWebhook(request, secret)).resolves.toEqual({
      ok: false,
      reason: 'body-used',
    });
  });
});

const slackSecret = '8f742231b10e8888abcd99yyyzzz85a5';
const slackBody = 'token=xyzz0WbapA4vBCDEFasx0q6G&team_id=T1DC2JH3J&command=%2Fweather&text=94070';

function slackRequest(body: string, timestamp: string | undefined, signature?: string): Request {
  const headers = new Headers({ 'content-type': 'application/x-www-form-urlencoded' });
  if (timestamp !== undefined) headers.set('x-slack-request-timestamp', timestamp);
  if (signature !== undefined) headers.set('x-slack-signature', signature);
  return new Request('https://example.test/slack', { method: 'POST', body, headers });
}

function slackSign(timestamp: string, body: string, key = slackSecret): string {
  return `v0=${hmac('sha256', key, `v0:${timestamp}:${body}`).digest('hex')}`;
}

describe('verifySlackRequest', () => {
  const ts = '1531420618';
  const now = Number(ts) * 1000 + 30_000;

  it('accepts a fresh, correctly signed request', async () => {
    const request = slackRequest(slackBody, ts, slackSign(ts, slackBody));
    await expect(verifySlackRequest(request, slackSecret, { now })).resolves.toEqual({
      ok: true,
      body: slackBody,
    });
  });

  it('rejects a timestamp outside the replay window, both ways', async () => {
    const stale = slackRequest(slackBody, ts, slackSign(ts, slackBody));
    await expect(
      verifySlackRequest(stale, slackSecret, { now: Number(ts) * 1000 + 301_000 }),
    ).resolves.toEqual({ ok: false, reason: 'stale-timestamp' });
    const future = slackRequest(slackBody, ts, slackSign(ts, slackBody));
    await expect(
      verifySlackRequest(future, slackSecret, { now: Number(ts) * 1000 - 301_000 }),
    ).resolves.toEqual({ ok: false, reason: 'stale-timestamp' });
  });

  it('honours a custom tolerance', async () => {
    const request = slackRequest(slackBody, ts, slackSign(ts, slackBody));
    await expect(
      verifySlackRequest(request, slackSecret, { now, toleranceSeconds: 10 }),
    ).resolves.toEqual({ ok: false, reason: 'stale-timestamp' });
  });

  it('rejects a tampered body or a replayed signature with a new timestamp', async () => {
    const tampered = slackRequest(`${slackBody}&x=1`, ts, slackSign(ts, slackBody));
    await expect(verifySlackRequest(tampered, slackSecret, { now })).resolves.toEqual({
      ok: false,
      reason: 'bad-signature',
    });
    const newer = String(Number(ts) + 10);
    const replayed = slackRequest(slackBody, newer, slackSign(ts, slackBody));
    await expect(verifySlackRequest(replayed, slackSecret, { now })).resolves.toEqual({
      ok: false,
      reason: 'bad-signature',
    });
  });

  it('classifies missing and malformed headers', async () => {
    await expect(
      verifySlackRequest(slackRequest(slackBody, undefined, 'v0=ab'), slackSecret, { now }),
    ).resolves.toEqual({ ok: false, reason: 'missing-timestamp' });
    await expect(
      verifySlackRequest(slackRequest(slackBody, 'soon', 'v0=ab'), slackSecret, { now }),
    ).resolves.toEqual({ ok: false, reason: 'malformed-timestamp' });
    await expect(
      verifySlackRequest(slackRequest(slackBody, ts), slackSecret, { now }),
    ).resolves.toEqual({ ok: false, reason: 'missing-signature' });
  });

  it('requires now', async () => {
    const request = slackRequest(slackBody, ts, slackSign(ts, slackBody));
    await expect(
      verifySlackRequest(request, slackSecret, {} as unknown as { now: number }),
    ).rejects.toThrow(TypeError);
  });
});

describe('handleSignal', () => {
  const accept = (body: string) => async (): Promise<SignalVerification> => ({ ok: true, body });
  const post = (body = payload) =>
    new Request('https://example.test/hook', { method: 'POST', body });

  it('answers 401 for a bad signature without dispatching', async () => {
    const dispatch = vi.fn();
    const response = await handleSignal(post(), {
      verify: async () => ({ ok: false, reason: 'bad-signature' }),
      dispatch,
    });
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ ok: false, reason: 'bad-signature' });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('answers 202 after dispatching the verified body', async () => {
    const dispatch = vi.fn();
    // Unsigned: rejected by the real verifier.
    const unsigned = await handleSignal(post(), {
      verify: (r) => verifyGitHubWebhook(r, secret),
      dispatch,
    });
    expect(unsigned.status).toBe(401);

    const signed = githubRequest(
      payload,
      `sha256=${hmac('sha256', secret, payload).digest('hex')}`,
    );
    const accepted = await handleSignal(signed, {
      verify: (r) => verifyGitHubWebhook(r, secret),
      dispatch,
    });
    expect(accepted.status).toBe(202);
    const expectedKey = `sha256:${createHash('sha256').update(payload).digest('hex')}`;
    expect(await accepted.json()).toEqual({ ok: true, key: expectedKey });
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch.mock.calls[0]?.[0]).toMatchObject({ body: payload, key: expectedKey });
    expect(dispatch.mock.calls[0]?.[0].request).toBe(signed);
  });

  it('answers 200 for a duplicate and dispatches once', async () => {
    const dispatch = vi.fn();
    const dedupe = createInMemoryClaim();
    const options = { verify: accept(payload), dedupe, dispatch };
    const first = await handleSignal(post(), options);
    const second = await handleSignal(post(), options);
    expect(first.status).toBe(202);
    expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({ ok: true, duplicate: true });
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it('uses a caller-derived key, e.g. the delivery id', async () => {
    const dispatch = vi.fn();
    const dedupe = createInMemoryClaim();
    const request = new Request('https://example.test/hook', {
      method: 'POST',
      body: payload,
      headers: { 'x-github-delivery': 'd-1' },
    });
    const response = await handleSignal(request, {
      verify: accept(payload),
      dedupe,
      key: ({ request: r }) => r.headers.get('x-github-delivery') ?? undefined,
      dispatch,
    });
    expect(response.status).toBe(202);
    expect(dispatch.mock.calls[0]?.[0].key).toBe('d-1');
    expect(await dedupe('d-1')).toBe(false);
  });

  describe('when dispatch throws', () => {
    const delivery = () =>
      new Request('https://example.test/hook', {
        method: 'POST',
        body: payload,
        headers: { 'x-github-delivery': 'd-1' },
      });
    const byDelivery = ({ request }: { request: Request }) =>
      request.headers.get('x-github-delivery') ?? undefined;
    const failingOnce = () => {
      let calls = 0;
      return vi.fn(async () => {
        if (++calls === 1) throw new Error('queue full');
      });
    };

    it("releases the claimed key, so the sender's retry dispatches", async () => {
      const dispatch = failingOnce();
      const options = {
        verify: accept(payload),
        dedupe: createInMemoryClaim(),
        key: byDelivery,
        dispatch,
      };
      const first = await handleSignal(delivery(), options);
      expect(first.status).toBe(500);
      expect(await first.json()).toEqual({ ok: false, reason: 'dispatch-error' });
      const retry = await handleSignal(delivery(), options);
      expect(retry.status).toBe(202);
      expect(await retry.json()).toEqual({ ok: true, key: 'd-1' });
      expect(dispatch).toHaveBeenCalledTimes(2);
      // Dispatched once successfully: the next redelivery is a duplicate.
      const again = await handleSignal(delivery(), options);
      expect(again.status).toBe(200);
      expect(dispatch).toHaveBeenCalledTimes(2);
    });

    it('keeps the key of a claim without release (a plain function)', async () => {
      const seen = new Set<string>();
      const dedupe = (key: string) => !seen.has(key) && Boolean(seen.add(key));
      const dispatch = failingOnce();
      const options = { verify: accept(payload), dedupe, key: byDelivery, dispatch };
      expect((await handleSignal(delivery(), options)).status).toBe(500);
      expect((await handleSignal(delivery(), options)).status).toBe(200);
      expect(dispatch).toHaveBeenCalledTimes(1);
    });

    it('still answers 500 when the release itself fails', async () => {
      const dedupe = Object.assign(() => true, {
        release: vi.fn(async () => {
          throw new Error('claim store down');
        }),
      });
      const response = await handleSignal(delivery(), {
        verify: accept(payload),
        dedupe,
        key: byDelivery,
        dispatch: failingOnce(),
      });
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ ok: false, reason: 'dispatch-error' });
      expect(dedupe.release).toHaveBeenCalledWith('d-1');
    });

    it('never releases a key it did not claim', async () => {
      const dedupe = Object.assign(() => false, { release: vi.fn() });
      const response = await handleSignal(delivery(), {
        verify: accept(payload),
        dedupe,
        key: byDelivery,
        dispatch: failingOnce(),
      });
      expect(response.status).toBe(200);
      expect(dedupe.release).not.toHaveBeenCalled();
    });
  });

  it('answers 500 when verify, dedupe or dispatch throws', async () => {
    const verifyThrows = await handleSignal(post(), {
      verify: () => {
        throw new Error('misconfigured');
      },
      dispatch: () => {},
    });
    expect(verifyThrows.status).toBe(500);
    expect(await verifyThrows.json()).toEqual({ ok: false, reason: 'verify-error' });

    const dedupeThrows = await handleSignal(post(), {
      verify: accept(payload),
      dedupe: () => {
        throw new Error('db down');
      },
      dispatch: () => {},
    });
    expect(await dedupeThrows.json()).toEqual({ ok: false, reason: 'dedupe-error' });
    expect(dedupeThrows.status).toBe(500);

    const keyThrows = await handleSignal(post(), {
      verify: accept(payload),
      key: () => {
        throw new Error('bad header');
      },
      dispatch: () => {},
    });
    expect(keyThrows.status).toBe(500);
    expect(await keyThrows.json()).toEqual({ ok: false, reason: 'key-error' });

    const dispatchThrows = await handleSignal(post(), {
      verify: accept(payload),
      dispatch: async () => {
        throw new Error('queue full');
      },
    });
    expect(dispatchThrows.status).toBe(500);
    expect(await dispatchThrows.json()).toEqual({ ok: false, reason: 'dispatch-error' });
  });
});
