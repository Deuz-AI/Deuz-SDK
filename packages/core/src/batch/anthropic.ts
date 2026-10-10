/**
 * Anthropic Message Batches (2.3, BA2): `POST /v1/messages/batches` with
 * `{ custom_id, params }` requests, polled until `processing_status` is
 * `ended`, then the JSON Lines file at `results_url`, one
 * `succeeded` / `errored` / `canceled` / `expired` result per request. Shapes
 * from `@anthropic-ai/sdk` 0.133 (`resources/messages/batches`); limits
 * (100,000 requests or 256 MB, 24 hours) from Anthropic's Claude API reference
 * (cached 2026-10-06). Not live-verified.
 */
import { anthropicAdapter } from '../adapters/anthropic';
import type { ResolvedCall } from '../internal/resolve-call';
import {
  count,
  ENDED,
  isObject,
  mergeHeaders,
  SubmitFailure,
  time,
  type BatchDriver,
  type BatchOutcome,
  type DriverStatus,
  type Json,
} from './driver';
import { BatchError } from './errors';
import { jsonLines, readJson, send } from './http';
import type { BatchState, BatchStatus } from './types';

const VERSION = '2023-06-01';
const MAX_REQUESTS = 100_000;
const MAX_BYTES = 256_000_000;

const adapter = anthropicAdapter;

/** The HTTP status Anthropic gives each error type; it decides whether a hold is released. */
const ERROR_STATUS = new Map<string, number>([
  ['invalid_request_error', 400],
  ['authentication_error', 401],
  ['billing_error', 402],
  ['permission_error', 403],
  ['not_found_error', 404],
  ['request_too_large', 413],
  ['rate_limit_error', 429],
  ['api_error', 500],
  ['timeout_error', 504],
  ['overloaded_error', 529],
]);

function headers(call: ResolvedCall, extra?: Record<string, string>): Record<string, string> {
  return mergeHeaders(
    { 'content-type': 'application/json', 'x-api-key': call.apiKey, 'anthropic-version': VERSION },
    call.headers,
    extra,
  );
}

/** Every `anthropic-beta` value the requests carry, once each, for the batch call. */
function betas(prepared: readonly { headers: Readonly<Record<string, string>> }[]): string {
  const values = new Set<string>();
  for (const request of prepared)
    for (const [name, value] of Object.entries(request.headers))
      if (name.toLowerCase() === 'anthropic-beta')
        for (const beta of value.split(',')) if (beta.trim()) values.add(beta.trim());
  return [...values].join(',');
}

function normalize(id: string, raw: unknown): DriverStatus {
  const batch: Json = isObject(raw) ? raw : {};
  const providerState =
    typeof batch.processing_status === 'string' ? batch.processing_status : 'unknown';
  const requests = isObject(batch.request_counts) ? batch.request_counts : {};
  const processing = count(requests.processing) ?? 0;
  const succeeded = count(requests.succeeded) ?? 0;
  const errored = count(requests.errored) ?? 0;
  const cancelled = count(requests.canceled) ?? 0;
  const expired = count(requests.expired) ?? 0;
  const total = processing + succeeded + errored + cancelled + expired;
  let state: BatchState;
  if (providerState === 'ended')
    state =
      typeof batch.cancel_initiated_at === 'string'
        ? 'cancelled'
        : total > 0 && expired === total
          ? 'expired'
          : 'completed';
  else state = providerState === 'canceling' ? 'cancelling' : 'running';
  const expiresAt = time(batch.expires_at);
  const status: BatchStatus = {
    id: typeof batch.id === 'string' ? batch.id : id,
    state,
    ended: ENDED.has(state),
    providerState,
    counts: { total, succeeded, errored, cancelled, expired, processing },
    ...(expiresAt !== undefined ? { expiresAt } : {}),
  };
  return { status, raw };
}

