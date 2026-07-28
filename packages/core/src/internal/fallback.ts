/**
 * fallback.ts — the cross-provider fail-over engine (1.7, D6). Because the
 * WHOLE history is canonical (`Message[]`/`Part[]`), a conversation can hop
 * providers mid-chat: the next candidate receives the identical request the
 * failed one got. Streaming semantics are strict pre-first-byte: an attempt
 * may fail over only while it has produced NO content — once the first
 * content part arrived, a mid-stream error is final (the existing rule).
 *
 * Shared by `withFallback` (the middleware) and the `fallbackModels` call
 * option — this module deliberately imports NO orchestrators (no cycles).
 */
import type { LanguageModel } from '../types/model';
import type {
  CallWarning,
  GenerateTextOptions,
  GenerateTextResult,
  StreamChatOptions,
  StreamChatResult,
} from '../types/methods';
import type { StreamPart } from '../types/stream';
import type { Usage, FinishReason } from '../types/usage';
import type { Dependencies } from '../types/deps';
import type { MemoryMutation } from '../memory';
import { createBroadcaster, createDeferred, lazyAsyncIterable } from './async-iter';
import { resolveDependencies, noopTracer } from './resolve-deps';
import { APICallError, BreakerOpenError, NetworkError, TimeoutError } from '../errors';

export interface FallbackHooks {
  /**
   * Decide whether an error may fail over (default: breaker-open, network,
   * timeout, and retryable / 5xx API errors — client errors never hop).
   */
  shouldFallback?: (error: unknown) => boolean;
  /** Telemetry hook — fired once per hop. */
  onFallback?: (info: { from: LanguageModel; to: LanguageModel; error: unknown }) => void;
}

export function defaultShouldFallback(error: unknown): boolean {
  if (error instanceof BreakerOpenError) return true;
  // A `step` / `tool` deadline (1.9) is a CALLER-IMPOSED BUDGET, not a provider
  // failure: hopping to another model cannot make the budget fit, and re-running
  // the loop would repeat the side effects of tools that already executed. Only
  // the transport-level layers ('connect'/'ttft'/'total') justify a fail-over.
  if (error instanceof TimeoutError) return error.layer !== 'step' && error.layer !== 'tool';
  if (error instanceof NetworkError) return true;
  if (error instanceof APICallError) {
    return error.isRetryable || (error.statusCode !== undefined && error.statusCode >= 500);
  }
  return false;
}

const modelKey = (model: LanguageModel): string => `${model.provider}:${model.modelId}`;

interface FailedOver {
  from: string;
  to: string;
  reason: string;
}

function failedOverOf(first: LanguageModel, winner: LanguageModel, error: unknown): FailedOver {
  const reason =
    error instanceof APICallError ||
    error instanceof BreakerOpenError ||
    error instanceof TimeoutError
      ? (error as { code: string }).code
      : 'error';
  return { from: modelKey(first), to: modelKey(winner), reason };
}

/** Buffered fail-over: try candidates in order until one resolves. */
export async function runGenerateWithFallback(
  run: (options: GenerateTextOptions) => Promise<GenerateTextResult>,
  options: GenerateTextOptions,
  models: LanguageModel[],
  hooks: FallbackHooks = {},
): Promise<GenerateTextResult> {
  const candidates = [options.model, ...models];
  const should = hooks.shouldFallback ?? defaultShouldFallback;
  let lastError: unknown;
  for (let i = 0; i < candidates.length; i++) {
    const model = candidates[i]!;
    try {
      const result = await run({ ...options, model });
      if (i > 0) {
        const deuz = (result.providerMetadata?.deuz ?? {}) as Record<string, unknown>;
        result.providerMetadata = {
          ...result.providerMetadata,
          deuz: { ...deuz, failedOver: failedOverOf(candidates[0]!, model, lastError) },
        };
      }
      return result;
    } catch (error) {
      lastError = error;
      if (i >= candidates.length - 1 || !should(error)) throw error;
      hooks.onFallback?.({ from: model, to: candidates[i + 1]!, error });
    }
  }
  throw lastError;
}

