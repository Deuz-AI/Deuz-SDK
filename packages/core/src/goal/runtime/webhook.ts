/**
 * Webhook delivery into a goal's inbox (2.4, spec §3.2): a Fetch API handler
 * that runs on the edge as it is, plus an adapter for Node's
 * `IncomingMessage`/`ServerResponse` that never imports `node:http` (the
 * request and response are typed structurally). Verification reuses
 * `verifyHmacSignature`, `verifyGitHubWebhook` and `verifySlackRequest`; the
 * scope and target goal come from the host's configuration, never from the
 * request. Edge-safe.
 */
import type { SignalVerification, HmacAlgorithm, SignatureEncoding } from '../../schedule/signal';
import type { Dependencies } from '../../types/deps';
import { notImplemented } from '../../internal/not-implemented';
import type { GoalEventInput } from '../events';
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

/**
 * A webhook handler that commits deliveries into a goal inbox (2.4). Answers:
 * `202` only after the delivery is durably enqueued; `200` only for a
 * recorded duplicate with the same content and target; `409` for a known
 * delivery id with another payload or target (nothing recorded); `401` for a
 * failed verification; `404` when no target matches; `413` for an oversized
 * body; `405` for a method other than POST. Dedupe ids never expire unless
 * the host prunes them; payloads become content-free tombstones after
 * retention.
 */
export function createWebhookHandler(_options: WebhookHandlerOptions): FetchHandler {
  return notImplemented('createWebhookHandler');
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

/**
 * Serves a Fetch handler from Node's `http` server, Express or similar (2.4):
 * builds a `Request` from the incoming message (`origin` resolves its URL)
 * and writes the `Response` back. Imports nothing from `node:http`.
 */
export function toNodeHandler(
  _handler: FetchHandler,
  _options?: { origin?: string },
): (request: NodeIncomingMessageLike, response: NodeServerResponseLike) => Promise<void> {
  return notImplemented('toNodeHandler');
}
