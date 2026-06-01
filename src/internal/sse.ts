/**
 * Robust Server-Sent-Events parser. Web-only: `ReadableStream` + `TextDecoder`.
 * Handles UTF-8 multibyte sequences split across chunk boundaries
 * (`decode(..., { stream: true })`), `\n` and `\r\n` line endings, multi-line
 * `data:` fields, and comment/keep-alive lines (`:` prefix). `[DONE]` is left
 * for the adapter to interpret. Cancels the underlying reader on early break.
 */
export interface SSEEvent {
  event?: string;
  data: string;
}

export async function* parseSSE(body: ReadableStream<Uint8Array>): AsyncGenerator<SSEEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let eventName: string | undefined;
  let dataLines: string[] = [];

  function takeEvent(): SSEEvent | undefined {
    if (dataLines.length === 0) {
      eventName = undefined;
      return undefined;
    }
    const ev: SSEEvent = { event: eventName, data: dataLines.join('\n') };
    eventName = undefined;
    dataLines = [];
    return ev;
  }

  function consumeLine(rawLine: string): void {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (line.startsWith(':')) return; // comment / keep-alive
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') eventName = value;
    else if (field === 'data') dataLines.push(value);
    // `id` / `retry` fields are ignored.
  }

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (line === '' || line === '\r') {
          const ev = takeEvent();
          if (ev) yield ev;
        } else {
          consumeLine(line);
        }
      }
    }
    buffer += decoder.decode();
    if (buffer !== '' && buffer !== '\r') consumeLine(buffer);
    const tail = takeEvent();
    if (tail) yield tail;
  } finally {
    try {
      await reader.cancel();
    } catch {
      /* stream already closed */
    }
  }
}
