/**
 * `./vertex/node` — Application Default Credentials for Vertex AI (1.9). The
 * Node twin of `createServiceAccountKeyProvider`: same `KeyProvider` seam, but
 * it FINDS the credential instead of being handed one, so a container that is
 * already authenticated (Cloud Run, GKE, GCE, or a `GOOGLE_APPLICATION_CREDENTIALS`
 * env var) needs no credential plumbing at all.
 *
 * ```ts
 * import { createAdcKeyProvider } from '@deuz-sdk/core/vertex/node';
 * const client = createClient({ deps: { keyProvider: createAdcKeyProvider() } });
 * ```
 *
 * ENV-VAR EXCEPTION, stated plainly: the edge-safe core NEVER reads env vars or
 * the filesystem — every such input arrives through the `Dependencies` seam.
 * This file is the documented exception, because ADC is *defined* in terms of
 * `GOOGLE_APPLICATION_CREDENTIALS` and the metadata server; a "portable" version
 * of it would just be `createServiceAccountKeyProvider`, which already exists on
 * the edge-safe `./vertex` subpath. Node built-ins load through a LAZY
 * `await import('node:…' as string)` so the browser bundle never resolves them.
 *
 * G1: like its edge twin this only RETURNS a `KeyProvider` — the highest link in
 * the key-precedence chain that `internal/resolve-call.ts` already owns.
 */
import type { Clock, KeyProvider } from '../types/deps';
import { AuthenticationError } from '../errors';
import {
  CLOUD_PLATFORM_SCOPE,
  createServiceAccountKeyProvider,
  type ServiceAccountCredentials,
} from '../vertex';

// Minimal node shapes; the `as string` specifiers keep tsup's dts builder from
// statically resolving node: (matches node/observe.ts / node/compute.ts).
interface NodeFs {
  readFile(path: string, encoding: string): Promise<string>;
}
interface NodeProcess {
  env: Record<string, string | undefined>;
}

async function loadFs(): Promise<NodeFs> {
  return (await import('node:fs/promises' as string)) as unknown as NodeFs;
}

let cachedProcess: NodeProcess | undefined;
async function loadProcess(): Promise<NodeProcess> {
  if (!cachedProcess) {
    cachedProcess = (await import('node:process' as string)) as unknown as NodeProcess;
  }
  return cachedProcess;
}

/** The GCE/Cloud Run metadata server. `GCE_METADATA_HOST` overrides the host. */
const DEFAULT_METADATA_HOST = 'metadata.google.internal';
const METADATA_TOKEN_PATH = '/computeMetadata/v1/instance/service-accounts/default/token';
const FALLBACK_TOKEN_LIFETIME_SECONDS = 3600;

export interface AdcKeyProviderOptions {
  /** Explicit service-account JSON key path — highest precedence, skips the env var. */
  keyFile?: string;
  /** Default `['https://www.googleapis.com/auth/cloud-platform']`. */
  scopes?: readonly string[];
  /** Refresh this long before expiry. Default 60_000. */
  refreshSkewMs?: number;
  /** Time source. Default: the host clock (this file is Node-only by design). */
  clock?: Clock;
  /** Transport. Default: the host `fetch` (Node >= 22 always has one). */
  fetch?: typeof fetch;
  /** Env bag override — the test seam; default `process.env`. */
  env?: Record<string, string | undefined>;
  /** Metadata server host (no scheme). Default `GCE_METADATA_HOST` or `metadata.google.internal`. */
  metadataHost?: string;
  /**
   * Metadata probe timeout. Default 3_000 — off GCP that address is a black
   * hole, and a hung credential lookup is indistinguishable from a hung model
   * call.
   */
  metadataTimeoutMs?: number;
  /**
   * Which `LanguageModel.provider` names to answer for. Default: any name
   * starting with `vertex`. Same G1 rationale as the edge twin: a keyProvider is
   * client-wide, so an unscoped one would hand this Google token to OpenAI.
   */
  providers?: readonly string[];
}

interface TokenEntry {
  accessToken: string;
  expiresAt: number;
}

/** Metadata-server tokens, keyed by (host, scopes). Same rules as the edge cache. */
const metadataCache = new Map<string, TokenEntry>();
const metadataInFlight = new Map<string, Promise<TokenEntry>>();

// The sanctioned host-clock fallback for this Node-only surface (the edge twin
// REQUIRES an injected clock; here a default is the whole point of ADC).
const hostClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => {
    const handle = setTimeout(fn, ms);
    return () => clearTimeout(handle);
  },
};

function authFailure(
  message: string,
  extra: { provider?: string; statusCode?: number; cause?: unknown } = {},
): AuthenticationError {
  return new AuthenticationError({ message, ...extra });
}

/**
 * Parse a credential file into service-account credentials.
 *
 * P0: the file content itself never reaches the error — a bad key file reports
 * its PATH and TYPE only, never the bytes it contained.
 */
