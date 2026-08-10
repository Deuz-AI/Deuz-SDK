/**
 * MCP OAuth provider — UNIT level: the store contract (which key gets which
 * secret), the dynamic-registration escape hatch, the redirect hand-off and the
 * invalidate/bind bookkeeping. The end-to-end flow against a fake authorization
 * server (discovery → registration → PKCE → refresh) is a separate suite; the
 * SDK owns the protocol, this file owns the seam we hand it.
 */
import { describe, it, expect } from 'vitest';
import {
  createOAuthProvider,
  inMemoryTokenStore,
  bindOAuthServer,
  toOAuthProvider,
} from '../src/mcp/auth';
import type { TokenStore, DeuzOAuthProvider } from '../src/types/config';

const SERVER = 'https://mcp.example.com/mcp';

/** The SDK-side shape we hand the transport, structurally mirrored for the test. */
interface SdkProvider {
  redirectUrl: string;
  clientMetadata: Record<string, unknown>;
  clientInformation(): Promise<Record<string, unknown> | undefined>;
  saveClientInformation(info: Record<string, unknown>): Promise<void>;
  tokens(): Promise<Record<string, unknown> | undefined>;
  saveTokens(tokens: Record<string, unknown>): Promise<void>;
  redirectToAuthorization(url: URL): Promise<void>;
  saveCodeVerifier(verifier: string): Promise<void>;
  codeVerifier(): Promise<string>;
  invalidateCredentials(
    scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery',
  ): Promise<void>;
}

const sdk = (provider: DeuzOAuthProvider): SdkProvider => provider.provider as SdkProvider;

/** A store that records every call, so key namespacing is observable. */
function spyStore(): TokenStore & { entries: Map<string, string>; reads: string[] } {
  const entries = new Map<string, string>();
  const reads: string[] = [];
  return {
    entries,
    reads,
    get(key) {
      reads.push(key);
      return entries.get(key);
    },
    set(key, value) {
      entries.set(key, value);
    },
    delete(key) {
      entries.delete(key);
    },
  };
}

describe('inMemoryTokenStore', () => {
  it('round-trips values and forgets deleted keys', async () => {
    const store = inMemoryTokenStore();
    expect(await store.get('missing')).toBeUndefined();
    await store.set('tokens:a', '{"access_token":"t1"}');
    expect(await store.get('tokens:a')).toBe('{"access_token":"t1"}');
    await store.delete('tokens:a');
    expect(await store.get('tokens:a')).toBeUndefined();
  });

  it('is the default store — a provider works with no `store` configured', async () => {
    const provider = createOAuthProvider({ redirectUri: 'http://127.0.0.1:9/callback' });
    await bindOAuthServer(provider, SERVER);
    await sdk(provider).saveTokens({ access_token: 'in-memory' });
    expect(await provider.tokens()).toEqual({ access_token: 'in-memory' });
  });
});

describe('client metadata (the RFC 7591 registration body)', () => {
  it('defaults a public PKCE client whose only redirect is the configured one', () => {
    const provider = createOAuthProvider({
      redirectUri: 'http://127.0.0.1:8976/callback',
      scope: 'mcp:tools mcp:resources',
    });
    expect(sdk(provider).redirectUrl).toBe('http://127.0.0.1:8976/callback');
    expect(sdk(provider).clientMetadata).toEqual({
      client_name: 'Deuz SDK',
      redirect_uris: ['http://127.0.0.1:8976/callback'],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      scope: 'mcp:tools mcp:resources',
    });
  });

  it('switches to a confidential client when a secret is configured; caller fields win', () => {
    const provider = createOAuthProvider({
      redirectUri: 'https://app.example.com/cb',
      clientSecret: 'shh',
      clientMetadata: { client_name: 'My App', software_id: 'my-app' },
    });
    const metadata = sdk(provider).clientMetadata;
    expect(metadata.token_endpoint_auth_method).toBe('client_secret_post');
    expect(metadata.client_name).toBe('My App');
    expect(metadata.software_id).toBe('my-app');
  });
});

