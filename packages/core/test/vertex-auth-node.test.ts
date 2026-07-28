/**
 * `./vertex/node` — Application Default Credentials.
 *
 * Hermetic by construction: the RSA keypair is generated with WebCrypto inside
 * the run (no committed PEM), credential files live in a real tmpdir, and the
 * metadata server is ALWAYS a stubbed fetch — nothing here touches 169.254.169.254
 * or oauth2.googleapis.com. Each metadata case uses its own `metadataHost` so the
 * module-level token cache cannot leak between tests.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAdcKeyProvider } from '../src/node/vertex-auth';
import { AuthenticationError } from '../src/errors';
import type { Clock } from '../src/types/deps';

const TOKEN_URI = 'https://oauth2.googleapis.com/token';
const METADATA_PATH = '/computeMetadata/v1/instance/service-accounts/default/token';

let dir: string;
let privateKeyPem: string;
let emailCounter = 0;

const clock: Clock = { now: () => 1_700_000_000_000, setTimeout: () => () => {} };

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'deuz-vertex-adc-'));
  const pair = (await crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair;
  const der = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey));
  let binary = '';
  for (const byte of der) binary += String.fromCharCode(byte);
  privateKeyPem = `-----BEGIN PRIVATE KEY-----\n${btoa(binary)
    .match(/.{1,64}/g)!
    .join('\n')}\n-----END PRIVATE KEY-----\n`;
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Write a service-account JSON key file and return its path + identity. */
async function writeKeyFile(name: string): Promise<{ path: string; email: string }> {
  emailCounter += 1;
  const email = `adc-${emailCounter}@my-proj.iam.gserviceaccount.com`;
  const path = join(dir, name);
  await writeFile(
    path,
    JSON.stringify({
      type: 'service_account',
      project_id: 'my-proj',
      client_email: email,
      private_key: privateKeyPem,
      token_uri: TOKEN_URI,
    }),
    'utf8',
  );
  return { path, email };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function recordingFetch(handler: (call: number) => Response) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return handler(calls.length - 1);
  }) as typeof fetch;
  return { fetch: fn, calls };
}

