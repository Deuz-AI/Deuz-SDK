/**
 * Gemini batch mode on the Developer API (2.3, BA2):
 * `POST /v1beta/models/{model}:batchGenerateContent` with inlined
 * `{ request, metadata }` entries, `GET /v1beta/batches/{id}` until
 * `metadata.state` ends, then the responses inlined in `metadata.output` (or
 * its `responsesFile`). The REST shapes are the ones `@google/genai` 2.28
 * converts to and from (`createBatchJobParametersToMldev`, `batchJobFromMldev`,
 * `inlinedResponseFromMldev`, `tJobState`). Vertex AI batch prediction is a
 * different API and not covered. Not live-verified.
 */
import { googleNativeAdapter } from '../adapters/google-native';
import type { ResolvedCall } from '../internal/resolve-call';
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
import type { BatchJob, BatchState, BatchStatus } from './types';

const adapter = googleNativeAdapter;

/** `BATCH_STATE_*` as the API reports it, and the `JOB_STATE_*` forms the SDK maps it to. */
const STATES = new Map<string, BatchState>([
  ['BATCH_STATE_PENDING', 'pending'],
  ['BATCH_STATE_RUNNING', 'running'],
  ['BATCH_STATE_SUCCEEDED', 'completed'],
  ['BATCH_STATE_FAILED', 'failed'],
  ['BATCH_STATE_CANCELLED', 'cancelled'],
  ['BATCH_STATE_EXPIRED', 'expired'],
  ['JOB_STATE_QUEUED', 'pending'],
  ['JOB_STATE_PENDING', 'pending'],
  ['JOB_STATE_RUNNING', 'running'],
  ['JOB_STATE_UPDATING', 'running'],
  ['JOB_STATE_CANCELLING', 'cancelling'],
  ['JOB_STATE_SUCCEEDED', 'completed'],
  ['JOB_STATE_PARTIALLY_SUCCEEDED', 'completed'],
  ['JOB_STATE_FAILED', 'failed'],
  ['JOB_STATE_CANCELLED', 'cancelled'],
  ['JOB_STATE_EXPIRED', 'expired'],
]);

/** google.rpc.Code → HTTP status, for a per-request error; it decides whether a hold is released. */
const RPC_STATUS = new Map<number, number>([
  [1, 499],
  [2, 500],
  [3, 400],
  [4, 504],
  [5, 404],
  [6, 409],
  [7, 403],
  [8, 429],
  [9, 400],
  [10, 409],
  [11, 400],
  [12, 501],
  [13, 500],
  [14, 503],
  [15, 500],
  [16, 401],
]);

const BATCH_NAME = /^batches\/([^/]+)$/;

function headers(call: ResolvedCall): Record<string, string> {
  return mergeHeaders(
    { 'content-type': 'application/json', 'x-goog-api-key': call.apiKey },
    call.headers,
  );
}

/** The `batches/{id}` path of a job, refusing anything else. */
function path(id: string, provider: string): string {
  const match = BATCH_NAME.exec(id);
  if (!match)
    throw new BatchError({
      kind: 'invalid-job',
      provider,
      batchId: id,
      message: `"${id.slice(0, 80)}" is not a Gemini batch name (batches/…).`,
    });
  return `batches/${encodeURIComponent(match[1]!)}`;
}

const modelPath = (modelId: string): string =>
  modelId.startsWith('models/') || modelId.startsWith('tunedModels/')
    ? modelId
    : `models/${modelId}`;

function normalize(id: string, raw: unknown): DriverStatus {
  const operation: Json = isObject(raw) ? raw : {};
  const metadata: Json = isObject(operation.metadata) ? operation.metadata : {};
  const providerState = typeof metadata.state === 'string' ? metadata.state : 'unknown';
  const state = STATES.get(providerState) ?? 'running';
  const failure = isObject(operation.error) ? operation.error : undefined;
  const status: BatchStatus = {
    id: typeof operation.name === 'string' ? operation.name : id,
    state,
    ended: ENDED.has(state),
    providerState,
    ...(failure && typeof failure.message === 'string' ? { error: failure.message } : {}),
  };
  return { status, raw };
}

