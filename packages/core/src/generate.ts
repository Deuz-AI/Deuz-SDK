/**
 * Canonical free functions, backed by the real inference pipeline (Faz 1).
 * Each implementation lives in its own module under `inference/` but they all
 * share the SAME pipeline in `core/inference.ts`.
 *
 * 1.9 turns this barrel into the CALL BOUNDARY: the one place that canonicalizes
 * a call's INPUT SHAPE before any orchestration sees it —
 *
 *   - `prompt` / `instructions` → a canonical `Message[]` (`core/normalize.ts`),
 *     so everything downstream (both loops, the pump, checkpoints, chat
 *     persistence, observation counts) reads a single `options.messages`;
 *   - a per-call `capabilities` override → the config Symbol of a per-call
 *     descriptor clone, the one channel `getCapabilities` reads
 *     (`internal/config-symbol.ts`).
 *
 * Doing it here is what keeps `messages` REQUIRED on `CommonCallOptions` (making
 * it optional is a locked-surface change) while `streamChat({ model, prompt: 'hi' })`
 * still typechecks: the either/or lives in these functions' OVERLOADS, not in the
 * interface. The two convenience wrappers mirror those overloads onto their own
 * methods (`createClient` in `src/client.ts`, `wrapModel` in `src/middleware.ts`)
 * and re-enter the SAME fold — see {@link PromptShorthand} and
 * {@link foldCallInput}; the fold is idempotent, so the boundary below stays the
 * one place that decides what a call's input shape means.
 */
import type { CommonCallOptions } from './types/config';
import type {
  GenerateObjectOptions,
  GenerateObjectResult,
  GenerateTextOptions,
  GenerateTextResult,
  StreamChatOptions,
  StreamChatResult,
  StreamObjectResult,
  DeepPartial,
} from './types/methods';
import type { StreamPart } from './types/stream';
import type { Usage, FinishReason } from './types/usage';
import { streamChat as streamChatImpl } from './inference/stream-chat';
import { generateText as generateTextImpl } from './inference/generate-text';
import { generateObject as generateObjectImpl } from './inference/generate-object';
import { streamObject as streamObjectImpl } from './inference/stream-object';
import { inputShapeError, resolveInputMessages } from './core/normalize';
import { fireRunFinish } from './core/metering';
import { withCapabilityOverride } from './internal/config-symbol';
import { attachClientContext, readClientContext } from './internal/client-context';
import { createDeferred } from './internal/async-iter';

/**
 * The `prompt` shorthand shape of a call's options: `prompt` REPLACES `messages`.
 *
 * `messages?: never` marks this overload as the prompt-ONLY shape, so a literal
 * carrying both never resolves here. The mutual exclusion itself is a RUNTIME
 * check ({@link canonicalize}): `prompt` is optional on `CommonCallOptions`, so
 * the canonical overload still structurally accepts both — and it has to, or
 * every wrapper that forwards a `CommonCallOptions`-typed value (`createClient`,
 * `wrapModel`) would stop compiling.
 *
 * Exported for `src/client.ts` and `src/middleware.ts` ONLY, so `DeuzClient` and
 * `WrappedModel` express the XOR with the SAME formulation instead of a second,
 * subtly different one. It is deliberately still absent from `src/index.ts`: the
 * overloads are the public surface, and a re-exported alias would be one more
 * permanent name on a ratcheted API.
 */
export type PromptShorthand<O> = Omit<O, 'messages' | 'prompt'> & {
  prompt: string;
  messages?: never;
};

type Canonical<O> = { ok: true; options: O } | { ok: false; error: unknown };

/**
 * Validate + canonicalize one call's options. Returns the failure instead of
 * throwing it: `streamChat`/`streamObject` must return synchronously (G2), so
 * each entry point decides how to surface it (rejection vs. error part) — the
 * same detect-here / decide-there split as Sprint 1's object-call guard.
 */
