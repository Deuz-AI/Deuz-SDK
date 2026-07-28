import { describe, it, expect, beforeAll } from 'vitest';
import { streamChat } from '../src/index';
import {
  createVertexAnthropic,
  createVertexGoogle,
  createServiceAccountKeyProvider,
  CLOUD_PLATFORM_SCOPE,
  type ServiceAccountCredentials,
} from '../src/vertex';
import { AuthenticationError } from '../src/errors';
import type { Clock } from '../src/types/deps';
import { sseResponse, sseEvents, mockFetch } from './fixtures/sse';

const ANTHROPIC_OK = sseEvents([
  {
    event: 'message_start',
    data: { type: 'message_start', message: { usage: { input_tokens: 4, output_tokens: 1 } } },
  },
  {
    event: 'content_block_start',
    data: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  },
  {
    event: 'content_block_delta',
    data: {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: 'vertex ok' },
    },
  },
  {
    event: 'message_delta',
    data: {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn' },
      usage: { output_tokens: 2 },
    },
  },
  { event: 'message_stop', data: { type: 'message_stop' } },
]);

const CC_OK = sseEvents([
  { data: { choices: [{ delta: { content: 'hi' }, finish_reason: 'stop' }] } },
  { data: { choices: [], usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 } } },
  { data: '[DONE]' },
]);

function drain(stream: AsyncIterable<unknown>): Promise<void> {
  return (async () => {
    for await (const _ of stream) void _;
  })();
}

describe('Vertex AI — Claude on Vertex (reuses Anthropic wire)', () => {
  it('builds the Vertex rawPredict URL + Bearer + anthropic_version, no model in body', async () => {
    const { fetch, calls } = mockFetch(() => sseResponse([ANTHROPIC_OK]));
    const vertexAnthropic = createVertexAnthropic({
      project: 'my-proj',
      location: 'us-east5',
      accessToken: 'ya29.token',
      fetch,
    });
    const result = streamChat({
      model: vertexAnthropic('claude-sonnet-4-5'),
      messages: [{ role: 'user', content: 'hi' }],
    });
    let text = '';
    for await (const c of result.textStream) text += c;
    expect(text).toBe('vertex ok'); // parse path is reused

    const { url, init } = calls[0]!;
    expect(url).toBe(
      'https://us-east5-aiplatform.googleapis.com/v1/projects/my-proj/locations/us-east5/publishers/anthropic/models/claude-sonnet-4-5:streamRawPredict',
    );
    const headers = init!.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer ya29.token');
    expect(headers['x-api-key']).toBeUndefined();
    expect(headers['anthropic-version']).toBeUndefined();

    const body = JSON.parse(String(init!.body));
    expect(body.anthropic_version).toBe('vertex-2023-10-16');
    expect(body.model).toBeUndefined(); // model lives in the URL on Vertex
    expect(body.max_tokens).toBeDefined();
  });

  it('uses the global host when location is "global"', async () => {
    const { fetch, calls } = mockFetch(() => sseResponse([ANTHROPIC_OK]));
    const v = createVertexAnthropic({ project: 'p', location: 'global', accessToken: 't', fetch });
    await drain(
      streamChat({ model: v('claude-opus-4-1'), messages: [{ role: 'user', content: 'hi' }] })
        .fullStream,
    );
    expect(calls[0]!.url).toContain(
      'https://aiplatform.googleapis.com/v1/projects/p/locations/global/',
    );
  });
});

