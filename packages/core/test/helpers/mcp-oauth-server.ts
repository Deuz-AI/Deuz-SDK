/**
 * mcp-oauth-server.ts — a zero-dependency fake OAuth 2.1 authorization server.
 *
 * `src/mcp/auth.ts` is a thin adaptor over the MCP SDK's own `auth()` state
 * machine, so the only way to test it honestly is to make the SDK talk to a real
 * authorization server over a real socket. That is all this is: `node:http` plus
 * `node:crypto`, ~one endpoint per RFC.
 *
 * | endpoint                                     | RFC       | what it exercises                      |
 * | -------------------------------------------- | --------- | -------------------------------------- |
 * | `GET  /.well-known/oauth-authorization-server`| 8414      | metadata discovery                     |
 * | `GET  /.well-known/oauth-protected-resource`  | 9728      | resource → AS indirection               |
 * | `POST /register`                              | 7591      | dynamic client registration            |
 * | `GET  /authorize`                             | 6749 §4.1 | consent + 302 back to `redirect_uri`   |
 * | `POST /token`                                 | 7636/6749 | PKCE S256 check, refresh, rotation     |
 *
 * Everything it issues is a COUNTER, not randomness (`client-1`, `code-1`, `at-1`,
 * `rt-1`), so assertions can name the value they expect. The PKCE check is the
 * real thing — `base64url(sha256(code_verifier)) === code_challenge`, computed with
 * `node:crypto` — and a mismatch answers `400 invalid_grant`, because a fake that
 * always says yes would let a broken verifier ship.
 *
 * Three arrays are exposed for assertions: `registrations`, `authorizations`,
 * `tokenRequests` (raw inputs, in order) and `issued` (what went back out).
 * `close()` is idempotent; call it from `afterEach`.
 */
