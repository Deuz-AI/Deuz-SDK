/**
 * Webhook delivery into a goal's inbox (2.4, spec §3.2): a Fetch API handler
 * that runs on the edge as it is, plus an adapter for Node's
 * `IncomingMessage`/`ServerResponse` that never imports `node:http` (the
 * request and response are typed structurally). Verification reuses
 * `verifyHmacSignature`, `verifyGitHubWebhook` and `verifySlackRequest`; the
 * scope and target goal come from the host's configuration, never from the
 * request. Edge-safe.
 */
import {
  verifyGitHubWebhook,
  verifyHmacSignature,
  verifySlackRequest,
} from '../../schedule/signal';
import type { SignalVerification, HmacAlgorithm, SignatureEncoding } from '../../schedule/signal';
import type { Dependencies } from '../../types/deps';
import { sha256Digest } from '../../internal/digest';
import { resolveDependencies } from '../../internal/resolve-deps';
import { createGoalEvent } from '../events';
import type { GoalEventInput } from '../events';
import type { GoalEvent } from '../types';
import { goalDeliveryDigest } from './delivery';
import { goalInboxKey } from './store';
import type { GoalRuntimeStore } from './store-types';

/** The Fetch API handler signature: what an edge route exports. */
export type FetchHandler = (request: Request) => Promise<Response>;

/** How a webhook request is verified. */
export type WebhookVerification =
  | {
      kind: 'hmac';
      secret: string | Uint8Array;
      /** The header holding the signature. */
      header: string;
      algorithm?: HmacAlgorithm;
      encoding?: SignatureEncoding;
      prefix?: string;
    }
  | { kind: 'github'; secret: string | Uint8Array }
  | { kind: 'slack'; signingSecret: string | Uint8Array; toleranceSeconds?: number }
  /** Your own check; it must read the body exactly once and return it on success. */
  | { kind: 'custom'; verify(request: Request): Promise<SignalVerification> };

/** Where a verified delivery goes: fixed, or chosen by host code from the verified request. */
export type WebhookTarget =
  | { scope: string; goalId: string }
  | ((input: {
      request: Request;
      body: string;
    }) =>
      | { scope: string; goalId: string }
      | undefined
      | Promise<{ scope: string; goalId: string } | undefined>);

/** Options of `createWebhookHandler`. */
export interface WebhookHandlerOptions {
  store: GoalRuntimeStore;
  verify: WebhookVerification;
  target: WebhookTarget;
  /**
   * The dedupe namespace: the endpoint and, for a multi-account provider, the
   * account (`webhook:<endpoint>[:<account>]`). With the scope and the
   * delivery id it forms the inbox entry id.
   */
  namespace: string;
  /**
   * The delivery id: a header name, or a function of the verified request.
   * Default: `X-GitHub-Delivery` for GitHub, else `sha256:<hex>` of the body.
   */
  deliveryId?: string | ((input: { request: Request; body: string }) => string | undefined);
  /** Extra goal event fields from the verified payload (source id, correlation, expiry). */
  event?: (input: {
    request: Request;
    body: string;
    deliveryId: string;
  }) => Partial<Omit<GoalEventInput, 'scope' | 'goalId' | 'key'>>;
  /** Bodies larger than this are refused with 413. Default 1 MiB. */
  maxBodyBytes?: number;
  deps?: Dependencies;
}

/** The default body cap of a webhook handler. */
const DEFAULT_MAX_BODY_BYTES = 1_048_576;
const VERIFICATION_KINDS = ['hmac', 'github', 'slack', 'custom'] as const;
const encoder = new TextEncoder();