function canonicalize<O extends CommonCallOptions>(options: O, fn: string): Canonical<O> {
  const error = inputShapeError(options, fn);
  if (error) return { ok: false, error };
  const messages = resolveInputMessages(options);
  const model = withCapabilityOverride(options.model, options.capabilities);
  // FAST PATH: nothing to rewrite → forward the caller's own object, untouched.
  // This is not just about allocation. `createClient` stashes apiKeys/baseUrls on
  // a NON-ENUMERABLE Symbol (G1's lowest-precedence key source) and `{ ...options }`
  // copies only enumerable keys, so every re-spread is a chance to lose it.
  if (messages === options.messages && model === options.model) return { ok: true, options };
  const next = { ...options, messages, model } as O & { prompt?: string; instructions?: string };
  // Strip the shorthand once it is folded in: the forwarded options are now
  // `messages`-only, so re-entry (a middleware calling `next()` a second time,
  // a fail-over hop) can never trip the XOR guard on our own output.
  delete next.prompt;
  delete next.instructions;
  const clientContext = readClientContext(options);
  if (clientContext) attachClientContext(next, clientContext);
  return { ok: true, options: next };
}

/**
 * Run {@link canonicalize} at a SECOND entry point: `wrapModel`
 * (`src/middleware.ts`). A middleware sees the call options BEFORE the base
 * function does, and `MiddlewareCallOptions` promises a canonical `messages`
 * array — `redactPII` and `promptInjectionGuard` read it directly, so a
 * `{ prompt }` call would have died inside the chain instead of reaching the fold.
 *
 * Idempotent by construction: `canonicalize` strips the shorthand once it is
 * folded in, so the base function canonicalizing again takes the untouched fast
 * path. An INVALID shape is returned VERBATIM — the entry point still owns how
 * the failure surfaces (rejection vs. `error` part), which is the whole point of
 * the detect-here / decide-there split.
 */
export function foldCallInput<O extends CommonCallOptions>(options: O, fn: string): O {
  const call = canonicalize(options, fn);
  return call.ok ? call.options : options;
}

/** One canonical `error` part, then end-of-stream — exactly how the pump reports a failure. */
async function* errorPartStream(error: unknown): AsyncGenerator<StreamPart> {
  yield { type: 'error', error };
}

/** An async iterable that rejects on first pull (a failed broadcaster's behaviour). */
function rejectingIterable<T>(error: unknown): AsyncIterable<T> {
  return {
    [Symbol.asyncIterator]: (): AsyncIterator<T> => ({ next: () => Promise.reject(error) }),
  };
}

/**
 * A `StreamChatResult` that only reports `error` (G2). `streamChat` NEVER throws,
 * so an invalid input shape has to travel the documented failure path: an `error`
 * part on `fullStream`, a throwing `textStream`, rejected `usage`/`finishReason`.
 * The deferreds pre-attach a no-op catch, so awaiting only one of them cannot
 * raise an `unhandledRejection`.
 */
function failedStream(error: unknown): StreamChatResult {
  const usage = createDeferred<Usage>();
  const finishReason = createDeferred<FinishReason>();
  usage.reject(error);
  finishReason.reject(error);
  return {
    textStream: rejectingIterable<string>(error),
    fullStream: { [Symbol.asyncIterator]: () => errorPartStream(error) },
    usage: usage.promise,
    finishReason: finishReason.promise,
    // Never rejects; the failure is reported through `onError` (consume contract).
    consume: async (opts) => {
      opts?.onError?.(error);
    },
  };
}

/** The `streamObject` twin of {@link failedStream} — its partial stream REJECTS. */
function failedObjectStream<T>(error: unknown): StreamObjectResult<T> {
  const object = createDeferred<T>();
  const usage = createDeferred<Usage>();
  const finishReason = createDeferred<FinishReason>();
  object.reject(error);
  usage.reject(error);
  finishReason.reject(error);
  return {
    partialObjectStream: rejectingIterable<DeepPartial<T>>(error),
    object: object.promise,
    usage: usage.promise,
    finishReason: finishReason.promise,
    consume: async (opts) => {
      opts?.onError?.(error);
    },
  };
}

