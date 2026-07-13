import type { CommonCallOptions } from '../types/config';
import type { StreamChatResult } from '../types/methods';
import type { StreamPart } from '../types/stream';
import type { Usage, FinishReason } from '../types/usage';
import type { ModelSurface } from '../types/model';
import type { Adapter, ObjectRequest, WireToolRequest } from '../adapters/types';
import { APICallError, NetworkError, TimeoutError } from '../errors';
import { resolveDependencies } from '../internal/resolve-deps';
import { resolveCall } from '../internal/resolve-call';
import {
  createObservationRuntime,
  observeCost,
  counterFields,
  type ObservationRuntime,
} from '../internal/observe-runtime';
import { toObservedError } from '../internal/observe-error';
import type { RunStartedEvent, ObservedError } from '../types/observe';
import { readClientContext } from '../internal/client-context';
import { createBroadcaster, createDeferred, lazyAsyncIterable } from '../internal/async-iter';
import { normalizeMessages } from './normalize';
import { getCapabilities } from './registry';
import { EMPTY_USAGE, withTotal, fireUsage, fireFinish } from './metering';
import { combineSignals, createTimeout, DEFAULT_TIMEOUTS, type TimeoutHandle } from './timeout';
import { DEFAULT_RETRY, backoffMs, shouldRetry, unitFromId, wait } from './resilience';
import { anthropicAdapter } from '../adapters/anthropic';
import { openaiCompatibleAdapter } from '../adapters/openai-compatible';
import { openaiResponsesAdapter } from '../adapters/openai-responses';
import { googleNativeAdapter } from '../adapters/google-native';

/** The only place that references every wire adapter (keeps tree-shaking clean). */
function getAdapter(surface: ModelSurface): Adapter {
  switch (surface) {
    case 'anthropic':
      return anthropicAdapter;
    case 'chat_completions':
      return openaiCompatibleAdapter;
    case 'responses':
      return openaiResponsesAdapter;
    case 'native':
      return googleNativeAdapter;
  }
}

/** A user-initiated cancel (resolve 'aborted'), distinct from a TimeoutError (a failure). */
function isUserAbort(err: unknown, signal?: AbortSignal): boolean {
  if (err instanceof TimeoutError) return false;
  if (signal?.aborted) return true;
  return !!err && typeof err === 'object' && (err as { name?: string }).name === 'AbortError';
}

