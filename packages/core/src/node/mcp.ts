/**
 * `./mcp/node` — the two things an MCP OAuth flow needs that a browser-safe
 * runtime cannot provide (2.0): somewhere on disk to keep refresh tokens, and a
 * loopback listener to catch the `?code=` a desktop/CLI redirect comes back on.
 *
 * ```ts
 * import { createFileTokenStore, createLoopbackRedirect } from '@deuz-sdk/core/mcp/node';
 * import { createMcpClient } from '@deuz-sdk/core/mcp';
 * // The error class is part of the taxonomy, so it ships from the root entry.
 * import { McpAuthorizationRequiredError } from '@deuz-sdk/core';
 *
 * const loopback = await createLoopbackRedirect();
 * const transport = { type: 'http', url } as const;
 * const auth = {
 *   redirectUri: loopback.redirectUri,
 *   store: createFileTokenStore({ path: `${homedir()}/.deuz/mcp-tokens.json` }),
 * };
 *
 * let client;
 * try {
 *   client = await createMcpClient({ transport, auth });   // tokens on disk? straight through
 * } catch (err) {
 *   if (!(err instanceof McpAuthorizationRequiredError)) throw err;
 *   // The listener only accepts a redirect that echoes ITS state back, so the
 *   // authorization request has to carry it. The host owns the final URL.
 *   const authorize = new URL(err.authorizationUrl);
 *   if (loopback.state) authorize.searchParams.set('state', loopback.state);
 *   showTheUser(authorize.toString());                     // the HOST decides how
 *   const authorizationCode = await loopback.waitForCode();
 *   client = await createMcpClient({ transport, auth, authorizationCode });
 * } finally {
 *   await loopback.close();
 * }
 * ```
 *
 * Node-only by construction (files and sockets), so it is exempt from the
 * edge-safety lint and reaches built-ins through a LAZY `await import('node:…')`
 * — the browser bundle never resolves them.
 */
import { AbortError, AuthenticationError, InvalidRequestError, TimeoutError } from '../errors';
import type { TokenStore } from '../types/config';

export type { TokenStore } from '../types/config';

// Minimal node builtin shapes; the `as string` specifiers keep tsup's dts
// builder from statically resolving node: (matches node/chat-store.ts).
interface NodeFs {
  mkdir(path: string, options: { recursive: boolean }): Promise<unknown>;
  writeFile(path: string, data: string, options: { encoding: string; mode: number }): Promise<void>;
  readFile(path: string, encoding: string): Promise<string>;
  chmod(path: string, mode: number): Promise<void>;
  rename(from: string, to: string): Promise<void>;
}

interface NodeHttpResponse {
  writeHead(status: number, headers: Record<string, string>): void;
  end(body?: string): void;
}
interface NodeHttpRequest {
  url?: string;
}
interface NodeHttpServer {
  listen(port: number, host: string, callback: () => void): void;
  address(): { port: number } | string | null;
  close(callback?: (err?: Error) => void): void;
  closeAllConnections?(): void;
  on(event: string, listener: (err: Error) => void): void;
}
interface NodeHttp {
  createServer(handler: (req: NodeHttpRequest, res: NodeHttpResponse) => void): NodeHttpServer;
}

interface NodeHash {
  update(data: string, encoding: string): NodeHash;
  digest(): Uint8Array;
}
interface NodeCrypto {
  randomBytes(size: number): { toString(encoding: string): string };
  createHash(algorithm: string): NodeHash;
  timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean;
}

async function loadFs(): Promise<NodeFs> {
  return (await import('node:fs/promises' as string)) as unknown as NodeFs;
}

// --- File-backed token store -------------------------------------------------

export interface FileTokenStoreOptions {
  /** JSON file the tokens live in. Parent directories are created on first write. */
  path: string;
}

/** Owner read/write only — these are live refresh tokens. */
const SECRET_FILE_MODE = 0o600;

function parentDirectory(path: string): string | undefined {
  const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return cut > 0 ? path.slice(0, cut) : undefined;
}

/**
 * `TokenStore` backed by ONE JSON file (`{ "<key>": "<value>" }`), created
 * `0600` because it holds refresh tokens — a token file the rest of the machine
 * can read is worse than no persistence at all.
 *
 * Writes go through a temp file and a rename, so a crash mid-write can never
 * tear the existing tokens (the `node/chat-store.ts` pattern), and every
 * operation is chained onto the previous one: `set` is read-modify-write, and
 * two concurrent SDK callbacks — the token save and the verifier save race
 * routinely — would otherwise lose one of the two entries.
 *
 * A file that is missing, unreadable or not valid JSON reads as EMPTY rather
 * than throwing: the caller re-authorizes, which is recoverable, instead of
 * crashing a run on a half-written file.
 */
