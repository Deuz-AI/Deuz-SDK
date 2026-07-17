import type { GenerateText, GenerateTextResult } from '../types/methods';
import { runOneStep } from './run-step';
import { runToolLoop } from './tool-loop';

/**
 * Non-streaming text generation. With `tools` it runs the agentic loop; without
 * tools it is a single buffered turn (identical to Faz 1). Both paths share the
 * same per-step accumulation (`runOneStep`). `chat` persistence (1.7) also
 * routes through the loop so every chat shape persists at the same boundaries.
 */
export const generateText: GenerateText = async (options): Promise<GenerateTextResult> => {
  if ((options.tools && Object.keys(options.tools).length > 0) || options.chat) {
    return runToolLoop(options);
  }

  const step = await runOneStep(options, { operation: 'generate-text' });
  return {
    text: step.text,
    usage: step.usage,
    finishReason: step.finishReason,
    response: { messages: [step.assistantMessage] },
    ...(step.observation ? { observation: step.observation } : {}),
  };
};