async function readBody(res: Response): Promise<unknown> {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function* projectText(source: AsyncIterable<StreamPart>): AsyncGenerator<string> {
  for await (const part of source) {
    if (part.type === 'text-delta') yield part.text;
    else if (part.type === 'error') throw part.error;
  }
}

/**
 * Build a `StreamChatResult` synchronously. No async work / no key access runs
 * in this body (G2) — the pump starts lazily on first access of ANY output, so
 * `streamChat` never throws; failures surface via the `fullStream` error part
 * and rejected `usage`/`finishReason` promises.
 */
export interface InternalRunOptions {
  /** Structured-output request, set by generateObject. */
  object?: ObjectRequest;
  /** Tool request, set by the agentic loop. */
  tools?: WireToolRequest;
  /**
   * Observation (1.6): the enclosing loop's runtime + correlation. When set,
   * the loop owns the run — this pump emits ONLY model.* events (never a
   * second run.started). When absent AND deps carry an observer, the pump is
   * the observation root for a single-turn run.
   */
  observe?: ObserveContext;
  /** Observation (1.6): run.started operation label for root pumps. Default 'stream-chat'. */
  operation?: RunStartedEvent['operation'];
}

/** Loop→pump observation correlation (threaded like stepSpan — never public). */
export interface ObserveContext {
  runtime: ObservationRuntime;
  /** Span the model events hang under (the loop's step span or run span). */
  parentSpanId?: string;
  stepIndex?: number;
  /** Marks compaction summarize side-calls on model.started. */
  purpose?: 'compaction-summary';
}

export function runStream(
  options: CommonCallOptions,
  internal: InternalRunOptions = {},
): StreamChatResult {
  const broadcaster = createBroadcaster<StreamPart>();
  const usageDeferred = createDeferred<Usage>();
  const finishDeferred = createDeferred<FinishReason>();

  // Subscribe eagerly so a caller who awaits `usage` first and iterates a stream
  // later still receives every buffered part (no hot-observable race).
  const fullSub = broadcaster.subscribe();
  const textSub = broadcaster.subscribe();

  let started = false;
  function ensureStarted(): void {
    if (started) return;
    started = true;
    void pump();
  }

  async function pump(): Promise<void> {
    const deps = resolveDependencies(options.deps);
    // Tracing (1.6): spans are no longer opened here — the tracer bridge (a
    // runtime sink) derives the invoke→step→execute_tool hierarchy from the
    // observation events below, so a model call can never be double-spanned.
    let retries = 0;
    let ttftMs: number | undefined;
    let finalUsage: Usage | undefined;
    let finalFinish: FinishReason | undefined;

    // Observation (1.6): a loop passes its runtime via `internal.observe` (the
    // pump then emits only model.* events); a bare call becomes the root of a
    // single-turn run. Fast path: rt is undefined without an observer — every
    // emission below is a single `if (rt)` branch and no ids are drawn.
    const rt = internal.observe?.runtime ?? createObservationRuntime(deps);
    const observeRoot = rt !== undefined && internal.observe === undefined;
    const provider = options.model.provider;
    const modelId = options.model.modelId;
    let runSpanId: string | undefined;
    let runStartedAt = 0;
    let modelSpanId = '';
    let modelStartedAt = 0;
    // Shared correlation fields for every model.* event of this call.
    let evCtx: {
      spanId: string;
      parentSpanId?: string;
      agentPath?: readonly string[];
      stepIndex?: number;
      provider: string;
      model: string;
    } = { spanId: '', provider, model: modelId };
    let outputTextLength = 0;
    let reasoningLength = 0;
    const toolCallIds = new Set<string>();
    let capturedText: string | undefined;
    let capturedReasoning: string | undefined;
    if (rt) {
      const toolCount = internal.tools?.tools.length ?? 0;
      if (observeRoot) {
        const runSpan = rt.startSpan();
        runSpanId = runSpan.spanId;
        runStartedAt = runSpan.startedAt;
        rt.emit({
          type: 'run.started',
          spanId: runSpanId,
          agentPath: options.agentPath,
          operation: internal.operation ?? 'stream-chat',
          provider,
          model: modelId,
          surface: options.model.surface,
          durable: false,
          resumed: false,
          messageCount: options.messages.length,
          toolCount,
          ...(rt.capture.messages ? { capturedMessages: options.messages } : {}),
        });
      }
      const modelSpan = rt.startSpan();
      modelSpanId = modelSpan.spanId;
      modelStartedAt = modelSpan.startedAt;
      evCtx = {
        spanId: modelSpanId,
        parentSpanId: internal.observe?.parentSpanId ?? runSpanId,
        agentPath: options.agentPath,
        stepIndex: internal.observe?.stepIndex,
        provider,
        model: modelId,
      };
      rt.emit({
        type: 'model.started',
        ...evCtx,
        surface: options.model.surface,
        ...(internal.observe?.purpose ? { purpose: internal.observe.purpose } : {}),
        maxRetries: options.maxRetries ?? DEFAULT_RETRY.maxRetries,
        messageCount: options.messages.length,
        toolCount,
        ...(options.responseFormat ? { responseFormat: options.responseFormat } : {}),
        ...(options.promptCaching ? { promptCaching: options.promptCaching } : {}),
        ...(rt.capture.messages ? { capturedMessages: options.messages } : {}),
      });
    }
    /** model.failed (+ root run.failed) — shared by mid-stream errors and thrown failures. */
    const emitFailure = (err: unknown): void => {
      if (!rt) return;
      const observed: ObservedError = toObservedError(err, rt.capture.errorMessages);
      rt.emit({
        type: 'model.failed',
        ...evCtx,
        durationMs: rt.durationSince(modelStartedAt),
        ...(ttftMs !== undefined ? { ttftMs } : {}),
        retryCount: retries,
        error: observed,
      });
      if (observeRoot) {
        rt.emit({
          type: 'run.failed',
          spanId: runSpanId!,
          agentPath: options.agentPath,
          status: 'failed',
          durationMs: rt.durationSince(runStartedAt),
          error: observed,
          stepCount: 0,
          ...counterFields(rt),
        });
      }
    };
    try {
      const clientContext = readClientContext(options);
      const call = await resolveCall({
        model: options.model,
        deps,
        headers: options.headers,
        clientContext,
      });
      const messages = normalizeMessages(options.messages);
      const caps = getCapabilities(options.model, deps.logger);
      const adapter = getAdapter(options.model.surface);
      const startedAt = deps.clock.now();
      const { url, init } = adapter.buildRequest({
        call,
        messages,
        caps,
        options,
        generateId: deps.generateId,
        object: internal.object,
        tools: internal.tools,
      });

      // --- pre-first-byte retry loop with 3-layer timeout ---
      const retry = {
        ...DEFAULT_RETRY,
        maxRetries: options.maxRetries ?? DEFAULT_RETRY.maxRetries,
      };
      const random = (): number => unitFromId(deps.generateId());
      let res!: Response;
      let timeout!: TimeoutHandle;
      for (let attempt = 0; ; attempt++) {
        retries = attempt; // retries performed so far (attempt 0 = first try)
        timeout = createTimeout(deps.clock, DEFAULT_TIMEOUTS);
        const signal = combineSignals([options.signal, timeout.signal]);
        try {
          res = await call.fetch(url, { ...init, signal });
        } catch (err) {
          timeout.clear();
          if (err instanceof TimeoutError || isUserAbort(err, options.signal)) throw err;
          if (attempt < retry.maxRetries) {
            const delayMs = backoffMs(attempt, undefined, random, retry);
            if (rt) {
              rt.emit({
                type: 'model.retry',
                ...evCtx,
                failedAttempt: attempt,
                nextAttempt: attempt + 1,
                delayMs,
                reason: 'network',
                errorCode: 'network_error',
              });
            }
            await wait(deps.clock, delayMs, options.signal);
            continue;
          }
          throw new NetworkError({
            message: `Network request to provider '${call.provider}' failed.`,
            provider: call.provider,
            upstreamType: err instanceof Error ? err.name : typeof err,
          });
        }
        if (res.ok) break; // keep `timeout` armed for the streaming phase
        timeout.clear();
        const mapped = adapter.mapError(res.status, await readBody(res), res.headers, {
          provider: call.provider,
        });
        if (shouldRetry(mapped, attempt, retry.maxRetries)) {
          const retryAfter = mapped instanceof APICallError ? mapped.retryAfterMs : undefined;
          const delayMs = backoffMs(attempt, retryAfter, random, retry);
          if (rt) {
            rt.emit({
              type: 'model.retry',
              ...evCtx,
              failedAttempt: attempt,
              nextAttempt: attempt + 1,
              delayMs,
              ...(retryAfter !== undefined ? { retryAfterMs: retryAfter } : {}),
              // 429 and 529 have their own stable codes; the remaining
              // retryable case is a 5xx APICallError ('timeout' can never
              // appear — TimeoutError is thrown, not retried).
              reason:
                mapped.code === 'rate_limit'
                  ? 'rate-limit'
                  : mapped.code === 'overloaded'
                    ? 'overloaded'
                    : 'server-error',
              ...(mapped instanceof APICallError ? { statusCode: mapped.statusCode } : {}),
              errorCode: mapped.code,
            });
          }
          await wait(deps.clock, delayMs, options.signal);
          continue;
        }
        throw mapped;
      }
      if (!res.body) {
        timeout.clear();
        throw new APICallError({
          message: 'Provider returned an empty response body.',
          statusCode: res.status,
          isRetryable: false,
          provider: call.provider,
        });
      }

      let firstContent = false;
      try {
        for await (const part of adapter.parseStream(res.body, {
          caps,
          generateId: deps.generateId,
          provider: call.provider,
        })) {
          if (
            !firstContent &&
            (part.type === 'text-delta' ||
              part.type === 'reasoning-delta' ||
              // 1.6: a tool-call-first response IS first content — it clears
              // the TTFT timer (previously it could false-trip at 60s).
              part.type === 'tool-call-delta')
          ) {
            firstContent = true;
            timeout.firstByte();
            ttftMs = deps.clock.now() - startedAt;
            if (rt) {
              rt.emit({
                type: 'model.first-content',
                ...evCtx,
                contentType:
                  part.type === 'text-delta'
                    ? 'text'
                    : part.type === 'reasoning-delta'
                      ? 'reasoning'
                      : 'tool-call',
                ttftMs,
              });
            }
          }
          if (rt) {
            if (part.type === 'text-delta') {
              outputTextLength += part.text.length;
              if (rt.capture.outputText) capturedText = (capturedText ?? '') + part.text;
            } else if (part.type === 'reasoning-delta') {
              reasoningLength += part.text.length;
              if (rt.capture.reasoning && !part.encrypted) {
                capturedReasoning = (capturedReasoning ?? '') + part.text;
              }
            } else if (part.type === 'tool-call-delta') {
              toolCallIds.add(part.id);
            }
          }
          if (part.type === 'error') {
            broadcaster.push(part);
            usageDeferred.reject(part.error);
            finishDeferred.reject(part.error);
            // mid-stream error is final — the bridge fails the invoke span
            emitFailure(part.error);
            broadcaster.close();
            return;
          }
          if (part.type === 'finish') {
            finalUsage = part.usage;
            finalFinish = part.finishReason;
          }
          broadcaster.push(part);
        }
      } finally {
        timeout.clear();
      }

      const usage = withTotal(finalUsage ?? EMPTY_USAGE);
      const finishReason = finalFinish ?? 'stop';
      usageDeferred.resolve(usage);
      finishDeferred.resolve(finishReason);
      fireUsage(options, deps, usage, { model: options.model.modelId, reason: 'finished', ttftMs });
      fireFinish(options, deps, { model: options.model.modelId, finishReason });
      if (rt) {
        rt.emit({
          type: 'model.completed',
          ...evCtx,
          durationMs: rt.durationSince(modelStartedAt),
          ...(ttftMs !== undefined ? { ttftMs } : {}),
          retryCount: retries,
          finishReason,
          usage,
          outputTextLength,
          reasoningLength,
          toolCallCount: toolCallIds.size,
          ...(capturedText !== undefined ? { capturedOutputText: capturedText } : {}),
          ...(capturedReasoning !== undefined ? { capturedReasoning } : {}),
        });
        if (observeRoot) {
          const costUsd = observeCost(
            rt,
            deps.priceProvider,
            'run',
            provider,
            modelId,
            usage,
            runSpanId!,
          );
          rt.emit({
            type: 'run.completed',
            spanId: runSpanId!,
            agentPath: options.agentPath,
            status: 'completed',
            durationMs: rt.durationSince(runStartedAt),
            finishReason,
            endReason: 'natural',
            stepCount: 0,
            ...counterFields(rt),
            usage,
            ...(costUsd !== undefined ? { costUsd } : {}),
          });
        }
      }
      broadcaster.close();
    } catch (err) {
      if (isUserAbort(err, options.signal)) {
        const usage = withTotal(finalUsage ?? EMPTY_USAGE);
        usageDeferred.resolve(usage);
        finishDeferred.resolve('aborted');
        fireUsage(options, deps, usage, {
          model: options.model.modelId,
          reason: 'aborted',
          ttftMs,
        });
        if (rt) {
          // Same rule for events: the model call COMPLETED with 'aborted'
          // (never model.failed), then the run aborts. Usage is honest —
          // usually zeros unless a finish part already arrived.
          rt.emit({
            type: 'model.completed',
            ...evCtx,
            durationMs: rt.durationSince(modelStartedAt),
            ...(ttftMs !== undefined ? { ttftMs } : {}),
            retryCount: retries,
            finishReason: 'aborted',
            usage,
            outputTextLength,
            reasoningLength,
            toolCallCount: toolCallIds.size,
          });
          if (observeRoot) {
            rt.emit({
              type: 'run.aborted',
              spanId: runSpanId!,
              agentPath: options.agentPath,
              status: 'aborted',
              durationMs: rt.durationSince(runStartedAt),
              usage,
            });
          }
        }
        broadcaster.close();
        return;
      }
      broadcaster.push({ type: 'error', error: err });
      usageDeferred.reject(err);
      finishDeferred.reject(err);
      emitFailure(err);
      broadcaster.close();
    }
  }

  const fullStream = lazyAsyncIterable<StreamPart>(() => fullSub, ensureStarted);
  const textStream = lazyAsyncIterable<string>(() => projectText(textSub), ensureStarted);

  return {
    get textStream() {
      return textStream;
    },
    get fullStream() {
      return fullStream;
    },
    get usage() {
      ensureStarted();
      return usageDeferred.promise;
    },
    get finishReason() {
      ensureStarted();
      return finishDeferred.promise;
    },
  };
}