/** `iss` of the JWT assertion in a recorded token-endpoint request. */
function issuerOf(init: RequestInit | undefined): string {
  const assertion = new URLSearchParams(String(init!.body)).get('assertion')!;
  const claims = assertion.split('.')[1]!.replace(/-/g, '+').replace(/_/g, '/');
  const json = atob(claims + '='.repeat((4 - (claims.length % 4)) % 4));
  return (JSON.parse(json) as { iss: string }).iss;
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

describe('createAdcKeyProvider — credential resolution order', () => {
  it('prefers an explicit keyFile over GOOGLE_APPLICATION_CREDENTIALS', async () => {
    const explicit = await writeKeyFile('explicit.json');
    const fromEnv = await writeKeyFile('from-env.json');
    const { fetch, calls } = recordingFetch(() =>
      jsonResponse({ access_token: 'ya29.explicit', expires_in: 3600 }),
    );

    const keyProvider = createAdcKeyProvider({
      keyFile: explicit.path,
      env: { GOOGLE_APPLICATION_CREDENTIALS: fromEnv.path },
      clock,
      fetch,
    });

    expect(await keyProvider.getKey('vertex-anthropic')).toBe('ya29.explicit');
    expect(calls[0]!.url).toBe(TOKEN_URI);
    expect(issuerOf(calls[0]!.init)).toBe(explicit.email);
    expect(issuerOf(calls[0]!.init)).not.toBe(fromEnv.email);
  });

  it('falls back to GOOGLE_APPLICATION_CREDENTIALS when no keyFile is given', async () => {
    const fromEnv = await writeKeyFile('env-only.json');
    const { fetch, calls } = recordingFetch(() =>
      jsonResponse({ access_token: 'ya29.env', expires_in: 3600 }),
    );
    const keyProvider = createAdcKeyProvider({
      env: { GOOGLE_APPLICATION_CREDENTIALS: fromEnv.path },
      clock,
      fetch,
    });
    expect(await keyProvider.getKey('vertex-google')).toBe('ya29.env');
    expect(issuerOf(calls[0]!.init)).toBe(fromEnv.email);
  });

  it('reads the REAL process.env when no `env` override is passed', async () => {
    const fromEnv = await writeKeyFile('real-env.json');
    const previous = process.env.GOOGLE_APPLICATION_CREDENTIALS;
    process.env.GOOGLE_APPLICATION_CREDENTIALS = fromEnv.path;
    try {
      const { fetch, calls } = recordingFetch(() =>
        jsonResponse({ access_token: 'ya29.real-env', expires_in: 3600 }),
      );
      const keyProvider = createAdcKeyProvider({ clock, fetch });
      expect(await keyProvider.getKey('vertex-anthropic')).toBe('ya29.real-env');
      expect(issuerOf(calls[0]!.init)).toBe(fromEnv.email);
    } finally {
      if (previous === undefined) delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
      else process.env.GOOGLE_APPLICATION_CREDENTIALS = previous;
    }
  });

  it('falls back to the metadata server and caches its token', async () => {
    const { fetch, calls } = recordingFetch((n) =>
      jsonResponse({ access_token: `ya29.metadata-${n}`, expires_in: 3600 }),
    );
    const keyProvider = createAdcKeyProvider({
      env: {},
      clock,
      fetch,
      metadataHost: 'metadata-test-cache.internal',
    });

    expect(await keyProvider.getKey('vertex-google')).toBe('ya29.metadata-0');
    expect(calls[0]!.url).toBe(`http://metadata-test-cache.internal${METADATA_PATH}`);
    expect((calls[0]!.init!.headers as Record<string, string>)['metadata-flavor']).toBe('Google');
    // No `scopes` query for the DEFAULT scope: a narrowed GCE instance would
    // reject cloud-platform where "whatever you have" succeeds.
    expect(calls[0]!.url).not.toContain('scopes=');

    expect(await keyProvider.getKey('vertex-anthropic')).toBe('ya29.metadata-0');
    expect(calls).toHaveLength(1);
  });

  it('forwards EXPLICIT scopes to the metadata server', async () => {
    const { fetch, calls } = recordingFetch(() =>
      jsonResponse({ access_token: 'ya29.scoped', expires_in: 3600 }),
    );
    const keyProvider = createAdcKeyProvider({
      env: {},
      clock,
      fetch,
      metadataHost: 'metadata-test-scopes.internal',
      scopes: ['https://www.googleapis.com/auth/cloud-platform.read-only'],
    });
    expect(await keyProvider.getKey('vertex-google')).toBe('ya29.scoped');
    expect(calls[0]!.url).toContain(
      `?scopes=${encodeURIComponent('https://www.googleapis.com/auth/cloud-platform.read-only')}`,
    );
  });

  it('honours GCE_METADATA_HOST', async () => {
    const { fetch, calls } = recordingFetch(() =>
      jsonResponse({ access_token: 'ya29.host', expires_in: 3600 }),
    );
    const keyProvider = createAdcKeyProvider({
      env: { GCE_METADATA_HOST: '169.254.169.254' },
      clock,
      fetch,
    });
    expect(await keyProvider.getKey('vertex-google')).toBe('ya29.host');
    expect(calls[0]!.url).toBe(`http://169.254.169.254${METADATA_PATH}`);
  });

  it('returns undefined for non-Vertex providers without reading a credential (G1)', async () => {
    const { fetch, calls } = recordingFetch(() => jsonResponse({ access_token: 'nope' }));
    const keyProvider = createAdcKeyProvider({
      keyFile: join(dir, 'does-not-exist.json'),
      env: {},
      clock,
      fetch,
    });
    expect(await keyProvider.getKey('openai')).toBeUndefined();
    expect(await keyProvider.getKey('anthropic')).toBeUndefined();
    expect(await keyProvider.getKey('google')).toBeUndefined();
    expect(calls).toHaveLength(0);
  });
});

describe('createAdcKeyProvider — a missing credential is actionable (P0-safe)', () => {
  it('names both ADC inputs when nothing is configured and the metadata server is dead', async () => {
    const fetchImpl = (async () => {
      throw new TypeError('fetch failed');
    }) as typeof fetch;
    const keyProvider = createAdcKeyProvider({
      env: {},
      clock,
      fetch: fetchImpl,
      metadataHost: 'metadata-test-dead.internal',
      metadataTimeoutMs: 10,
    });
    const error = await rejection(keyProvider.getKey('vertex-anthropic'));
    expect(error).toBeInstanceOf(AuthenticationError);
    const message = (error as AuthenticationError).message;
    expect(message).toContain('No Google credentials found');
    expect(message).toContain('GOOGLE_APPLICATION_CREDENTIALS');
    expect(message).toContain('keyFile');
    expect(message).toContain('createServiceAccountKeyProvider');
    expect((error as AuthenticationError).statusCode).toBe(0);
  });

  it('reports a metadata-server rejection with its status', async () => {
    const { fetch } = recordingFetch(() => new Response('no sa attached', { status: 404 }));
    const keyProvider = createAdcKeyProvider({
      env: {},
      clock,
      fetch,
      metadataHost: 'metadata-test-404.internal',
    });
    const error = await rejection(keyProvider.getKey('vertex-google'));
    expect(error).toBeInstanceOf(AuthenticationError);
    expect((error as AuthenticationError).statusCode).toBe(404);
    expect((error as AuthenticationError).message).toContain('Vertex AI User');
  });

  it('names the unreadable path, and says which input pointed at it', async () => {
    const missing = join(dir, 'nope.json');
    const { fetch } = recordingFetch(() => jsonResponse({ access_token: 'x' }));

    const viaOption = createAdcKeyProvider({ keyFile: missing, env: {}, clock, fetch });
    const optionError = (await rejection(viaOption.getKey('vertex-google'))) as AuthenticationError;
    expect(optionError).toBeInstanceOf(AuthenticationError);
    expect(optionError.message).toContain(missing);
    expect(optionError.message).not.toContain('GOOGLE_APPLICATION_CREDENTIALS');

    const viaEnv = createAdcKeyProvider({
      env: { GOOGLE_APPLICATION_CREDENTIALS: missing },
      clock,
      fetch,
    });
    const envError = (await rejection(viaEnv.getKey('vertex-google'))) as AuthenticationError;
    expect(envError.message).toContain('GOOGLE_APPLICATION_CREDENTIALS');
  });

  it('rejects a gcloud user credential with the exact fix, never echoing the refresh token', async () => {
    const path = join(dir, 'application_default_credentials.json');
    await writeFile(
      path,
      JSON.stringify({
        type: 'authorized_user',
        client_id: '764086051850-6qr4p6gpi6hn506pt8ejuq83di341hur.apps.googleusercontent.com',
        client_secret: 'd-TOP-SECRET-value',
        refresh_token: '1//0gLEAK-ME-IF-YOU-DARE',
      }),
      'utf8',
    );
    const { fetch, calls } = recordingFetch(() => jsonResponse({ access_token: 'x' }));
    const keyProvider = createAdcKeyProvider({ keyFile: path, env: {}, clock, fetch });

    const error = (await rejection(keyProvider.getKey('vertex-google'))) as AuthenticationError;
    expect(error).toBeInstanceOf(AuthenticationError);
    expect(error.message).toContain('authorized_user');
    expect(error.message).toContain('gcloud iam service-accounts keys create');
    // P0: the file's own secrets never reach the error.
    expect(error.message).not.toContain('1//0gLEAK-ME-IF-YOU-DARE');
    expect(error.message).not.toContain('d-TOP-SECRET-value');
    expect(calls).toHaveLength(0);
  });

  it('rejects malformed / incomplete credential files without quoting them', async () => {
    const { fetch } = recordingFetch(() => jsonResponse({ access_token: 'x' }));

    const garbage = join(dir, 'garbage.json');
    await writeFile(garbage, 'this-is-not-json{{{', 'utf8');
    const garbageError = (await rejection(
      createAdcKeyProvider({ keyFile: garbage, env: {}, clock, fetch }).getKey('vertex-google'),
    )) as AuthenticationError;
    expect(garbageError.message).toContain('not valid JSON');
    expect(garbageError.message).not.toContain('this-is-not-json');

    const partial = join(dir, 'partial.json');
    await writeFile(
      partial,
      JSON.stringify({ type: 'service_account', client_email: 'sa@p.iam.gserviceaccount.com' }),
      'utf8',
    );
    const partialError = (await rejection(
      createAdcKeyProvider({ keyFile: partial, env: {}, clock, fetch }).getKey('vertex-google'),
    )) as AuthenticationError;
    expect(partialError.message).toContain('private_key');
  });

  it('passes a token-endpoint failure through from the service-account path', async () => {
    const { path } = await writeKeyFile('exchange-fails.json');
    const { fetch } = recordingFetch(() =>
      jsonResponse({ error: 'invalid_grant', error_description: 'Invalid JWT Signature.' }, 400),
    );
    const keyProvider = createAdcKeyProvider({ keyFile: path, env: {}, clock, fetch });
    const error = (await rejection(keyProvider.getKey('vertex-anthropic'))) as AuthenticationError;
    expect(error).toBeInstanceOf(AuthenticationError);
    expect(error.statusCode).toBe(400);
    expect(error.upstreamType).toBe('invalid_grant');
    expect(error.message).not.toContain('BEGIN PRIVATE KEY');
  });

  it('re-attempts resolution after a failure (a late-mounted secret must work)', async () => {
    const late = join(dir, 'late.json');
    const { fetch } = recordingFetch(() =>
      jsonResponse({ access_token: 'ya29.late', expires_in: 3600 }),
    );
    const keyProvider = createAdcKeyProvider({ keyFile: late, env: {}, clock, fetch });

    await expect(keyProvider.getKey('vertex-google')).rejects.toBeInstanceOf(AuthenticationError);
    emailCounter += 1;
    await writeFile(
      late,
      JSON.stringify({
        type: 'service_account',
        client_email: `late-${emailCounter}@my-proj.iam.gserviceaccount.com`,
        private_key: privateKeyPem,
      }),
      'utf8',
    );
    expect(await keyProvider.getKey('vertex-google')).toBe('ya29.late');
  });
});
