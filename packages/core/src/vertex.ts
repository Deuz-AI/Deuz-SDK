import type { LanguageModel, Provider } from './types/model';
import type { Clock, KeyProvider } from './types/deps';
import { attachConfig } from './internal/config-symbol';
import { AuthenticationError } from './errors';
import { uint8ToBase64 } from './internal/image';
import { redactObservationString } from './internal/redact';

/**
 * Google Vertex AI transports. Vertex hosts BOTH Anthropic Claude and Gemini,
 * but authenticates with a short-lived OAuth2 access token (not an API key) and
 * uses regional endpoints. So the same app can route Gemini through AI Studio
 * (`@deuz-sdk/core/google`) OR Vertex (`createVertexGoogle`), and Claude through the
 * direct Anthropic API (`@deuz-sdk/core/anthropic`) OR Vertex (`createVertexAnthropic`).
 *
 * `accessToken` is a convenience for a single short-lived call — it expires in
 * ~60 minutes with no refresh path. For anything long-running pass
 * {@link createServiceAccountKeyProvider} (edge-safe, service-account JSON) or
 * `createAdcKeyProvider` from `@deuz-sdk/core/vertex/node` (Application Default
 * Credentials) as `deps.keyProvider` and leave `accessToken` unset.
 */
export interface VertexSettings {
  project: string;
  location: string;
  /** OAuth2 access token (e.g. `gcloud auth print-access-token`). Short-lived. */
  accessToken?: string;
  fetch?: typeof fetch;
  headers?: Record<string, string>;
}

function vertexBase(location: string): string {
  return location === 'global'
    ? 'https://aiplatform.googleapis.com'
    : `https://${location}-aiplatform.googleapis.com`;
}

/**
 * Anthropic Claude on Vertex AI. Reuses the Anthropic Messages wire (same SSE
 * parsing / error mapping); only the URL, auth (Bearer), and `anthropic_version`
 * placement differ. Model ids are the Vertex form, e.g. `claude-sonnet-4-5`.
 */
export function createVertexAnthropic(settings: VertexSettings): Provider {
  const { project, location } = settings;
  return (modelId: string): LanguageModel =>
    attachConfig(
      { provider: 'vertex-anthropic', modelId, surface: 'anthropic' },
      {
        provider: 'vertex-anthropic',
        apiKey: settings.accessToken,
        baseURL: vertexBase(location),
        fetch: settings.fetch,
        headers: settings.headers,
        vertex: { project, location },
      },
    );
}

/**
 * Gemini on Vertex AI via its OpenAI-compatible endpoint. Reuses the
 * Chat-Completions wire. Pass the model in Vertex form, e.g.
 * `google/gemini-2.5-flash`.
 */
export function createVertexGoogle(settings: VertexSettings): Provider {
  const { project, location } = settings;
  const baseURL = `${vertexBase(location)}/v1beta1/projects/${project}/locations/${location}/endpoints/openapi`;
  return (modelId: string): LanguageModel =>
    attachConfig(
      { provider: 'vertex-google', modelId, surface: 'chat_completions' },
      {
        provider: 'vertex-google',
        apiKey: settings.accessToken,
        baseURL,
        fetch: settings.fetch,
        headers: settings.headers,
      },
    );
}

/**
 * Gemini on Vertex AI via the NATIVE `generateContent` wire (full capabilities:
 * reasoning + thoughtSignature, structured output, grounding, native PDF/audio).
 * Reuses `google-native.ts` — the adapter sees `call.vertex` and builds the
 * Vertex URL (`…/projects/{p}/locations/{l}/publishers/google/models/{model}`)
 * with `Authorization: Bearer <OAuth2 token>` instead of `x-goog-api-key`.
 *
 * Pass the bare model id (e.g. `gemini-2.5-flash`, `gemini-2.5-pro`). The OAuth2
 * access token is short-lived — prefer a refreshing `deps.keyProvider`
 * ({@link createServiceAccountKeyProvider}) over the static `accessToken`
 * convenience field.
 */