describe('Vertex AI — Gemini on Vertex (reuses Chat Completions wire)', () => {
  it('builds the openapi chat/completions URL + Bearer', async () => {
    const { fetch, calls } = mockFetch(() => sseResponse([CC_OK]));
    const vertexGoogle = createVertexGoogle({
      project: 'my-proj',
      location: 'us-central1',
      accessToken: 'ya29.token',
      fetch,
    });
    const result = streamChat({
      model: vertexGoogle('google/gemini-2.5-flash'),
      messages: [{ role: 'user', content: 'hi' }],
    });
    let text = '';
    for await (const c of result.textStream) text += c;
    expect(text).toBe('hi');

    const { url, init } = calls[0]!;
    expect(url).toBe(
      'https://us-central1-aiplatform.googleapis.com/v1beta1/projects/my-proj/locations/us-central1/endpoints/openapi/chat/completions',
    );
    expect((init!.headers as Record<string, string>).authorization).toBe('Bearer ya29.token');
    const body = JSON.parse(String(init!.body));
    expect(body.model).toBe('google/gemini-2.5-flash');
  });
});

// ===========================================================================
// Service-account OAuth2 key provider (1.9)
//
// The RSA keypair is generated with WebCrypto INSIDE the run — no PEM is ever
// committed, not even an expired one. One keypair is shared by every case
// (2048-bit keygen is the slow part); isolation comes from a UNIQUE
// `client_email` per case, which is what the token cache is keyed by.
// ===========================================================================

const TOKEN_URI = 'https://oauth2.googleapis.com/token';

let keyPair: CryptoKeyPair;
let privateKeyPem: string;
let emailCounter = 0;

/** A fresh service-account identity over the shared keypair (fresh cache entry). */
function serviceAccount(overrides: Partial<ServiceAccountCredentials> = {}) {
  emailCounter += 1;
  return {
    client_email: `sa-${emailCounter}@my-proj.iam.gserviceaccount.com`,
    private_key: privateKeyPem,
    ...overrides,
  } satisfies ServiceAccountCredentials;
}

function toPem(der: Uint8Array, label = 'PRIVATE KEY'): string {
  let binary = '';
  for (const byte of der) binary += String.fromCharCode(byte);
  const wrapped = btoa(binary)
    .match(/.{1,64}/g)!
    .join('\n');
  return `-----BEGIN ${label}-----\n${wrapped}\n-----END ${label}-----\n`;
}

beforeAll(async () => {
  keyPair = (await crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair;
  privateKeyPem = toPem(new Uint8Array(await crypto.subtle.exportKey('pkcs8', keyPair.privateKey)));
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** A recording fetch over a handler — the token endpoint is plain JSON, not SSE. */
function recordingFetch(handler: (call: number) => Response) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return handler(calls.length - 1);
  }) as typeof fetch;
  return { fetch: fn, calls };
}

/** A clock whose `now` is a plain mutable cell (no fake timers needed). */
function stepClock(start = 1_700_000_000_000): Clock & { set(t: number): void } {
  let t = start;
  return {
    now: () => t,
    setTimeout: (fn, ms) => (setTimeout(fn, ms), () => {}),
    set(next: number) {
      t = next;
    },
  };
}

/** `KeyProvider.getKey` may return a bare value, so await rather than `.then`. */
async function rejection(value: unknown): Promise<unknown> {
  try {
    await value;
    return undefined;
  } catch (error) {
    return error;
  }
}

function b64urlToString(segment: string): string {
  const b64 = segment.replace(/-/g, '+').replace(/_/g, '/');
  return atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
}

/** Pull the `assertion` out of a recorded token-endpoint request. */
function assertionOf(init: RequestInit | undefined): {
  header: Record<string, unknown>;
  claims: Record<string, unknown>;
  signingInput: string;
  signature: Uint8Array;
} {
  const raw = new URLSearchParams(String(init!.body)).get('assertion')!;
  const [h, c, s] = raw.split('.');
  const binary = b64urlToString(s!);
  const signature = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) signature[i] = binary.charCodeAt(i);
  return {
    header: JSON.parse(b64urlToString(h!)) as Record<string, unknown>,
    claims: JSON.parse(b64urlToString(c!)) as Record<string, unknown>,
    signingInput: `${h}.${c}`,
    signature,
  };
}