/** One inlined response, or one line of a responses file. */
function outcomeOf(item: unknown, index: number, job: BatchJob): BatchOutcome | undefined {
  if (!isObject(item)) return undefined;
  const metadata = isObject(item.metadata) ? item.metadata : {};
  const key = typeof metadata.key === 'string' ? metadata.key : item.key;
  // Responses come in request order; the key we sent identifies them first.
  const id = typeof key === 'string' ? key : job.requests[index]?.id;
  if (id === undefined) return undefined;
  if (isObject(item.response)) return { id, kind: 'reply', body: item.response };
  if (isObject(item.error)) {
    const code = count(item.error.code);
    const status = code === undefined ? undefined : code >= 100 ? code : RPC_STATUS.get(code);
    const message =
      typeof item.error.message === 'string' ? item.error.message : 'The request failed.';
    return {
      id,
      kind: 'error',
      ...(status !== undefined ? { status } : {}),
      error: adapter.mapError(status ?? 500, { error: { message } }, new Headers()),
    };
  }
  // A bare GenerateContentResponse line (responses file without wrappers).
  if (Array.isArray(item.candidates) || isObject(item.usageMetadata))
    return { id, kind: 'reply', body: item };
  return undefined;
}

async function status(id: string, ctx: BatchCallContext): Promise<DriverStatus> {
  const response = await send(
    ctx,
    adapter,
    `${ctx.call.baseURL}/v1beta/${path(id, ctx.call.provider)}`,
    { method: 'GET', headers: headers(ctx.call) },
  );
  return normalize(id, await readJson(response, ctx));
}

export const geminiBatchDriver: BatchDriver = {
  protocol: 'gemini',

  async submit(prepared, ctx, options) {
    const { call } = ctx;
    let operation: unknown;
    try {
      operation = await readJson(
        await send(
          ctx,
          adapter,
          `${call.baseURL}/v1beta/${modelPath(options.modelId)}:batchGenerateContent`,
          {
            method: 'POST',
            headers: headers(call),
            body: JSON.stringify({
              batch: {
                displayName: options.displayName ?? 'deuz-batch',
                inputConfig: {
                  requests: {
                    requests: prepared.map((request) => ({
                      request: request.body,
                      metadata: { key: request.id },
                    })),
                  },
                },
              },
            }),
          },
        ),
        ctx,
      );
    } catch (error) {
      throw new SubmitFailure(error, true);
    }
    const name = isObject(operation) ? operation.name : undefined;
    if (typeof name !== 'string' || !BATCH_NAME.test(name))
      throw new SubmitFailure(
        new BatchError({
          kind: 'provider',
          provider: call.provider,
          message: 'The Gemini batch API returned no batch name (batches/…).',
        }),
        true,
      );
    return { id: name };
  },

  status,

  async cancel(id, ctx) {
    await send(ctx, adapter, `${ctx.call.baseURL}/v1beta/${path(id, ctx.call.provider)}:cancel`, {
      method: 'POST',
      headers: headers(ctx.call),
      body: '{}',
    });
    // The cancel call answers with an empty body: read where the batch stands.
    return status(id, ctx);
  },

  async *outcomes(job, raw, ctx: BatchCallContext) {
    const operation: Json = isObject(raw) ? raw : {};
    const metadata: Json = isObject(operation.metadata) ? operation.metadata : {};
    const output: Json = isObject(metadata.output) ? metadata.output : {};
    const inlined = isObject(output.inlinedResponses) ? output.inlinedResponses : undefined;
    if (inlined) {
      const responses = Array.isArray(inlined.inlinedResponses) ? inlined.inlinedResponses : [];
      for (const [index, item] of responses.entries()) {
        const outcome = outcomeOf(item, index, job);
        if (outcome) yield outcome;
      }
      return;
    }
    const file = output.responsesFile;
    if (typeof file !== 'string' || !/^files\/[^/]+$/.test(file)) return;
    const response = await send(
      ctx,
      adapter,
      `${ctx.call.baseURL}/v1beta/files/${encodeURIComponent(file.slice('files/'.length))}:download?alt=media`,
      { method: 'GET', headers: headers(ctx.call) },
    );
    let index = 0;
    for await (const line of jsonLines(response, ctx)) {
      const outcome = outcomeOf(line, index++, job);
      if (outcome) yield outcome;
    }
  },

  missing(state) {
    if (state === 'cancelled') return 'cancelled';
    if (state === 'expired') return 'expired';
    return 'unknown';
  },
};