describe('client information (dynamic registration)', () => {
  it('a configured clientId skips DCR entirely — no store read, no registration', async () => {
    const store = spyStore();
    const provider = createOAuthProvider({
      redirectUri: 'https://app.example.com/cb',
      clientId: 'preregistered-123',
      clientSecret: 'shh',
      store,
    });
    await bindOAuthServer(provider, SERVER);
    store.reads.length = 0;

    expect(await sdk(provider).clientInformation()).toEqual({
      client_id: 'preregistered-123',
      client_secret: 'shh',
    });
    expect(store.reads).toEqual([]);
  });

  it('without a clientId, saveClientInformation persists what DCR minted', async () => {
    const store = spyStore();
    const provider = createOAuthProvider({ redirectUri: 'https://app.example.com/cb', store });
    await bindOAuthServer(provider, SERVER);

    expect(await sdk(provider).clientInformation()).toBeUndefined();
    await sdk(provider).saveClientInformation({ client_id: 'dcr-9', client_secret: 'from-server' });

    expect(store.entries.get(`client-info:${SERVER}`)).toBe(
      '{"client_id":"dcr-9","client_secret":"from-server"}',
    );
    expect(await sdk(provider).clientInformation()).toEqual({
      client_id: 'dcr-9',
      client_secret: 'from-server',
    });
  });

  it('treats a corrupt entry as absent instead of throwing out of an SDK callback', async () => {
    const store = spyStore();
    store.entries.set(`client-info:${SERVER}`, '{not json');
    store.entries.set(`tokens:${SERVER}`, 'null');
    const provider = createOAuthProvider({ redirectUri: 'https://app.example.com/cb', store });
    await bindOAuthServer(provider, SERVER);

    expect(await sdk(provider).clientInformation()).toBeUndefined();
    expect(await provider.tokens()).toBeUndefined();
  });
});

describe('PKCE verifier + tokens', () => {
  it('writes the verifier and the tokens to their own namespaced keys', async () => {
    const store = spyStore();
    const provider = createOAuthProvider({ redirectUri: 'https://app.example.com/cb', store });
    await bindOAuthServer(provider, SERVER);

    // The SDK MINTS the verifier (edge-safe core draws no randomness of its own);
    // the provider only has to keep it until the exchange.
    await sdk(provider).saveCodeVerifier('verifier-from-the-sdk');
    await sdk(provider).saveTokens({ access_token: 'at', refresh_token: 'rt', expires_in: 3600 });

    expect([...store.entries.keys()].sort()).toEqual([
      `code-verifier:${SERVER}`,
      'server-url',
      `tokens:${SERVER}`,
    ]);
    expect(store.entries.get(`code-verifier:${SERVER}`)).toBe('verifier-from-the-sdk');
    expect(await sdk(provider).codeVerifier()).toBe('verifier-from-the-sdk');
    expect(await provider.tokens()).toEqual({
      access_token: 'at',
      refresh_token: 'rt',
      expires_in: 3600,
    });
  });

  it('a missing verifier is an actionable error, not a bare undefined', async () => {
    const provider = createOAuthProvider({ redirectUri: 'https://app.example.com/cb' });
    await bindOAuthServer(provider, SERVER);
    await expect(sdk(provider).codeVerifier()).rejects.toThrow(/code verifier/i);
  });
});

describe('redirect hand-off', () => {
  it('records the URL and calls onRedirect — never opens anything itself', async () => {
    const seen: URL[] = [];
    const provider = createOAuthProvider({
      redirectUri: 'https://app.example.com/cb',
      onRedirect: (url) => {
        seen.push(url);
      },
    });
    expect(provider.authorizationUrl()).toBeUndefined();

    const target = new URL('https://auth.example.com/authorize?client_id=abc&code_challenge=xyz');
    await sdk(provider).redirectToAuthorization(target);

    expect(seen).toEqual([target]);
    expect(provider.authorizationUrl()?.toString()).toBe(target.toString());
  });

  it('awaits an async onRedirect before the SDK moves on', async () => {
    const order: string[] = [];
    const provider = createOAuthProvider({
      redirectUri: 'https://app.example.com/cb',
      onRedirect: async () => {
        await Promise.resolve();
        order.push('handler');
      },
    });
    await sdk(provider).redirectToAuthorization(new URL('https://auth.example.com/authorize'));
    order.push('after');
    expect(order).toEqual(['handler', 'after']);
  });
});