export function createFileTokenStore(options: FileTokenStoreOptions): TokenStore {
  const temp = `${options.path}.tmp`;

  const readAll = async (): Promise<Record<string, string>> => {
    let contents: string;
    try {
      contents = await (await loadFs()).readFile(options.path, 'utf8');
    } catch {
      return {};
    }
    try {
      const parsed: unknown = JSON.parse(contents);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
      const entries: Record<string, string> = {};
      for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof value === 'string') entries[key] = value;
      }
      return entries;
    } catch {
      return {}; // corrupt → treat as empty; the next write repairs it
    }
  };

  const writeAll = async (entries: Record<string, string>): Promise<void> => {
    const fs = await loadFs();
    const dir = parentDirectory(options.path);
    if (dir) await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(temp, JSON.stringify(entries, null, 2), {
      encoding: 'utf8',
      mode: SECRET_FILE_MODE,
    });
    // `mode` only applies when the file is CREATED — an inherited temp file
    // from an earlier run would keep its old permissions without this.
    try {
      await fs.chmod(temp, SECRET_FILE_MODE);
    } catch {
      /* filesystems without POSIX modes (Windows, some mounts) */
    }
    await fs.rename(temp, options.path);
  };

  // Serialize every operation: the store is a read-modify-write over one file.
  let queue: Promise<unknown> = Promise.resolve();
  const enqueue = <T>(op: () => Promise<T>): Promise<T> => {
    const next = queue.then(op, op);
    queue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  };

  const update = (mutate: (entries: Record<string, string>) => void): Promise<void> =>
    enqueue(async () => {
      const entries = await readAll();
      mutate(entries);
      await writeAll(entries);
    });

  return {
    get: (key) => enqueue(async () => (await readAll())[key]),
    set: (key, value) =>
      update((entries) => {
        entries[key] = value;
      }),
    delete: (key) =>
      update((entries) => {
        delete entries[key];
      }),
  };
}

// --- Loopback redirect listener ---------------------------------------------

export interface LoopbackRedirectOptions {
  /** Port to bind on 127.0.0.1. Default 0 — the OS picks a free one. */
  port?: number;
  /** Path the authorization server redirects to. Default `/callback`. */
  path?: string;
  /** How long to wait for the redirect. Default 300_000 (5 minutes). */
  timeoutMs?: number;
  /**
   * The OAuth `state` this listener demands back. Default: a fresh 256-bit
   * random value — put it in the authorization request (see the module example)
   * and only that request's redirect is accepted.
   *
   * Pass a string to reuse a value you already minted. Pass `false` ONLY when
   * the authorization request genuinely cannot carry `state`: without the echo
   * the listener answers ANY caller, and a local process — or any page open in
   * the user's browser — can then hand it an authorization code of its own
   * (RFC 6819 §4.4.1.5 code injection).
   */
  state?: string | false;
}

export interface LoopbackRedirect {
  /** Pass this as `McpOAuthOptions.redirectUri`. */
  readonly redirectUri: string;
  /**
   * The `state` a redirect must echo for this listener to accept it — put it in
   * the authorization request. `undefined` only when checking was turned off
   * with `state: false`.
   */
  readonly state: string | undefined;
  /** The `?code=` from the redirect. Rejects on `?error=`, or when the wait times out. */
  waitForCode(): Promise<string>;
  /** Stop listening. Idempotent; safe to call from a `finally`. */
  close(): Promise<void>;
}

const REDIRECT_PAGE = (heading: string, detail: string): string =>
  `<!doctype html><meta charset="utf-8"><title>${heading}</title>` +
  `<body style="font:16px system-ui;padding:3rem;max-width:32rem"><h1>${heading}</h1><p>${detail}</p></body>`;

/**
 * A SINGLE-SHOT loopback listener on 127.0.0.1 — the desktop/CLI half of an
 * OAuth redirect. It answers exactly one authorization result, hands the code
 * to `waitForCode()` and stops.
 *
 * 127.0.0.1 rather than `localhost`: the name can resolve to `::1` first, and an
 * authorization server that registered the IPv4 literal would then redirect
 * somewhere nothing is listening. It is also the BIND address, never 0.0.0.0 —
 * a listener on the wildcard would take an authorization code off the LAN.
 * The timer starts at CREATION, not at `waitForCode()`, because the redirect
 * URI is live the moment this resolves.
 *
 * Anything on this machine can reach a loopback port, so the port alone proves
 * nothing about who is calling: the redirect must ALSO echo the `state` minted
 * here, compared in constant time. A request that does not is answered 400 and
 * otherwise IGNORED — it must not be able to end the wait a real redirect is
 * still coming for.
 */
