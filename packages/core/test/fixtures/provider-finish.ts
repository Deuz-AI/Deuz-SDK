/**
 * Scripted stops for the provider finish-reason tests (2.3, K4). The wire
 * shapes come from the official packages' type definitions: `@google/genai`
 * 2.28.0 (`FinishReason`, `GenerateContentResponse`) and `openai` 7.32.0
 * (`ChatCompletionChunk`, the Responses stream events). Not live-verified.
 */
import type { FinishReason } from '../../src/types/usage';
import { sseEvents } from './sse';

/**
 * Every value of `@google/genai` 2.28's `FinishReason`, with the finish reason
 * a turn that ends on it gets in Deuz.
 */
export const GEMINI_FINISH_REASONS: readonly (readonly [string, FinishReason])[] = [
  ['FINISH_REASON_UNSPECIFIED', 'stop'],
  ['STOP', 'stop'],
  ['MAX_TOKENS', 'length'],
  ['CONTINUATION', 'length'],
  ['SAFETY', 'content_filter'],
  ['RECITATION', 'content_filter'],
  ['BLOCKLIST', 'content_filter'],
  ['PROHIBITED_CONTENT', 'content_filter'],
  ['SPII', 'content_filter'],
  ['IMAGE_SAFETY', 'content_filter'],
  ['IMAGE_PROHIBITED_CONTENT', 'content_filter'],
  ['IMAGE_RECITATION', 'content_filter'],
  ['LANGUAGE', 'error'],
  ['OTHER', 'error'],
  ['MALFORMED_FUNCTION_CALL', 'error'],
  ['UNEXPECTED_TOOL_CALL', 'error'],
  ['TOO_MANY_TOOL_CALLS', 'error'],
  ['NO_IMAGE', 'error'],
  ['IMAGE_OTHER', 'error'],
];

/** A Gemini part that calls `get_weather`, complete as the Gemini API sends it. */
export const GEMINI_CALL = { functionCall: { name: 'get_weather', args: { city: 'Rome' } } };

/**
 * One streamed Gemini turn: `parts` in a first chunk, then a final chunk that
 * ends with `finishReason` (with no content, as a filtered stream ends).
 */
export function geminiTurn(finishReason: string, parts: unknown[] = [{ text: 'Partial' }]): string {
  return sseEvents([
    { data: { candidates: [{ content: { role: 'model', parts } }] } },
    {
      data: {
        candidates: [{ content: { role: 'model', parts: [] }, finishReason }],
        usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 2, totalTokenCount: 6 },
      },
    },
  ]);
}
