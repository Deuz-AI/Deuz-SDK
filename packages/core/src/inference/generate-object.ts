import type {
  GenerateObject,
  GenerateObjectOptions,
  GenerateObjectResult,
  StreamChatResult,
} from '../types/methods';
import type { ObjectRequest } from '../adapters/types';
import { runStream } from '../core/inference';
import { getCapabilities } from '../core/registry';
import { createWarningSink } from '../internal/warnings';
import { resolveDependencies } from '../internal/resolve-deps';
import { toJSONSchema, validateOutput } from '../schema/bridge';
import { NoObjectGeneratedError } from '../errors';
import { assertNoLoopOptions, loopOptionsError, pickObjectStrategy } from './object-shared';

/** Collect the object payload: JSON text (json mode) or first tool-call args. */
async function collect(result: StreamChatResult, strategy: 'json' | 'tool'): Promise<string> {
  let text = '';
  const toolArgs = new Map<string, string>();
  let firstToolId: string | undefined;
  for await (const part of result.fullStream) {
    if (part.type === 'text-delta') {
      text += part.text;
    } else if (part.type === 'tool-call-delta') {
      if (firstToolId === undefined) firstToolId = part.id;
      toolArgs.set(part.id, (toolArgs.get(part.id) ?? '') + part.argsTextDelta);
    } else if (part.type === 'error') {
      throw part.error;
    }
  }
  if (strategy === 'tool')
    return firstToolId !== undefined ? (toolArgs.get(firstToolId) ?? '') : '';
  return text;
}

export const generateObject: GenerateObject = async <T = unknown>(
  options: GenerateObjectOptions<T>,
): Promise<GenerateObjectResult<T>> => {
  // 1.9: fail LOUD on loop options this call cannot honour — they used to be
  // dropped in silence (the tools never reached the wire). `generateObject` is
  // async, so a throw here is a rejected promise, before any network work.
  const ignored = assertNoLoopOptions(options, 'generateObject');
  if (ignored.length > 0) throw loopOptionsError(ignored, 'generateObject');

  const schema = await toJSONSchema(options.schema);
  // ONE sink across every repair attempt (1.9): a repair is a second run of the
  // SAME call, so the caller should see one set of notices, not one per attempt.
  const warnings = createWarningSink(resolveDependencies(options.deps).logger);
  const caps = getCapabilities(options.model, undefined, undefined, warnings);

  const strategy = pickObjectStrategy(options, caps);

  const object: ObjectRequest = {
    schema,
    name: options.schemaName,
    description: options.schemaDescription,
    strategy,
  };

  const maxAttempts = 2; // initial + one repair retry
  let lastRaw = '';
  let lastError: unknown;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    // Observation: each repair attempt is its own run (rare; honest timeline).
    const result = runStream(options, { object, operation: 'generate-object', warnings });
    const raw = await collect(result, strategy); // throws on hard transport error
    const usage = await result.usage;
    const finishReason = await result.finishReason;
    lastRaw = raw;

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      lastError = err;
      continue;
    }
    const validation = await validateOutput<T>(options.schema, parsed);
    if (validation.ok) {
      return {
        object: validation.value,
        usage,
        finishReason,
        ...(warnings.list().length ? { warnings: warnings.list() } : {}),
      };
    }
    lastError = new Error(validation.issues);
  }

  throw new NoObjectGeneratedError(
    `generateObject could not produce a valid object after ${maxAttempts} attempts.`,
    { text: lastRaw, cause: lastError },
  );
};