import {
  createServer,
  type IncomingMessage,
  type Server as HttpServer,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { createHash } from 'node:crypto';

/** A `POST /register` request together with the credentials it was answered with. */
export interface RegistrationRecord {
  /** The RFC 7591 client metadata exactly as it arrived. */
  request: Record<string, unknown>;
  clientId: string;
  clientSecret?: string;
  tokenEndpointAuthMethod: string;
}

/** A parsed `/authorize` request — the PKCE and CSRF material a test asserts on. */
export interface AuthorizationRecord {
  code: string;
  clientId?: string;
  redirectUri?: string;
  codeChallenge?: string;
  codeChallengeMethod?: string;
  state?: string;
  scope?: string;
  resource?: string;
  /** Set once the code has been redeemed — a second `/token` call must fail. */
  redeemed: boolean;
}

/** A `POST /token` request: form fields flattened, plus the client auth header. */
export interface TokenRequestRecord {
  params: Record<string, string>;
  authorizationHeader?: string;
  /** The grant that was attempted, even when the request was rejected. */
  grantType?: string;
  /** HTTP status this request was answered with. */
  status: number;
  /** OAuth error code when `status` is not 200. */
  error?: string;
}

/** One successfully issued token pair. */
export interface IssuedTokenRecord {
  accessToken: string;
  refreshToken?: string;
  clientId?: string;
  grantType: string;
  scope?: string;
  resource?: string;
  expiresIn: number;
  /** Wall-clock expiry, and the flag `expireAccessTokens()` flips. */
  expiresAtMs: number;
  revoked: boolean;
}

export interface FakeAuthServerOptions {
  /** `expires_in` on issued access tokens. Default 3600. */
  accessTokenTtlSeconds?: number;
  /** Issue `refresh_token` alongside every access token. Default `true`. */
  issueRefreshToken?: boolean;
  /** Replace the refresh token on every `refresh_token` grant. Default `false`. */
  rotateRefreshTokens?: boolean;
  /** `token_endpoint_auth_method` handed back by `/register`. Default `client_secret_post`. */
  tokenEndpointAuthMethod?: 'client_secret_post' | 'client_secret_basic' | 'none';
  /** `scopes_supported` in the AS metadata. Omitted when absent. */
  scopesSupported?: string[];
  /** `resource` in the RFC 9728 document. Defaults to this server's own origin. */
  resource?: string;
  /** Answer `/register` with this status instead of 201 (DCR failure paths). */
  registrationStatus?: number;
}

export interface FakeAuthServerHandle {
  /** Origin, no trailing slash — hand this to `authorizationServers`. */
  url: string;
  port: number;
  issued: IssuedTokenRecord[];
  registrations: RegistrationRecord[];
  authorizations: AuthorizationRecord[];
  tokenRequests: TokenRequestRecord[];
  /**
   * Play the user: parse an `/authorize` URL, record `code_challenge`/`state`/
   * `client_id`/`redirect_uri`, and return the authorization code — no browser and
   * no redirect involved. (Hitting `GET /authorize` over HTTP does the same thing
   * and then 302s to `redirect_uri`, for loopback-listener tests.)
   */
  simulateUserAuthorization(authorizationUrl: string | URL): string;
  /** Is this token one we issued, unrevoked and unexpired? Feeds the MCP harness's gate. */
  isValidAccessToken(token: string | undefined): boolean;
  /** Invalidate every access token issued so far — a deterministic stand-in for expiry. */
  expireAccessTokens(): void;
  /** Idempotent teardown. Always call it. */
  close(): Promise<void>;
}

/** RFC 7636 §4.2: `code_challenge = BASE64URL(SHA256(ASCII(code_verifier)))`. */
function s256(verifier: string): string {
  return createHash('sha256').update(verifier, 'ascii').digest('base64url');
}

function json(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Start the fake authorization server on an ephemeral 127.0.0.1 port. Resolves
 * once it is accepting connections.
 */
export async function startFakeAuthServer(
  opts: FakeAuthServerOptions = {},
): Promise<FakeAuthServerHandle> {
  const ttl = opts.accessTokenTtlSeconds ?? 3600;
  const withRefresh = opts.issueRefreshToken ?? true;
  const authMethod = opts.tokenEndpointAuthMethod ?? 'client_secret_post';

  const registrations: RegistrationRecord[] = [];
  const authorizations: AuthorizationRecord[] = [];
  const tokenRequests: TokenRequestRecord[] = [];
  const issued: IssuedTokenRecord[] = [];

  const codes = new Map<string, AuthorizationRecord>();
  const clients = new Map<string, RegistrationRecord>();
  /** refresh_token → the issuance it belongs to, so a rotated token can be re-linked. */
  const refreshTokens = new Map<string, IssuedTokenRecord>();

  let clientSeq = 0;
  let codeSeq = 0;
  let tokenSeq = 0;
  let closed = false;
  let port = 0;

  const sockets = new Set<Socket>();
  const origin = (): string => `http://127.0.0.1:${port}`;

  function authorizationServerMetadata(): Record<string, unknown> {
    const doc: Record<string, unknown> = {
      issuer: origin(),
      authorization_endpoint: `${origin()}/authorize`,
      token_endpoint: `${origin()}/token`,
      registration_endpoint: `${origin()}/register`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['client_secret_post', 'client_secret_basic', 'none'],
    };
    if (opts.scopesSupported) doc.scopes_supported = opts.scopesSupported;
    return doc;
  }

  function protectedResourceMetadata(): Record<string, unknown> {
    const doc: Record<string, unknown> = {
      resource: opts.resource ?? `${origin()}/`,
      authorization_servers: [origin()],
      bearer_methods_supported: ['header'],
    };
    if (opts.scopesSupported) doc.scopes_supported = opts.scopesSupported;
    return doc;
  }

  /** Record an `/authorize` request and mint its one-time code. */
  function authorize(url: URL): AuthorizationRecord {
    const q = url.searchParams;
    const record: AuthorizationRecord = {
      code: `code-${++codeSeq}`,
      clientId: q.get('client_id') ?? undefined,
      redirectUri: q.get('redirect_uri') ?? undefined,
      codeChallenge: q.get('code_challenge') ?? undefined,
      codeChallengeMethod: q.get('code_challenge_method') ?? undefined,
      state: q.get('state') ?? undefined,
      scope: q.get('scope') ?? undefined,
      resource: q.get('resource') ?? undefined,
      redeemed: false,
    };
    authorizations.push(record);
    codes.set(record.code, record);
    return record;
  }

  /** RFC 6749 §2.3.1 — Basic header wins, then the POST body. */
  function clientCredentials(
    req: IncomingMessage,
    params: URLSearchParams,
  ): { clientId?: string; clientSecret?: string } {
    const header = req.headers.authorization;
    if (header?.startsWith('Basic ')) {
      const decoded = Buffer.from(header.slice('Basic '.length), 'base64').toString('utf8');
      const sep = decoded.indexOf(':');
      if (sep >= 0) {
        return { clientId: decoded.slice(0, sep), clientSecret: decoded.slice(sep + 1) };
      }
    }
    return {
      clientId: params.get('client_id') ?? undefined,
      clientSecret: params.get('client_secret') ?? undefined,
    };
  }

  function issue(
    grantType: string,
    clientId: string | undefined,
    scope: string | undefined,
    resource: string | undefined,
  ): IssuedTokenRecord {
    const n = ++tokenSeq;
    const record: IssuedTokenRecord = {
      accessToken: `at-${n}`,
      clientId,
      grantType,
      scope,
      resource,
      expiresIn: ttl,
      expiresAtMs: Date.now() + ttl * 1000,
      revoked: false,
    };
    if (withRefresh) {
      record.refreshToken = `rt-${n}`;
      refreshTokens.set(record.refreshToken, record);
    }
    issued.push(record);
    return record;
  }

  function tokenResponse(record: IssuedTokenRecord): Record<string, unknown> {
    const body: Record<string, unknown> = {
      access_token: record.accessToken,
      token_type: 'Bearer',
      expires_in: record.expiresIn,
    };
    if (record.refreshToken) body.refresh_token = record.refreshToken;
    if (record.scope) body.scope = record.scope;
    return body;
  }

  async function handleToken(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const params = new URLSearchParams(await readBody(req));
    const flat: Record<string, string> = {};
    for (const [k, v] of params) flat[k] = v;
    const grantType = params.get('grant_type') ?? undefined;
    const record: TokenRequestRecord = {
      params: flat,
      grantType,
      status: 200,
    };
    const authHeader = req.headers.authorization;
    if (authHeader) record.authorizationHeader = authHeader;
    tokenRequests.push(record);

    const fail = (status: number, error: string, description: string): void => {
      record.status = status;
      record.error = error;
      json(res, status, { error, error_description: description });
    };

    const { clientId, clientSecret } = clientCredentials(req, params);
    const registered = clientId ? clients.get(clientId) : undefined;
    // Only clients WE registered are checked for a secret — a test may hard-code a
    // pre-provisioned client_id that never went through DCR.
    if (registered?.clientSecret && registered.clientSecret !== clientSecret) {
      fail(401, 'invalid_client', 'Client authentication failed.');
      return;
    }

    if (grantType === 'authorization_code') {
      const code = params.get('code');
      const grant = code ? codes.get(code) : undefined;
      if (!grant || grant.redeemed) {
        fail(400, 'invalid_grant', 'Unknown or already-redeemed authorization code.');
        return;
      }
      if (grant.codeChallenge) {
        const verifier = params.get('code_verifier');
        if (!verifier) {
          fail(400, 'invalid_grant', 'Missing code_verifier for a PKCE authorization.');
          return;
        }
        if (s256(verifier) !== grant.codeChallenge) {
          fail(400, 'invalid_grant', 'PKCE verification failed (S256 mismatch).');
          return;
        }
      }
      const redirectUri = params.get('redirect_uri');
      if (grant.redirectUri && redirectUri && grant.redirectUri !== redirectUri) {
        fail(400, 'invalid_grant', 'redirect_uri does not match the authorization request.');
        return;
      }
      grant.redeemed = true;
      json(
        res,
        200,
        tokenResponse(
          issue('authorization_code', clientId, grant.scope, params.get('resource') ?? undefined),
        ),
      );
      return;
    }

    if (grantType === 'refresh_token') {
      const presented = params.get('refresh_token');
      const previous = presented ? refreshTokens.get(presented) : undefined;
      if (!previous) {
        fail(400, 'invalid_grant', 'Unknown refresh token.');
        return;
      }
      // The old access token dies with the refresh — that is what makes a
      // "401 → refresh → retry" test observable.
      previous.revoked = true;
      const next = issue(
        'refresh_token',
        clientId,
        previous.scope,
        params.get('resource') ?? undefined,
      );
      if (withRefresh && !opts.rotateRefreshTokens && presented) {
        if (next.refreshToken) refreshTokens.delete(next.refreshToken);
        next.refreshToken = presented;
        refreshTokens.set(presented, next);
      } else if (presented) {
        refreshTokens.delete(presented);
      }
      json(res, 200, tokenResponse(next));
      return;
    }

    fail(400, 'unsupported_grant_type', `Unsupported grant_type: ${String(grantType)}`);
  }

  async function handleRegister(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(raw);
      body =
        typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
    } catch {
      json(res, 400, { error: 'invalid_client_metadata', error_description: 'Body is not JSON.' });
      return;
    }
    if (opts.registrationStatus && opts.registrationStatus !== 201) {
      json(res, opts.registrationStatus, {
        error: 'invalid_client_metadata',
        error_description: 'Registration rejected by the test harness.',
      });
      return;
    }
    const n = ++clientSeq;
    const record: RegistrationRecord = {
      request: body,
      clientId: `client-${n}`,
      tokenEndpointAuthMethod: authMethod,
    };
    if (authMethod !== 'none') record.clientSecret = `secret-${n}`;
    registrations.push(record);
    clients.set(record.clientId, record);
    // RFC 7591 §3.2.1: echo the metadata back with the credentials. The SDK parses
    // this with `OAuthClientInformationFullSchema`, which REQUIRES `redirect_uris`.
    json(res, 201, {
      ...body,
      client_id: record.clientId,
      ...(record.clientSecret ? { client_secret: record.clientSecret } : {}),
      client_id_issued_at: Math.floor(Date.now() / 1000),
      client_secret_expires_at: 0,
      token_endpoint_auth_method: record.tokenEndpointAuthMethod,
    });
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', origin());
    const path = url.pathname;

    if (req.method === 'GET' && path === '/.well-known/oauth-authorization-server') {
      json(res, 200, authorizationServerMetadata());
      return;
    }
    if (req.method === 'GET' && path.startsWith('/.well-known/oauth-protected-resource')) {
      json(res, 200, protectedResourceMetadata());
      return;
    }
    if (req.method === 'POST' && path === '/register') {
      await handleRegister(req, res);
      return;
    }
    if (req.method === 'POST' && path === '/token') {
      await handleToken(req, res);
      return;
    }
    if (req.method === 'GET' && path === '/authorize') {
      const grant = authorize(url);
      if (!grant.redirectUri) {
        json(res, 400, { error: 'invalid_request', error_description: 'Missing redirect_uri.' });
        return;
      }
      const back = new URL(grant.redirectUri);
      back.searchParams.set('code', grant.code);
      if (grant.state) back.searchParams.set('state', grant.state);
      res.writeHead(302, { location: back.toString() });
      res.end();
      return;
    }
    json(res, 404, { error: 'not_found' });
  }

  const httpServer: HttpServer = createServer((req, res) => {
    void handle(req, res).catch((err: unknown) => {
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'harness_failure', error_description: String(err) }));
    });
  });
  httpServer.on('connection', (socket: Socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(0, '127.0.0.1', () => {
      httpServer.removeListener('error', reject);
      resolve();
    });
  });
  port = (httpServer.address() as AddressInfo).port;

  return {
    get url() {
      return origin();
    },
    get port() {
      return port;
    },
    issued,
    registrations,
    authorizations,
    tokenRequests,
    simulateUserAuthorization(authorizationUrl: string | URL) {
      const url =
        typeof authorizationUrl === 'string' ? new URL(authorizationUrl) : authorizationUrl;
      return authorize(url).code;
    },
    isValidAccessToken(token: string | undefined) {
      if (!token) return false;
      const record = issued.find((t) => t.accessToken === token);
      return !!record && !record.revoked && record.expiresAtMs > Date.now();
    },
    expireAccessTokens() {
      for (const record of issued) record.revoked = true;
    },
    async close() {
      if (closed) return;
      closed = true;
      for (const socket of sockets) socket.destroy();
      sockets.clear();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    },
  };
}
