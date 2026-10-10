/**
 * `createBatchClient` (2.3, BA2): submit single-turn requests to a provider's
 * batch API, follow the batch, and read its results.
 */
import { AbortError, isDeuzError, NoObjectGeneratedError, type DeuzError } from '../errors';
import { withCapabilityOverride } from '../internal/config-symbol';
import { resolveCall } from '../internal/resolve-call';
import { resolveDependencies } from '../internal/resolve-deps';
import { createWarningSink } from '../internal/warnings';
import { validateOutput } from '../schema/bridge';
import type { JSONSchema, StandardSchemaV1 } from '../types/schema';
import { anthropicBatchDriver } from './anthropic';
import { isObject, SubmitFailure, type BatchDriver, type BatchOutcome } from './driver';
import { BatchError } from './errors';
import { geminiBatchDriver } from './gemini';
import type { BatchCallContext } from './http';
import { openaiBatchDriver } from './openai';
import { parseReply, type ParsedReply } from './parse';
import { prepareRequests, protocolFor, validateRequests } from './prepare';
import type {
  BatchClient,
  BatchClientOptions,
  BatchJob,
  BatchJobRequest,
  BatchProtocol,
  BatchResult,
  BatchResultsOptions,
  BatchStatus,
  BatchWaitOptions,
} from './types';

const DRIVERS: Record<BatchProtocol, BatchDriver> = {
  openai: openaiBatchDriver,
  anthropic: anthropicBatchDriver,
  gemini: geminiBatchDriver,
};

const HOUR = 3_600_000;
/** The providers' 24-hour batch window, and an hour to read the results. */
const DEFAULT_HOLD_MS = 25 * HOUR;
const DEFAULT_INTERVAL_MS = 60_000;

type Schema = StandardSchemaV1 | JSONSchema;

const PROTOCOLS: ReadonlySet<string> = new Set(['openai', 'anthropic', 'gemini']);

/** A version-1 job handle, as far as the client reads it. */
function isJob(value: unknown): value is BatchJob {
  return (
    isObject(value) &&
    value.version === 1 &&
    typeof value.id === 'string' &&
    value.id !== '' &&
    typeof value.protocol === 'string' &&
    PROTOCOLS.has(value.protocol) &&
    typeof value.provider === 'string' &&
    typeof value.modelId === 'string' &&
    typeof value.surface === 'string' &&
    Array.isArray(value.requests) &&
    value.requests.every((request) => isObject(request) && typeof request.id === 'string')
  );
}

function positive(value: number | undefined, label: string): void {
  if (value !== undefined && (!Number.isSafeInteger(value) || value < 1))
    throw new BatchError({
      kind: 'invalid-request',
      message: `${label} must be a positive integer of milliseconds.`,
    });
}

/**
 * Create a batch client for one model. Only OpenAI (Responses, Chat
 * Completions), Anthropic Messages and Gemini generateContent on their own
 * APIs batch; any other model throws `BatchError` kind `unsupported` here.
 *
 * Not live-verified: the wire shapes come from the providers' SDK types and
 * are tested against in-memory stand-ins.
 */
