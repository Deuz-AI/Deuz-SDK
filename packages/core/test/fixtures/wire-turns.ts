/**
 * Scripted provider turns for the 2.3 native chat / memory / fallback tests:
 * Anthropic Messages turns built block by block (thinking, redacted thinking,
 * text, tool_use) and OpenAI Chat Completions turns, plus a fetch that records
 * every request body and answers from a script (a turn, a Response factory, or
 * a thrown network error).
 */
import { sseEvents, sseResponse } from './sse';

export type ClaudeBlock =
  | { type: 'thinking'; text?: string; signature: string }
  | { type: 'redacted_thinking'; data: string }
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; json: string };

/** One Anthropic Messages SSE turn of `blocks`, ending with `stop`. */
export function claudeTurn(blocks: ClaudeBlock[], stop = 'end_turn'): string {
  const events: { event: string; data: unknown }[] = [
    {
      event: 'message_start',
      data: { type: 'message_start', message: { usage: { input_tokens: 10, output_tokens: 1 } } },
    },
  ];
  blocks.forEach((block, index) => {
    const start = (content_block: unknown) =>
      events.push({
        event: 'content_block_start',
        data: { type: 'content_block_start', index, content_block },
      });
    const delta = (value: unknown) =>
      events.push({
        event: 'content_block_delta',
        data: { type: 'content_block_delta', index, delta: value },
      });
    if (block.type === 'thinking') {
      start({ type: 'thinking', thinking: '', signature: '' });
      if (block.text) delta({ type: 'thinking_delta', thinking: block.text });
      delta({ type: 'signature_delta', signature: block.signature });
    } else if (block.type === 'redacted_thinking') {
      start({ type: 'redacted_thinking', data: block.data });
    } else if (block.type === 'text') {
      start({ type: 'text', text: '' });
      delta({ type: 'text_delta', text: block.text });
    } else {
      start({ type: 'tool_use', id: block.id, name: block.name, input: {} });
      delta({ type: 'input_json_delta', partial_json: block.json });
    }
    events.push({ event: 'content_block_stop', data: { type: 'content_block_stop', index } });
  });
  events.push({
    event: 'message_delta',
    data: { type: 'message_delta', delta: { stop_reason: stop }, usage: { output_tokens: 5 } },
  });
  events.push({ event: 'message_stop', data: { type: 'message_stop' } });
  return sseEvents(events);
}

/** One OpenAI Chat Completions SSE turn: optional text, optional tool calls. */
export function openaiTurn(
  turn: { text?: string; toolCalls?: { id: string; name: string; json: string }[] },
  usage = { prompt_tokens: 8, completion_tokens: 4 },
): string {
  const events: { data: unknown }[] = [];
  if (turn.text)
    events.push({
      data: { choices: [{ index: 0, delta: { content: turn.text }, finish_reason: null }] },
    });
  (turn.toolCalls ?? []).forEach((call, index) => {
    events.push({
      data: {
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index,
                  id: call.id,
                  type: 'function',
                  function: { name: call.name, arguments: call.json },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      },
    });
  });
  events.push({
    data: {
      choices: [
        { index: 0, delta: {}, finish_reason: turn.toolCalls?.length ? 'tool_calls' : 'stop' },
      ],
    },
  });
  events.push({
    data: {
      choices: [],
      usage: { ...usage, total_tokens: usage.prompt_tokens + usage.completion_tokens },
    },
  });
  events.push({ data: '[DONE]' });
  return sseEvents(events);
}

/** A provider-side failure an attempt can answer with. */
export const overloaded = (): Response =>
  new Response(
    JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: 'overloaded' } }),
    { status: 529, headers: { 'content-type': 'application/json' } },
  );
export const serverError = (): Response =>
  new Response(JSON.stringify({ error: { message: 'upstream died', type: 'server_error' } }), {
    status: 500,
    headers: { 'content-type': 'application/json' },
  });
export const badRequest = (): Response =>
  new Response(
    JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'bad' } }),
    { status: 400, headers: { 'content-type': 'application/json' } },
  );

export type ScriptStep = string | (() => Response) | { throws: unknown };

/**
 * A `fetch` that answers call N with `script[N]` (the last repeats) and keeps
 * every request body, parsed.
 */
export function scriptedFetch(script: ScriptStep[]) {
  const bodies: Record<string, unknown>[] = [];
  let index = 0;
  const fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    const step = script[Math.min(index, script.length - 1)]!;
    index += 1;
    if (typeof step === 'string') return sseResponse([step]);
    if (typeof step === 'function') return step();
    throw step.throws;
  }) as typeof globalThis.fetch;
  return { fetch, bodies, calls: () => bodies.length };
}
