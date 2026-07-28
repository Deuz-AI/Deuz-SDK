import type { CommonCallOptions } from '../types/config';
import type { CallWarning, StreamChatResult } from '../types/methods';
import type { StreamPart } from '../types/stream';
import type { Usage, FinishReason } from '../types/usage';
import type { ModelSurface } from '../types/model';
import type { Adapter, BuildContext, ObjectRequest, WireToolRequest } from '../adapters/types';
import { APICallError, BreakerOpenError, NetworkError, TimeoutError } from '../errors';
import { resolveDependencies } from '../internal/resolve-deps';
import { resolveCall, resolveSignal } from '../internal/resolve-call';
import {
  createObservationRuntime,
  observeCost,
  counterFields,
  type ObservationRuntime,
} from '../internal/observe-runtime';
import { toObservedError } from '../internal/observe-error';
import type { RunStartedEvent, ObservedError } from '../types/observe';
import { readClientContext } from '../internal/client-context';
import { createWarningSink, unsupportedSetting, type WarningSink } from '../internal/warnings';
import { createBroadcaster, createDeferred, lazyAsyncIterable } from '../internal/async-iter';
import { normalizeMessages } from './normalize';
import { getCapabilities } from './registry';
import { EMPTY_USAGE, withTotal, fireUsage, fireFinish } from './metering';
import { combineSignals, createTimeout, resolveTimeouts, type TimeoutHandle } from './timeout';
import {
  DEFAULT_RETRY,
  BREAKER_THRESHOLD,
  BREAKER_COOLDOWN_MS,
  backoffMs,
  isBreakerCountable,
  shouldRetry,
  unitFromId,
  wait,
} from './resilience';
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
function isUserAbort(err: unknown, signal?: AbortSignal, failSignal?: AbortSignal): boolean {
  if (err instanceof TimeoutError) return false;
  if (signal?.aborted) return true;
  // A failure signal (1.9: the loop's stepMs deadline) is NEVER a user cancel,
  // even if the transport reported a bare AbortError instead of our reason.
  if (failSignal?.aborted) return false;
  return !!err && typeof err === 'object' && (err as { name?: string }).name === 'AbortError';
}

/**
 * When a fetch/body read was cut by one of OUR abort sources, surface the reason
 * we armed (a `TimeoutError`) rather than the transport's bare `AbortError` —
 * not every transport propagates `signal.reason`. The user's own signal is left
 * alone: its abort is a cancel, not a failure (G2).
 */
