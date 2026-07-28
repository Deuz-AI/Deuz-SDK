import type {
  GenerateObjectOptions,
  StreamObject,
  StreamObjectResult,
  DeepPartial,
} from '../types/methods';
import type { Usage, FinishReason } from '../types/usage';
import type { ObjectRequest } from '../adapters/types';
import { runStream } from '../core/inference';
import { getCapabilities } from '../core/registry';
import { createWarningSink } from '../internal/warnings';
import { resolveDependencies } from '../internal/resolve-deps';
import type { CallWarning } from '../types/methods';
import { toJSONSchema, validateOutput } from '../schema/bridge';
import { NoObjectGeneratedError } from '../errors';
import { assertNoLoopOptions, loopOptionsError, pickObjectStrategy } from './object-shared';
import { parsePartialJson } from '../internal/partial-json';
import { createBroadcaster, createDeferred, lazyAsyncIterable } from '../internal/async-iter';

/**
 * Streaming structured output. Mirrors `runStream`'s G2 shell: returns
 * synchronously, starts the network pump lazily on first output access, and
 * surfaces every failure as a rejection — never a synchronous throw.
 *
 * json strategy streams best-effort partials (tolerant partial-JSON parse per
 * text-delta, emitting only when the value changes); tool-strategy models
 * buffer and emit the final validated object once. Unlike `generateObject`
 * there is NO repair retry — emitted partials cannot be un-streamed.
 */
export const streamObject: StreamObject = <T = unknown>(
  options: GenerateObjectOptions<T>,
): StreamObjectResult<T> => {
  const broadcaster = createBroadcaster<DeepPartial<T>>();
  const objectDeferred = createDeferred<T>();
  const usageDeferred = createDeferred<Usage>();
  const finishDeferred = createDeferred<FinishReason>();
  const warningsDeferred = createDeferred<CallWarning[]>();
  const warningSink = createWarningSink(resolveDependencies(options.deps).logger);
  // Eager subscription BEFORE the lazy start so no part can be missed (G2).
  const sub = broadcaster.subscribe();

  let started = false;
  // 1.9 (consume): the pump promise, so a drain can await the terminal work
  // that follows the last partial (usage/finishReason settlement, validation).
  let pumpDone: Promise<void> | undefined;
  const ensureStarted = (): void => {
    if (started) return;
    started = true;
    // pump() catches everything internally; the extra catch keeps consume()'s
    // await unrejectable (G2 never-throw).
    pumpDone = pump().catch(() => {});
  };

  async function pump(): Promise<void> {
    try {
      // 1.9: loop options this call cannot honour used to be dropped in silence.
      // The check lives INSIDE the pump so the failure travels the existing G2
      // path (error part on the partial stream + rejected object/usage/finish) —
      // `streamObject` itself must never throw synchronously.
      const ignored = assertNoLoopOptions(options, 'streamObject');
      if (ignored.length > 0) throw loopOptionsError(ignored, 'streamObject');

      // All async work (schema conversion included) stays inside the pump.
      const schema = await toJSONSchema(options.schema);
      const strategy = pickObjectStrategy(
        options,
        getCapabilities(options.model, undefined, undefined, warningSink),
      );
      const object: ObjectRequest = {
        schema,
        name: options.schemaName,
        description: options.schemaDescription,
        strategy,
      };
      const inner = runStream(options, {
        object,
        operation: 'stream-object',
        warnings: warningSink,
      });

      let buf = '';
      let lastJson: string | undefined;
      const toolArgs = new Map<string, string>();
      let firstToolId: string | undefined;

      for await (const part of inner.fullStream) {
        if (part.type === 'text-delta' && strategy === 'json') {
          buf += part.text;
          const parsed = parsePartialJson(buf);
          if (parsed !== undefined) {
            const json = JSON.stringify(parsed.value);
            if (json !== lastJson) {
              lastJson = json;
              broadcaster.push(parsed.value as DeepPartial<T>);
            }
          }
        } else if (part.type === 'tool-call-delta' && strategy === 'tool') {
          if (firstToolId === undefined) firstToolId = part.id;
          toolArgs.set(part.id, (toolArgs.get(part.id) ?? '') + part.argsTextDelta);
        } else if (part.type === 'error') {
          throw part.error;
        }
      }

      if (strategy === 'tool') {
        buf = firstToolId !== undefined ? (toolArgs.get(firstToolId) ?? '') : '';
      }

      // Resolve BEFORE parse/validation — the tokens were spent either way,
      // so usage/finishReason survive a NoObjectGeneratedError.
      usageDeferred.resolve(await inner.usage);
      finishDeferred.resolve(await inner.finishReason);
      warningsDeferred.resolve(warningSink.list());

      let parsed: unknown;
      try {
        parsed = JSON.parse(buf);
      } catch (err) {
        throw new NoObjectGeneratedError('streamObject: final payload is not valid JSON.', {
          text: buf,
          cause: err,
        });
      }
      const validation = await validateOutput<T>(options.schema, parsed);
      if (!validation.ok) {
        throw new NoObjectGeneratedError('streamObject: final object failed schema validation.', {
          text: buf,
          cause: new Error(validation.issues),
        });
      }

      if (strategy === 'tool') {
        // Buffered path: single emission of the validated object.
        broadcaster.push(validation.value as DeepPartial<T>);
      }
      objectDeferred.resolve(validation.value);
      broadcaster.close();
    } catch (err) {
      // Deferreds settle once — rejecting after resolve is a no-op, so this
      // catch handles both transport failures and validation failures.
      objectDeferred.reject(err);
      usageDeferred.reject(err);
      finishDeferred.reject(err);
      // fail(), not close(): consumers of the partial stream must see the
      // failure, not a clean end-of-stream.
      broadcaster.fail(err);
    }
  }

  /**
   * `consume()` (1.9) — same contract as `StreamChatResult.consume`: the pump is
   * lazy (G2), so a result nobody pulls never reaches its terminal boundary
   * (`onUsage`/`onFinish` never fire). Drains through its OWN subscription so a
   * caller iterating `partialObjectStream` loses nothing, is memoized, and NEVER
   * rejects — failures (transport AND final-validation) go to `onError`.
   *
   * Unlike the chat pumps this broadcaster is `fail()`ed rather than closed, so
   * even a subscription taken after the failure re-raises it — no deferred
   * fallback needed here.
   */
  let drain: Promise<{ error: unknown } | undefined> | undefined;
  const consume = (consumeOptions?: { onError?: (error: unknown) => void }): Promise<void> => {
    drain ??= (async () => {
      const own = broadcaster.subscribe();
      ensureStarted();
      let failure: { error: unknown } | undefined;
      try {
        for await (const value of own) void value;
      } catch (err) {
        failure = { error: err };
      }
      try {
        await pumpDone;
      } catch {
        // unreachable (pump never rejects) — the contract holds regardless
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
  };

  return {
    partialObjectStream: lazyAsyncIterable(() => sub, ensureStarted),
    get object() {
      ensureStarted();
      return objectDeferred.promise;
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
    // A plain method, never a getter: reading it must not start the pump (G2).
    consume,
  };
};
