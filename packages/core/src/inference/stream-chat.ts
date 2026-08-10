import type { StreamChat, StreamChatOptions, StreamChatResult } from '../types/methods';
import { runStream } from '../core/inference';
import { runStreamToolLoop } from './stream-tool-loop';
import { runStreamWithFallback } from '../internal/fallback';

const dispatch = (options: StreamChatOptions): StreamChatResult =>
  (options.tools && Object.keys(options.tools).length > 0) ||
  options.chat ||
  options.memory ||
  options.verifyStep ||
  // `doneWhen` (1.9, N2) fires at the natural-completion boundary, which only
  // the loop has — routing a tool-less call here is what keeps the option from
  // being silently ignored.
  options.doneWhen ||
  // Guardrails (2.0) hang off loop boundaries the single-turn stream does not
  // have (the pre-run input hook, the natural-completion output hook), so a
  // tool-less guarded call routes here — an accepted-but-inert safety control is
  // the worst possible outcome for this option.
  options.guardrails ||
  // Zero-config MCP (2.0): the servers' tools ARE the tool set, so a call whose
  // only tools are remote still belongs in the loop.
  (options.mcp?.length ?? 0) > 0
    ? runStreamToolLoop(options)
    : runStream(options);

/**
 * Canonical streaming chat. Returns synchronously; the pump starts lazily. With
 * `tools` it runs the streaming agentic loop (one `fullStream` across N steps);
 * without tools it is the single-turn Faz 1 stream. `chat` persistence (1.7)
 * also routes through the loop so every chat shape persists at the same
 * terminal boundaries (step parts appear on the stream — documented).
 * `fallbackModels` (1.7, D6) wraps the dispatch in pre-first-byte fail-over.
 */
export const streamChat: StreamChat = (options) => {
  if (options.fallbackModels && options.fallbackModels.length > 0) {
    const { fallbackModels, ...rest } = options;
    return runStreamWithFallback(dispatch, rest, fallbackModels);
  }
  return dispatch(options);
};
