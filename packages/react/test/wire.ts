/**
 * Wire fixtures for the 2.3 settlement tests (F06 verdicts, F07 resume).
 *
 * The resume side is NOT hand-rolled: `journal()` records parts in core's own
 * in-memory `StreamStateStore` and serves them through core's
 * `resumeDeuzStreamResponse`, so cursor parsing, leg-end sentinels and
 * caught-up `[DONE]` are the real server semantics, not a test's guess at them.
 */
import { createInMemoryStreamStateStore, resumeDeuzStreamResponse } from '@deuz-sdk/core/ui';
import type { DeuzUIPart } from '@deuz-sdk/core/ui';

const SSE_HEADERS = { 'content-type': 'text/event-stream', 'x-deuz-stream': 'v2' };

function frames(events: Array<{ id?: number; data: string }>): string {
  return events
    .map((e) => `${e.id !== undefined ? `id: ${e.id}\n` : ''}data: ${e.data}\n\n`)
    .join('');
}

/** A complete SSE `Response` (jsdom's Blob lacks `.stream()`, hence the manual body). */
function sseResponse(events: Array<{ id?: number; data: string }>): Response {
  const bytes = new TextEncoder().encode(frames(events));
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    }),
    { headers: SSE_HEADERS },
  );
}

/**
 * A POST response whose connection DROPS after `events`: the body errors
 * before `[DONE]`, exactly as a real `fetch` body does on a network failure.
 */
function droppingResponse(events: Array<{ id?: number; data: string }>): Response {
  const bytes = new TextEncoder().encode(frames(events));
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
        // Errored on a later turn of the event loop, so the delivered frames
        // are read (and folded) before the drop surfaces.
        setTimeout(() => controller.error(new TypeError('network connection lost')), 0);
      },
    }),
    { headers: SSE_HEADERS },
  );
}

/**
 * A response that delivers `events` and then STALLS until `signal` aborts,
 * which errors the body — what a real `fetch` does when its request is
 * aborted mid-stream.
 */
export function stallingResponse(
  events: Array<{ id?: number; data: string }>,
  signal: AbortSignal | null | undefined,
): Response {
  const bytes = new TextEncoder().encode(frames(events));
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
        signal?.addEventListener('abort', () =>
          controller.error(new DOMException('aborted', 'AbortError')),
        );
      },
    }),
    { headers: SSE_HEADERS },
  );
}

/** A POST response with id-less frames, then `[DONE]` (the shape the existing tests use). */
export function postResponse(parts: DeuzUIPart[]): Response {
  return sseResponse([...parts.map((p) => ({ data: JSON.stringify(p) })), { data: '[DONE]' }]);
}

export const parts = {
  start: (messageId: string): DeuzUIPart => ({ type: 'start', messageId }),
  text: (text: string): DeuzUIPart => ({ type: 'text-delta', text }),
  toolCall: (toolCallId: string, toolName: string, input: unknown = {}): DeuzUIPart => ({
    type: 'tool-call',
    toolCallId,
    toolName,
    input,
  }),
  toolResult: (toolCallId: string, toolName: string, output: unknown): DeuzUIPart => ({
    type: 'tool-result',
    toolCallId,
    toolName,
    output,
  }),
  approval: (
    approvalId: string,
    toolCallId: string,
    toolName: string,
    input: unknown = {},
    token?: string,
  ): DeuzUIPart => ({
    type: 'tool-approval-request',
    approvalId,
    toolCallId,
    toolName,
    input,
    ...(token !== undefined ? { token } : {}),
  }),
  finish: (): DeuzUIPart => ({
    type: 'finish',
    finishReason: 'stop',
    usage: {
      inputTokens: 1,
      outputTokens: 1,
      reasoningTokens: 0,
      cachedReadTokens: 0,
      cacheWriteTokens: 0,
      cacheWrite1hTokens: 0,
      totalTokens: 2,
    },
  }),
};

export type Body = {
  messages: Array<{ role: string; content: unknown }>;
  approvalResponses?: Array<Record<string, unknown>>;
  [key: string]: unknown;
};

/**
 * A `fetch` for the POST route that records every request body. `respond` gets
 * the 1-based round number and the parsed body.
 */
export function recordingFetch(respond: (round: number, body: Body) => Response): {
  fetch: typeof fetch;
  bodies: Body[];
} {
  const bodies: Body[] = [];
  const fetchMock: typeof fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as Body;
    bodies.push(body);
    return respond(bodies.length, body);
  };
  return { fetch: fetchMock, bodies };
}

/**
 * A server-side stream journal for ONE `streamId`, plus its GET resume
 * endpoint. Legs append with continued seq numbering and a `done` sentinel,
 * exactly like `toDeuzStreamResponse({ store, streamId })` on a continued run.
 */
export function journal(streamId = 'stream-1') {
  const store = createInMemoryStreamStateStore();
  let seq = 0;
  /** Every cursor the endpoint was asked to resume from, in call order. */
  const cursors: Array<string | undefined> = [];
  const record = async (leg: DeuzUIPart[]): Promise<Array<{ id: number; data: string }>> => {
    const events = [];
    for (const part of leg) {
      events.push({ id: seq, data: JSON.stringify(part) });
      await store.append(streamId, seq++, part);
    }
    await store.append(streamId, seq++, { type: 'done' });
    return events;
  };
  return {
    cursors,
    /** Journal one completed leg (the server kept running, whatever the client saw). */
    leg: async (leg: DeuzUIPart[]): Promise<void> => {
      await record(leg);
    },
    /** The POST response for a journaled leg: the same frames, with their seq ids. */
    respond: async (leg: DeuzUIPart[]): Promise<Response> => {
      const events = await record(leg);
      return sseResponse([...events, { id: seq - 1, data: '[DONE]' }]);
    },
    /**
     * The POST response for a journaled leg whose connection drops after
     * `delivered` frames. The journal still holds the WHOLE leg: the server
     * finishes the run into the store even when the client is gone.
     */
    respondDropping: async (leg: DeuzUIPart[], delivered: number): Promise<Response> => {
      const events = await record(leg);
      return droppingResponse(events.slice(0, delivered));
    },
    /** GET resume endpoint: replay after the client's cursor (`resumeDeuzStreamResponse`). */
    endpoint: (ctx: { lastEventId?: string }): Response => {
      cursors.push(ctx.lastEventId);
      return resumeDeuzStreamResponse(store, streamId, { lastEventId: ctx.lastEventId ?? null });
    },
    /** A resume endpoint that IGNORES the cursor and replays everything (a lost cursor). */
    replayEverything: (ctx: { lastEventId?: string }): Response => {
      cursors.push(ctx.lastEventId);
      return resumeDeuzStreamResponse(store, streamId);
    },
  };
}