/**
 * Would an inner call build an observation runtime? `StreamChatResult.observation`
 * is documented as present ONLY when an observer (or a real tracer) is active, and
 * a shell that builds its own result has to decide that SYNCHRONOUSLY — before any
 * inner result exists. So this mirrors `createObservationRuntime`'s activation rule
 * (`internal/observe-runtime.ts`): an enabled observer OR an injected non-noop
 * tracer. `noopTracer` is exported for exactly this identity check.
 *
 * It lives in this leaf module because BOTH shells need it (`runStreamWithFallback`
 * below and `deferStream` in `src/middleware.ts`, which imports it from here) and
 * because this module deliberately imports no orchestrator — duplicating the rule
 * is how the two shells would drift apart.
 */
export function observationActive(deps: Dependencies | undefined): boolean {
  if (!deps) return false;
  if (deps.observer !== undefined && deps.observer.options?.enabled !== false) return true;
  return deps.tracer !== undefined && deps.tracer !== noopTracer;
}

/** Parts that count as FIRST CONTENT — after one of these, errors are final. */
function isContentPart(part: StreamPart): boolean {
  return (
    part.type === 'text-delta' ||
    part.type === 'reasoning-delta' ||
    part.type === 'tool-call-delta' ||
    part.type === 'tool-call'
  );
}

/**
 * Streaming fail-over (G2: returns synchronously, never throws). Each attempt
 * is buffered until its first content part; a pre-content failure (thrown or
 * an `error` part) hops to the next candidate, the failed attempt's promises
 * are silenced, and the winner's parts flow through with a
 * `providerMetadata.deuz.failedOver` marker on the terminal finish.
 *
 * The shell forwards the WHOLE `StreamChatResult` shape (1.9): `runId` and
 * `memory` as before, plus `warnings`, `observation` and `consume()` — see the
 * comments at each site for why a shell has to decide some of them from the CALL
 * rather than from the (not yet existing) inner result.
 */
