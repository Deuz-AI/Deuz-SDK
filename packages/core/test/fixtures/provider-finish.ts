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
  /** A refusal content part: its `response.refusal.delta` pieces. */
  refusal?: string[];
  /** The text `response.refusal.done` finalizes; absent: the pieces joined. */
  refusalDone?: string;
  /** The refusal message item's `phase`. */
  phase?: string;
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
  if (turn.refusal) {
    const message = {
      type: 'message',
      id: 'msg_2',
      role: 'assistant',
      ...(turn.phase !== undefined ? { phase: turn.phase } : {}),
    };
    const at = { item_id: 'msg_2', output_index: output, content_index: 0 };
    push('response.output_item.added', {
      output_index: output,
      item: { ...message, status: 'in_progress', content: [] },
    });
    push('response.content_part.added', { ...at, part: { type: 'refusal', refusal: '' } });
    for (const delta of turn.refusal) push('response.refusal.delta', { ...at, delta });
    const refusal = turn.refusalDone ?? turn.refusal.join('');
    push('response.refusal.done', { ...at, refusal });
    push('response.content_part.done', { ...at, part: { type: 'refusal', refusal } });
    push('response.output_item.done', {
      output_index: output++,
      item: { ...message, status: 'completed', content: [{ type: 'refusal', refusal }] },
    });
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

/** What one streamed Chat Completions turn carries, in this order. */
export interface ChatTurn {
  /** `delta.content` text. */
  text?: string;
  /** `delta.refusal` pieces. */
  refusal?: string[];
  /** A `get_weather` tool call and its (possibly cut-off) argument text. */
  call?: { args: string };
  /** The last choice's `finish_reason`. */
  finish: string;
}

/**
 * One streamed Chat Completions turn (openai 7.32 `ChatCompletionChunk`). The
 * content deltas carry `refusal: null`, which the type allows; the usage chunk
 * comes last (`stream_options.include_usage`).
 */
export function chatTurn(turn: ChatTurn): string {
  const chunk = (choices: unknown[], extra: Record<string, unknown> = {}) => ({
    data: { id: 'chatcmpl-1', object: 'chat.completion.chunk', created: 0, choices, ...extra },
  });
  const delta = (value: Record<string, unknown>, finish_reason: string | null = null) =>
    chunk([{ index: 0, delta: value, finish_reason }]);
  const events: { data: unknown }[] = [delta({ role: 'assistant', content: '', refusal: null })];
  if (turn.text !== undefined) events.push(delta({ content: turn.text, refusal: null }));
  for (const refusal of turn.refusal ?? []) events.push(delta({ refusal }));
  if (turn.call) {
    const fn = { name: 'get_weather', arguments: '' };
    events.push(
      delta({ tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: fn }] }),
    );
    events.push(delta({ tool_calls: [{ index: 0, function: { arguments: turn.call.args } }] }));
  }
  events.push(delta({}, turn.finish));
  events.push(chunk([], { usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }), {
    data: '[DONE]',
  });
  return sseEvents(events);
}