describe('Vertex AI — service-account key provider (1.9)', () => {
  it('signs an RS256 JWT assertion with the documented claims and exchanges it', async () => {
    const credentials = serviceAccount();
    const { fetch, calls } = recordingFetch(() =>
      jsonResponse({ access_token: 'ya29.minted', expires_in: 3599, token_type: 'Bearer' }),
    );
    const clock = stepClock();
    const keyProvider = createServiceAccountKeyProvider({ credentials, clock, fetch });

    await expect(keyProvider.getKey('vertex-anthropic')).resolves.toBe('ya29.minted');
    expect(calls).toHaveLength(1);

    const { url, init } = calls[0]!;
    expect(url).toBe(TOKEN_URI);
    expect(init!.method).toBe('POST');
    expect((init!.headers as Record<string, string>)['content-type']).toBe(
      'application/x-www-form-urlencoded',
    );
    const form = new URLSearchParams(String(init!.body));
    expect(form.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer');

    const { header, claims, signingInput, signature } = assertionOf(init);
    expect(header).toEqual({ alg: 'RS256', typ: 'JWT' });
    expect(claims.iss).toBe(credentials.client_email);
    expect(claims.scope).toBe(CLOUD_PLATFORM_SCOPE);
    expect(claims.aud).toBe(TOKEN_URI);
    // iat/exp come from the INJECTED clock — never Date.now().
    expect(claims.iat).toBe(1_700_000_000);
    expect(claims.exp).toBe(1_700_000_000 + 3600);

    // Really RS256 over the real key, not just a well-shaped string.
    await expect(
      crypto.subtle.verify(
        'RSASSA-PKCS1-v1_5',
        keyPair.publicKey,
        signature as unknown as ArrayBuffer,
        new TextEncoder().encode(signingInput),
      ),
    ).resolves.toBe(true);
  });

  it('caches the token before expiry and refreshes once inside the skew window', async () => {
    const { fetch, calls } = recordingFetch((n) =>
      jsonResponse({ access_token: `ya29.token-${n}`, expires_in: 3600 }),
    );
    const clock = stepClock(0);
    const keyProvider = createServiceAccountKeyProvider({
      credentials: serviceAccount(),
      clock,
      fetch,
    });

    expect(await keyProvider.getKey('vertex-google')).toBe('ya29.token-0');
    // Well inside the window: cached, no second exchange.
    clock.set(3_000_000);
    expect(await keyProvider.getKey('vertex-google')).toBe('ya29.token-0');
    // One millisecond before the 60s skew boundary: still cached.
    clock.set(3_539_999);
    expect(await keyProvider.getKey('vertex-google')).toBe('ya29.token-0');
    expect(calls).toHaveLength(1);

    // At the boundary (expiresAt - refreshSkewMs) it refreshes.
    clock.set(3_540_000);
    expect(await keyProvider.getKey('vertex-google')).toBe('ya29.token-1');
    expect(calls).toHaveLength(2);
    // The refreshed token is itself cached from the NEW now().
    expect(await keyProvider.getKey('vertex-google')).toBe('ya29.token-1');
    expect(calls).toHaveLength(2);
  });

  it('honours a custom refreshSkewMs', async () => {
    const { fetch, calls } = recordingFetch((n) =>
      jsonResponse({ access_token: `ya29.skew-${n}`, expires_in: 3600 }),
    );
    const clock = stepClock(0);
    const keyProvider = createServiceAccountKeyProvider({
      credentials: serviceAccount(),
      clock,
      fetch,
      refreshSkewMs: 600_000,
    });
    expect(await keyProvider.getKey('vertex-google')).toBe('ya29.skew-0');
    clock.set(2_999_999);
    expect(await keyProvider.getKey('vertex-google')).toBe('ya29.skew-0');
    clock.set(3_000_000);
    expect(await keyProvider.getKey('vertex-google')).toBe('ya29.skew-1');
    expect(calls).toHaveLength(2);
  });

  it('never lets two service accounts share a cached token', async () => {
    const first = serviceAccount();
    const second = serviceAccount();
    expect(first.client_email).not.toBe(second.client_email);

    const seen: string[] = [];
    let minted = 0;
    const makeFetch = (): typeof fetch =>
      (async (_input: RequestInfo | URL, init?: RequestInit) => {
        seen.push(String(assertionOf(init).claims.iss));
        return jsonResponse({ access_token: `ya29.sa-${minted++}`, expires_in: 3600 });
      }) as typeof fetch;

    const clock = stepClock(0);
    const a = createServiceAccountKeyProvider({ credentials: first, clock, fetch: makeFetch() });
    const b = createServiceAccountKeyProvider({ credentials: second, clock, fetch: makeFetch() });

    expect(await a.getKey('vertex-anthropic')).toBe('ya29.sa-0');
    expect(await b.getKey('vertex-anthropic')).toBe('ya29.sa-1');
    // Each identity signed its own assertion and kept its own token.
    expect(seen).toEqual([first.client_email, second.client_email]);
    expect(await a.getKey('vertex-anthropic')).toBe('ya29.sa-0');
    expect(await b.getKey('vertex-anthropic')).toBe('ya29.sa-1');
    expect(seen).toHaveLength(2);
  });

  it('keys the cache by scopes too — a different scope set mints its own token', async () => {
    const credentials = serviceAccount();
    const { fetch, calls } = recordingFetch((n) =>
      jsonResponse({ access_token: `ya29.scoped-${n}`, expires_in: 3600 }),
    );
    const clock = stepClock(0);
    const wide = createServiceAccountKeyProvider({ credentials, clock, fetch });
    const narrow = createServiceAccountKeyProvider({
      credentials,
      clock,
      fetch,
      scopes: ['https://www.googleapis.com/auth/devstorage.read_only'],
    });
    expect(await wide.getKey('vertex-google')).toBe('ya29.scoped-0');
    expect(await narrow.getKey('vertex-google')).toBe('ya29.scoped-1');
    expect(await wide.getKey('vertex-google')).toBe('ya29.scoped-0');
    expect(calls).toHaveLength(2);
    expect(assertionOf(calls[1]!.init).claims.scope).toBe(
      'https://www.googleapis.com/auth/devstorage.read_only',
    );
  });

  it('coalesces concurrent misses into ONE token exchange', async () => {
    let served = 0;
    const fetchImpl = (async () => {
      served += 1;
      await new Promise((r) => setTimeout(r, 5));
      return jsonResponse({ access_token: 'ya29.single', expires_in: 3600 });
    }) as typeof fetch;
    const keyProvider = createServiceAccountKeyProvider({
      credentials: serviceAccount(),
      clock: stepClock(0),
      fetch: fetchImpl,
    });
    const tokens = await Promise.all([
      keyProvider.getKey('vertex-google'),
      keyProvider.getKey('vertex-google'),
      keyProvider.getKey('vertex-anthropic'),
    ]);
    expect(tokens).toEqual(['ya29.single', 'ya29.single', 'ya29.single']);
    expect(served).toBe(1);
  });

  it('returns undefined for non-Vertex providers so G1 falls through to their own key', async () => {
    const { fetch, calls } = recordingFetch(() => jsonResponse({ access_token: 'x' }));
    const keyProvider = createServiceAccountKeyProvider({
      credentials: serviceAccount(),
      clock: stepClock(),
      fetch,
    });
    expect(await keyProvider.getKey('openai')).toBeUndefined();
    expect(await keyProvider.getKey('anthropic')).toBeUndefined();
    expect(await keyProvider.getKey('google')).toBeUndefined(); // AI Studio uses an API key
    expect(calls).toHaveLength(0);

    // …and an opted-in custom provider name is answered.
    const scoped = createServiceAccountKeyProvider({
      credentials: serviceAccount(),
      clock: stepClock(),
      fetch,
      providers: ['my-vertex-proxy'],
    });
    expect(await scoped.getKey('my-vertex-proxy')).toBe('x');
    expect(await scoped.getKey('vertex-google')).toBeUndefined();
  });

  it('accepts a `\\n`-escaped PEM (the env-var round trip)', async () => {
    const { fetch } = recordingFetch(() =>
      jsonResponse({ access_token: 'ya29.env', expires_in: 3600 }),
    );
    const keyProvider = createServiceAccountKeyProvider({
      credentials: serviceAccount({ private_key: privateKeyPem.replace(/\n/g, '\\n') }),
      clock: stepClock(),
      fetch,
    });
    await expect(keyProvider.getKey('vertex-anthropic')).resolves.toBe('ya29.env');
  });

  it('honours `token_uri` from the credentials file (aud follows it)', async () => {
    const tokenUri = 'https://oauth2.example-gdc.internal/token';
    const { fetch, calls } = recordingFetch(() =>
      jsonResponse({ access_token: 'ya29.gdc', expires_in: 3600 }),
    );
    const keyProvider = createServiceAccountKeyProvider({
      credentials: serviceAccount({ token_uri: tokenUri }),
      clock: stepClock(),
      fetch,
    });
    expect(await keyProvider.getKey('vertex-google')).toBe('ya29.gdc');
    expect(calls[0]!.url).toBe(tokenUri);
    expect(assertionOf(calls[0]!.init).claims.aud).toBe(tokenUri);
  });

  it('feeds the minted token into the Vertex wire as the Bearer (G1: keyProvider wins)', async () => {
    const token = recordingFetch(() =>
      jsonResponse({ access_token: 'ya29.wire', expires_in: 3600 }),
    );
    const model = mockFetch(() => sseResponse([ANTHROPIC_OK]));
    const keyProvider = createServiceAccountKeyProvider({
      credentials: serviceAccount(),
      clock: stepClock(),
      fetch: token.fetch,
    });
    // No `accessToken` on the factory at all — the provider is the only key source.
    const vertexAnthropic = createVertexAnthropic({
      project: 'p',
      location: 'us-east5',
      fetch: model.fetch,
    });
    await drain(
      streamChat({
        model: vertexAnthropic('claude-sonnet-4-5'),
        messages: [{ role: 'user', content: 'hi' }],
        deps: { keyProvider },
      }).fullStream,
    );
    expect((model.calls[0]!.init!.headers as Record<string, string>).authorization).toBe(
      'Bearer ya29.wire',
    );
    expect(token.calls).toHaveLength(1);
  });
});

describe('Vertex AI — service-account failures stay actionable and key-free (P0)', () => {
  const PEM_BODY = () => privateKeyPem.split('\n')[1]!;

  it.each([
    [400, { error: 'invalid_grant', error_description: 'Invalid JWT Signature.' }],
    [401, { error: 'unauthorized_client', error_description: 'Client is unauthorized.' }],
  ])('maps HTTP %i from the token endpoint to AuthenticationError', async (status, body) => {
    const credentials = serviceAccount();
    const { fetch, calls } = recordingFetch(() => jsonResponse(body, status));
    const keyProvider = createServiceAccountKeyProvider({
      credentials,
      clock: stepClock(),
      fetch,
    });

    const error = await rejection(keyProvider.getKey('vertex-anthropic'));
    expect(error).toBeInstanceOf(AuthenticationError);
    const authError = error as AuthenticationError;
    expect(authError.statusCode).toBe(status);
    expect(authError.isRetryable).toBe(false);
    expect(authError.upstreamType).toBe(body.error);
    expect(authError.message).toContain(`HTTP ${status}`);
    expect(authError.message).toContain(body.error);
    // Actionable: names the identity, the scopes and the clock-skew trap.
    expect(authError.message).toContain(credentials.client_email);
    expect(authError.message).toContain('clock');

    // P0: no key material anywhere in the message or its JSON form — and no
    // echo of the REQUEST body, which carries the signed JWT assertion.
    const sentAssertion = new URLSearchParams(String(calls[0]!.init!.body)).get('assertion')!;
    const serialized = `${authError.message}${JSON.stringify(authError.toJSON())}`;
    expect(serialized).not.toContain('BEGIN PRIVATE KEY');
    expect(serialized).not.toContain(PEM_BODY());
    expect(serialized).not.toContain(sentAssertion);
    expect(serialized).not.toContain(sentAssertion.split('.')[2]!);
  });

  it('reports a token-endpoint 5xx without echoing the request body', async () => {
    const { fetch } = recordingFetch(
      () => new Response('upstream boom', { status: 503, statusText: 'Service Unavailable' }),
    );
    const keyProvider = createServiceAccountKeyProvider({
      credentials: serviceAccount(),
      clock: stepClock(),
      fetch,
    });
    await expect(keyProvider.getKey('vertex-google')).rejects.toThrow(/HTTP 503/);
  });

  it('surfaces a transport failure as AuthenticationError with statusCode 0', async () => {
    const fetchImpl = (async () => {
      throw new TypeError('fetch failed');
    }) as typeof fetch;
    const keyProvider = createServiceAccountKeyProvider({
      credentials: serviceAccount(),
      clock: stepClock(),
      fetch: fetchImpl,
    });
    const error = await rejection(keyProvider.getKey('vertex-google'));
    expect(error).toBeInstanceOf(AuthenticationError);
    expect((error as AuthenticationError).statusCode).toBe(0);
    expect((error as AuthenticationError).message).toContain('oauth2.googleapis.com/token');
  });

  it('rejects a non-PEM private_key without quoting it', async () => {
    const keyProvider = createServiceAccountKeyProvider({
      credentials: serviceAccount({ private_key: 'super-secret-not-a-pem' }),
      clock: stepClock(),
      fetch: recordingFetch(() => jsonResponse({ access_token: 'x' })).fetch,
    });
    const error = await rejection(keyProvider.getKey('vertex-google'));
    expect(error).toBeInstanceOf(AuthenticationError);
    expect((error as AuthenticationError).message).toContain('not a PEM block');
    expect((error as AuthenticationError).message).not.toContain('super-secret-not-a-pem');
  });

  it('tells a PKCS#1 key holder exactly how to convert it, key bytes excluded', async () => {
    const pkcs1Labelled = toPem(
      new Uint8Array(await crypto.subtle.exportKey('pkcs8', keyPair.privateKey)),
      'RSA PRIVATE KEY',
    );
    const keyProvider = createServiceAccountKeyProvider({
      credentials: serviceAccount({ private_key: pkcs1Labelled }),
      clock: stepClock(),
      fetch: recordingFetch(() => jsonResponse({ access_token: 'x' })).fetch,
    });
    const error = await rejection(keyProvider.getKey('vertex-google'));
    expect(error).toBeInstanceOf(AuthenticationError);
    const message = (error as AuthenticationError).message;
    expect(message).toContain('RSA PRIVATE KEY');
    expect(message).toContain('openssl pkcs8 -topk8 -nocrypt');
    expect(message).not.toContain(PEM_BODY());
  });

  it('rejects a 200 with no access_token, and a missing credential field at construction', async () => {
    const keyProvider = createServiceAccountKeyProvider({
      credentials: serviceAccount(),
      clock: stepClock(),
      fetch: recordingFetch(() => jsonResponse({ token_type: 'Bearer' })).fetch,
    });
    await expect(keyProvider.getKey('vertex-google')).rejects.toThrow(/without an `access_token`/);

    expect(() =>
      createServiceAccountKeyProvider({
        credentials: { client_email: 'sa@p.iam.gserviceaccount.com', private_key: '' },
        clock: stepClock(),
        fetch: recordingFetch(() => jsonResponse({})).fetch,
      }),
    ).toThrow(TypeError);
  });
});
