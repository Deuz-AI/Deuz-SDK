import type { GenerateText, GenerateTextOptions, GenerateTextResult } from '../types/methods';
import { runOneStep } from './run-step';
import { runToolLoop } from './tool-loop';
import { runGenerateWithFallback } from '../internal/fallback';

/**
 * Non-streaming text generation. With `tools` it runs the agentic loop; without
 * tools it is a single buffered turn (identical to Faz 1). Both paths share the
 * same per-step accumulation (`runOneStep`). `chat` persistence (1.7) also
 * routes through the loop so every chat shape persists at the same boundaries.
 * `fallbackModels` (1.7, D6) wraps the call in fail-over.
 */
export const generateText: GenerateText = async (options): Promise<GenerateTextResult> => {
  if (options.fallbackModels && options.fallbackModels.length > 0) {
    const { fallbackModels, ...rest } = options;
    return runGenerateWithFallback(
      (o: GenerateTextOptions) => generateText(o),
      rest,
      fallbackModels,
    );
  }
  if (
    (options.tools && Object.keys(options.tools).length > 0) ||
    options.chat ||
    options.memory ||
    options.verifyStep ||
    // `doneWhen` (1.9, N2): the natural-completion boundary exists only inside
    // the loop, so a tool-less call has to be routed through it or the option
    // would be accepted and silently ignored.
    options.doneWhen
  ) {
    return runToolLoop(options);
  }

  const step = await runOneStep(options, { operation: 'generate-text' });
  return {
    text: step.text,
    usage: step.usage,
    finishReason: step.finishReason,
    // Non-fatal notices (1.9): omitted entirely when there are none, so a clean
    // call's result shape is byte-identical to 1.8.
    ...(step.warnings?.length ? { warnings: step.warnings } : {}),
    response: { messages: [step.assistantMessage] },
    ...(step.observation ? { observation: step.observation } : {}),
  };
};
