import type { ModelCapabilities } from '../core/registry';
import type { LanguageModel } from '../types/model';
import type { CommonCallOptions } from '../types/config';

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
