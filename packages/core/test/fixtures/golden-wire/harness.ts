/**
 * Golden wire capture (2.4, W0A): a recording `fetch`, deterministic
 * dependencies and scripted provider answers, so a scenario sends the same
 * requests on every run. `golden-wire.test.ts` replays every scenario of
 * `scenarios.ts` against the fixtures recorded from 2.3.0.
 *
 * The provider answers are written out here on purpose instead of reusing the
 * shared test fixtures: an answer decides what the next request of a tool round
 * replays, so a change to a shared fixture must never move a golden request.
 */
import { sseEvents, sseResponse } from '../../../src/testing';
import type { Dependencies } from '../../../src/types/deps';

/** One captured HTTP request, as the fixture files store it. */
export interface WireRequest {
  method: string;
  /** The full URL: scheme, host, path and query. */
  url: string;
  /** Every header, sorted by name; the test keys read `<secret>` (see {@link SECRET}). */
  headers: Record<string, string>;
  /** The body exactly as sent (the bytes of the JSON text), or null without one. */
  body: string | null;
}

/**
 * One request as a fixture file stores it. A JSON body is kept as its value
 * (`json`), so the file stays readable: the bytes 2.3.0 sent were checked at
 * recording time to be exactly `JSON.stringify(json)`, and the test compares
 * the bytes sent now against that text. A body that is not such canonical JSON
 * would be kept verbatim in `bodyText`; no request without a body is captured.
 */
export interface FixtureRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  json?: unknown;
  bodyText?: string;
}

/** A fixture file under `<release>/`. */
export interface GoldenFixture {
  scenario: string;
  /** The release whose code wrote the file. */
  recordedFrom: string;
  requests: FixtureRequest[];
}

/** The fixture form of a captured request. */
export function toFixtureRequest(request: WireRequest): FixtureRequest {
  const { body, ...rest } = request;
  if (body === null) return rest;
  try {
    const json: unknown = JSON.parse(body);
    if (JSON.stringify(json) === body) return { ...rest, json };
  } catch {
    // Not JSON: kept verbatim below.
  }
  return { ...rest, bodyText: body };
}

/** The exact body bytes (as text) a fixture request stands for. */
export function fixtureBody(request: FixtureRequest): string | null {
  if (request.bodyText !== undefined) return request.bodyText;
  return 'json' in request ? JSON.stringify(request.json) : null;
}

/**
 * The one fake key every scenario passes. It is replaced by `<secret>` in the
 * captured headers and URL, so a fixture pins where and how the key is sent
 * (`x-api-key`, `authorization: Bearer …`, `api-key`) but never a value.
 */
export const SECRET = 'golden-test-key-0000';

/** A fixed clock: the requests carry no time, but nothing reads the host's. */
export const FIXED_NOW = Date.UTC(2026, 0, 2, 3, 4, 5);

/** Fresh deterministic dependencies for one scenario run. */
export function goldenDeps(): Dependencies {
  let next = 0;
  return {
    generateId: () => `gid_${String(++next).padStart(4, '0')}`,
    clock: {
      now: () => FIXED_NOW,
      setTimeout: (fn, ms) => {
        const timer = setTimeout(fn, ms);
        return () => clearTimeout(timer);
      },
    },
  };
}

function headerRecord(headers: HeadersInit | undefined): Record<string, string> {
  const entries: [string, string][] =
    headers === undefined
      ? []
      : headers instanceof Headers
        ? [...headers.entries()]
        : Array.isArray(headers)
          ? headers.map(([k, v]) => [k, v] as [string, string])
          : Object.entries(headers);
  const out: Record<string, string> = {};
  for (const [name, value] of entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    out[name] = hideSecret(value);
  }
  return out;
}

const hideSecret = (value: string): string => value.split(SECRET).join('<secret>');

function bodyText(body: BodyInit | null | undefined): string | null {
  if (body === undefined || body === null) return null;
  if (typeof body === 'string') return body;
  if (body instanceof Uint8Array) return new TextDecoder().decode(body);
  if (body instanceof ArrayBuffer) return new TextDecoder().decode(new Uint8Array(body));
  // A FormData or stream body carries a generated boundary or no fixed bytes:
  // no scenario sends one, and a scenario that does must say how it is pinned.
  throw new TypeError(`golden-wire: cannot capture a ${Object.prototype.toString.call(body)} body`);
}

/**
 * A step of a provider script: an SSE body for one turn, or a function of the
 * captured request that answers with an SSE body or a whole Response.
 */
export type ScriptStep = string | ((request: WireRequest) => string | Response);

/**
 * A `fetch` that records every request and answers call N with `script[N]`
 * (the last step repeats).
 */
export function recordingFetch(script: readonly ScriptStep[]) {
  const requests: WireRequest[] = [];
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const request: WireRequest = {
      method: init?.method ?? 'GET',
      url: hideSecret(url),
      headers: headerRecord(init?.headers),
      body: bodyText(init?.body),
    };
    requests.push(request);
    const step = script[Math.min(requests.length - 1, script.length - 1)];
    if (step === undefined) throw new Error('golden-wire: the scenario has no scripted answer');
    const answer = typeof step === 'string' ? step : step(request);
    return typeof answer === 'string' ? sseResponse([answer]) : answer;
  }) as typeof globalThis.fetch;
  return { fetch, requests };
}

/** A JSON answer (embeddings, rerank). */
export const jsonAnswer = (value: unknown) => (): Response =>
  new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

// ---------------------------------------------------------------------------
// Scripted answers, one builder per wire.
// ---------------------------------------------------------------------------

export const TOOL_CALL_ID = 'call_golden_1';

export type Wire = 'anthropic' | 'chat' | 'responses' | 'gemini';

