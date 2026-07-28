import type { ModelCapabilities } from '../core/registry';
import type { LanguageModel } from '../types/model';
import type { CommonCallOptions } from '../types/config';
import { InvalidRequestError } from '../errors';

/** The slice of the object-call options that strategy selection reads. */
export interface ObjectStrategyOptions {
  model: LanguageModel;
  mode?: 'auto' | 'json' | 'tool';
  effort?: CommonCallOptions['effort'];
}

/** Pick json vs tool coercion for structured output (shared by generateObject/streamObject). */
export function pickObjectStrategy(
  options: ObjectStrategyOptions,
  caps: ModelCapabilities,
): 'json' | 'tool' {
  const requested = options.mode ?? 'auto';
  let strategy: 'json' | 'tool' =
    requested === 'json'
      ? 'json'
      : requested === 'tool'
        ? 'tool'
        : caps.structuredOutput
          ? 'json'
          : 'tool';

  // G3: Anthropic rejects forced tool_choice while extended thinking is enabled
  // (HTTP 400) → never pick the tool strategy in that case; use native json mode.
  // Adaptive-thinking models (effortWire 'output_config') can't disable thinking,
  // so they always take the json strategy.
  const thinkingOn =
    caps.effortWire === 'output_config' ||
    (caps.reasoning && options.effort !== undefined && options.effort !== 'none');
  if (strategy === 'tool' && options.model.provider === 'anthropic' && thinkingOn) {
    strategy = 'json';
  }

  return strategy;
}

/**
 * Agentic-loop / orchestration options a structured-output call CANNOT honour.
 * `generateObject`/`streamObject` call `runStream` DIRECTLY — they never enter
 * the tool loop — so nothing reads any key below and, until 1.9, they were
 * dropped in silence (a `generateObject({ …, tools })` compiled, ran, and never
 * sent the tools). Order is `CommonCallOptions` declaration order so the error
 * message is deterministic.
 *
 * Deliberately ABSENT because an object call DOES honour them (verified against
 * generate-object.ts / stream-object.ts / core/inference.ts + the four
 * adapters): `signal`, `maxRetries`, `headers`, `deps`, `onUsage`, `onFinish`,
 * `temperature`, `maxOutputTokens`, `topP`, `stopSequences`, `effort`,
 * `responseFormat`, `providerOptions`, `promptCaching`, and `agentPath`
 * (observation correlation + usage metering). A false positive here would break
 * working code — worse than the bug this guard fixes.
 */
const IGNORED_OBJECT_OPTIONS = [
  'tools',
  'toolChoice',
  'maxSteps',
  'stopWhen',
  'budget',
  'maxToolConcurrency',
  'onStepFinish',
  'prepareStep',
  'activeTools',
  'verifyStep',
  'maxVerifyAttempts',
  'compaction',
  'approveToolCall',
  'approvalResponses',
  'session',
  'chat',
  'memory',
  'fallbackModels',
  'approvalSigner',
  'approvalMaxAgeMs',
] as const satisfies readonly (keyof CommonCallOptions)[];

/** Keys whose EMPTY value asks for nothing (a generic wrapper spreading `tools: {}` is not a bug). */
const EMPTY_RECORD_KEYS = new Set<string>(['tools', 'budget']);

/**
 * Did the caller actually ASK for this option? `undefined` (generic wrappers
 * forward absent keys as `undefined`), an empty collection, and `maxSteps: 1`
 * (already exactly what a single-turn object call does) are not requests.
 * Emptiness is checked per key — never via `Object.keys` on an arbitrary value,
 * since `session`/`chat`/`memory`/`approvalSigner` may be class instances whose
 * members live on the prototype.
 */
function isRequested(key: string, value: unknown): boolean {
  if (value === undefined) return false;
  if (key === 'maxSteps') return typeof value === 'number' && value > 1;
  if (Array.isArray(value)) return value.length > 0;
  if (EMPTY_RECORD_KEYS.has(key)) {
    return typeof value === 'object' && value !== null && Object.keys(value).length > 0;
  }
  return true;
}

/**
 * Detect loop options a structured-output call would silently ignore. Returns
 * the ignored keys that are actually present (empty array when clean).
 *
 * It DETECTS and never throws: `streamObject` must return synchronously (G2), so
 * only `generateObject` may turn the result into a throw. Both callers build the
 * message with {@link loopOptionsError} so the wording stays identical.
 *
 * The public `GenerateObjectOptions` still structurally extends
 * `CommonCallOptions` on purpose — removing inherited fields from an exported
 * interface is a BREAKING type change and the 1.0 surface is locked, so this is
 * enforced at RUNTIME only.
 */
export function assertNoLoopOptions(
  options: CommonCallOptions,
  // The entry-point name is part of the seam (both call sites name themselves,
  // and the ignored set may diverge later) — detection itself is fn-independent.
  _fn: 'generateObject' | 'streamObject',
): string[] {
  const bag = options as unknown as Record<string, unknown>;
  return IGNORED_OBJECT_OPTIONS.filter((key) => isRequested(key, bag[key]));
}

/** The single wording for the ignored-options failure (shared by both entry points). */
export function loopOptionsError(
  keys: readonly string[],
  fn: 'generateObject' | 'streamObject',
): InvalidRequestError {
  return new InvalidRequestError({
    message:
      `${fn} cannot honour these agentic-loop options and would otherwise ignore them ` +
      `silently: ${keys.join(', ')}. Structured output is a single-turn call — drop these ` +
      `options, or use generateText/streamChat if you need the tool loop.`,
  });
}