export function createVertexGoogleNative(settings: VertexSettings): Provider {
  const { project, location } = settings;
  return (modelId: string): LanguageModel =>
    attachConfig(
      { provider: 'vertex-google', modelId, surface: 'native' },
      {
        provider: 'vertex-google',
        apiKey: settings.accessToken,
        baseURL: vertexBase(location),
        fetch: settings.fetch,
        headers: settings.headers,
        vertex: { project, location },
      },
    );
}

// ---------------------------------------------------------------------------
// Service-account OAuth2 (1.9) — the refresh path `accessToken` never had.
//
// Vertex is the enterprise Google surface, and every enterprise credential is a
// service-account JSON key: `client_email` + an RS256 `private_key`. The OAuth2
// dance for it is a signed JWT assertion exchanged for a ~1h access token
// (RFC 7523) — pure WebCrypto, so it belongs in the edge-safe core rather than
// in every consumer's app code.
//
// G1: this returns a `KeyProvider`, the seam that ALREADY sits at the top of the
// key-precedence chain (`internal/resolve-call.ts`). No new resolution path.
// ---------------------------------------------------------------------------

/** The scope every Vertex AI call needs; the default for the key providers below. */
export const CLOUD_PLATFORM_SCOPE = 'https://www.googleapis.com/auth/cloud-platform';

/** Google's OAuth2 token endpoint (per-credentials override via `token_uri`). */
const GOOGLE_TOKEN_URI = 'https://oauth2.googleapis.com/token';
const JWT_BEARER_GRANT = 'urn:ietf:params:oauth:grant-type:jwt-bearer';
/** Assertion lifetime. Google caps it at 1h and mints a token that expires with it. */
const ASSERTION_LIFETIME_SECONDS = 3600;
/** Only used when a 2xx token response omits `expires_in` (Google always sends it). */
const FALLBACK_TOKEN_LIFETIME_SECONDS = 3600;
/** Cap on upstream error text copied into a message (P0: bounded + redacted). */
const MAX_UPSTREAM_DETAIL = 200;

/**
 * The credential half of a Google service-account JSON key. Field names are
 * snake_case ON PURPOSE: this is the shape of the file itself, so
 * `JSON.parse(keyFileContents)` drops straight in with no re-mapping.
 */
export interface ServiceAccountCredentials {
  client_email: string;
  /** Unencrypted PKCS#8 PEM (`-----BEGIN PRIVATE KEY-----`), as the file stores it. */
  private_key: string;
  /** Present in the file; unused for auth but handy as a `project` default. */
  project_id?: string;
  /** Honoured when present (the file carries it); default Google's endpoint. */
  token_uri?: string;
}

export interface ServiceAccountKeyProviderOptions {
  /** Parsed service-account JSON (never logged — see the P0 note on the factory). */
  credentials: ServiceAccountCredentials;
  /**
   * REQUIRED time source: `iat`/`exp` on the assertion and the refresh
   * decision. Not optional-with-a-global-fallback — an ambient `Date.now()` is
   * exactly what edge purity bans, and an injected clock is what makes the
   * cache/refresh behaviour deterministic in tests.
   */
  clock: Clock;
  /** REQUIRED transport, same reason: no reach for a global `fetch`. */
  fetch: typeof fetch;
  /** Default `['https://www.googleapis.com/auth/cloud-platform']`. */
  scopes?: readonly string[];
  /** Refresh this long before expiry. Default 60_000. */
  refreshSkewMs?: number;
  /**
   * Which `LanguageModel.provider` names to answer for. Default: any name
   * starting with `vertex` (`vertex-anthropic`, `vertex-google`).
   *
   * A keyProvider is CLIENT-wide and sits at the TOP of the G1 chain, so an
   * unscoped one would hand this Google OAuth token to OpenAI/Anthropic too.
   * Returning `undefined` for everything else lets those providers fall through
   * to their own key. Set this only when a custom factory (e.g.
   * `createOpenAICompatible`) fronts Vertex under a different provider name.
   */
  providers?: readonly string[];
}

interface TokenEntry {
  accessToken: string;
  /** Injected-clock timestamp (ms) at which the token stops being usable. */
  expiresAt: number;
}

