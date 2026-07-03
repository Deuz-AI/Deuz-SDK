/**
 * Deuz-native UI streaming wire. `@deuz-sdk/core` is its OWN AI SDK — this protocol
 * is ours, not a copy of any other SDK's. The server serializes the canonical
 * `fullStream` to SSE (`x-deuz-stream: v1`); the client reads it back — directly
 * via `readDeuzStream`, or through the `useChat`/`useObject` hooks (`./react`).
 */
import type { StreamChatResult, StreamObjectResult } from './types/methods';
import type { StreamPart } from './types/stream';
import type { Usage, FinishReason } from './types/usage';
import { parseSSE } from './internal/sse';
import { redactString } from './internal/redact';

export const DEUZ_STREAM_VERSION = 'v1';

/** A part of the Deuz UI stream (mirrors the canonical stream, UI-framed). */
export type DeuzUIPart =
  | { type: 'start'; messageId: string }
  | { type: 'step-start'; step: number }
  | { type: 'step-finish'; step: number; finishReason: FinishReason; usage: Usage }
  | { type: 'text-delta'; text: string }
  | { type: 'reasoning-delta'; text: string; signature?: string }
  | { type: 'tool-input-delta'; toolCallId: string; toolName?: string; delta: string }
  | { type: 'tool-call'; toolCallId: string; toolName: string; input: unknown }
  | {
      type: 'tool-result';
      toolCallId: string;
      toolName: string;
      output: unknown;
      isError?: boolean;
    }
  | { type: 'source'; id: string; url?: string; title?: string }
  | {
      type: 'tool-approval-request';
      approvalId: string;
      toolCallId: string;
      toolName: string;
      input: unknown;
    }
  /**
   * Client→server direction only (declared for wire symmetry): the verdict
   * travels in the next HTTP request's body as `approvalResponses` — it is
   * never serialized by `toDeuzStreamResponse`. `useChat` consumes it.
   */
  | { type: 'tool-approval-response'; approvalId: string; approved: boolean; reason?: string }
  /** `streamObject` partial — each delta REPLACES the previous partial wholesale. */
  | { type: 'object-delta'; object: unknown }
  | { type: 'finish'; finishReason: FinishReason; usage: Usage }
  | { type: 'error'; message: string };

function errorMessage(error: unknown): string {
  if (error instanceof Error) return redactString(error.message);
  return redactString(typeof error === 'string' ? error : 'Stream error.');
}

/** Map a canonical StreamPart → a Deuz UI part (undefined = drop). */
function toUIPart(part: StreamPart): DeuzUIPart | undefined {
  switch (part.type) {
    case 'text-delta':
      return { type: 'text-delta', text: part.text };
    case 'reasoning-delta':
      return {
        type: 'reasoning-delta',
        text: part.text,
        ...(part.signature ? { signature: part.signature } : {}),
      };
    case 'tool-call-delta':
      return {
        type: 'tool-input-delta',
        toolCallId: part.id,
        ...(part.name ? { toolName: part.name } : {}),
        delta: part.argsTextDelta,
      };
    case 'tool-call':
      return {
        type: 'tool-call',
        toolCallId: part.toolCallId,
        toolName: part.toolName,
        input: part.input,
      };
    case 'tool-result':
      return {
        type: 'tool-result',
        toolCallId: part.toolCallId,
        toolName: part.toolName,
        output: part.output,
        ...(part.isError ? { isError: true } : {}),
      };
    case 'source':
      return {
        type: 'source',
        id: part.id,
        ...(part.url ? { url: part.url } : {}),
        ...(part.title ? { title: part.title } : {}),
      };
    case 'tool-approval-request':
      // Explicit case required — the default drops unknown canonical parts.
      return {
        type: 'tool-approval-request',
        approvalId: part.approvalId,
        toolCallId: part.toolCallId,
        toolName: part.toolName,
        input: part.input,
      };
    case 'step-start':
      return { type: 'step-start', step: part.stepIndex };
    case 'step-finish':
      return {
        type: 'step-finish',
        step: part.stepIndex,
        finishReason: part.finishReason,
        usage: part.usage,
      };
    case 'finish':
      return { type: 'finish', finishReason: part.finishReason, usage: part.usage };
    case 'error':
      return { type: 'error', message: errorMessage(part.error) };
    default:
      return undefined;
  }
}

export interface ToDeuzStreamOptions {
  messageId?: string;
  /** Source for the message id (e.g. deps.generateId). */
  generateId?: () => string;
  /** Extra response headers. */
  headers?: Record<string, string>;
}

/** Serialize a `StreamChatResult` to a Deuz-protocol SSE `Response`. Edge-safe. */
export function toDeuzStreamResponse(
  result: StreamChatResult,
  options: ToDeuzStreamOptions = {},
): Response {
  const encoder = new TextEncoder();
  const messageId = options.messageId ?? options.generateId?.() ?? 'deuz-msg';

  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (part: DeuzUIPart): void => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(part)}\n\n`));
      };
      send({ type: 'start', messageId });
      try {
        for await (const part of result.fullStream) {
          const ui = toUIPart(part);
          if (ui) send(ui);
        }
      } catch (err) {
        send({ type: 'error', message: errorMessage(err) });
      }
      controller.enqueue(encoder.encode('data: [DONE]\n\n'));
      controller.close();
    },
  });

  return new Response(body, {
    status: 200,
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      'x-deuz-stream': DEUZ_STREAM_VERSION,
      ...options.headers,
    },
  });
}

/**
 * Serialize a `streamObject` result to a Deuz-protocol SSE `Response`
 * (`object-delta` parts; `useObject` reads it back). Edge-safe. Failures —
 * transport errors AND final-validation rejection — surface as a redacted
 * `error` part; `usage`/`finishReason` ride the terminal `finish` part on
 * success.
 */
export function toDeuzObjectStreamResponse(
  result: StreamObjectResult<unknown>,
  options: ToDeuzStreamOptions = {},
): Response {
  const encoder = new TextEncoder();
  const messageId = options.messageId ?? options.generateId?.() ?? 'deuz-msg';

  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (part: DeuzUIPart): void => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(part)}\n\n`));
      };
      send({ type: 'start', messageId });
      try {
        for await (const partial of result.partialObjectStream) {
          send({ type: 'object-delta', object: partial });
        }
        send({
          type: 'finish',
          finishReason: await result.finishReason,
          usage: await result.usage,
        });
      } catch (err) {
        send({ type: 'error', message: errorMessage(err) });
      }
      controller.enqueue(encoder.encode('data: [DONE]\n\n'));
      controller.close();
    },
  });

  return new Response(body, {
    status: 200,
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      'x-deuz-stream': DEUZ_STREAM_VERSION,
      ...options.headers,
    },
  });
}

/** Client-side reader: a Deuz-protocol SSE `Response` → `DeuzUIPart` async-iterable. */
export async function* readDeuzStream(response: Response): AsyncGenerator<DeuzUIPart> {
  if (!response.body) return;
  for await (const ev of parseSSE(response.body)) {
    if (ev.data === '[DONE]') return;
    try {
      yield JSON.parse(ev.data) as DeuzUIPart;
    } catch {
      /* skip malformed line */
    }
  }
}