export interface Turn {
  text?: string;
  /** One tool call, with its arguments as JSON text; the id is {@link TOOL_CALL_ID}. */
  call?: { name: string; args: string };
}

/** Anthropic Messages SSE. */
function anthropicTurn(turn: Turn): string {
  const events: { event: string; data: unknown }[] = [
    {
      event: 'message_start',
      data: {
        type: 'message_start',
        message: {
          id: 'msg_golden',
          type: 'message',
          role: 'assistant',
          content: [],
          usage: { input_tokens: 12, output_tokens: 1 },
        },
      },
    },
  ];
  let index = 0;
  if (turn.text !== undefined) {
    events.push(
      {
        event: 'content_block_start',
        data: { type: 'content_block_start', index, content_block: { type: 'text', text: '' } },
      },
      {
        event: 'content_block_delta',
        data: {
          type: 'content_block_delta',
          index,
          delta: { type: 'text_delta', text: turn.text },
        },
      },
      { event: 'content_block_stop', data: { type: 'content_block_stop', index } },
    );
    index += 1;
  }
  if (turn.call) {
    events.push(
      {
        event: 'content_block_start',
        data: {
          type: 'content_block_start',
          index,
          content_block: { type: 'tool_use', id: TOOL_CALL_ID, name: turn.call.name, input: {} },
        },
      },
      {
        event: 'content_block_delta',
        data: {
          type: 'content_block_delta',
          index,
          delta: { type: 'input_json_delta', partial_json: turn.call.args },
        },
      },
      { event: 'content_block_stop', data: { type: 'content_block_stop', index } },
    );
  }
  events.push(
    {
      event: 'message_delta',
      data: {
        type: 'message_delta',
        delta: { stop_reason: turn.call ? 'tool_use' : 'end_turn' },
        usage: { output_tokens: 6 },
      },
    },
    { event: 'message_stop', data: { type: 'message_stop' } },
  );
  return sseEvents(events);
}

/** OpenAI Chat Completions SSE (every compatible host). */
function chatTurn(turn: Turn): string {
  const events: { data: unknown }[] = [];
  if (turn.text !== undefined) {
    events.push({
      data: { choices: [{ index: 0, delta: { content: turn.text }, finish_reason: null }] },
    });
  }
  if (turn.call) {
    events.push(
      {
        data: {
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: TOOL_CALL_ID,
                    type: 'function',
                    function: { name: turn.call.name, arguments: '' },
                  },
                ],
              },
              finish_reason: null,
            },
          ],
        },
      },
      {
        data: {
          choices: [
            {
              index: 0,
              delta: { tool_calls: [{ index: 0, function: { arguments: turn.call.args } }] },
              finish_reason: null,
            },
          ],
        },
      },
    );
  }
  events.push(
    {
      data: {
        choices: [{ index: 0, delta: {}, finish_reason: turn.call ? 'tool_calls' : 'stop' }],
      },
    },
    { data: { choices: [], usage: { prompt_tokens: 12, completion_tokens: 6, total_tokens: 18 } } },
    { data: '[DONE]' },
  );
  return sseEvents(events);
}

/** OpenAI Responses SSE. */
function responsesTurn(turn: Turn): string {
  const events: { event: string; data: Record<string, unknown> }[] = [];
  const push = (type: string, data: Record<string, unknown>): void => {
    events.push({ event: type, data: { type, sequence_number: events.length, ...data } });
  };
  let output = 0;
  if (turn.text !== undefined) {
    const message = { type: 'message', id: 'msg_golden', role: 'assistant' };
    const at = { item_id: 'msg_golden', output_index: output, content_index: 0 };
    push('response.output_item.added', {
      output_index: output,
      item: { ...message, status: 'in_progress', content: [] },
    });
    push('response.output_text.delta', { ...at, delta: turn.text });
    push('response.output_item.done', {
      output_index: output,
      item: {
        ...message,
        status: 'completed',
        content: [{ type: 'output_text', text: turn.text, annotations: [] }],
      },
    });
    output += 1;
  }
  if (turn.call) {
    const item = {
      type: 'function_call',
      id: 'fc_golden',
      call_id: TOOL_CALL_ID,
      name: turn.call.name,
    };
    push('response.output_item.added', {
      output_index: output,
      item: { ...item, arguments: '', status: 'in_progress' },
    });
    push('response.function_call_arguments.delta', {
      item_id: 'fc_golden',
      output_index: output,
      delta: turn.call.args,
    });
    push('response.output_item.done', {
      output_index: output,
      item: { ...item, arguments: turn.call.args, status: 'completed' },
    });
  }
  push('response.completed', {
    response: {
      id: 'resp_golden',
      status: 'completed',
      incomplete_details: null,
      usage: { input_tokens: 12, output_tokens: 6, total_tokens: 18 },
    },
  });
  return sseEvents(events);
}

/** Gemini `streamGenerateContent?alt=sse`. */
function geminiTurn(turn: Turn): string {
  const parts: unknown[] = [];
  if (turn.text !== undefined) parts.push({ text: turn.text });
  if (turn.call) {
    parts.push({
      functionCall: { name: turn.call.name, args: JSON.parse(turn.call.args) as unknown },
    });
  }
  return sseEvents([
    {
      data: {
        candidates: [{ content: { role: 'model', parts }, finishReason: 'STOP', index: 0 }],
        usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 6, totalTokenCount: 18 },
        modelVersion: 'golden',
      },
    },
  ]);
}

/** One scripted turn on `wire`. */
export function turn(wire: Wire, value: Turn): string {
  switch (wire) {
    case 'anthropic':
      return anthropicTurn(value);
    case 'chat':
      return chatTurn(value);
    case 'responses':
      return responsesTurn(value);
    case 'gemini':
      return geminiTurn(value);
  }
}
