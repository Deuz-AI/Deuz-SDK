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
  GenerateTextOptions,
  GenerateTextResult,
  StreamChatOptions,
  StreamChatResult,
} from '../types/methods';
import type { StreamPart } from '../types/stream';
import type { Usage, FinishReason } from '../types/usage';
import type { MemoryMutation } from '../memory';
import { createBroadcaster, createDeferred, lazyAsyncIterable } from './async-iter';
import { resolveDependencies } from './resolve-deps';
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
  if (error instanceof TimeoutError || error instanceof NetworkError) return true;
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

  let started = false;
  const ensureStarted = (): void => {
    if (started) return;
    started = true;
    void pump();
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
    get memory() {
      if (!memoryDeferred) return undefined;
      ensureStarted();
      return memoryDeferred.promise;
    },
    ...(runId !== undefined ? { runId } : {}),
  };
}
