/**
 * Transport for the batch lifecycle calls (2.3, BA2): one fetch through the
 * model's resolved call (its `fetch`, credentials and headers), provider
 * failures mapped by the model's own wire adapter, and JSON Lines read as a
 * stream so a large result file never sits in memory whole.
 */
import type { Adapter } from '../adapters/types';
import { NetworkError } from '../errors';
import { readErrorBody } from '../internal/media-http';
import type { ResolvedCall } from '../internal/resolve-call';

/** What every lifecycle call needs: the resolved call and the caller's signal. */
export interface BatchCallContext {
  readonly call: ResolvedCall;
  readonly signal?: AbortSignal;
}

/**
 * A transport failure (DNS, a reset connection, a body that breaks off) as the
 * retryable `NetworkError` every model call uses, so `wait` polls again. An
 * abort of the caller's signal keeps its own reason.
 */
function transportError(ctx: BatchCallContext, cause: unknown, phase: string): unknown {
  if (ctx.signal?.aborted) return cause;
  return new NetworkError({
    message: `Batch request to provider '${ctx.call.provider}' failed ${phase}.`,
    provider: ctx.call.provider,
    upstreamType: cause instanceof Error ? cause.name : typeof cause,
    cause,
  });
}

/**
 * Send one lifecycle request. A non-2xx answer becomes the wire's typed error
 * (`RateLimitError`, `AuthenticationError`, …), exactly as for a model call;
 * a failure before any answer is a `NetworkError`.
 */
export async function send(
  ctx: BatchCallContext,
  adapter: Adapter,
  url: string,
  init: RequestInit,
): Promise<Response> {
  let response: Response;
  try {
    response = await ctx.call.fetch(url, {
      ...init,
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    });
  } catch (cause) {
    throw transportError(ctx, cause, 'before a response arrived');
  }
  if (!response.ok) {
    const body = await readErrorBody(response);
    throw adapter.mapError(response.status, body, response.headers, {
      provider: ctx.call.provider,
    });
  }
  return response;
}

/** The JSON body of a lifecycle answer; an empty body reads as `{}`. */
export async function readJson(response: Response, ctx: BatchCallContext): Promise<unknown> {
  let text: string;
  try {
    text = await response.text();
  } catch (cause) {
    throw transportError(ctx, cause, 'while its answer was read');
  }
  return text.trim() === '' ? {} : (JSON.parse(text) as unknown);
}

/**
 * The lines of a JSON Lines body, parsed one at a time as the bytes arrive.
 * A line that is not JSON yields `undefined` (the caller skips it). Breaking
 * out of the loop cancels the body.
 */
export async function* jsonLines(
  response: Response,
  ctx: BatchCallContext,
): AsyncGenerator<unknown> {
  const body = response.body;
  if (!body) return;
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let done = false;
  const parse = (line: string): unknown => {
    try {
      return JSON.parse(line) as unknown;
    } catch {
      return undefined;
    }
  };
  try {
    while (!done) {
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await reader.read();
      } catch (cause) {
        throw transportError(ctx, cause, 'while its results were read');
      }
      done = chunk.done;
      buffer += chunk.done ? decoder.decode() : decoder.decode(chunk.value, { stream: true });
      let newline = buffer.indexOf('\n');
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line) yield parse(line);
        newline = buffer.indexOf('\n');
      }
    }
    if (buffer.trim()) yield parse(buffer.trim());
  } finally {
    if (!done) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