export async function createLoopbackRedirect(
  options: LoopbackRedirectOptions = {},
): Promise<LoopbackRedirect> {
  const path = options.path ?? '/callback';
  const timeoutMs = options.timeoutMs ?? 300_000;
  const http = (await import('node:http' as string)) as unknown as NodeHttp;
  const nodeCrypto = (await import('node:crypto' as string)) as unknown as NodeCrypto;

  // 256 bits, base64url so it survives a query string untouched.
  const expectedState =
    options.state === false
      ? undefined
      : (options.state ?? nodeCrypto.randomBytes(32).toString('base64url'));
  // Hash both sides first: `timingSafeEqual` throws on a length mismatch, and
  // the digest makes every comparison the same fixed width.
  const stateMatches = (received: string | null): boolean => {
    if (expectedState === undefined) return true;
    if (received === null) return false;
    const digest = (value: string): Uint8Array =>
      nodeCrypto.createHash('sha256').update(value, 'utf8').digest();
    return nodeCrypto.timingSafeEqual(digest(received), digest(expectedState));
  };

  let settle: ((code: string) => void) | undefined;
  let fail: ((err: Error) => void) | undefined;
  const code = new Promise<string>((resolve, reject) => {
    settle = resolve;
    fail = reject;
  });
  // Nobody may be awaiting yet when the timeout fires — keep Node from
  // reporting the rejection as unhandled.
  void code.catch(() => undefined);

  const server = http.createServer((req, res) => {
    // `req.url` is path+query only; the base is irrelevant to what we read.
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (url.pathname !== path) {
      res.writeHead(404, { 'content-type': 'text/plain', connection: 'close' });
      res.end('Not found');
      return;
    }
    // Wrong/absent state → refuse the REQUEST, not the flow: a forged call must
    // not be able to fail the wait the real redirect is still on its way to.
    if (!stateMatches(url.searchParams.get('state'))) {
      res.writeHead(400, { 'content-type': 'text/html; charset=utf-8', connection: 'close' });
      res.end(
        REDIRECT_PAGE(
          'Authorization rejected',
          'This redirect did not come from the request that started here. You can close this window.',
        ),
      );
      return;
    }
    const received = url.searchParams.get('code');
    const error = url.searchParams.get('error');
    if (received) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', connection: 'close' });
      res.end(
        REDIRECT_PAGE('Authorized', 'You can close this window and return to your terminal.'),
      );
      settle?.(received);
      return;
    }
    res.writeHead(400, { 'content-type': 'text/html; charset=utf-8', connection: 'close' });
    res.end(REDIRECT_PAGE('Authorization failed', 'You can close this window and try again.'));
    const description = url.searchParams.get('error_description');
    fail?.(
      new AuthenticationError({
        message: error
          ? `The authorization server refused the request: ${error}${description ? ` — ${description}` : ''}`
          : 'The authorization redirect carried neither `code` nor `error`.',
        statusCode: 400,
      }),
    );
  });

  // A bind failure (EADDRINUSE on an explicit `port`) arrives as an 'error'
  // event, NOT as a rejected listen — without this hand-off the await below
  // would hang forever on the one input a caller controls.
  let failListen: ((err: Error) => void) | undefined;
  server.on('error', (err) => {
    const wrapped = new InvalidRequestError({
      message: `Could not listen on 127.0.0.1:${options.port ?? 0} for the OAuth redirect. Pick a free \`port\`, or let the default 0 choose one.`,
      cause: err,
    });
    if (failListen) failListen(wrapped);
    else fail?.(wrapped);
  });

  await new Promise<void>((resolve, reject) => {
    failListen = reject;
    server.listen(options.port ?? 0, '127.0.0.1', () => {
      failListen = undefined;
      resolve();
    });
  });

  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : (options.port ?? 0);
  const redirectUri = `http://127.0.0.1:${port}${path}`;

  const timer = setTimeout(() => {
    fail?.(
      new TimeoutError(
        'total',
        `Timed out after ${timeoutMs}ms waiting for the OAuth redirect on ${redirectUri}.`,
      ),
    );
  }, timeoutMs);
  // A forgotten listener must not hold the process open on its own.
  (timer as unknown as { unref?: () => void }).unref?.();

  let stopping: Promise<void> | undefined;
  const stopListening = (): Promise<void> => {
    if (!stopping) {
      clearTimeout(timer);
      stopping = new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
    return stopping;
  };

  // Single-shot: however the wait ends, stop ACCEPTING — gracefully, because the
  // browser is still reading the page we just wrote (every response carries
  // `connection: close`, so the socket ends on its own).
  void code.then(
    () => stopListening(),
    () => stopListening(),
  );

  return {
    redirectUri,
    state: expectedState,
    waitForCode: () => code,
    close() {
      // An explicit close is a HARD stop — nothing is waiting on that page any
      // more, so a still-open socket must not keep the process alive.
      server.closeAllConnections?.();
      const done = stopListening();
      // No-op once the code arrived; otherwise the pending wait would leak.
      fail?.(
        new AbortError(
          `The loopback redirect listener on ${redirectUri} was closed before an authorization code arrived.`,
        ),
      );
      return done;
    },
  };
}