export function createBatchClient(options: BatchClientOptions): BatchClient {
  const model = withCapabilityOverride(options.model, options.capabilities);
  const protocol = protocolFor(model);
  const driver = DRIVERS[protocol];
  const deps = resolveDependencies(options.deps);
  const holdMs = options.holdMs ?? DEFAULT_HOLD_MS;
  positive(holdMs, 'holdMs');
  /** The schemas of the structured requests this client submitted, by job and request id. */
  const schemas = new Map<string, ReadonlyMap<string, Schema>>();

  const context = async (signal?: AbortSignal): Promise<BatchCallContext> => ({
    call: await resolveCall({ model, deps, headers: options.headers }),
    ...(signal ? { signal } : {}),
  });

  function check(job: BatchJob): void {
    if (!isJob(job))
      throw new BatchError({
        kind: 'invalid-job',
        provider: model.provider,
        message: 'Not a batch job handle (version 1).',
      });
    if (job.protocol !== protocol || job.provider !== model.provider)
      throw new BatchError({
        kind: 'invalid-job',
        provider: model.provider,
        batchId: job.id,
        message:
          `Batch ${job.id} belongs to ${job.provider} (${job.protocol}); this client ` +
          `sends to ${model.provider} (${protocol}).`,
      });
  }

  async function status(job: BatchJob, signal?: AbortSignal): Promise<BatchStatus> {
    check(job);
    return (await driver.status(job.id, await context(signal))).status;
  }

  /** Parse a structured request's object out of its reply, and validate it. */
  async function objectOf(
    id: string,
    reply: ParsedReply,
    object: NonNullable<BatchJobRequest['object']>,
    schema: Schema | undefined,
  ): Promise<{ object?: unknown; error?: DeuzError }> {
    let text = reply.text;
    let value: unknown;
    let parsed = false;
    if (object.strategy === 'tool') {
      const call =
        reply.toolCalls.find((candidate) => candidate.name === object.toolName) ??
        reply.toolCalls[0];
      if (!call)
        return {
          error: new NoObjectGeneratedError(
            `Batch request "${id}" made no ${object.toolName ?? 'structured-output'} tool call.`,
            { text },
          ),
        };
      if (typeof call.input === 'string') text = call.input;
      else {
        value = call.input;
        text = JSON.stringify(call.input) ?? '';
        parsed = true;
      }
    }
    if (!parsed) {
      try {
        value = JSON.parse(text) as unknown;
      } catch (cause) {
        return {
          error: new NoObjectGeneratedError(`Batch request "${id}" did not return a JSON object.`, {
            text,
            cause,
          }),
        };
      }
    }
    if (schema === undefined) return { object: value };
    const validation = await validateOutput(schema, value);
    return validation.ok
      ? { object: validation.value }
      : {
          error: new NoObjectGeneratedError(
            `Batch request "${id}" returned an object that does not match its schema: ${validation.issues}`,
            { text, cause: new Error(validation.issues) },
          ),
        };
  }

  /** One result from one outcome. */
  async function resultOf(
    job: BatchJob,
    request: BatchJobRequest,
    outcome: BatchOutcome,
    schema: Schema | undefined,
  ): Promise<BatchResult> {
    const id = request.id;
    if (outcome.kind === 'cancelled') return { id, status: 'cancelled', text: '' };
    if (outcome.kind === 'expired') return { id, status: 'expired', text: '' };
    if (outcome.kind === 'error') return { id, status: 'errored', text: '', error: outcome.error };
    const reply = parseReply(job.surface, outcome.body);
    let costUsd: number | undefined;
    if (reply.usageAvailable && deps.priceProvider) {
      try {
        const price = await deps.priceProvider.priceUsage(job.modelId, reply.usage, {
          tier: 'batch',
        });
        if (price !== undefined && Number.isFinite(price) && price >= 0) costUsd = price;
      } catch {
        // A price lookup that fails leaves the cost unknown.
      }
    }
    const extracted =
      request.object && !reply.error ? await objectOf(id, reply, request.object, schema) : {};
    const error: DeuzError | undefined = reply.error
      ? new BatchError({
          kind: 'provider',
          provider: job.provider,
          batchId: job.id,
          message:
            `${job.provider} failed batch request "${id}"` +
            (reply.error.code ? ` (${reply.error.code})` : '') +
            `: ${reply.error.message}`,
        })
      : extracted.error;
    return {
      id,
      status: reply.error ? 'errored' : 'succeeded',
      text: reply.text,
      ...(reply.reasoning ? { reasoning: reply.reasoning } : {}),
      ...('object' in extracted ? { object: extracted.object } : {}),
      finishReason: reply.finishReason,
      usage: reply.usage,
      usageAvailable: reply.usageAvailable,
      ...(costUsd !== undefined ? { costUsd } : {}),
      ...(error ? { error } : {}),
      ...(reply.stopDetails ? { stopDetails: reply.stopDetails } : {}),
      ...(reply.providerMetadata ? { providerMetadata: reply.providerMetadata } : {}),
    };
  }

  /** The result of a request an ended batch reports nothing for. */
  function missingResult(job: BatchJob, request: BatchJobRequest, ended: BatchStatus): BatchResult {
    const id = request.id;
    switch (driver.missing(ended.state)) {
      case 'cancelled':
        return { id, status: 'cancelled', text: '' };
      case 'expired':
        return { id, status: 'expired', text: '' };
      case 'not-run':
        return {
          id,
          status: 'errored',
          text: '',
          error: new BatchError({
            kind: 'provider',
            provider: job.provider,
            batchId: job.id,
            message:
              `Batch ${job.id} failed before request "${id}" ran` +
              (ended.error ? `: ${ended.error}` : '.'),
          }),
        };
      case 'unknown':
        return {
          id,
          status: 'errored',
          text: '',
          error: new BatchError({
            kind: 'provider',
            provider: job.provider,
            batchId: job.id,
            message: `${job.provider} reported no result for batch request "${id}" (batch ${job.id} is ${ended.state}).`,
          }),
        };
    }
  }

  async function* results(job: BatchJob, read: BatchResultsOptions = {}) {
    check(job);
    const ctx = await context(read.signal);
    const { status: ended, raw } = await driver.status(job.id, ctx);
    if (!ended.ended)
      throw new BatchError({
        kind: 'not-ended',
        provider: job.provider,
        batchId: job.id,
        message: `Batch ${job.id} is ${ended.state}: its results can be read once it ends.`,
      });
    const requests = new Map(job.requests.map((request) => [request.id, request]));
    const known = schemas.get(job.id);
    const seen = new Set<string>();
    for await (const outcome of driver.outcomes(job, raw, ctx)) {
      const request = requests.get(outcome.id);
      // A result for no request of this job, or a repeated one, is ignored.
      if (!request || seen.has(outcome.id)) continue;
      seen.add(outcome.id);
      yield await resultOf(
        job,
        request,
        outcome,
        read.schemas?.[request.id] ?? known?.get(request.id),
      );
    }
    for (const request of job.requests)
      if (!seen.has(request.id)) yield missingResult(job, request, ended);
    if (options.store) await options.store.put({ ...job, closedAt: deps.clock.now() });
  }

  /** Sleep on the injected clock; an abort ends it early. */
  function sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(signal.reason ?? new AbortError());
        return;
      }
      const onAbort = () => {
        cancel();
        reject(signal?.reason ?? new AbortError());
      };
      const cancel = deps.clock.setTimeout(() => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  return Object.freeze({
    async submit(requests, submitOptions = {}) {
      validateRequests(requests);
      if (driver.maxRequests !== undefined && requests.length > driver.maxRequests)
        throw new BatchError({
          kind: 'invalid-request',
          provider: model.provider,
          message: `A ${model.provider} batch takes at most ${driver.maxRequests} requests; this one has ${requests.length}.`,
        });
      const ctx = await context(submitOptions.signal);
      const warnings = createWarningSink();
      const prepared = await prepareRequests(requests, {
        model,
        call: ctx.call,
        deps,
        warnings,
        bounded: false,
      });
      const submittedAt = deps.clock.now();
      let submitted;
      try {
        submitted = await driver.submit(prepared, ctx, {
          modelId: model.modelId,
          surface: model.surface,
          ...(submitOptions.displayName !== undefined
            ? { displayName: submitOptions.displayName }
            : {}),
        });
      } catch (error) {
        throw error instanceof SubmitFailure ? error.error : error;
      }
      const notices = warnings.list();
      const job: BatchJob = {
        version: 1,
        id: submitted.id,
        protocol,
        provider: model.provider,
        modelId: model.modelId,
        surface: model.surface,
        submittedAt,
        ...(submitted.expiresAt !== undefined ? { expiresAt: submitted.expiresAt } : {}),
        holdUntil: submittedAt + holdMs,
        ...(submitted.endpoint ? { endpoint: submitted.endpoint } : {}),
        ...(submitted.inputFileId ? { inputFileId: submitted.inputFileId } : {}),
        ...(submitOptions.displayName !== undefined
          ? { displayName: submitOptions.displayName }
          : {}),
        requests: prepared.map((request) => ({
          id: request.id,
          ...(request.object
            ? {
                object: {
                  strategy: request.object.strategy,
                  ...(request.object.toolName ? { toolName: request.object.toolName } : {}),
                },
              }
            : {}),
        })),
        ...(notices.length > 0 ? { warnings: notices } : {}),
      };
      const structured = prepared.filter((request) => request.object);
      if (structured.length > 0)
        schemas.set(
          job.id,
          new Map(structured.map((request) => [request.id, request.object!.schema])),
        );
      if (options.store) {
        try {
          await options.store.put(job);
        } catch (cause) {
          throw new BatchError({
            kind: 'store',
            provider: job.provider,
            batchId: job.id,
            job,
            cause,
            message: `Batch ${job.id} was submitted, but the job store failed to record it; keep error.job to read its results.`,
          });
        }
      }
      return job;
    },

    status: (job, call = {}) => status(job, call.signal),

    async wait(job, wait: BatchWaitOptions = {}) {
      check(job);
      const interval = wait.intervalMs ?? DEFAULT_INTERVAL_MS;
      positive(interval, 'intervalMs');
      positive(wait.timeoutMs, 'timeoutMs');
      const deadline = wait.timeoutMs === undefined ? undefined : deps.clock.now() + wait.timeoutMs;
      for (;;) {
        if (wait.signal?.aborted) throw wait.signal.reason ?? new AbortError();
        try {
          const current = await status(job, wait.signal);
          wait.onStatus?.(current);
          if (current.ended) return current;
        } catch (error) {
          // A provider hiccup (429, 5xx) is retried on the next poll.
          const retryable =
            isDeuzError(error) && (error as { isRetryable?: unknown }).isRetryable === true;
          if (!retryable || wait.signal?.aborted) throw error;
        }
        const left = deadline === undefined ? interval : deadline - deps.clock.now();
        if (left <= 0)
          throw new BatchError({
            kind: 'timeout',
            provider: job.provider,
            batchId: job.id,
            message: `Batch ${job.id} did not end within ${wait.timeoutMs} ms.`,
          });
        await sleep(Math.min(interval, left), wait.signal);
      }
    },

    results,

    async collect(job, read) {
      const out: BatchResult[] = [];
      for await (const result of results(job, read)) out.push(result);
      return out;
    },

    async cancel(job, call = {}) {
      check(job);
      return (await driver.cancel(job.id, await context(call.signal))).status;
    },

    async pending() {
      if (!options.store)
        throw new BatchError({
          kind: 'store',
          provider: model.provider,
          message: 'pending() reads the job store; pass `store` to createBatchClient.',
        });
      const jobs = await options.store.list();
      return jobs
        .filter(
          (job) =>
            isJob(job) &&
            job.closedAt === undefined &&
            job.protocol === protocol &&
            job.provider === model.provider,
        )
        .sort((a, b) => a.submittedAt - b.submittedAt);
    },
  } satisfies BatchClient);
}