export function runStreamWithFallback(
  run: (options: StreamChatOptions) => StreamChatResult,
  options: StreamChatOptions,
  models: LanguageModel[],
  hooks: FallbackHooks = {},
): StreamChatResult {
  // Stabilize the durable identity across attempts (and expose it sync).
  let callOptions = options;
  if (callOptions.session && callOptions.session.runId === undefined) {
    const runId = resolveDependencies(callOptions.deps).generateId();
    callOptions = { ...callOptions, session: { ...callOptions.session, runId } };
  }
  const runId = callOptions.session?.runId;

  const broadcaster = createBroadcaster<StreamPart>();
  const usageDeferred = createDeferred<Usage>();
  const finishDeferred = createDeferred<FinishReason>();
  const fullSub = broadcaster.subscribe();
  const textSub = broadcaster.subscribe();
  const memoryDeferred =
    callOptions.memory && callOptions.memory.extract !== false
      ? createDeferred<MemoryMutation[]>()
      : undefined;
  // 1.9: the shell used to build a PARTIAL StreamChatResult — no `warnings`, no
  // `observation`, no `consume()` — so enabling fail-over silently dropped all
  // three. `warnings` and `consume` are unconditional (they forward the winner's,
  // exactly like `deferStream` in src/middleware.ts); `observation` keeps its
  // documented conditional presence, decided from the call's deps.
  const warningsDeferred = createDeferred<CallWarning[]>();
  const observationDeferred = createDeferred<void>();
  const observationHandle = observationActive(callOptions.deps)
    ? { settled: observationDeferred.promise }
    : undefined;
  /** Every attempt's observation settlement — a failed hop still emitted events. */
  const settlements: Promise<void>[] = [];
  /** The attempt whose parts flow through, once one produced content. */
  let winner: StreamChatResult | undefined;

  let started = false;
  /**
   * 1.9 (consume): the pump promise, so a drain can await the POST-terminal
   * bookkeeping instead of just the last part.
   */
  let pumpDone: Promise<void> | undefined;
  const ensureStarted = (): void => {
    if (started) return;
    started = true;
    pumpDone = pump()
      // pump() catches everything internally; belt-and-braces so awaiting this in
      // consume() can never reject (G2 never-throw).
      .catch(() => {})
      .finally(() => {
        void (async () => {
          try {
            warningsDeferred.resolve(await (winner?.warnings ?? []));
          } catch {
            // `warnings` never rejects by contract — resolve empty regardless.
            warningsDeferred.resolve([]);
          }
          await Promise.allSettled(settlements);
          observationDeferred.resolve();
        })();
      });
  };

  async function pump(): Promise<void> {
    const candidates = [callOptions.model, ...models];
    const should = hooks.shouldFallback ?? defaultShouldFallback;
    let lastError: unknown;
    try {
      for (let i = 0; i < candidates.length; i++) {
        const model = candidates[i]!;
        const attempt = run({ ...callOptions, model });
        const iterator = attempt.fullStream[Symbol.asyncIterator]();
        const buffered: StreamPart[] = [];
        let failure: unknown;
        let sawFailure = false;
        let content = false;
        let endedEarly = false;
        for (;;) {
          let next: IteratorResult<StreamPart>;
          try {
            next = await iterator.next();
          } catch (error) {
            failure = error;
            sawFailure = true;
            break;
          }
          if (next.done) {
            endedEarly = true;
            break;
          }
          const part = next.value;
          if (part.type === 'error') {
            failure = part.error;
            sawFailure = true;
            break;
          }
          buffered.push(part);
          if (isContentPart(part)) {
            content = true;
            break;
          }
        }

        // Collect this attempt's observation settlement HERE, not at construction:
        // the streaming loop assigns its handle inside the pump (after the
        // checkpoint/chat-store awaits), so a read before the first part would
        // still see `undefined`. By now the attempt has produced a part, ended, or
        // failed, so its handle exists if observation is on at all.
        const settled = attempt.observation?.settled;
        if (settled) settlements.push(settled);

        if (sawFailure && !content) {
          // Pre-first-content failure — this attempt may fail over.
          attempt.usage.catch(() => {});
          attempt.finishReason.catch(() => {});
          void attempt.memory?.catch(() => {});
          lastError = failure;
          if (i < candidates.length - 1 && should(failure)) {
            hooks.onFallback?.({ from: model, to: candidates[i + 1]!, error: failure });
            continue;
          }
          // Exhausted (or non-fallback error): surface G2-style.
          for (const part of buffered) broadcaster.push(part);
          broadcaster.push({ type: 'error', error: failure });
          usageDeferred.reject(failure);
          finishDeferred.reject(failure);
          memoryDeferred?.resolve([]);
          broadcaster.close();
          return;
        }

        // WINNER: re-emit the buffer, then pipe the rest through (patching the
        // terminal finish with the failedOver marker when we hopped).
        winner = attempt;
        const failedOver = i > 0 ? failedOverOf(candidates[0]!, model, lastError) : undefined;
        const patch = (part: StreamPart): StreamPart => {
          if (!failedOver || part.type !== 'finish') return part;
          const deuz = (part.providerMetadata?.deuz ?? {}) as Record<string, unknown>;
          return {
            ...part,
            providerMetadata: { ...part.providerMetadata, deuz: { ...deuz, failedOver } },
          };
        };
        for (const part of buffered) broadcaster.push(patch(part));
        if (!endedEarly) {
          for (;;) {
            let next: IteratorResult<StreamPart>;
            try {
              next = await iterator.next();
            } catch (error) {
              // Post-first-content failure is FINAL (the existing rule).
              broadcaster.push({ type: 'error', error });
              usageDeferred.reject(error);
              finishDeferred.reject(error);
              memoryDeferred?.resolve([]);
              broadcaster.close();
              return;
            }
            if (next.done) break;
            broadcaster.push(patch(next.value));
          }
        }
        try {
          usageDeferred.resolve(await attempt.usage);
        } catch (error) {
          usageDeferred.reject(error);
        }
        try {
          finishDeferred.resolve(await attempt.finishReason);
        } catch (error) {
          finishDeferred.reject(error);
        }
        if (memoryDeferred) {
          if (attempt.memory) {
            void attempt.memory.then((mutations) => memoryDeferred.resolve(mutations));
          } else {
            memoryDeferred.resolve([]);
          }
        }
        broadcaster.close();
        return;
      }
    } catch (error) {
      // Defensive: nothing above should throw, but G2 must hold regardless.
      broadcaster.push({ type: 'error', error });
      usageDeferred.reject(error);
      finishDeferred.reject(error);
      memoryDeferred?.resolve([]);
      broadcaster.close();
    }
  }

  async function* projectText(source: AsyncIterable<StreamPart>): AsyncGenerator<string> {
    for await (const part of source) {
      if (part.type === 'text-delta') yield part.text;
      else if (part.type === 'error') throw part.error;
    }
  }

  const fullStream = lazyAsyncIterable<StreamPart>(() => fullSub, ensureStarted);
  const textStream = lazyAsyncIterable<string>(() => projectText(textSub), ensureStarted);

  /**
   * `consume()` (1.9) — the fail-over twin of the drains in `core/inference.ts`
   * and `inference/stream-tool-loop.ts`. Sprint 2 shipped `consume()` on the
   * normal paths only, so `streamChat({ fallbackModels })` and the `withFallback`
   * middleware returned `undefined` here and `res.consume?.()` was a silent no-op
   * on exactly the shape it exists for (chat persistence / durable checkpoints /
   * `onFinish` / memory extraction never ran when nobody iterated).
   *
   * Drains through its OWN broadcaster subscription, so consume() plus a normal
   * iteration both see every part; awaits the shell's pump AND the winning
   * attempt's own memoized drain (an agentic loop persists chat and saves its
   * last checkpoint AFTER its stream closed, so stopping at the last part would
   * return too early). Memoized — a second call awaits the SAME drain, so
   * terminal effects can never fire twice. NEVER rejects: a failure is reported
   * through `onError` and stays on `fullStream` as the `error` part.
   */
  let drain: Promise<{ error: unknown } | undefined> | undefined;
  function consume(consumeOptions?: { onError?: (error: unknown) => void }): Promise<void> {
    drain ??= (async () => {
      // Subscribe BEFORE the lazy start, exactly like fullSub/textSub — a
      // subscription taken after the broadcaster closed sees nothing at all,
      // hence the `usage` fallback below for a late consume().
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
        await pumpDone;
      } catch {
        // unreachable (pump never rejects) — the contract holds regardless
      }
      try {
        // The winner owns its own post-terminal bookkeeping; hand off to its
        // memoized drain rather than re-implementing it. A hopped-away attempt is
        // abandoned by design (its promises were silenced) and is not drained.
        await winner?.consume?.();
      } catch {
        // consume() never rejects either — defensive
      }
      if (memoryDeferred) {
        try {
          await memoryDeferred.promise;
        } catch {
          /* never rejects — defensive */
        }
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
      ensureStarted();
      return warningsDeferred.promise;
    },
    get memory() {
      if (!memoryDeferred) return undefined;
      ensureStarted();
      return memoryDeferred.promise;
    },
    get observation() {
      if (!observationHandle) return undefined;
      ensureStarted();
      return observationHandle;
    },
    // A plain method, never a getter: reading `result.consume` must NOT start the
    // pump (G2 lazy start).
    consume,
    ...(runId !== undefined ? { runId } : {}),
  };
}
