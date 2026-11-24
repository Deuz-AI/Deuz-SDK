import type {
  LanguageModelV4,
  LanguageModelV4CallOptions,
  LanguageModelV4GenerateResult,
  LanguageModelV4StreamPart,
  LanguageModelV4StreamResult,
} from '@ai-sdk/provider';
import { BreakerOpenError } from '@deuz-sdk/core/errors';
import type { BudgetLedger } from '@deuz-sdk/core/agent';
import { DeuzUnsupportedModelError } from './errors';
import { createGuard, isProviderFailure, type DeuzOptions } from './guard';
import { defaultPriceKey, isContentPart, type DeuzModelRef } from './spec';

/** A fallback model with its own price key. */
export interface DeuzFallback {
  readonly model: LanguageModelV4;
  /** Price key of this model; default: the `priceKey` function, else `defaultPriceKey`. */
  readonly priceKey?: string;
}

/** Options of `deuz()`: the shared options plus fail-over. */
export interface DeuzModelOptions extends DeuzOptions {
  /**
   * Models tried in order when the previous one fails before its first
   * content byte (core's rule). Each attempt is reserved, priced and settled
   * as its own call, and each model has its own breaker. A string `priceKey`
   * applies to the wrapped model only.
   */
  readonly fallbackModels?: readonly (LanguageModelV4 | DeuzFallback)[];
  /**
   * Whether an error may fail over. Default (core's): an open breaker, a
   * retryable error and a 5xx status. Client errors, aborts and budget
   * refusals never hop.
   */
  readonly shouldFallback?: (error: unknown) => boolean;
  /** Called once per hop; a throwing callback is ignored. */
  readonly onFallback?: (info: {
    readonly from: DeuzModelRef;
    readonly to: DeuzModelRef;
    readonly error: unknown;
  }) => void;
}

/** A Deuz-guarded AI SDK language model. */
export type DeuzLanguageModel = LanguageModelV4 & {
  /** The ledger every call reserves against: read `totals()` for this wrapper's spend. */
  readonly ledger: BudgetLedger;
};

/** Core's default fail-over rule, for AI SDK errors (duck-typed `isRetryable` / `statusCode`). */
export function defaultShouldFallback(error: unknown): boolean {
  return error instanceof BreakerOpenError || isProviderFailure(error);
}

function reasonOf(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === 'string') return code;
  const status = (error as { statusCode?: unknown } | null)?.statusCode;
  if (typeof status === 'number') return `http_${status}`;
  return 'error';
}

const keyOf = (model: DeuzModelRef): string => `${model.provider}:${model.modelId}`;

function assertV4(model: unknown): LanguageModelV4 {
  const version = (model as { specificationVersion?: unknown } | null)?.specificationVersion;
  if (version !== 'v4') throw new DeuzUnsupportedModelError(String(version));
  return model as LanguageModelV4;
}

/**
 * Wrap an AI SDK language model so every call goes through a Deuz budget,
 * circuit breaker and optional fail-over. The result is a `LanguageModelV4`
 * with the wrapped model's `provider` and `modelId`, usable anywhere the AI
 * SDK takes a model (`generateText`, `streamText`, `generateObject`, agents).
 *
 * Per call: an open breaker fails fast with core's `BreakerOpenError`; the
 * call is reserved at an estimate (the prompt by characters plus
 * `maxOutputTokens`, or 4 096), priced by Deuz's price table; a refusal throws
 * `DeuzBudgetError`, which the AI SDK does not retry; after the call the
 * reported usage settles the reservation and `onCost` receives a receipt,
 * also attached as `providerMetadata.deuz`. A stream settles when its
 * `finish` part arrives.
 *
 * @example
 * ```ts
 * import { generateText } from 'ai';
 * import { openai } from '@ai-sdk/openai';
 * import { deuz } from '@deuz-sdk/ai-sdk-provider';
 *
 * const model = deuz(openai('gpt-5-mini'), { budget: { usd: 5 } });
 * const { text } = await generateText({ model, prompt: 'Hello' });
 * ```
 */
