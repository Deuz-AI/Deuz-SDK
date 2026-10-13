/**
 * OpenAI Batch API (2.3, BA2): the requests go up as a JSON Lines file
 * (`POST /files`, purpose `batch`), then `POST /batches` runs it against
 * `/v1/responses` or `/v1/chat/completions` within the 24-hour window. Batch
 * and file shapes come from `openai` 7.32 (`resources/batches`,
 * `resources/files`); the per-line format (`custom_id`, `method`, `url`,
 * `body` in; `custom_id`, `response.status_code`, `response.body`, `error`
 * out) is the Batch guide that SDK links to. Not live-verified.
 */
import { openaiCompatibleAdapter } from '../adapters/openai-compatible';
import type { ResolvedCall } from '../internal/resolve-call';
import type { ModelSurface } from '../types/model';
import {
  count,
  ENDED,
  isObject,
  mergeHeaders,
  SubmitFailure,
  type BatchDriver,
  type BatchOutcome,
  type DriverStatus,
  type Json,
} from './driver';
import { BatchError } from './errors';
import { jsonLines, readJson, send, type BatchCallContext } from './http';
import type { BatchState, BatchStatus } from './types';

/** "The file can contain up to 50,000 requests, and can be up to 200 MB in size." */
const MAX_REQUESTS = 50_000;
const MAX_BYTES = 200_000_000;

const adapter = openaiCompatibleAdapter;

const STATES = new Map<string, BatchState>([
  ['validating', 'pending'],
  ['in_progress', 'running'],
  ['finalizing', 'running'],
  ['cancelling', 'cancelling'],
  ['completed', 'completed'],
  ['cancelled', 'cancelled'],
  ['expired', 'expired'],
  ['failed', 'failed'],
]);

function headers(call: ResolvedCall, json: boolean): Record<string, string> {
  return mergeHeaders(
    json ? { 'content-type': 'application/json' } : undefined,
    { authorization: `Bearer ${call.apiKey}` },
    call.headers,
  );
}

const endpointFor = (surface: ModelSurface): '/v1/responses' | '/v1/chat/completions' =>
  surface === 'responses' ? '/v1/responses' : '/v1/chat/completions';

function normalize(id: string, raw: unknown): DriverStatus {
  const batch: Json = isObject(raw) ? raw : {};
  const providerState = typeof batch.status === 'string' ? batch.status : 'unknown';
  // An unknown status is treated as still running: never as ended.
  const state = STATES.get(providerState) ?? 'running';
  const requests = isObject(batch.request_counts) ? batch.request_counts : {};
  const total = count(requests.total);
  const succeeded = count(requests.completed);
  const errored = count(requests.failed);
  const expires = count(batch.expires_at);
  const errors = (
    isObject(batch.errors) && Array.isArray(batch.errors.data) ? batch.errors.data : []
  )
    .filter(isObject)
    .map((entry) => (typeof entry.message === 'string' ? entry.message : ''))
    .filter(Boolean);
  const status: BatchStatus = {
    id: typeof batch.id === 'string' ? batch.id : id,
    state,
    ended: ENDED.has(state),
    providerState,
    ...(total !== undefined && succeeded !== undefined && errored !== undefined
      ? {
          counts: {
            total,
            succeeded,
            errored,
            processing: Math.max(0, total - succeeded - errored),
          },
        }
      : {}),
    ...(expires !== undefined ? { expiresAt: expires * 1000 } : {}),
    ...(errors.length > 0 ? { error: errors.join('; ') } : {}),
  };
  return { status, raw };
}

/** One output or error file line. */
function outcomeOf(line: unknown, provider: string): BatchOutcome | undefined {
  if (!isObject(line) || typeof line.custom_id !== 'string') return undefined;
  const id = line.custom_id;
  if (isObject(line.response)) {
    const response = line.response;
    const status = count(response.status_code);
    if (status !== undefined && status >= 200 && status < 300)
      return { id, kind: 'reply', body: response.body };
    if (status !== undefined) {
      const requestId = typeof response.request_id === 'string' ? response.request_id : undefined;
      return {
        id,
        kind: 'error',
        status,
        error: adapter.mapError(
          status,
          response.body,
          new Headers(requestId ? { 'x-request-id': requestId } : {}),
          { provider },
        ),
      };
    }
  }
  const error: Json = isObject(line.error) ? line.error : {};
  const code = typeof error.code === 'string' ? error.code : undefined;
  if (code === 'batch_expired') return { id, kind: 'expired' };
  if (code === 'batch_cancelled') return { id, kind: 'cancelled' };
  return {
    id,
    kind: 'error',
    error: new BatchError({
      kind: 'provider',
      provider,
      message:
        `OpenAI reported ${code ?? 'an error'} for batch request "${id}"` +
        (typeof error.message === 'string' ? `: ${error.message}` : '.'),
    }),
  };
}

