import type { GenerateText, GenerateTextResult } from '../types/methods';
import { runOneStep } from './run-step';
import { runToolLoop } from './tool-loop';

/**
 * Non-streaming text generation. With `tools` it runs the agentic loop; without
 * tools it is a single buffered turn (identical to Faz 1). Both paths share the
 * same per-step accumulation (`runOneStep`).
 */
export const generateText: GenerateText = async (options): Promise<GenerateTextResult> => {
  if (options.tools && Object.keys(options.tools).length > 0) {
    return runToolLoop(options);
  }

  const step = await runOneStep(options, { operation: 'generate-text' });
  return {
    text: step.text,
    usage: step.usage,
    finishReason: step.finishReason,
    response: { messages: [step.assistantMessage] },
  };
};
