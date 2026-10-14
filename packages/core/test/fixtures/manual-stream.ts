/**
 * A canonical chat stream the test feeds by hand (the serializers read only
 * `fullStream`), and helpers to read a Deuz SSE body frame by frame.
 */
import type { StreamChatResult } from '../../src/index';
import type { StreamPart } from '../../src/types/stream';

export interface ManualResult {
  result: StreamChatResult;
  push(part: StreamPart): void;
  end(): void;
  /** True once the serializer stopped reading (it broke out of the loop). */
  returned(): boolean;
}

export function manualResult(): ManualResult {
  const queue: StreamPart[] = [];
  let notify: (() => void) | undefined;
  let done = false;
  let returned = false;
  async function* iterate(): AsyncGenerator<StreamPart> {
    try {
      for (;;) {
        while (queue.length > 0) yield queue.shift()!;
        if (done) return;
        await new Promise<void>((resolve) => (notify = resolve));
      }
    } finally {
      returned = true;
    }
  }
  const usage = Promise.resolve({
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    cachedReadTokens: 0,
    cacheWriteTokens: 0,
    cacheWrite1hTokens: 0,
    totalTokens: 0,
  });
  return {
    result: {
      fullStream: iterate(),
      textStream: (async function* () {})(),
      usage,
      finishReason: Promise.resolve('stop'),
    } as StreamChatResult,
    push(part) {
      queue.push(part);
      const wake = notify;
      notify = undefined;
      wake?.();
    },
    end() {
      done = true;
      const wake = notify;
      notify = undefined;
      wake?.();
    },
    returned: () => returned,
  };
}

export const textPart = (text: string): StreamPart => ({ type: 'text-delta', text });

/** One SSE event of a body: its `id:` (when present) and its `data:`. */
export interface SseFrame {
  id?: string;
  data: string;
}

/** Splits a whole SSE body into frames. */
export function sseFrames(body: string): SseFrame[] {
  return body
    .split('\n\n')
    .filter((chunk) => chunk.length > 0)
    .map((chunk) => {
      const frame: SseFrame = { data: '' };
      for (const line of chunk.split('\n')) {
        if (line.startsWith('id: ')) frame.id = line.slice(4);
        else if (line.startsWith('data: ')) frame.data = line.slice(6);
      }
      return frame;
    });
}

/** Reads a body incrementally: `next()` resolves with the text that arrived since the last call. */
export function bodyReader(response: Response): {
  /** Everything received so far. */
  text(): string;
  /** Waits for more bytes; resolves false once the body ended. */
  more(): Promise<boolean>;
  /** Reads until the text received so far contains `fragment`. */
  until(fragment: string): Promise<string>;
  /** Reads until the body ends. */
  rest(): Promise<string>;
  cancel(): Promise<void>;
} {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let received = '';
  let ended = false;
  const more = async (): Promise<boolean> => {
    if (ended) return false;
    const { value, done } = await reader.read();
    if (done) {
      ended = true;
      return false;
    }
    received += decoder.decode(value, { stream: true });
    return true;
  };
  return {
    text: () => received,
    more,
    async until(fragment) {
      while (!received.includes(fragment))
        if (!(await more())) throw new Error(`the body ended before ${JSON.stringify(fragment)}`);
      return received;
    },
    async rest() {
      while (await more());
      return received;
    },
    cancel: () => reader.cancel(),
  };
}