/**
 * Canonical streaming chat. Returns SYNCHRONOUSLY and never throws (G2); the
 * network pump starts lazily on first output access.
 *
 * ```ts
 * const res = streamChat({ model, prompt: 'Explain SSE in one sentence.' });
 * for await (const chunk of res.textStream) process.stdout.write(chunk);
 * ```
 *
 * `prompt` is shorthand for a single user turn and is MUTUALLY EXCLUSIVE with
 * `messages`; `instructions` is the system prompt and combines with either.
 */
export function streamChat(options: StreamChatOptions): StreamChatResult;
export function streamChat(options: PromptShorthand<StreamChatOptions>): StreamChatResult;
export function streamChat(
  options: StreamChatOptions | PromptShorthand<StreamChatOptions>,
): StreamChatResult {
  const call = canonicalize(options as StreamChatOptions, 'streamChat');
  return call.ok ? streamChatImpl(call.options) : failedStream(call.error);
}

/**
 * Non-streaming text generation (buffered). Accepts `prompt` OR `messages`; an
 * invalid pair REJECTS — this entry point is already async, so a caller that
 * awaits (or `.catch()`es) needs no extra try/catch.
 */
export function generateText(options: GenerateTextOptions): Promise<GenerateTextResult>;
export function generateText(
  options: PromptShorthand<GenerateTextOptions>,
): Promise<GenerateTextResult>;
export function generateText(
  options: GenerateTextOptions | PromptShorthand<GenerateTextOptions>,
): Promise<GenerateTextResult> {
  const call = canonicalize(options as GenerateTextOptions, 'generateText');
  if (!call.ok) return Promise.reject(call.error);
  return generateTextImpl(call.options).then((result) => {
    // G12 (1.9): the BUFFERED agentic loop (`inference/tool-loop.ts`) has no
    // terminal `fireFinish` of its own — until 1.9 the pump inside each STEP
    // fired one, so an N-step run delivered `onFinish` N times. The pump is now
    // silent for loop steps (see `core/inference.ts`), so the run's single firing
    // happens here, with the finishReason of the WHOLE run. `steps` is present
    // only on a loop result (`runToolLoop`'s `finish()`), never on the
    // single-turn shape whose own pump fired already. The streaming twin needs no
    // equivalent — `inference/stream-tool-loop.ts` fires its own.
    if (result.steps) {
      fireRunFinish(call.options, {
        model: call.options.model.modelId,
        finishReason: result.finishReason,
      });
    }
    return result;
  });
}

/** Structured output (buffered). Accepts `prompt` OR `messages`; an invalid pair rejects. */
export function generateObject<T = unknown>(
  options: GenerateObjectOptions<T>,
): Promise<GenerateObjectResult<T>>;
export function generateObject<T = unknown>(
  options: PromptShorthand<GenerateObjectOptions<T>>,
): Promise<GenerateObjectResult<T>>;
export function generateObject<T = unknown>(
  options: GenerateObjectOptions<T> | PromptShorthand<GenerateObjectOptions<T>>,
): Promise<GenerateObjectResult<T>> {
  const call = canonicalize(options as GenerateObjectOptions<T>, 'generateObject');
  return call.ok ? generateObjectImpl(call.options) : Promise.reject(call.error);
}

/**
 * Streaming structured output. Returns synchronously (G2), so an invalid
 * `prompt`/`messages` pair surfaces as a rejected `object`/`usage`/`finishReason`
 * and a rejecting `partialObjectStream` — never a synchronous throw.
 */
export function streamObject<T = unknown>(options: GenerateObjectOptions<T>): StreamObjectResult<T>;
export function streamObject<T = unknown>(
  options: PromptShorthand<GenerateObjectOptions<T>>,
): StreamObjectResult<T>;
export function streamObject<T = unknown>(
  options: GenerateObjectOptions<T> | PromptShorthand<GenerateObjectOptions<T>>,
): StreamObjectResult<T> {
  const call = canonicalize(options as GenerateObjectOptions<T>, 'streamObject');
  return call.ok ? streamObjectImpl(call.options) : failedObjectStream<T>(call.error);
}
