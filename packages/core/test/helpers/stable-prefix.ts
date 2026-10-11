/**
 * Prefix-diff harness for F22 (2.3): a scripted Claude Messages endpoint and
 * the check every stable-prefix test asserts with.
 *
 * Claude 5.x binds each thinking block to the conversation before it: the
 * top-level `system`, the `tools` array and every earlier message. So for two
 * consecutive requests N and N+1 of one conversation, N's system + tools +
 * messages, serialized, must be a BYTE PREFIX of N+1's. What may change is
 * everything else (`max_tokens`, `output_config.effort`, `tool_choice`,
 * `thinking`, headers) and what N+1 appends.
 */
import { createAnthropic } from '../../src/anthropic';
import { sseEvents, sseResponse } from '../../src/testing';
import type { LanguageModel } from '../../src/types/model';

/** One Anthropic request as the scripted endpoint received it. */
export interface ClaudeRequest {
  system?: unknown;
  tools?: Array<{ name: string; [key: string]: unknown }>;
  messages: Array<{ role: string; content: unknown }>;
  [key: string]: unknown;
}

export type Block =
  | { type: 'thinking'; text?: string; signature: string }
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input?: unknown };

/** One Messages SSE turn, block by block, as the API streams it. */
export function claudeTurn(
  blocks: Block[],
  stop = blocks.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn',
): string {
  const events: { event: string; data: unknown }[] = [
    {
      event: 'message_start',
      data: {
        type: 'message_start',
        message: { id: 'msg', role: 'assistant', usage: { input_tokens: 10, output_tokens: 1 } },
      },
    },
  ];
  const delta = (index: number, d: unknown) =>
    events.push({
      event: 'content_block_delta',
      data: { type: 'content_block_delta', index, delta: d },
    });
  blocks.forEach((block, index) => {
    const start = (content_block: unknown) =>
      events.push({
        event: 'content_block_start',
        data: { type: 'content_block_start', index, content_block },
      });
    if (block.type === 'thinking') {
      start({ type: 'thinking', thinking: '', signature: '' });
      if (block.text) delta(index, { type: 'thinking_delta', thinking: block.text });
      delta(index, { type: 'signature_delta', signature: block.signature });
    } else if (block.type === 'text') {
      start({ type: 'text', text: '' });
      delta(index, { type: 'text_delta', text: block.text });
    } else {
      start({ type: 'tool_use', id: block.id, name: block.name, input: {} });
      delta(index, { type: 'input_json_delta', partial_json: JSON.stringify(block.input ?? {}) });
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

/** A thinking turn (empty text, `display: 'omitted'`) that calls one tool. */
export function thinkThenCall(
  signature: string,
  id: string,
  name: string,
  input: unknown = {},
): string {
  return claudeTurn([
    { type: 'thinking', signature },
    { type: 'tool_use', id, name, input },
  ]);
}

/** A thinking turn that answers with text. */
export function thinkThenAnswer(signature: string, text: string): string {
  return claudeTurn([
    { type: 'thinking', signature },
    { type: 'text', text },
  ]);
}

/**
 * A scripted Claude endpoint: `respond` picks the turn for each request (by its
 * index, or by the request itself). Every request body is recorded, parsed.
 */
export function scriptedClaude(
  respond: string[] | ((request: ClaudeRequest, index: number) => string),
  modelId = 'claude-opus-5-5',
): {
  model: LanguageModel;
  /** Every request, in order. */
  requests: ClaudeRequest[];
  /** Every request's headers, in order. */
  headers: Array<Record<string, string>>;
  /** Builds the same model on the same endpoint (another `modelId` allowed). */
  model2(id: string): LanguageModel;
} {
  const requests: ClaudeRequest[] = [];
  const headers: Array<Record<string, string>> = [];
  const fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const request = JSON.parse(String(init!.body)) as ClaudeRequest;
    const index = requests.length;
    requests.push(request);
    headers.push((init!.headers ?? {}) as Record<string, string>);
    const turn = Array.isArray(respond)
      ? respond[Math.min(index, respond.length - 1)]!
      : respond(request, index);
    return sseResponse([turn]);
  }) as typeof globalThis.fetch;
  const provider = createAnthropic({ apiKey: 'k', fetch });
  return { model: provider(modelId), requests, headers, model2: (id) => provider(id) };
}

/** The part of a request a thinking block is bound to, one string per element. */
function boundPrefix(request: ClaudeRequest): string[] {
  return [
    `system ${JSON.stringify(request.system ?? null)}`,
    `tools ${JSON.stringify(request.tools ?? null)}`,
    ...request.messages.map((m, i) => `messages[${i}] ${JSON.stringify(m)}`),
  ];
}

/**
 * Where request `next` stops extending request `prev`: `undefined` when prev's
 * system + tools + messages, serialized, are a byte prefix of next's, else a
 * description of the first element that differs.
 */
export function prefixBreak(prev: ClaudeRequest, next: ClaudeRequest): string | undefined {
  const a = boundPrefix(prev);
  const b = boundPrefix(next);
  if (b.join('\n').startsWith(a.join('\n'))) return undefined;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) {
      return `${a[i]!.split(' ')[0]} changed:\n  before: ${a[i]}\n  after:  ${b[i] ?? '(missing)'}`;
    }
  }
  return 'request shrank';
}

/** Every break across a sequence of requests of ONE conversation (empty: stable throughout). */
export function prefixBreaks(requests: ClaudeRequest[]): string[] {
  const breaks: string[] = [];
  for (let i = 1; i < requests.length; i++) {
    const hit = prefixBreak(requests[i - 1]!, requests[i]!);
    if (hit) breaks.push(`request ${i - 1} -> ${i}: ${hit}`);
  }
  return breaks;
}

/** True when the request sends any thinking block back. */
export function replaysThinking(request: ClaudeRequest): boolean {
  return request.messages.some(
    (m) =>
      m.role === 'assistant' &&
      Array.isArray(m.content) &&
      (m.content as Array<{ type: string }>).some((b) => b.type === 'thinking'),
  );
}
