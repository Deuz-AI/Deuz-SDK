/**
 * Verified inbound signals: webhook signature checks over WebCrypto
 * (`crypto.subtle`, no randomness) and a handler that turns a verified,
 * deduplicated request into one dispatch. Edge-safe.
 */
import type { ScheduleClaim } from './scheduler';

export type SignalRejection =
  | 'missing-signature'
  | 'malformed-signature'
  | 'bad-signature'
  | 'missing-timestamp'
  | 'malformed-timestamp'
  | 'stale-timestamp'
  | 'body-used';

/** A verifier's answer. On success `body` is the raw body, read exactly once. */
export type SignalVerification =
  | { readonly ok: true; readonly body: string }
  | { readonly ok: false; readonly reason: SignalRejection };

export type HmacAlgorithm = 'SHA-1' | 'SHA-256' | 'SHA-384' | 'SHA-512';
export type SignatureEncoding = 'hex' | 'base64' | 'base64url';

export interface HmacSignatureOptions {
  /** The raw body exactly as received. */
  body: string | Uint8Array;
  /** The signature as sent, e.g. a header value. */
  signature: string | null | undefined;
  secret: string | Uint8Array;
  /** Default 'SHA-256'. */
  algorithm?: HmacAlgorithm;
  /** Default 'hex'. */
  encoding?: SignatureEncoding;
  /** A scheme prefix the signature must start with, e.g. 'sha256='. */
  prefix?: string;
}

const ALGORITHMS: readonly HmacAlgorithm[] = ['SHA-1', 'SHA-256', 'SHA-384', 'SHA-512'];
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function bytes(value: string | Uint8Array): Uint8Array<ArrayBuffer> {
  return typeof value === 'string' ? encoder.encode(value) : new Uint8Array(value);
}

function decodeSignature(text: string, encoding: SignatureEncoding): Uint8Array | undefined {
  if (encoding === 'hex') {
    if (text.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(text)) return undefined;
    const out = new Uint8Array(text.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(text.slice(i * 2, i * 2 + 2), 16);
    return out;
  }
  const pattern = encoding === 'base64' ? /^[A-Za-z0-9+/]+={0,2}$/ : /^[A-Za-z0-9_-]+={0,2}$/;
  if (!pattern.test(text)) return undefined;
  const standard = encoding === 'base64' ? text : text.replace(/-/g, '+').replace(/_/g, '/');
  const padded = standard.padEnd(Math.ceil(standard.length / 4) * 4, '=');
  try {
    const binary = atob(padded);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
  } catch {
    return undefined;
  }
}

/** Compares in time that depends only on the lengths, which are public. */
function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

async function hmac(
  algorithm: HmacAlgorithm,
  secret: string | Uint8Array,
  data: Uint8Array<ArrayBuffer>,
): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    'raw',
    bytes(secret),
    { name: 'HMAC', hash: algorithm },
    false,
    ['sign'],
  );
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, data));
}

async function check(
  options: Omit<HmacSignatureOptions, 'body'>,
  data: Uint8Array<ArrayBuffer>,
): Promise<SignalRejection | undefined> {
  const algorithm = options.algorithm ?? 'SHA-256';
  if (!ALGORITHMS.includes(algorithm))
    throw new TypeError(`Unsupported HMAC algorithm: ${String(options.algorithm)}`);
  const secret = options.secret;
  if (!(typeof secret === 'string' || secret instanceof Uint8Array) || secret.length === 0)
    throw new TypeError('HMAC secret must be a nonempty string or Uint8Array');
  let text = options.signature;
  if (typeof text !== 'string' || text === '') return 'missing-signature';
  if (options.prefix !== undefined) {
    if (!text.startsWith(options.prefix)) return 'malformed-signature';
    text = text.slice(options.prefix.length);
  }
  const provided = decodeSignature(text.trim(), options.encoding ?? 'hex');
  if (!provided) return 'malformed-signature';
  const expected = await hmac(algorithm, secret, data);
  return timingSafeEqual(expected, provided) ? undefined : 'bad-signature';
}

/** Verifies an HMAC signature over a body you already hold. */
export async function verifyHmacSignature(
  options: HmacSignatureOptions,
): Promise<SignalVerification> {
  const data = bytes(options.body);
  const reason = await check(options, data);
  if (reason) return { ok: false, reason };
  return {
    ok: true,
    body: typeof options.body === 'string' ? options.body : decoder.decode(data),
  };
}

async function readBody(request: Request): Promise<Uint8Array<ArrayBuffer> | undefined> {
  if (request.bodyUsed) return undefined;
  return new Uint8Array(await request.arrayBuffer());
}

/**
 * Verifies a GitHub webhook delivery: `X-Hub-Signature-256` is `sha256=` plus
 * the hex HMAC-SHA256 of the raw body under the webhook secret.
 */
export async function verifyGitHubWebhook(
  request: Request,
  secret: string,
): Promise<SignalVerification> {
  const signature = request.headers.get('x-hub-signature-256');
  if (!signature) return { ok: false, reason: 'missing-signature' };
  const body = await readBody(request);
  if (!body) return { ok: false, reason: 'body-used' };
  return verifyHmacSignature({ body, signature, secret, prefix: 'sha256=' });
}