export function deuz(model: LanguageModelV4, options: DeuzModelOptions = {}): DeuzLanguageModel {
  const primary = assertV4(model);
  const guard = createGuard(options);
  const candidates: { model: LanguageModelV4; priceKey: string | undefined }[] = [
    { model: primary, priceKey: undefined },
    ...(options.fallbackModels ?? []).map((entry) => {
      const fallback: DeuzFallback =
        (entry as LanguageModelV4).specificationVersion === undefined
          ? (entry as DeuzFallback)
          : { model: entry as LanguageModelV4 };
      const candidate = assertV4(fallback.model);
      const ref = { provider: candidate.provider, modelId: candidate.modelId };
      return {
        model: candidate,
        // A string priceKey names the wrapped model only.
        priceKey:
          fallback.priceKey ??
          (typeof options.priceKey === 'string' ? defaultPriceKey(ref) : undefined),
      };
    }),
  ];
  const should = options.shouldFallback ?? defaultShouldFallback;
  const first: DeuzModelRef = { provider: primary.provider, modelId: primary.modelId };

  /** Decide a hop after candidate `index` failed; returns the next attempt's context. */
  function hop(
    index: number,
    error: unknown,
    params: LanguageModelV4CallOptions,
  ): { from: string; reason: string } | undefined {
    const next = candidates[index + 1];
    if (!next || params.abortSignal?.aborted || !should(error)) return undefined;
    const current = candidates[index]!.model;
    try {
      options.onFallback?.({
        from: { provider: current.provider, modelId: current.modelId },
        to: { provider: next.model.provider, modelId: next.model.modelId },
        error,
      });
    } catch {
      // Telemetry only.
    }
    return { from: keyOf(first), reason: reasonOf(error) };
  }

  async function doGenerate(
    params: LanguageModelV4CallOptions,
  ): Promise<LanguageModelV4GenerateResult> {
    let failedOver: { from: string; reason: string } | undefined;
    for (const [index, candidate] of candidates.entries()) {
      try {
        return await guard.generate(
          candidate.model,
          params,
          (call) => candidate.model.doGenerate(call),
          {
            ...(candidate.priceKey !== undefined ? { priceKey: candidate.priceKey } : {}),
            ...(failedOver ? { failedOver } : {}),
          },
        );
      } catch (error) {
        failedOver = hop(index, error, params);
        if (!failedOver) throw error;
      }
    }
    // Unreachable: the last candidate either returns or throws.
    throw new Error('deuz: no model answered.');
  }

  async function doStream(
    params: LanguageModelV4CallOptions,
  ): Promise<LanguageModelV4StreamResult> {
    let failedOver: { from: string; reason: string } | undefined;
    for (const [index, candidate] of candidates.entries()) {
      let result: LanguageModelV4StreamResult;
      try {
        result = await guard.stream(
          candidate.model,
          params,
          (call) => candidate.model.doStream(call),
          {
            ...(candidate.priceKey !== undefined ? { priceKey: candidate.priceKey } : {}),
            ...(failedOver ? { failedOver } : {}),
          },
        );
      } catch (error) {
        failedOver = hop(index, error, params);
        if (!failedOver) throw error;
        continue;
      }
      // Pre-first-byte rule: buffer until the first content part; an error
      // before it may hop, any error after it is final.
      const reader = result.stream.getReader();
      const buffered: LanguageModelV4StreamPart[] = [];
      let done = false;
      let failure: { error: unknown; thrown: boolean } | undefined;
      try {
        for (;;) {
          const next = await reader.read();
          if (next.done) {
            done = true;
            break;
          }
          buffered.push(next.value);
          if (next.value.type === 'error') {
            failure = { error: next.value.error, thrown: false };
            break;
          }
          if (next.value.type === 'finish' || isContentPart(next.value)) break;
        }
      } catch (error) {
        failure = { error, thrown: true };
      }
      if (failure) {
        const nextAttempt = hop(index, failure.error, params);
        if (nextAttempt) {
          // Cancelling closes this attempt's hold and records the breaker failure.
          await reader.cancel().catch(() => undefined);
          failedOver = nextAttempt;
          continue;
        }
        if (failure.thrown) throw failure.error;
      }
      return { ...result, stream: replay(buffered, reader, done) };
    }
    throw new Error('deuz: no model answered.');
  }

  return {
    specificationVersion: 'v4',
    provider: primary.provider,
    modelId: primary.modelId,
    get supportedUrls() {
      return primary.supportedUrls;
    },
    ledger: guard.ledger,
    doGenerate,
    doStream,
  };
}

/** The buffered parts, then the rest of the attempt. */
function replay(
  buffered: LanguageModelV4StreamPart[],
  reader: ReadableStreamDefaultReader<LanguageModelV4StreamPart>,
  done: boolean,
): ReadableStream<LanguageModelV4StreamPart> {
  return new ReadableStream<LanguageModelV4StreamPart>({
    async pull(controller) {
      const part = buffered.shift();
      if (part) {
        controller.enqueue(part);
        return;
      }
      if (done) {
        controller.close();
        return;
      }
      try {
        const next = await reader.read();
        if (next.done) controller.close();
        else controller.enqueue(next.value);
      } catch (error) {
        controller.error(error);
      }
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
}
