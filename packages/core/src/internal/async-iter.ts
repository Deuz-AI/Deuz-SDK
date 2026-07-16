/**
 * Async-stream primitives for the inference orchestrator. The hard constraint
 * (Faz 1 plan, G2/G5): `streamChat` returns SYNCHRONOUSLY, so the network pump
 * must start lazily on first access of ANY output, fan out to both `textStream`
 * and `fullStream`, and resolve `usage`/`finishReason` from the same pass.
 */

export interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(reason?: unknown): void;
}

/**
 * A promise with externally-callable resolve/reject. A no-op rejection handler
 * is pre-attached so awaiting ONLY the sibling promise (e.g. `usage` but not
 * `finishReason`) never triggers an `unhandledRejection`.
 */
export function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  promise.catch(() => {});
  return { promise, resolve, reject };
}

export interface Broadcaster<T> {
  /** Emit a value to every active subscriber. No-op after close/fail. */
  push(value: T): void;
  /** Normal completion — subscribers drain their queue then finish. */
  close(): void;
  /** Error completion — subscribers drain their queue then reject. */
  fail(error: unknown): void;
  /** Independent consumer; each gets its own buffered queue (a tee branch). */
  subscribe(): AsyncIterableIterator<T>;
}

interface Sub<T> {
  queue: T[];
  waiting: ((result: IteratorResult<T>) => void) | null;
  rejectWaiting: ((reason: unknown) => void) | null;
  done: boolean;
}

/**
 * Multi-consumer fan-out. Each `subscribe()` branch buffers independently, so a
 * slow/ignored branch does not block the others (it just buffers — bounded by
 * the response size, the documented footgun). Errors and EOF drain queued
 * values first, then surface.
 */
export function createBroadcaster<T>(): Broadcaster<T> {
  const subs = new Set<Sub<T>>();
  let closed = false;
  let failure: { error: unknown } | null = null;

  function push(value: T): void {
    if (closed) return;
    for (const s of subs) {
      if (s.waiting) {
        const w = s.waiting;
        s.waiting = null;
        s.rejectWaiting = null;
        w({ value, done: false });
      } else {
        s.queue.push(value);
      }
    }
  }

  function finishWaiters(reject: boolean): void {
    for (const s of subs) {
      if (reject && s.rejectWaiting) {
        const r = s.rejectWaiting;
        s.waiting = null;
        s.rejectWaiting = null;
        r(failure!.error);
      } else if (!reject && s.waiting) {
        const w = s.waiting;
        s.waiting = null;
        s.rejectWaiting = null;
        s.done = true;
        w({ value: undefined as never, done: true });
      }
    }
  }

  function close(): void {
    if (closed) return;
    closed = true;
    finishWaiters(false);
  }

  function fail(error: unknown): void {
    if (closed) return;
    closed = true;
    failure = { error };
    finishWaiters(true);
  }

  function subscribe(): AsyncIterableIterator<T> {
    const s: Sub<T> = { queue: [], waiting: null, rejectWaiting: null, done: false };
    subs.add(s);
    const iterator: AsyncIterableIterator<T> = {
      next(): Promise<IteratorResult<T>> {
        if (s.queue.length > 0) {
          return Promise.resolve({ value: s.queue.shift() as T, done: false });
        }
        if (s.done) return Promise.resolve({ value: undefined as never, done: true });
        if (failure) return Promise.reject(failure.error);
        if (closed) {
          s.done = true;
          return Promise.resolve({ value: undefined as never, done: true });
        }
        return new Promise<IteratorResult<T>>((resolve, reject) => {
          s.waiting = resolve;
          s.rejectWaiting = reject;
        });
      },
      return(): Promise<IteratorResult<T>> {
        s.done = true;
        subs.delete(s);
        return Promise.resolve({ value: undefined as never, done: true });
      },
      [Symbol.asyncIterator]() {
        return iterator;
      },
    };
    return iterator;
  }

  return { push, close, fail, subscribe };
}

/** Wrap an iterable factory so iteration triggers `onStart` (lazy pump kick). */
export function lazyAsyncIterable<T>(
  make: () => AsyncIterator<T>,
  onStart: () => void,
): AsyncIterable<T> {
  return {
    [Symbol.asyncIterator](): AsyncIterator<T> {
      onStart();
      return make();
    },
  };
}

/** Project/transform each value of an async iterable, skipping `undefined`. */
export function mapAsyncIterable<T, U>(
  source: AsyncIterable<T>,
  fn: (value: T) => U | undefined,
): AsyncIterable<U> {
  return {
    async *[Symbol.asyncIterator]() {
      for await (const value of source) {
        const mapped = fn(value);
        if (mapped !== undefined) yield mapped;
      }
    },
  };
}
