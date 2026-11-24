/**
 * deuz meter (2.5): reads usage from a response as it passes by, without
 * holding it back. SSE bodies are parsed incrementally, event by event, and
 * the bytes themselves go to the client untouched; a JSON body is copied up
 * to a cap and parsed once it ends. The wire shapes are mapped by the same
 * functions the provider adapters use, so the meter bills exactly as a Deuz
 * call would. Edge-safe.
 */
import { mapAnthropicUsage } from '../adapters/anthropic';
import type { AnthropicUsage } from '../adapters/anthropic';
import { mapOpenAIUsage } from '../adapters/openai-compatible';
import { mapResponsesUsage } from '../adapters/openai-responses';
import type { ResponsesUsage } from '../adapters/openai-responses';
import type { Usage } from '../types/usage';
import type { MeterProtocol } from './types';

type ChatUsage = Parameters<typeof mapOpenAIUsage>[0];

/** What a reader has seen so far. */
export interface UsageReading {
  /** Usage as far as it was seen. */
  readonly usage?: Usage;
  /** Whether `usage` is the provider's final count. */
  readonly complete: boolean;
  /** The provider reported an error inside a 2xx body. */
  readonly errored: boolean;
}

/** @internal An incremental usage reader for one response body. */
export interface UsageReader {
  push(chunk: Uint8Array): void;
  end(): void;
  read(): UsageReading;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** One protocol's view of decoded JSON payloads (SSE `data:` or a whole JSON body). */
interface PayloadReader {
  event(payload: Record<string, unknown>, eventName: string | undefined): void;
  json(body: Record<string, unknown>): void;
  read(): UsageReading;
}

function anthropicReader(): PayloadReader {
  let input: AnthropicUsage | undefined;
  let outputTokens = 0;
  let final = false;
  let errored = false;
  return {
    event(data, name) {
      const type = typeof data.type === 'string' ? data.type : name;
      if (type === 'message_start') {
        const message = isRecord(data.message) ? data.message : undefined;
        if (isRecord(message?.usage)) {
          input = message.usage as AnthropicUsage;
          outputTokens = input.output_tokens ?? 0;
        }
      } else if (type === 'message_delta' && isRecord(data.usage)) {
        // Cumulative: the final delta's counts replace message_start's, but an
        // absent input count never erases the one already seen.
        const usage = data.usage as AnthropicUsage;
        if (usage.output_tokens !== undefined) outputTokens = usage.output_tokens;
        input = {
          ...input,
          ...usage,
          input_tokens: usage.input_tokens ?? input?.input_tokens,
        };
        final = true;
      } else if (type === 'error') errored = true;
    },
    json(body) {
      if (body.type === 'error') errored = true;
      if (!isRecord(body.usage)) return;
      input = body.usage as AnthropicUsage;
      outputTokens = input.output_tokens ?? 0;
      final = true;
    },
    read() {
      return {
        ...(input ? { usage: mapAnthropicUsage(input, outputTokens) } : {}),
        complete: final && input !== undefined,
        errored,
      };
    },
  };
}

function chatReader(): PayloadReader {
  let usage: ChatUsage | undefined;
  let errored = false;
  const take = (data: Record<string, unknown>) => {
    if (isRecord(data.usage)) usage = data.usage as ChatUsage;
    if (isRecord(data.error)) errored = true;
  };
  return {
    event: take,
    json: take,
    read() {
      return { ...(usage ? { usage: mapOpenAIUsage(usage) } : {}), complete: !!usage, errored };
    },
  };
}

/** Responses events whose `response.usage` is the final, billed count. */
const RESPONSES_FINAL = new Set(['response.completed', 'response.incomplete', 'response.failed']);

function responsesReader(): PayloadReader {
  let usage: ResponsesUsage | undefined;
  let errored = false;
  return {
    event(data, name) {
      const type = typeof data.type === 'string' ? data.type : name;
      if (type === 'error') errored = true;
      if (type === undefined || !RESPONSES_FINAL.has(type)) return;
      const response = isRecord(data.response) ? data.response : undefined;
      if (isRecord(response?.usage)) usage = response.usage as ResponsesUsage;
      else if (type === 'response.failed') errored = true;
    },
    json(body) {
      if (isRecord(body.usage)) usage = body.usage as ResponsesUsage;
      if (isRecord(body.error)) errored = true;
    },
    read() {
      return { ...(usage ? { usage: mapResponsesUsage(usage) } : {}), complete: !!usage, errored };
    },
  };
}

function payloadReader(protocol: MeterProtocol): PayloadReader {
  if (protocol === 'anthropic-messages') return anthropicReader();
  return protocol === 'openai-chat' ? chatReader() : responsesReader();
}

function parse(text: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(text);
    return isRecord(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * @internal Feeds SSE events to `onEvent` as bytes arrive: `\n`, `\r\n` and
 * bare `\r` line ends (a CR at a chunk's end waits for the next chunk),
 * multi-line `data:` fields, comments, and UTF-8 split across chunks.
 */
export function createSseSplitter(onEvent: (data: string, event: string | undefined) => void): {
  push(chunk: Uint8Array): void;
  end(): void;
} {
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let event: string | undefined;
  let data: string[] = [];
  let first = true;

  const line = (raw: string) => {
    const text = first ? raw.replace(/^﻿/, '') : raw;
    first = false;
    if (text === '') {
      if (data.length > 0) onEvent(data.join('\n'), event);
      data = [];
      event = undefined;
      return;
    }
    if (text.startsWith(':')) return;
    const colon = text.indexOf(':');
    const field = colon === -1 ? text : text.slice(0, colon);
    let value = colon === -1 ? '' : text.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') event = value;
    else if (field === 'data') data.push(value);
  };

  // Where the scan for a line end resumes: a long line arriving in many
  // chunks is scanned once, not once per chunk.
  let scanned = 0;
  const drain = (final: boolean) => {
    let start = 0;
    let index = scanned;
    for (; index < buffer.length; index++) {
      const char = buffer[index];
      if (char !== '\n' && char !== '\r') continue;
      if (char === '\r' && index + 1 === buffer.length && !final) break;
      line(buffer.slice(start, index));
      if (char === '\r' && buffer[index + 1] === '\n') index++;
      start = index + 1;
    }
    buffer = buffer.slice(start);
    scanned = Math.max(0, Math.min(index, buffer.length + start) - start);
  };

  return {
    push(chunk) {
      buffer += decoder.decode(chunk, { stream: true });
      drain(false);
    },
    end() {
      buffer += decoder.decode();
      drain(true);
      if (buffer !== '') line(buffer);
      buffer = '';
      line('');
    },
  };
}

/** @internal A reader for an SSE body. */
export function createSseUsageReader(protocol: MeterProtocol): UsageReader {
  const reader = payloadReader(protocol);
  const splitter = createSseSplitter((data, event) => {
    if (data === '[DONE]') return;
    const payload = parse(data);
    if (payload) reader.event(payload, event);
  });
  return { push: splitter.push, end: splitter.end, read: reader.read };
}

/**
 * @internal A reader for a JSON body: it keeps a copy of at most `maxBytes`
 * and parses it at the end. A larger body yields no usage.
 */
export function createJsonUsageReader(protocol: MeterProtocol, maxBytes: number): UsageReader {
  const reader = payloadReader(protocol);
  const chunks: Uint8Array[] = [];
  let size = 0;
  let overflow = false;
  return {
    push(chunk) {
      if (overflow) return;
      size += chunk.byteLength;
      if (size > maxBytes) {
        overflow = true;
        chunks.length = 0;
        return;
      }
      chunks.push(chunk.slice());
    },
    end() {
      if (overflow) return;
      const decoder = new TextDecoder('utf-8');
      let text = '';
      for (const chunk of chunks) text += decoder.decode(chunk, { stream: true });
      text += decoder.decode();
      chunks.length = 0;
      const body = parse(text);
      if (body) reader.json(body);
    },
    read: reader.read,
  };
}