/**
 * Token cache keyed by (client_email, scopes, token endpoint) — NEVER by
 * anything derived from the private key. Two service accounts in one process
 * must not share a token, and a narrower scope set must not be satisfied by a
 * broader one; both fall out of the key.
 *
 * Module-level ON PURPOSE: the common serverless shape builds its provider
 * inside the request handler, so a per-instance cache would re-mint a JWT on
 * every warm invocation. `inFlight` coalesces concurrent misses so N parallel
 * requests cause ONE token exchange.
 */
const tokenCache = new Map<string, TokenEntry>();
const inFlight = new Map<string, Promise<TokenEntry>>();

/** Base64url without padding (`uint8ToBase64` keeps this Buffer-free). */
function b64url(bytes: Uint8Array): string {
  return uint8ToBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Base64 -> bytes with Web APIs only; `uint8ToBase64` covers the other direction. */
function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function authFailure(
  message: string,
  extra: { provider?: string; statusCode?: number; upstreamType?: string; cause?: unknown } = {},
): AuthenticationError {
  return new AuthenticationError({ message, ...extra });
}

/**
 * PEM -> PKCS#8 DER, Web APIs only (`atob`, no Buffer).
 *
 * Also un-escapes a `\n`-literal key: pasting a service-account key into an env
 * var is the single most common way to get here, and that round-trip leaves the
 * newlines escaped.
 *
 * P0: every failure path reports the PEM's LABEL and nothing else. The key bytes
 * must never reach an error message, a log, a span or an observation event.
 */
function pemToPkcs8(privateKeyPem: string, provider?: string): Uint8Array {
  const normalized = privateKeyPem.includes('\\n')
    ? privateKeyPem.replace(/\\n/g, '\n')
    : privateKeyPem;
  const match = /-----BEGIN ([A-Z0-9 ]+)-----([\s\S]+?)-----END [A-Z0-9 ]+-----/.exec(normalized);
  if (!match) {
    throw authFailure(
      "The service-account `private_key` is not a PEM block. Pass the field verbatim from the downloaded JSON key (it starts with '-----BEGIN PRIVATE KEY-----').",
      { provider },
    );
  }
  const label = match[1]!;
  if (label !== 'PRIVATE KEY') {
    throw authFailure(
      `The service-account \`private_key\` is a '${label}' PEM; WebCrypto imports unencrypted PKCS#8 only. ` +
        (label === 'RSA PRIVATE KEY'
          ? 'Convert it with `openssl pkcs8 -topk8 -nocrypt -in key.pem -out pkcs8.pem`.'
          : 'Decrypt/convert it to an unencrypted PKCS#8 PEM, or download a fresh JSON key from IAM.'),
      { provider },
    );
  }
  try {
    return base64ToBytes(match[2]!.replace(/\s+/g, ''));
  } catch {
    // The cause would carry the key bytes — report the shape only (P0).
    throw authFailure(
      'The service-account `private_key` PEM body is not valid base64 — the key looks truncated or re-wrapped. Re-copy it from the JSON key file.',
      { provider },
    );
  }
}

/**
 * Read a FAILED token response for its short upstream code only.
 *
 * P0: bounded and redacted. The upstream body is the only thing quoted — the
 * REQUEST body (which carries the signed assertion) never is, and the observe
 * profile's JWT/PEM patterns catch an endpoint that echoes one back.
 */
async function describeFailure(
  response: Response,
): Promise<{ detail: string; upstreamType?: string }> {
  let text = '';
  try {
    text = await response.text();
  } catch {
    /* an unreadable error body is not itself an error */
  }
  if (!text) return { detail: '' };
  try {
    const parsed = JSON.parse(text) as { error?: unknown; error_description?: unknown };
    const code = typeof parsed.error === 'string' ? parsed.error : undefined;
    const description =
      typeof parsed.error_description === 'string' ? parsed.error_description : undefined;
    const detail = [code, description].filter(Boolean).join(': ');
    return {
      detail: redactObservationString(detail).slice(0, MAX_UPSTREAM_DETAIL),
      ...(code ? { upstreamType: code.slice(0, 64) } : {}),
    };
  } catch {
    return { detail: redactObservationString(text).slice(0, MAX_UPSTREAM_DETAIL) };
  }
}

/**
 * Google service-account OAuth2 as a `KeyProvider`: mint an RS256-signed JWT
 * assertion with WebCrypto, exchange it for an access token, cache the token
 * until it nears expiry, refresh transparently. Edge-safe — `crypto.subtle`,
 * `fetch`, `TextEncoder`, `atob`/`btoa` and NOTHING ambient.
 *
 * ```ts
 * const keyProvider = createServiceAccountKeyProvider({
 *   credentials: JSON.parse(serviceAccountJson),
 *   clock: { now: () => Date.now(), setTimeout: (fn, ms) => { const t = setTimeout(fn, ms); return () => clearTimeout(t); } },
 *   fetch,
 * });
 * const vertex = createVertexAnthropic({ project: 'p', location: 'us-east5' });
 * const client = createClient({ deps: { keyProvider } });
 * await client.generateText({ model: vertex('claude-sonnet-4-5'), prompt: 'hi' });
 * ```
 *
 * There is deliberately NO background refresh timer: a `setTimeout` chain keeps
 * an isolate/process alive and is unobservable to the caller. Expiry is checked
 * (against the injected clock) on every `getKey`, which is the only moment a
 * fresh token is actually needed.
 *
 * P0: `credentials.private_key` never leaves this closure — it is not logged,
 * not attached to an error, and not part of the cache key. A failed exchange
 * reports the HTTP status plus the short upstream error code; the REQUEST body
 * (which carries the signed assertion) is never reported.
 */
export function createServiceAccountKeyProvider(
  options: ServiceAccountKeyProviderOptions,
): KeyProvider {
  const { credentials, clock, fetch: fetchImpl } = options;
  if (!credentials?.client_email || !credentials?.private_key) {
    throw new TypeError(
      'createServiceAccountKeyProvider: `credentials` needs both `client_email` and `private_key` (the fields of a service-account JSON key).',
    );
  }
  if (!clock || !fetchImpl) {
    throw new TypeError(
      'createServiceAccountKeyProvider: `clock` and `fetch` are required — core reads no ambient clock or global fetch.',
    );
  }
  const scopes =
    options.scopes && options.scopes.length > 0 ? [...options.scopes] : [CLOUD_PLATFORM_SCOPE];
  const scope = scopes.join(' ');
  const refreshSkewMs = options.refreshSkewMs ?? 60_000;
  const tokenUri = credentials.token_uri ?? GOOGLE_TOKEN_URI;
  const cacheKey = `${credentials.client_email} ${scope} ${tokenUri}`;
  const encoder = new TextEncoder();
  const matches = (provider: string): boolean =>
    options.providers ? options.providers.includes(provider) : provider.startsWith('vertex');

  // The imported key is reusable across refreshes; a REJECTION is not memoized
  // (mirrors createApprovalSigner's `void keyPromise.catch(...)` guard, which is
  // also what keeps a rejection from firing as an unhandled one).
  let keyPromise: Promise<CryptoKey> | undefined;
  const privateKey = (provider: string): Promise<CryptoKey> => {
    if (!keyPromise) {
      const der = pemToPkcs8(credentials.private_key, provider);
      keyPromise = crypto.subtle.importKey(
        'pkcs8',
        // Same BufferSource cast durable.ts uses for a decoded Uint8Array (the
        // lib types pin ArrayBuffer, ours is ArrayBufferLike).
        der as unknown as ArrayBuffer,
        { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
        false,
        ['sign'],
      );
      const started = keyPromise;
      void keyPromise.catch(() => {
        if (keyPromise === started) keyPromise = undefined;
      });
    }
    return keyPromise;
  };

  const signAssertion = async (provider: string): Promise<string> => {
    const issuedAtSeconds = Math.floor(clock.now() / 1000);
    const header = { alg: 'RS256', typ: 'JWT' };
    const claims = {
      iss: credentials.client_email,
      scope,
      aud: tokenUri,
      exp: issuedAtSeconds + ASSERTION_LIFETIME_SECONDS,
      iat: issuedAtSeconds,
    };
    const signingInput = `${b64url(encoder.encode(JSON.stringify(header)))}.${b64url(
      encoder.encode(JSON.stringify(claims)),
    )}`;
    let signature: ArrayBuffer;
    try {
      signature = await crypto.subtle.sign(
        'RSASSA-PKCS1-v1_5',
        await privateKey(provider),
        encoder.encode(signingInput),
      );
    } catch (cause) {
      if (cause instanceof AuthenticationError) throw cause; // already actionable (PEM shape)
      // P0: the message is redacted and the cause dropped — a WebCrypto/DER
      // failure must not become a channel for key bytes.
      throw authFailure(
        `The service-account \`private_key\` could not be imported for signing (${redactObservationString(
          cause instanceof Error ? cause.message : String(cause),
        ).slice(
          0,
          MAX_UPSTREAM_DETAIL,
        )}). It must be the unencrypted PKCS#8 PEM from the JSON key.`,
        { provider },
      );
    }
    return `${signingInput}.${b64url(new Uint8Array(signature))}`;
  };

  const mintToken = async (provider: string): Promise<TokenEntry> => {
    const assertion = await signAssertion(provider);
    let response: Response;
    try {
      response = await fetchImpl(tokenUri, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: JWT_BEARER_GRANT, assertion }).toString(),
      });
    } catch (cause) {
      // statusCode 0 = no HTTP response at all (same convention as NetworkError),
      // so a consumer branching on the status cannot mistake a dead network for
      // a rejected credential.
      throw authFailure(
        `Could not reach the Google token endpoint (${tokenUri}) to refresh the Vertex access token for '${credentials.client_email}'.`,
        { provider, statusCode: 0, cause },
      );
    }
    if (!response.ok) {
      const { detail, upstreamType } = await describeFailure(response);
      throw authFailure(
        `Vertex service-account auth failed: the Google token endpoint returned HTTP ${response.status}` +
          `${detail ? ` (${detail})` : ''}. Check that the key for '${credentials.client_email}' is still ACTIVE, ` +
          `that its \`private_key\` is the unmodified value from the JSON key, that the scopes (${scope}) are allowed, ` +
          `and that this host's clock is accurate — a skew over ~5 minutes invalidates the signed assertion.`,
        { provider, statusCode: response.status, ...(upstreamType ? { upstreamType } : {}) },
      );
    }
    let payload: { access_token?: unknown; expires_in?: unknown };
    try {
      payload = (await response.json()) as { access_token?: unknown; expires_in?: unknown };
    } catch (cause) {
      throw authFailure(
        `The Google token endpoint (${tokenUri}) returned HTTP ${response.status} with a body that is not JSON.`,
        { provider, statusCode: response.status, cause },
      );
    }
    if (typeof payload.access_token !== 'string' || !payload.access_token) {
      throw authFailure(
        `The Google token endpoint returned HTTP ${response.status} without an \`access_token\` for '${credentials.client_email}'.`,
        { provider, statusCode: response.status },
      );
    }
    const lifetimeSeconds =
      typeof payload.expires_in === 'number' && payload.expires_in > 0
        ? payload.expires_in
        : FALLBACK_TOKEN_LIFETIME_SECONDS;
    // Measured from RECEIPT, not from `iat`: the exchange itself took time, so
    // this is the conservative end of the window.
    return { accessToken: payload.access_token, expiresAt: clock.now() + lifetimeSeconds * 1000 };
  };

  return {
    async getKey(provider) {
      // G1: not ours -> `undefined`, so factory config / ClientConfig.apiKeys
      // still resolve the key for every other provider in the app.
      if (!matches(provider)) return undefined;

      const cached = tokenCache.get(cacheKey);
      if (cached && clock.now() < cached.expiresAt - refreshSkewMs) return cached.accessToken;

      let flight = inFlight.get(cacheKey);
      if (!flight) {
        flight = mintToken(provider);
        inFlight.set(cacheKey, flight);
      }
      try {
        const entry = await flight;
        tokenCache.set(cacheKey, entry);
        return entry.accessToken;
      } finally {
        // Idempotent: every coalesced caller clears the same settled flight.
        if (inFlight.get(cacheKey) === flight) inFlight.delete(cacheKey);
      }
    },
  };
}
