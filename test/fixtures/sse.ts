/**
 * Golden-replay helpers. Primary strategy (Faz 1.E): inject `deps.fetch` (or a
 * factory `fetch`) that returns a `Response` whose body is an SSE `ReadableStream`
 * built from fixture chunks — fully deterministic, no network interception.
 */

/** Build a streaming `text/event-stream` Response from raw chunk strings. */
export function sseResponse(chunks: string[], init: ResponseInit = {}): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
    ...init,
  });
}

/** Format `event:`/`data:` blocks into a single SSE wire string. */
export function sseEvents(events: { event?: string; data: unknown }[]): string {
  return events
    .map((e) => {
      const data = typeof e.data === 'string' ? e.data : JSON.stringify(e.data);
      return `${e.event ? `event: ${e.event}\n` : ''}data: ${data}\n\n`;
    })
    .join('');
}

/** A fetch that always returns the given Response (records the last request). */
export function mockFetch(response: Response | (() => Response)): {
  fetch: typeof fetch;
  calls: { url: string; init?: RequestInit }[];
} {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return typeof response === 'function' ? response() : response;
  }) as typeof fetch;
  return { fetch: fn, calls };
}

/** A fetch that returns a different Response per call (last repeats). Records each request. */
export function mockFetchSequence(responses: (() => Response)[]): {
  fetch: typeof fetch;
  calls: { url: string; init?: RequestInit }[];
} {
  const calls: { url: string; init?: RequestInit }[] = [];
  let i = 0;
  const fn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    const make = responses[Math.min(i, responses.length - 1)]!;
    i++;
    return make();
  }) as typeof fetch;
  return { fetch: fn, calls };
}