function parseKeyFile(
  path: string,
  contents: string,
  provider?: string,
): ServiceAccountCredentials {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(contents) as Record<string, unknown>;
  } catch {
    throw authFailure(
      `The credential file '${path}' is not valid JSON. It must be the service-account key downloaded from IAM (a JSON object with \`client_email\` and \`private_key\`).`,
      { provider },
    );
  }
  if (parsed.type === 'authorized_user') {
    throw authFailure(
      `'${path}' holds a gcloud USER credential (\`type: "authorized_user"\`), not a service account. ` +
        'Vertex service-account auth needs a JSON key: `gcloud iam service-accounts keys create key.json --iam-account=<sa>` ' +
        'then point `keyFile` / GOOGLE_APPLICATION_CREDENTIALS at it. On GCP itself, attach the service account to the ' +
        'workload instead and let the metadata server answer.',
      { provider },
    );
  }
  if (parsed.type === 'external_account' || parsed.type === 'impersonated_service_account') {
    throw authFailure(
      `'${path}' holds a '${String(parsed.type)}' credential, which needs a token-exchange flow this provider does not implement. ` +
        'Use a service-account JSON key, or run on GCP and let the metadata server answer.',
      { provider },
    );
  }
  // Truthiness as well as type: an EMPTY `private_key` would otherwise reach the
  // inner factory's constructor guard as a bare TypeError instead of this
  // actionable AuthenticationError.
  if (!parsed.client_email || typeof parsed.client_email !== 'string') {
    throw authFailure(
      `The credential file '${path}' is missing \`client_email\`. Download a fresh service-account JSON key from IAM.`,
      { provider },
    );
  }
  if (!parsed.private_key || typeof parsed.private_key !== 'string') {
    throw authFailure(
      `The credential file '${path}' is missing \`private_key\`. Download a fresh service-account JSON key from IAM.`,
      { provider },
    );
  }
  return {
    client_email: parsed.client_email,
    private_key: parsed.private_key,
    ...(typeof parsed.project_id === 'string' ? { project_id: parsed.project_id } : {}),
    ...(typeof parsed.token_uri === 'string' ? { token_uri: parsed.token_uri } : {}),
  };
}

/**
 * Application Default Credentials as a `KeyProvider` for Vertex AI, resolved in
 * the documented ADC order:
 *
 *   1. `options.keyFile` — an explicit service-account JSON key path.
 *   2. `GOOGLE_APPLICATION_CREDENTIALS` — the same file, from the environment.
 *   3. The GCE/Cloud Run/GKE metadata server (the attached service account).
 *
 * Steps 1 and 2 hand the parsed credentials to
 * {@link createServiceAccountKeyProvider}, so the JWT signing, token cache and
 * refresh behaviour are byte-for-byte the edge implementation. Step 3 needs no
 * private key at all: the metadata server mints the token.
 *
 * NOT consulted: gcloud's well-known
 * `~/.config/gcloud/application_default_credentials.json`. That file usually
 * holds a `type: "authorized_user"` refresh-token credential, a different grant
 * this provider deliberately does not implement — for local development create a
 * service-account key and point `keyFile` at it (pointing `keyFile` at the
 * well-known file yields an actionable error saying exactly this).
 *
 * The resolution runs on the FIRST `getKey` and is then memoized, so a
 * mis-detected credential surfaces as an `AuthenticationError` on the first
 * call rather than at construction (construction stays synchronous and
 * side-effect-free).
 */