function outcomeOf(line: unknown, provider: string): BatchOutcome | undefined {
  if (!isObject(line) || typeof line.custom_id !== 'string' || !isObject(line.result))
    return undefined;
  const id = line.custom_id;
  const result = line.result;
  switch (result.type) {
    case 'succeeded':
      return { id, kind: 'reply', body: result.message };
    case 'canceled':
      return { id, kind: 'cancelled' };
    case 'expired':
      return { id, kind: 'expired' };
    case 'errored': {
      const body: Json = isObject(result.error) ? result.error : {};
      const type = isObject(body.error) ? body.error.type : undefined;
      const status = typeof type === 'string' ? ERROR_STATUS.get(type) : undefined;
      const requestId = typeof body.request_id === 'string' ? body.request_id : undefined;
      return {
        id,
        kind: 'error',
        ...(status !== undefined ? { status } : {}),
        error: adapter.mapError(
          status ?? 500,
          body,
          new Headers(requestId ? { 'request-id': requestId } : {}),
          { provider },
        ),
      };
    }
    default:
      return undefined;
  }
}

/**
 * The results URL to read. `results_url` is used as given when it is on the
 * client's base URL's host; on another host (the API behind a proxy, say) its
 * path is read through the configured base URL instead, so the key only ever
 * goes to the host you configured.
 */
function resultsUrl(call: ResolvedCall, given: string): string {
  const url = new URL(given, `${call.baseURL}/`);
  return url.origin === new URL(call.baseURL).origin
    ? url.toString()
    : `${call.baseURL}${url.pathname}${url.search}`;
}

export const anthropicBatchDriver: BatchDriver = {
  protocol: 'anthropic',
  maxRequests: MAX_REQUESTS,

  async submit(prepared, ctx) {
    const { call } = ctx;
    const body = JSON.stringify({
      requests: prepared.map((request) => ({ custom_id: request.id, params: request.body })),
    });
    const size = new TextEncoder().encode(body).byteLength;
    if (size > MAX_BYTES)
      throw new SubmitFailure(
        new BatchError({
          kind: 'invalid-request',
          provider: call.provider,
          message: `An Anthropic Message Batch takes at most 256 MB; this one is ${size} bytes.`,
        }),
        false,
      );
    const beta = betas(prepared);
    let batch: unknown;
    try {
      batch = await readJson(
        await send(ctx, adapter, `${call.baseURL}/v1/messages/batches`, {
          method: 'POST',
          headers: headers(call, beta ? { 'anthropic-beta': beta } : undefined),
          body,
        }),
      );
    } catch (error) {
      throw new SubmitFailure(error, true);
    }
    if (!isObject(batch) || typeof batch.id !== 'string')
      throw new SubmitFailure(
        new BatchError({
          kind: 'provider',
          provider: call.provider,
          message: 'The Anthropic Message Batches API returned no batch id.',
        }),
        true,
      );
    const expiresAt = time(batch.expires_at);
    return { id: batch.id, ...(expiresAt !== undefined ? { expiresAt } : {}) };
  },

  async status(id, ctx) {
    const response = await send(
      ctx,
      adapter,
      `${ctx.call.baseURL}/v1/messages/batches/${encodeURIComponent(id)}`,
      { method: 'GET', headers: headers(ctx.call) },
    );
    return normalize(id, await readJson(response));
  },

  async cancel(id, ctx) {
    const response = await send(
      ctx,
      adapter,
      `${ctx.call.baseURL}/v1/messages/batches/${encodeURIComponent(id)}/cancel`,
      { method: 'POST', headers: headers(ctx.call) },
    );
    return normalize(id, await readJson(response));
  },

  async *outcomes(job, raw, ctx) {
    const batch: Json = isObject(raw) ? raw : {};
    if (typeof batch.results_url !== 'string' || batch.results_url === '')
      throw new BatchError({
        kind: 'provider',
        provider: ctx.call.provider,
        batchId: job.id,
        message:
          `Message Batch ${job.id} has ended but has no results_url` +
          (typeof batch.archived_at === 'string' ? ': its results were archived.' : '.'),
      });
    let url: string;
    try {
      url = resultsUrl(ctx.call, batch.results_url);
    } catch (cause) {
      throw new BatchError({
        kind: 'provider',
        provider: ctx.call.provider,
        batchId: job.id,
        cause,
        message: `Message Batch ${job.id} has a results_url that is not a URL.`,
      });
    }
    const response = await send(ctx, adapter, url, {
      method: 'GET',
      headers: headers(ctx.call, { accept: 'application/binary' }),
    });
    for await (const line of jsonLines(response)) {
      const outcome = outcomeOf(line, ctx.call.provider);
      if (outcome) yield outcome;
    }
  },

  // Every request of an ended Message Batch has a result line.
  missing: () => 'unknown',
};