function reply(status: number, body: Record<string, unknown>, headers?: Record<string, string>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

const refuse = (status: number, reason: string, headers?: Record<string, string>) =>
  reply(status, { ok: false, reason }, headers);

/** The body, read once and at most `max` bytes of it; a longer body is cut off as it arrives. */
async function readBody(
  request: Request,
  max: number,
): Promise<Uint8Array<ArrayBuffer> | 'too-large' | 'used'> {
  if (request.bodyUsed) return 'used';
  const declared = request.headers.get('content-length');
  if (declared !== null && /^\d+$/.test(declared) && Number(declared) > max) return 'too-large';
  if (!request.body) return new Uint8Array(0);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => undefined);
      return 'too-large';
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function nonEmpty(value: unknown, name: string): string {
  if (typeof value !== 'string' || value === '')
    throw new TypeError(`A webhook ${name} must be a nonempty string`);
  return value;
}

function checkTarget(target: { scope: string; goalId: string }): {
  scope: string;
  goalId: string;
} {
  return {
    scope: nonEmpty(target.scope, 'target scope'),
    goalId: nonEmpty(target.goalId, 'target goalId'),
  };
}

/**
 * A webhook handler that commits deliveries into a goal inbox (2.4). Answers:
 * `202` only after the delivery is durably enqueued; `200` only for a
 * recorded duplicate with the same content and target; `409` for a known
 * delivery id with another payload or target (nothing recorded); `401` for a
 * failed verification; `404` when no target matches; `413` for an oversized
 * body; `405` for a method other than POST. Dedupe ids never expire unless
 * the host prunes them; payloads become content-free tombstones after
 * retention.
 *
 * The queued event comes from host code only: scope and goal from `target`,
 * source `{ type: 'signal', id: namespace }`, key and id the inbox entry id
 * (so the goal's own dedupe agrees with the inbox), `at` the arrival time on
 * the injected clock, and a `payload` reference (entry id, body digest,
 * media type, size); `event` adds fields from the verified body. A store or
 * host-code failure answers `500`, never `202`, so the sender retries.
 */
export function createWebhookHandler(options: WebhookHandlerOptions): FetchHandler {
  if (typeof options !== 'object' || options === null || typeof options.store !== 'object')
    throw new TypeError('createWebhookHandler needs a GoalRuntimeStore');
  const { store, verify } = options;
  const namespace = nonEmpty(options.namespace, 'namespace');
  if (!VERIFICATION_KINDS.includes(verify?.kind))
    throw new TypeError(
      `Webhook verification kind must be one of ${VERIFICATION_KINDS.join(', ')}`,
    );
  if (verify.kind === 'hmac') nonEmpty(verify.header, 'signature header');
  if (verify.kind === 'custom' && typeof verify.verify !== 'function')
    throw new TypeError('A custom webhook verification needs a verify function');
  const fixedTarget =
    typeof options.target === 'function' ? undefined : checkTarget(options.target);
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  if (!Number.isSafeInteger(maxBodyBytes) || maxBodyBytes < 1)
    throw new TypeError('maxBodyBytes must be a positive integer');
  const deps = resolveDependencies(options.deps);

  async function verified(
    request: Request,
    bytes: Uint8Array<ArrayBuffer>,
  ): Promise<SignalVerification> {
    if (verify.kind === 'hmac')
      return verifyHmacSignature({
        body: bytes,
        signature: request.headers.get(verify.header),
        secret: verify.secret,
        ...(verify.algorithm !== undefined ? { algorithm: verify.algorithm } : {}),
        ...(verify.encoding !== undefined ? { encoding: verify.encoding } : {}),
        ...(verify.prefix !== undefined ? { prefix: verify.prefix } : {}),
      });
    // The helpers read the body of the request they get: hand them a copy
    // holding the bytes already read. They hash a byte secret as it is.
    const copy = new Request(request.url, {
      method: request.method,
      headers: request.headers,
      body: bytes,
    });
    if (verify.kind === 'github') return verifyGitHubWebhook(copy, verify.secret as string);
    if (verify.kind === 'slack')
      return verifySlackRequest(copy, verify.signingSecret as string, {
        now: deps.clock.now(),
        ...(verify.toleranceSeconds !== undefined
          ? { toleranceSeconds: verify.toleranceSeconds }
          : {}),
      });
    return verify.verify(copy);
  }

  async function deliveryIdOf(request: Request, body: string): Promise<string> {
    const option = options.deliveryId;
    const found =
      typeof option === 'function'
        ? option({ request, body })
        : typeof option === 'string'
          ? request.headers.get(option)
          : verify.kind === 'github'
            ? request.headers.get('x-github-delivery')
            : undefined;
    return typeof found === 'string' && found !== '' ? found : sha256Digest(body);
  }

  return async (request) => {
    if (request.method !== 'POST') return refuse(405, 'method-not-allowed', { allow: 'POST' });
    const bytes = await readBody(request, maxBodyBytes);
    if (bytes === 'too-large') return refuse(413, 'payload-too-large');
    if (bytes === 'used') return refuse(401, 'body-used');

    let verification: SignalVerification;
    try {
      verification = await verified(request, bytes);
    } catch {
      return refuse(500, 'verify-error');
    }
    if (!verification.ok) return refuse(401, verification.reason);
    const body = verification.body;

    let target: { scope: string; goalId: string } | undefined;
    try {
      target =
        fixedTarget ??
        (await (options.target as Exclude<WebhookTarget, { scope: string }>)({ request, body }));
      if (target !== undefined) target = checkTarget(target);
    } catch {
      return refuse(500, 'target-error');
    }
    if (!target) return refuse(404, 'unknown-target');
    const { scope, goalId } = target;
    try {
      if (!(await store.load(goalId, { scope }))) return refuse(404, 'unknown-target');
    } catch {
      return refuse(500, 'store-error');
    }

    let deliveryId: string;
    let event: GoalEvent;
    const mediaType = request.headers.get('content-type') ?? undefined;
    const payload = { body, ...(mediaType !== undefined ? { mediaType } : {}) };
    try {
      deliveryId = await deliveryIdOf(request, body);
      const entryId = goalInboxKey(scope, namespace, deliveryId);
      const extra = options.event?.({ request, body, deliveryId }) ?? {};
      event = createGoalEvent({
        source: { type: 'signal', id: namespace },
        at: deps.clock.now(),
        payload: {
          ref: entryId,
          digest: await sha256Digest(body),
          ...(mediaType !== undefined ? { mediaType } : {}),
          bytes: encoder.encode(body).length,
        },
        ...extra,
        scope,
        goalId,
        key: entryId,
      });
    } catch {
      return refuse(500, 'event-error');
    }

    let status: 'enqueued' | 'duplicate' | 'conflict';
    try {
      const digest = await goalDeliveryDigest({ scope, goalId, event, payload });
      ({ status } = await store.inbox.enqueue({
        scope,
        goalId,
        namespace,
        deliveryId,
        event,
        payload,
        digest,
      }));
    } catch {
      return refuse(500, 'store-error');
    }
    if (status === 'conflict') return refuse(409, 'delivery_conflict');
    if (status === 'duplicate') return reply(200, { ok: true, duplicate: true, deliveryId });
    return reply(202, { ok: true, deliveryId });
  };
}

/** The part of Node's `IncomingMessage` the adapter reads. */
export interface NodeIncomingMessageLike extends AsyncIterable<Uint8Array | string> {
  method?: string;
  url?: string;
  headers: Record<string, string | string[] | undefined>;
}

/** The part of Node's `ServerResponse` the adapter writes. */
export interface NodeServerResponseLike {
  statusCode: number;
  setHeader(name: string, value: string): unknown;
  end(body?: string | Uint8Array): unknown;
}

/** The body of an incoming message as a stream: read as the handler reads, stopped when it stops. */
function bodyStream(source: AsyncIterable<Uint8Array | string>): ReadableStream<Uint8Array> {
  let iterator: AsyncIterator<Uint8Array | string> | undefined;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      iterator ??= source[Symbol.asyncIterator]();
      const { done, value } = await iterator.next();
      if (done) controller.close();
      else controller.enqueue(typeof value === 'string' ? encoder.encode(value) : value);
    },
    async cancel() {
      await iterator?.return?.();
    },
  });
}