export function createAdcKeyProvider(options: AdcKeyProviderOptions = {}): KeyProvider {
  const clock = options.clock ?? hostClock;
  const scopes =
    options.scopes && options.scopes.length > 0 ? [...options.scopes] : [CLOUD_PLATFORM_SCOPE];
  const refreshSkewMs = options.refreshSkewMs ?? 60_000;
  const metadataTimeoutMs = options.metadataTimeoutMs ?? 3_000;
  // Explicit `scopes` are forwarded to the metadata server; the DEFAULT is not.
  // A plain GCE instance often carries a narrowed scope set, and asking it for
  // cloud-platform fails where asking for "whatever you have" succeeds.
  const explicitScopes = Boolean(options.scopes && options.scopes.length > 0);
  const matches = (provider: string): boolean =>
    options.providers ? options.providers.includes(provider) : provider.startsWith('vertex');

  const env = async (): Promise<Record<string, string | undefined>> =>
    options.env ?? (await loadProcess()).env;
  const fetchImpl = async (): Promise<typeof fetch> => {
    if (options.fetch) return options.fetch;
    if (typeof globalThis.fetch !== 'function') {
      throw authFailure(
        'createAdcKeyProvider needs a `fetch` implementation: this runtime has no global fetch. Pass `fetch` explicitly.',
      );
    }
    return globalThis.fetch;
  };

  const readMetadataToken = async (provider: string): Promise<TokenEntry> => {
    const vars = await env();
    const host = options.metadataHost ?? vars.GCE_METADATA_HOST ?? DEFAULT_METADATA_HOST;
    const query = explicitScopes ? `?scopes=${encodeURIComponent(scopes.join(','))}` : '';
    const url = `http://${host}${METADATA_TOKEN_PATH}${query}`;
    const doFetch = await fetchImpl();
    let response: Response;
    try {
      response = await doFetch(url, {
        headers: { 'metadata-flavor': 'Google' },
        signal: AbortSignal.timeout(metadataTimeoutMs),
      });
    } catch (cause) {
      throw authFailure(
        `No Google credentials found. Neither \`keyFile\` nor GOOGLE_APPLICATION_CREDENTIALS is set, and the metadata server (${url}) is unreachable — so this host is not on GCP. ` +
          'Set GOOGLE_APPLICATION_CREDENTIALS to a service-account JSON key, pass `keyFile`, or use `createServiceAccountKeyProvider` with credentials you load yourself.',
        { provider, statusCode: 0, cause },
      );
    }
    if (!response.ok) {
      throw authFailure(
        `The metadata server returned HTTP ${response.status} for the default service-account token. ` +
          'Attach a service account to this workload (Cloud Run/GKE/GCE) and grant it the Vertex AI User role, or provide a service-account JSON key.',
        { provider, statusCode: response.status },
      );
    }
    let payload: { access_token?: unknown; expires_in?: unknown };
    try {
      payload = (await response.json()) as { access_token?: unknown; expires_in?: unknown };
    } catch (cause) {
      throw authFailure(
        `The metadata server returned a non-JSON token response (HTTP ${response.status}).`,
        { provider, statusCode: response.status, cause },
      );
    }
    if (typeof payload.access_token !== 'string' || !payload.access_token) {
      throw authFailure(
        `The metadata server returned HTTP ${response.status} without an \`access_token\`.`,
        { provider, statusCode: response.status },
      );
    }
    const lifetimeSeconds =
      typeof payload.expires_in === 'number' && payload.expires_in > 0
        ? payload.expires_in
        : FALLBACK_TOKEN_LIFETIME_SECONDS;
    return { accessToken: payload.access_token, expiresAt: clock.now() + lifetimeSeconds * 1000 };
  };

  const metadataProvider = (): KeyProvider => ({
    async getKey(provider) {
      const vars = await env();
      const host = options.metadataHost ?? vars.GCE_METADATA_HOST ?? DEFAULT_METADATA_HOST;
      const cacheKey = `${host} ${scopes.join(' ')}`;
      const cached = metadataCache.get(cacheKey);
      if (cached && clock.now() < cached.expiresAt - refreshSkewMs) return cached.accessToken;
      let flight = metadataInFlight.get(cacheKey);
      if (!flight) {
        flight = readMetadataToken(provider);
        metadataInFlight.set(cacheKey, flight);
      }
      try {
        const entry = await flight;
        metadataCache.set(cacheKey, entry);
        return entry.accessToken;
      } finally {
        if (metadataInFlight.get(cacheKey) === flight) metadataInFlight.delete(cacheKey);
      }
    },
  });

  /** The ADC search itself. Memoized on success; a failure is re-attempted. */
  let resolved: Promise<KeyProvider> | undefined;
  const resolve = async (provider: string): Promise<KeyProvider> => {
    const vars = await env();
    const path = options.keyFile ?? vars.GOOGLE_APPLICATION_CREDENTIALS;
    if (!path) return metadataProvider();

    let contents: string;
    try {
      contents = await (await loadFs()).readFile(path, 'utf8');
    } catch (cause) {
      throw authFailure(
        `Could not read the Google credential file '${path}'${
          options.keyFile ? '' : ' (from GOOGLE_APPLICATION_CREDENTIALS)'
        }. Check the path and that this process can read it.`,
        { provider, cause },
      );
    }
    const credentials = parseKeyFile(path, contents, provider);
    return createServiceAccountKeyProvider({
      credentials,
      clock,
      fetch: await fetchImpl(),
      scopes,
      refreshSkewMs,
      // Forward the SAME matcher, never `[provider]`: this resolution is
      // memoized, so pinning it to the first provider that arrived would make a
      // second Vertex transport ('vertex-google' after 'vertex-anthropic') fall
      // through to "no API key".
      ...(options.providers ? { providers: options.providers } : {}),
    });
  };

  return {
    async getKey(provider) {
      // G1: not ours -> undefined, so every other provider keeps its own key.
      if (!matches(provider)) return undefined;
      if (!resolved) {
        const started = resolve(provider);
        resolved = started;
        void started.catch(() => {
          // Do not memoize a failure: a missing file / unreachable metadata
          // server can be fixed between calls (a mounted secret arriving late).
          if (resolved === started) resolved = undefined;
        });
      }
      return (await resolved).getKey(provider);
    },
  };
}
