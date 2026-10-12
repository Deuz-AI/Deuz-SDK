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

/** What one streamed Responses turn carries, in this order. */
export interface ResponsesTurn {
  /** `response.output_text.delta` text. */
  text?: string;
  /** A `get_weather` function call and its (possibly cut-off) argument text. */
  call?: { args: string };
  /** `incomplete_details.reason` of a final `response.incomplete`; absent: `response.completed`. */
  incomplete?: string;
}

/** One streamed OpenAI Responses turn (openai 7.32 `ResponseStreamEvent` shapes). */
export function responsesTurn(turn: ResponsesTurn): string {
  const events: { event: string; data: Record<string, unknown> }[] = [];
  const push = (type: string, data: Record<string, unknown>): void => {
    events.push({ event: type, data: { type, sequence_number: events.length, ...data } });
  };
  let output = 0;
  if (turn.text !== undefined) {
    const at = { item_id: 'msg_1', output_index: output++, content_index: 0 };
    push('response.output_text.delta', { ...at, delta: turn.text });
  }
  if (turn.call) {
    const item = { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'get_weather' };
    push('response.output_item.added', {
      output_index: output,
      item: { ...item, arguments: '', status: 'in_progress' },
    });
    push('response.function_call_arguments.delta', {
      item_id: 'fc_1',
      output_index: output++,
      delta: turn.call.args,
    });
  }
  const status = turn.incomplete !== undefined ? 'incomplete' : 'completed';
  push(`response.${status}`, {
    response: {
      status,
      incomplete_details: turn.incomplete !== undefined ? { reason: turn.incomplete } : null,
      usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
    },
  });
  return sseEvents(events);
}