export interface SlackVerifyOptions {
  /** The current time in epoch ms, e.g. `deps.clock.now()`. Required: core never reads the host clock. */
  now: number;
  /** The replay window either side of `now`. Default 300 (five minutes, Slack's advice). */
  toleranceSeconds?: number;
}

/**
 * Verifies a Slack request: `X-Slack-Signature` is `v0=` plus the hex
 * HMAC-SHA256 of `v0:{X-Slack-Request-Timestamp}:{raw body}` under the
 * signing secret, and the timestamp must lie within the replay window.
 */
export async function verifySlackRequest(
  request: Request,
  signingSecret: string,
  options: SlackVerifyOptions,
): Promise<SignalVerification> {
  const now = options?.now;
  if (typeof now !== 'number' || !Number.isFinite(now))
    throw new TypeError('verifySlackRequest needs options.now (epoch milliseconds)');
  const tolerance = options.toleranceSeconds ?? 300;
  if (!Number.isFinite(tolerance) || tolerance < 0)
    throw new TypeError('toleranceSeconds must be a nonnegative number');
  const timestamp = request.headers.get('x-slack-request-timestamp');
  if (!timestamp) return { ok: false, reason: 'missing-timestamp' };
  if (!/^\d{1,12}$/.test(timestamp)) return { ok: false, reason: 'malformed-timestamp' };
  const signature = request.headers.get('x-slack-signature');
  if (!signature) return { ok: false, reason: 'missing-signature' };
  if (Math.abs(now / 1000 - Number(timestamp)) > tolerance)
    return { ok: false, reason: 'stale-timestamp' };
  const body = await readBody(request);
  if (!body) return { ok: false, reason: 'body-used' };
  const head = encoder.encode(`v0:${timestamp}:`);
  const base = new Uint8Array(head.length + body.length);
  base.set(head);
  base.set(body, head.length);
  const reason = await check({ signature, secret: signingSecret, prefix: 'v0=' }, base);
  return reason ? { ok: false, reason } : { ok: true, body: decoder.decode(body) };
}

export interface SignalDispatchInput {
  body: string;
  /** The dedupe key: `options.key`'s answer, or `sha256:<hex of body>`. */
  key: string;
  request: Request;
}

export interface HandleSignalOptions {
  verify(request: Request): SignalVerification | Promise<SignalVerification>;
  /**
   * Resolves true the first time a key is seen (the scheduler's claim shape,
   * so `createInMemoryClaim()` or a durable claim fits). When `dispatch`
   * throws, its `release` gives the key back so the sender's retry dispatches;
   * a claim without `release` answers that retry as a duplicate. Omit it when
   * `dispatch` is itself idempotent on the key.
   */
  dedupe?: ScheduleClaim;
  /** Derives the dedupe key, e.g. from `X-GitHub-Delivery`. Default: a SHA-256 of the body. */
  key?(input: { body: string; request: Request }): string | undefined | Promise<string | undefined>;
  /** Starts or resumes the work. Keep it short: enqueue, or start a durable run keyed by `key`. */
  dispatch(input: SignalDispatchInput): unknown;
}

function reply(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

async function bodyKey(body: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(body)));
  let hex = '';
  for (const byte of digest) hex += byte.toString(16).padStart(2, '0');
  return `sha256:${hex}`;
}

/**
 * Verifies, dedupes and dispatches one inbound signal. Answers 401 for a
 * rejected signature, 200 for a duplicate (nothing dispatched), 202 once
 * `dispatch` resolves, and 500 when verify, dedupe or dispatch throws. A 500
 * invites the sender to retry, so a throwing dispatch first releases the key
 * it claimed (when the claim has `release`).
 */
export async function handleSignal(
  request: Request,
  options: HandleSignalOptions,
): Promise<Response> {
  let verification: SignalVerification;
  try {
    verification = await options.verify(request);
  } catch {
    return reply(500, { ok: false, reason: 'verify-error' });
  }
  if (!verification.ok) return reply(401, { ok: false, reason: verification.reason });
  const { body } = verification;
  let key: string;
  try {
    key = (await options.key?.({ body, request })) || (await bodyKey(body));
  } catch {
    return reply(500, { ok: false, reason: 'key-error' });
  }
  if (options.dedupe) {
    let fresh: boolean;
    try {
      fresh = (await options.dedupe(key)) === true;
    } catch {
      return reply(500, { ok: false, reason: 'dedupe-error' });
    }
    if (!fresh) return reply(200, { ok: true, duplicate: true, key });
  }
  try {
    await options.dispatch({ body, key, request });
  } catch {
    try {
      // Only a fresh key reaches dispatch, so this gives back our own claim.
      await options.dedupe?.release?.(key);
    } catch {
      // The key stays claimed and the retry is answered as a duplicate.
    }
    return reply(500, { ok: false, reason: 'dispatch-error' });
  }
  return reply(202, { ok: true, key });
}
