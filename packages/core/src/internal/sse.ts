/**
 * Robust Server-Sent-Events parser. Web-only: `ReadableStream` + `TextDecoder`.
 * Handles UTF-8 multibyte sequences split across chunk boundaries
 * (`decode(..., { stream: true })`), `\n`, `\r\n`, and bare `\r` line endings, multi-line
 * `data:` fields, and comment/keep-alive lines (`:` prefix). `[DONE]` is left
 * for the adapter to interpret. Cancels the underlying reader on early break.
 *
 * `id:` lines follow the SSE spec: the last seen id is sticky and stamped on
 * every subsequent event (the Deuz wire v2 resume cursor). `retry:` is ignored.
 */
export interface SSEEvent {
  event?: string;
  data: string;
  /** Last seen `id:` value (sticky per the SSE spec). Absent before any id line. */
  id?: string;
}

export async function* parseSSE(body: ReadableStream<Uint8Array>): AsyncGenerator<SSEEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let eventName: string | undefined;
  let dataLines: string[] = [];
  let lastId: string | undefined;
  let firstLine = true;

  function takeEvent(): SSEEvent | undefined {
    if (dataLines.length === 0) {
      eventName = undefined;
      return undefined;
    }
    const ev: SSEEvent = {
      event: eventName,
      data: dataLines.join('\n'),
      ...(lastId !== undefined ? { id: lastId } : {}),
    };
    eventName = undefined;
    dataLines = [];
    return ev;
  }

  function consumeLine(rawLine: string): void {
    const line = firstLine ? rawLine.replace(/^\uFEFF/, '') : rawLine;
    firstLine = false;
    if (line.startsWith(':')) return; // comment / keep-alive
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') eventName = value;
    else if (field === 'data') dataLines.push(value);
    // Per spec an id containing NULL is ignored; `retry:` stays ignored.
    else if (field === 'id' && !value.includes('\0')) lastId = value;
  }

  /**
   * Remove and return one SSE line. A trailing CR is held until the next chunk
   * so a CRLF split across chunks is treated as one delimiter, not two lines.
   */
  function takeLine(final: boolean): string | undefined {
    for (let i = 0; i < buffer.length; i++) {
      const char = buffer[i];
      if (char === '\n') {
        const line = buffer.slice(0, i);
        buffer = buffer.slice(i + 1);
        return line;
      }
      if (char === '\r') {
        if (i + 1 === buffer.length && !final) return undefined;
        const width = buffer[i + 1] === '\n' ? 2 : 1;
        const line = buffer.slice(0, i);
        buffer = buffer.slice(i + width);
        return line;
      }
    }
    return undefined;
  }

  function dispatchLine(line: string): SSEEvent | undefined {
    if (line === '') return takeEvent();
    consumeLine(line);
    return undefined;
  }

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      for (;;) {
        const line = takeLine(false);
        if (line === undefined) break;
        const ev = dispatchLine(line);
        if (ev) yield ev;
      }
    }
    buffer += decoder.decode();
    for (;;) {
      const line = takeLine(true);
      if (line === undefined) break;
      const ev = dispatchLine(line);
      if (ev) yield ev;
    }
    if (buffer !== '') consumeLine(buffer);
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