describe('server binding + invalidate', () => {
  it('namespaces per server, so one store backs many of them', async () => {
    const store = spyStore();
    const other = 'https://other.example.com/mcp';
    const provider = createOAuthProvider({ redirectUri: 'https://app.example.com/cb', store });

    await bindOAuthServer(provider, SERVER);
    await sdk(provider).saveTokens({ access_token: 'first' });
    await bindOAuthServer(provider, other);
    await sdk(provider).saveTokens({ access_token: 'second' });

    expect(store.entries.get(`tokens:${SERVER}`)).toBe('{"access_token":"first"}');
    expect(store.entries.get(`tokens:${other}`)).toBe('{"access_token":"second"}');
    // The last server is persisted so a SECOND process knows which exchange
    // `completeAuth` should finish.
    expect(store.entries.get('server-url')).toBe(other);
  });

  it('normalizes the server URL so a trailing slash does not split the tokens', async () => {
    const store = spyStore();
    const provider = createOAuthProvider({ redirectUri: 'https://app.example.com/cb', store });
    await bindOAuthServer(provider, 'https://mcp.example.com');
    await sdk(provider).saveTokens({ access_token: 'x' });
    expect([...store.entries.keys()]).toContain('tokens:https://mcp.example.com/');
  });

  it('invalidate drops the tokens and the stale verifier, keeping the registration', async () => {
    const store = spyStore();
    const provider = createOAuthProvider({ redirectUri: 'https://app.example.com/cb', store });
    await bindOAuthServer(provider, SERVER);
    await sdk(provider).saveClientInformation({ client_id: 'dcr-9' });
    await sdk(provider).saveCodeVerifier('v');
    await sdk(provider).saveTokens({ access_token: 'at' });

    await provider.invalidate();

    expect(await provider.tokens()).toBeUndefined();
    expect(store.entries.has(`code-verifier:${SERVER}`)).toBe(false);
    // Registration is not a credential the server rejected — re-registering on
    // every expiry would litter the authorization server with dead clients.
    expect(store.entries.get(`client-info:${SERVER}`)).toBe('{"client_id":"dcr-9"}');
  });

  it('completeAuth without a bound server explains what to do instead of exchanging blind', async () => {
    const provider = createOAuthProvider({ redirectUri: 'https://app.example.com/cb' });
    await expect(provider.completeAuth('code-1')).rejects.toThrow(/not bound to an MCP server/);
  });

  it('an unbound provider keeps its keys in one shared namespace', async () => {
    // Never handed to `createMcpClient`, so nothing told it which server this
    // is. It still functions as a key/value seam — it just cannot complete an
    // exchange (the guard above), so the shared bucket only ever holds what a
    // caller poked in deliberately.
    const store = spyStore();
    const provider = createOAuthProvider({ redirectUri: 'https://app.example.com/cb', store });
    await sdk(provider).saveTokens({ access_token: 'at' });
    expect([...store.entries.keys()]).toEqual(['tokens:default']);
  });
});

describe('invalidateCredentials (what the SDK drops after a rejection)', () => {
  /** All three per-server secrets present, so each scope's blast radius shows. */
  async function seeded(): Promise<{
    store: ReturnType<typeof spyStore>;
    provider: DeuzOAuthProvider;
  }> {
    const store = spyStore();
    const provider = createOAuthProvider({ redirectUri: 'https://app.example.com/cb', store });
    await bindOAuthServer(provider, SERVER);
    await sdk(provider).saveClientInformation({ client_id: 'dcr-9' });
    await sdk(provider).saveCodeVerifier('v');
    await sdk(provider).saveTokens({ access_token: 'at', refresh_token: 'rt' });
    return { store, provider };
  }

  /** Everything but the binding record, which no scope is allowed to touch. */
  const secrets = (store: ReturnType<typeof spyStore>): string[] =>
    [...store.entries.keys()].filter((k) => k !== 'server-url').sort();

  it("'tokens' drops the pair only — the SDK retries the whole flow with it gone", async () => {
    const { store, provider } = await seeded();
    await sdk(provider).invalidateCredentials('tokens');
    expect(secrets(store)).toEqual([`client-info:${SERVER}`, `code-verifier:${SERVER}`]);
    expect(await provider.tokens()).toBeUndefined();
  });

  it("'verifier' drops the in-flight PKCE verifier only", async () => {
    const { store, provider } = await seeded();
    await sdk(provider).invalidateCredentials('verifier');
    expect(secrets(store)).toEqual([`client-info:${SERVER}`, `tokens:${SERVER}`]);
  });

  it("'client' drops the dynamic registration only", async () => {
    const { store, provider } = await seeded();
    await sdk(provider).invalidateCredentials('client');
    expect(secrets(store)).toEqual([`code-verifier:${SERVER}`, `tokens:${SERVER}`]);
    expect(await sdk(provider).clientInformation()).toBeUndefined();
  });

  it("'discovery' is a no-op — this provider caches no discovery state", async () => {
    const { store, provider } = await seeded();
    await sdk(provider).invalidateCredentials('discovery');
    expect(secrets(store)).toEqual([
      `client-info:${SERVER}`,
      `code-verifier:${SERVER}`,
      `tokens:${SERVER}`,
    ]);
  });

  it("'all' clears this server's three keys, leaving other servers and the binding", async () => {
    const other = 'https://other.example.com/mcp';
    const { store, provider } = await seeded();
    await bindOAuthServer(provider, other);
    await sdk(provider).saveTokens({ access_token: 'other-at' });
    await bindOAuthServer(provider, SERVER);

    await sdk(provider).invalidateCredentials('all');

    // One store backs many servers; a rejection at one must not log the rest out.
    expect(secrets(store)).toEqual([`tokens:${other}`]);
    // The binding is bookkeeping, not a credential: a second process needs it
    // to know which exchange `completeAuth` is finishing.
    expect(store.entries.get('server-url')).toBe(SERVER);
  });
});

describe('toOAuthProvider', () => {
  it('builds a provider from options and passes an existing one through untouched', () => {
    const built = toOAuthProvider({ redirectUri: 'https://app.example.com/cb' });
    expect(typeof built.completeAuth).toBe('function');
    // Same instance back: a provider shared across servers keeps ONE token
    // store and one binding, which is the whole point of accepting both shapes.
    expect(toOAuthProvider(built)).toBe(built);
  });
});
