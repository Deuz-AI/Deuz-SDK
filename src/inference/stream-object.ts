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
import { toJSONSchema, validateOutput } from '../schema/bridge';
import { NoObjectGeneratedError } from '../errors';
import { pickObjectStrategy } from './object-shared';
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
  // Eager subscription BEFORE the lazy start so no part can be missed (G2).
  const sub = broadcaster.subscribe();

  let started = false;
  const ensureStarted = (): void => {
    if (started) return;
    started = true;
    void pump();
  };

  async function pump(): Promise<void> {
    try {
      // All async work (schema conversion included) stays inside the pump.
      const schema = await toJSONSchema(options.schema);
      const strategy = pickObjectStrategy(options, getCapabilities(options.model));
      const object: ObjectRequest = {
        schema,
        name: options.schemaName,
        description: options.schemaDescription,
        strategy,
      };
      const inner = runStream(options, { object });

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
  };
};
