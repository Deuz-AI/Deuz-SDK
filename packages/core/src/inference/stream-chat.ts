import type { StreamChat } from '../types/methods';
import { runStream } from '../core/inference';
import { runStreamToolLoop } from './stream-tool-loop';

/**
 * Canonical streaming chat. Returns synchronously; the pump starts lazily. With
 * `tools` it runs the streaming agentic loop (one `fullStream` across N steps);
 * without tools it is the single-turn Faz 1 stream. `chat` persistence (1.7)
 * also routes through the loop so every chat shape persists at the same
 * terminal boundaries (step parts appear on the stream — documented).
 */
export const streamChat: StreamChat = (options) =>
  (options.tools && Object.keys(options.tools).length > 0) || options.chat || options.memory
    ? runStreamToolLoop(options)
    : runStream(options);