function requestOf(message: NodeIncomingMessageLike, origin: string | undefined): Request {
  const headers = new Headers();
  for (const [name, value] of Object.entries(message.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) for (const item of value) headers.append(name, item);
    else headers.set(name, value);
  }
  const url = new URL(message.url ?? '/', origin ?? `http://${headers.get('host') ?? 'localhost'}`);
  const method = (message.method ?? 'GET').toUpperCase();
  const init: RequestInit & { duplex?: 'half' } = { method, headers };
  if (method !== 'GET' && method !== 'HEAD') {
    init.body = bodyStream(message);
    // Node's fetch needs this for a streamed request body.
    init.duplex = 'half';
  }
  return new Request(url, init);
}

/**
 * Serves a Fetch handler from Node's `http` server, Express or similar (2.4):
 * builds a `Request` from the incoming message (`origin` resolves its URL)
 * and writes the `Response` back. Imports nothing from `node:http`.
 *
 * Without `origin` the URL is `http://` plus the `Host` header. The body is
 * streamed to the handler as it reads it (a webhook handler stops reading
 * past `maxBodyBytes`), never buffered first. A handler that throws answers
 * `500`.
 */
export function toNodeHandler(
  handler: FetchHandler,
  options?: { origin?: string },
): (request: NodeIncomingMessageLike, response: NodeServerResponseLike) => Promise<void> {
  if (typeof handler !== 'function') throw new TypeError('toNodeHandler needs a Fetch handler');
  const origin = options?.origin;
  if (origin !== undefined)
    try {
      new URL(origin);
    } catch {
      throw new TypeError(`origin must be an absolute URL, not ${JSON.stringify(origin)}`);
    }
  return async (message, response) => {
    let answer: Response;
    try {
      answer = await handler(requestOf(message, origin));
    } catch {
      answer = refuse(500, 'handler-error');
    }
    response.statusCode = answer.status;
    answer.headers.forEach((value, name) => {
      response.setHeader(name, value);
    });
    response.end(new Uint8Array(await answer.arrayBuffer()));
  };
}
