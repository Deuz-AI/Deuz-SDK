import type { CommonCallOptions } from '../types/config';
import type { StreamChatResult } from '../types/methods';
import type { StreamPart } from '../types/stream';
import type { Usage, FinishReason } from '../types/usage';
import type { ModelSurface } from '../types/model';
import type { Span } from '../types/deps';
import type { Adapter, ObjectRequest, WireToolRequest } from '../adapters/types';
import { APICallError, NetworkError, TimeoutError } from '../errors';
import { resolveDependencies } from '../internal/resolve-deps';
import { resolveCall } from '../internal/resolve-call';
import { openSpan, invokeAttributes, setUsageAttributes } from '../internal/trace';
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
   * Tracing (1.6): the enclosing loop's `step` span. When set, the loop owns
   * the invoke/step hierarchy — the pump emits NO `invoke` span of its own and
   * reports pre-first-byte retries onto this span as `deuz.retry.count`.
   */
  stepSpan?: Span;
  /** Tracing (1.6): true for loop-internal side calls (compaction summarize) — no span at all. */
  skipInvokeSpan?: boolean;
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
    // Tracing (1.6): a bare public call (streamChat/generateText without tools,
    // generateObject/streamObject) gets its single-shot `invoke` span HERE —
    // lazily, when the pump starts (G2). Agentic loops pass `stepSpan` (they
    // own the invoke/step hierarchy) and compaction side-calls pass
    // `skipInvokeSpan`, so a model call is never double-wrapped. Attributes
    // carry only ids/counts/enums — message content, headers, URLs and key
    // material NEVER enter a span (semconv content capture off by design).
    const invoke =
      internal.stepSpan || internal.skipInvokeSpan
        ? undefined
        : openSpan(deps.tracer, 'invoke', invokeAttributes(options.model, options.agentPath));
    // Where `deuz.retry.count` lands: the loop's step span, else our invoke.
    const retryTarget: Span | undefined = internal.stepSpan ?? invoke?.span;
    let retries = 0;
    let ttftMs: number | undefined;
    let finalUsage: Usage | undefined;
    let finalFinish: FinishReason | undefined;
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
            await wait(deps.clock, backoffMs(attempt, undefined, random, retry), options.signal);
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
          await wait(deps.clock, backoffMs(attempt, retryAfter, random, retry), options.signal);
          continue;
        }
        throw mapped;
      }
      if (retries > 0) retryTarget?.setAttribute('deuz.retry.count', retries);

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
          if (!firstContent && (part.type === 'text-delta' || part.type === 'reasoning-delta')) {
            firstContent = true;
            timeout.firstByte();
            ttftMs = deps.clock.now() - startedAt;
          }
          if (part.type === 'error') {
            broadcaster.push(part);
            usageDeferred.reject(part.error);
            finishDeferred.reject(part.error);
            invoke?.fail(part.error); // mid-stream error is final — record + end
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
      if (invoke) {
        setUsageAttributes(invoke, usage, finishReason);
        invoke.setAttribute('deuz.step.count', 1);
        invoke.end();
      }
      broadcaster.close();
    } catch (err) {
      if (retries > 0) retryTarget?.setAttribute('deuz.retry.count', retries);
      if (isUserAbort(err, options.signal)) {
        const usage = withTotal(finalUsage ?? EMPTY_USAGE);
        usageDeferred.resolve(usage);
        finishDeferred.resolve('aborted');
        fireUsage(options, deps, usage, {
          model: options.model.modelId,
          reason: 'aborted',
          ttftMs,
        });
        if (invoke) {
          // A user abort is a resolution, not a failure — no exception recorded.
          setUsageAttributes(invoke, usage, 'aborted');
          invoke.setAttribute('deuz.step.count', 1);
          invoke.end();
        }
        broadcaster.close();
        return;
      }
      broadcaster.push({ type: 'error', error: err });
      usageDeferred.reject(err);
      finishDeferred.reject(err);
      invoke?.fail(err);
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
