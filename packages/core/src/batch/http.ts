/**
 * Transport for the batch lifecycle calls (2.3, BA2): one fetch through the
 * model's resolved call (its `fetch`, credentials and headers), provider
 * failures mapped by the model's own wire adapter, and JSON Lines read as a
 * stream so a large result file never sits in memory whole.
 */
import type { Adapter } from '../adapters/types';
import { readErrorBody } from '../internal/media-http';
import type { ResolvedCall } from '../internal/resolve-call';

/** What every lifecycle call needs: the resolved call and the caller's signal. */
export interface BatchCallContext {
  readonly call: ResolvedCall;
  readonly signal?: AbortSignal;
}

/**
 * Send one lifecycle request. A non-2xx answer becomes the wire's typed error
 * (`RateLimitError`, `AuthenticationError`, …), exactly as for a model call.
 */
export async function send(
  ctx: BatchCallContext,
  adapter: Adapter,
  url: string,
  init: RequestInit,
): Promise<Response> {
  const response = await ctx.call.fetch(url, {
    ...init,
    ...(ctx.signal ? { signal: ctx.signal } : {}),
  });
  if (!response.ok) {
    const body = await readErrorBody(response);
    throw adapter.mapError(response.status, body, response.headers, {
      provider: ctx.call.provider,
    });
  }
  return response;
}

/** The JSON body of a lifecycle answer; an empty body reads as `{}`. */
export async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  return text.trim() === '' ? {} : (JSON.parse(text) as unknown);
}

/**
 * The lines of a JSON Lines body, parsed one at a time as the bytes arrive.
 * A line that is not JSON yields `undefined` (the caller skips it). Breaking
 * out of the loop cancels the body.
 */
export async function* jsonLines(response: Response): AsyncGenerator<unknown> {
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
      const chunk = await reader.read();
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