function withAbortReason(err: unknown, ...ours: (AbortSignal | undefined)[]): unknown {
  if (err instanceof TimeoutError) return err;
  for (const signal of ours) {
    if (signal?.aborted && signal.reason instanceof TimeoutError) return signal.reason;
  }
  return err;
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
  /**
   * An EXTRA abort source that means FAILURE, not a user cancel (1.9): today the
   * agentic loop's `timeout.stepMs` deadline. It is merged into the fetch signal
   * but deliberately kept OUT of `isUserAbort`'s user-signal check, so an expiry
   * surfaces as a `TimeoutError` (error part + rejected promises) instead of
   * resolving `finishReason: 'aborted'` — the G2 distinction the tests pin.
   */
  failSignal?: AbortSignal;
  /**
   * Warnings sink OWNED BY THE ENCLOSING LOOP (1.9). A loop re-derives
   * capabilities and re-builds the request on EVERY step, so the same
   * degradation (a stripped `temperature`, an unknown slug) is discovered again
   * each time. Passing one sink for the whole run makes it a single report: the
   * sink dedupes by (type, setting, message), and this pump only emits `warning`
   * parts for entries that were not already in it when the step started.
   *
   * Absent (a bare `streamChat`/`generateText`) → the pump owns a fresh sink for
   * the single call.
   */
  warnings?: WarningSink;
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
  // Warnings (1.9): the sink is CALL-SCOPED — a module-level one would leak
  // across concurrent calls on an edge isolate. It is created here rather than
  // inside pump() so `warnings` can settle from the pump's `finally` (below) and
  // therefore NEVER hangs, whatever exit the pump takes. No logger is attached:
  // every site that records into it either already writes its own richer line
  // (the registry's unknown-slug warning, the Chat Completions hosted-tool drop,
  // the dropped-document drop) or mirrors through `addWarning` below — the sink's
  // own forward on top of those would double-log.
  const warnings = internal.warnings ?? createWarningSink();
  const warningsDeferred = createDeferred<CallWarning[]>();

  // Subscribe eagerly so a caller who awaits `usage` first and iterates a stream
  // later still receives every buffered part (no hot-observable race).
  const fullSub = broadcaster.subscribe();
  const textSub = broadcaster.subscribe();

  let started = false;
  // Observation settlement (1.6.1): resolves after the pump finishes AND all
  // async enrichments (e.g. priceProvider cost) have been emitted.
  const observationDeferred = createDeferred<void>();
  let observationHandle: { settled: Promise<void> } | undefined;
  let rtRef: ObservationRuntime | undefined;
  // 1.9 (consume): the pump promise, so a drain can await the POST-terminal
  // bookkeeping (onFinish/metering) and not just the last part.
  let pumpDone: Promise<void> | undefined;
  function ensureStarted(): void {
    if (started) return;
    started = true;
    pumpDone = pump()
      // pump() catches everything internally; belt-and-braces so awaiting this
      // in consume() can never reject (G2 never-throw).
      .catch(() => {})
      .finally(() => {
        // `warnings` resolves alongside usage/finishReason and NEVER rejects
        // (declared contract): the full set is only known once the run is over,
        // and a failed run still reports whatever was collected. Settling here
        // covers every exit — success, mid-stream error, user abort, throw —
        // with one line instead of four.
        warningsDeferred.resolve(warnings.list());
        void (async () => {
          try {
            await rtRef?.settled();
          } catch {
            // settlement must never throw
          }
          observationDeferred.resolve();
        })();
      });
  }

  async function pump(): Promise<void> {
    const deps = resolveDependencies(options.deps);
    // 1.9: `signal` / deprecated `abortSignal` collapse in ONE place; and the
    // per-call timeout layers resolve ONCE (absent `timeout` === DEFAULT_TIMEOUTS,
    // i.e. the 1.8 behaviour). `stepMs`/`toolMs` belong to the loop, not to a
    // single model call, so this pump only reads ttft/total.
    const userSignal = resolveSignal(options);
    const timeouts = resolveTimeouts(options.timeout);
    /** The armed ttft/total signal of the CURRENT attempt (for abort-reason recovery). */
    let timeoutSignal: AbortSignal | undefined;
    // Tracing (1.6): spans are no longer opened here — the tracer bridge (a
    // runtime sink) derives the invoke→step→execute_tool hierarchy from the
    // observation events below, so a model call can never be double-spanned.
    let retries = 0;
    let ttftMs: number | undefined;
    let finalUsage: Usage | undefined;
    let finalFinish: FinishReason | undefined;

    // --- warnings (1.9) ---
    // Cursor into the sink: everything before it has already been emitted as a
    // `warning` part. An INHERITED sink starts at its current length, because the
    // enclosing loop's earlier steps already put those parts on the same stream.
    let emittedWarnings = internal.warnings ? internal.warnings.list().length : 0;
    /** Emit a canonical `warning` part for each newly discovered warning. */
    const flushWarnings = (): void => {
      const all = warnings.list();
      for (let i = emittedWarnings; i < all.length; i++) {
        broadcaster.push({ type: 'warning', warning: all[i]! });
      }
      emittedWarnings = all.length;
    };
    /**
     * Record a warning discovered HERE (a site with no pre-1.9 log line of its
     * own) and mirror it to the logger, so a log-only workflow sees it too. The
     * mirror is gated on the sink actually having accepted the entry, so the
     * dedupe covers the log as well as the list.
     */
    const addWarning = (warning: CallWarning): void => {
      const before = warnings.list().length;
      warnings.add(warning);
      if (warnings.list().length === before) return;
      deps.logger.warn(warning.message, {
        warning: warning.type,
        ...(warning.setting !== undefined ? { setting: warning.setting } : {}),
      });
    };

    // Observation (1.6): a loop passes its runtime via `internal.observe` (the
    // pump then emits only model.* events); a bare call becomes the root of a
    // single-turn run. Fast path: rt is undefined without an observer — every
    // emission below is a single `if (rt)` branch and no ids are drawn.
    const rt = internal.observe?.runtime ?? createObservationRuntime(deps);
    const observeRoot = rt !== undefined && internal.observe === undefined;
    if (rt) {
      rtRef = rt;
      observationHandle = { settled: observationDeferred.promise };
    }
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
    // Circuit breaker (1.7, D6): keyed per provider:model, resolved per client
    // (G11). Set after resolveCall; consulted before the first attempt.
    let breakerKey: string | undefined;
    try {
      const clientContext = readClientContext(options);
      const call = await resolveCall({
        model: options.model,
        deps,
        headers: options.headers,
        clientContext,
      });
      breakerKey = `${call.provider}:${modelId}`;
      let breakerState: import('../types/deps').BreakerState | undefined;
      try {
        breakerState = await deps.breakerStore.get(breakerKey);
      } catch {
        /* a failing breaker store never blocks calls */
      }
      if (
        breakerState?.cooldownUntil !== undefined &&
        breakerState.cooldownUntil > deps.clock.now()
      ) {
        throw new BreakerOpenError({
          provider: call.provider,
          modelId,
          cooldownUntil: breakerState.cooldownUntil,
        });
      }
      const messages = normalizeMessages(options.messages);
      const caps = getCapabilities(options.model, deps.logger, undefined, warnings);
      // A setting the caller ACTUALLY SET that this (model, wire) pair cannot
      // carry (1.9). Only ever for a value that was passed: an option nobody
      // supplied was not degraded, and a warning on every call would be noise.
      if (caps.samplingRestrictions && options.model.surface !== 'native') {
        // Reasoning rows reject sampling params, so all three wires that read the
        // flag strip them (anthropic.ts / openai-compatible.ts /
        // openai-responses.ts). google-native.ts never strips — it sends
        // temperature/topP unconditionally — so a row that claims the restriction
        // on the native wire must NOT be reported as a drop.
        const why = `${modelId} restricts sampling parameters (a reasoning model rejects them)`;
        if (options.temperature !== undefined) {
          addWarning(
            unsupportedSetting('temperature', `temperature was dropped from the request: ${why}.`),
          );
        }
        if (options.topP !== undefined) {
          addWarning(unsupportedSetting('topP', `topP was dropped from the request: ${why}.`));
        }
      }
      // `effort` is gated on `caps.reasoning` by all four wires. 'none' asks for
      // no reasoning and gets exactly that, so nothing was lost — no warning.
      if (!caps.reasoning && options.effort !== undefined && options.effort !== 'none') {
        addWarning(
          unsupportedSetting(
            'effort',
            `effort '${options.effort}' was dropped from the request: ${provider}/${modelId} has no ` +
              `reasoning capability in the registry (pass \`capabilities: { reasoning: true }\` if it does).`,
          ),
        );
      }
      const adapter = getAdapter(options.model.surface);
      const startedAt = deps.clock.now();
      // The per-call warning sink rides along (1.9) so a wire can report a lossy
      // mapping as a typed warning instead of only a log line. `BuildContext`
      // does not declare it yet — the intersection keeps the hand-off type-safe
      // without a cast until `adapters/types.ts` carries the field for all four.
      const buildCtx: BuildContext & { warnings: WarningSink } = {
        call,
        messages,
        caps,
        options,
        generateId: deps.generateId,
        object: internal.object,
        tools: internal.tools,
        // Adapters warn through the injected logger when a wire cannot carry
        // something the caller asked for (lossy mapping must never be silent).
        logger: deps.logger,
        warnings,
      };
      const { url, init } = adapter.buildRequest(buildCtx);
      // Every warning site of a call runs before the first byte (capability
      // resolution + request building), so one flush here puts them on the
      // stream ahead of the model's own parts.
      flushWarnings();

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
        timeout = createTimeout(deps.clock, timeouts);
        timeoutSignal = timeout.signal;
        // The loop's stepMs deadline (internal.failSignal) rides along as a
        // third source — merged for the transport, kept out of the user-abort
        // classification below.
        const signal = combineSignals([userSignal, internal.failSignal, timeout.signal]);
        try {
          res = await call.fetch(url, { ...init, signal });
        } catch (raw) {
          timeout.clear();
          const err = withAbortReason(raw, timeout.signal, internal.failSignal);
          if (err instanceof TimeoutError || isUserAbort(err, userSignal, internal.failSignal))
            throw err;
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
            await wait(deps.clock, delayMs, userSignal);
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
          await wait(deps.clock, delayMs, userSignal);
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
      // First byte arrived — the provider is healthy again: reset the breaker
      // (best-effort, only when there was something to clear).
      if (breakerState && breakerState.failures > 0) {
        void Promise.resolve(deps.breakerStore.set(breakerKey, { failures: 0 })).catch(() => {});
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
            // Live cost (1.7, D2): single-turn calls price the finish usage
            // inline; loop-driven calls (internal.tools set) leave it to the
            // loop's cumulative per-step part.
            if (!internal.tools && deps.priceProvider) {
              try {
                const priced = withTotal(part.usage);
                const costUsd = await deps.priceProvider.priceUsage(modelId, priced);
                if (typeof costUsd === 'number') {
                  const savings = await deps.priceProvider.cacheSavings?.(modelId, priced);
                  broadcaster.push({
                    type: 'cost',
                    costUsd,
                    deltaUsd: costUsd,
                    ...(typeof savings === 'number' && savings > 0
                      ? { cacheSavingsUsd: savings }
                      : {}),
                  });
                }
              } catch {
                deps.logger.warn('cost part skipped — priceProvider threw');
              }
            }
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
      // G12 (1.9): `onFinish` belongs to the RUN, so only the run's owner fires
      // it. A STEP of an agentic loop (`internal.tools` set — the same
      // "loop-driven call" test the cost part above uses) leaves it to the loop,
      // which fires once with the run's finishReason. Firing here as well made
      // every loop-routed call deliver `onFinish` twice (once per step, plus once
      // for the loop). `onUsage` above is per MODEL CALL and keeps firing on
      // every step — see the G12 note in `core/metering.ts`.
      if (!internal.tools) {
        fireFinish(options, deps, { model: options.model.modelId, finishReason });
      }
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
    } catch (raw) {
      // A failure before the flush above (a throw out of buildRequest, a 4xx, an
      // open breaker) must still report what was already collected.
      flushWarnings();
      // Recover our own abort reason first: a ttft/total/step expiry that cut
      // the BODY read can reach us as a bare AbortError, and misreading it as a
      // user cancel would resolve 'aborted' instead of failing (G2).
      const err = withAbortReason(raw, timeoutSignal, internal.failSignal);
      if (isUserAbort(err, userSignal, internal.failSignal)) {
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
      // Breaker bookkeeping (1.7, D6): count provider-health failures only —
      // a threshold of consecutive ones opens the breaker for a cooldown.
      if (breakerKey !== undefined && isBreakerCountable(err)) {
        try {
          const failures = ((await deps.breakerStore.get(breakerKey))?.failures ?? 0) + 1;
          const now = deps.clock.now();
          await deps.breakerStore.set(
            breakerKey,
            failures >= BREAKER_THRESHOLD
              ? { failures, openedAt: now, cooldownUntil: now + BREAKER_COOLDOWN_MS }
              : { failures },
          );
          if (failures >= BREAKER_THRESHOLD) {
            deps.logger.warn('circuit breaker opened', {
              key: breakerKey,
              failures,
              cooldownMs: BREAKER_COOLDOWN_MS,
            });
          }
        } catch {
          /* best-effort — a failing store never changes call behavior */
        }
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

  /**
   * `consume()` (1.9) — the counterpart of the lazy pump (G2). Nobody iterating
   * means the run never reaches its terminal boundary, so `onUsage`/`onFinish`
   * (and, in the agentic loop, chat persistence / checkpoints / memory
   * extraction) never fire. Draining through its OWN broadcaster subscription
   * leaves `fullStream`/`textStream` intact, so consume() + iteration both see
   * every part. Memoized: a second call awaits the SAME drain, so terminal
   * effects can never fire twice. NEVER rejects — a failure is reported through
   * `onError` and stays on `fullStream` as the `error` part.
   */
  let drain: Promise<{ error: unknown } | undefined> | undefined;
  function consume(consumeOptions?: { onError?: (error: unknown) => void }): Promise<void> {
    drain ??= (async () => {
      // Subscribe BEFORE the lazy start, exactly like fullSub/textSub. A
      // subscription taken after the pump closed sees nothing at all — hence
      // the `usage` fallback below for a late consume().
      const sub = broadcaster.subscribe();
      ensureStarted();
      let failure: { error: unknown } | undefined;
      try {
        for await (const part of sub) {
          // A mid-stream failure is an error PART here (the pump closes the
          // broadcaster, it never fails it) — never a thrown iteration.
          if (part.type === 'error') failure ??= { error: part.error };
        }
      } catch (err) {
        failure ??= { error: err };
      }
      try {
        // The terminal bookkeeping runs after the last part; resolving on the
        // drain alone would let a serverless host tear the isolate down early.
        await pumpDone;
      } catch {
        // unreachable (pump never rejects) — the contract holds regardless
      }
      if (!failure) {
        try {
          await usageDeferred.promise;
        } catch (err) {
          failure = { error: err };
        }
      }
      return failure;
    })();
    return drain.then((failure) => {
      if (!failure) return;
      try {
        consumeOptions?.onError?.(failure.error);
      } catch {
        // an onError that throws must not break the never-reject contract
      }
    });
  }

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
    get warnings() {
      // Starts the pump like `usage`/`finishReason` do: the set is only known
      // once the call has run, so awaiting this alone must not deadlock (G2).
      ensureStarted();
      return warningsDeferred.promise;
    },
    get observation() {
      ensureStarted();
      return observationHandle;
    },
    // A plain method, never a getter: reading `result.consume` must NOT start
    // the pump (G2 lazy start).
    consume,
  };
}