export const openaiBatchDriver: BatchDriver = {
  protocol: 'openai',
  maxRequests: MAX_REQUESTS,

  async submit(prepared, ctx, options) {
    const { call } = ctx;
    const endpoint = endpointFor(options.surface);
    const lines = prepared.map((request) =>
      JSON.stringify({ custom_id: request.id, method: 'POST', url: endpoint, body: request.body }),
    );
    const bytes = new TextEncoder().encode(`${lines.join('\n')}\n`);
    if (bytes.byteLength > MAX_BYTES)
      throw new SubmitFailure(
        new BatchError({
          kind: 'invalid-request',
          provider: call.provider,
          message: `An OpenAI batch input file takes at most 200 MB; this one is ${bytes.byteLength} bytes.`,
        }),
        false,
      );
    const form = new FormData();
    form.append('purpose', 'batch');
    form.append('file', new Blob([bytes], { type: 'application/jsonl' }), 'deuz-batch.jsonl');
    let fileId: string;
    try {
      const file = await readJson(
        await send(ctx, adapter, `${call.baseURL}/files`, {
          method: 'POST',
          headers: headers(call, false),
          body: form,
        }),
        ctx,
      );
      if (!isObject(file) || typeof file.id !== 'string')
        throw new BatchError({
          kind: 'provider',
          provider: call.provider,
          message: 'The OpenAI Files API returned no file id for the batch input.',
        });
      fileId = file.id;
    } catch (error) {
      // Nothing can have run: the batch was never created.
      throw new SubmitFailure(error, false);
    }
    let batch: unknown;
    try {
      batch = await readJson(
        await send(ctx, adapter, `${call.baseURL}/batches`, {
          method: 'POST',
          headers: headers(call, true),
          body: JSON.stringify({
            input_file_id: fileId,
            endpoint,
            completion_window: '24h',
            ...(options.displayName ? { metadata: { display_name: options.displayName } } : {}),
          }),
        }),
        ctx,
      );
    } catch (error) {
      throw new SubmitFailure(error, true);
    }
    if (!isObject(batch) || typeof batch.id !== 'string')
      throw new SubmitFailure(
        new BatchError({
          kind: 'provider',
          provider: call.provider,
          message: 'The OpenAI Batches API returned no batch id.',
        }),
        true,
      );
    const expires = count(batch.expires_at);
    return {
      id: batch.id,
      endpoint,
      inputFileId: fileId,
      ...(expires !== undefined ? { expiresAt: expires * 1000 } : {}),
    };
  },

  async status(id, ctx) {
    const response = await send(
      ctx,
      adapter,
      `${ctx.call.baseURL}/batches/${encodeURIComponent(id)}`,
      { method: 'GET', headers: headers(ctx.call, false) },
    );
    return normalize(id, await readJson(response, ctx));
  },

  async cancel(id, ctx) {
    const response = await send(
      ctx,
      adapter,
      `${ctx.call.baseURL}/batches/${encodeURIComponent(id)}/cancel`,
      { method: 'POST', headers: headers(ctx.call, false) },
    );
    return normalize(id, await readJson(response, ctx));
  },

  async *outcomes(_job, raw, ctx: BatchCallContext) {
    const batch: Json = isObject(raw) ? raw : {};
    for (const file of [batch.output_file_id, batch.error_file_id]) {
      if (typeof file !== 'string' || file === '') continue;
      const response = await send(
        ctx,
        adapter,
        `${ctx.call.baseURL}/files/${encodeURIComponent(file)}/content`,
        { method: 'GET', headers: headers(ctx.call, false) },
      );
      for await (const line of jsonLines(response, ctx)) {
        const outcome = outcomeOf(line, ctx.call.provider);
        if (outcome) yield outcome;
      }
    }
  },

  missing(state) {
    switch (state) {
      case 'cancelled':
        return 'cancelled';
      case 'expired':
        return 'expired';
      // "failed": the input file did not validate, so no request ran.
      case 'failed':
        return 'not-run';
      default:
        return 'unknown';
    }
  },
};
