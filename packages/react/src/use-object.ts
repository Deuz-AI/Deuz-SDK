/**
 * useObject — streams `toDeuzObjectStreamResponse` output (`object-delta`
 * parts) into React state. Ported from the frozen `@deuz-sdk/core/react` hook.
 *
 * 1.9 adds the two options `useChat` grew for the same reasons: `onHttpError`
 * (forwarded verbatim to core's `readDeuzStream`) and `throttleMs` — a
 * structured-output stream emits one partial per token, and each partial
 * REPLACES the object wholesale, so an unthrottled render tree rebuilds on
 * every token.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { DeepPartial } from '@deuz-sdk/core';
import { readDeuzStream } from '@deuz-sdk/core/ui';

export interface UseObjectOptions {
  /** Endpoint serving `toDeuzObjectStreamResponse` output. */
  api: string;
  headers?: Record<string, string>;
  /**
   * How a NON-2xx response from `api` is reported (default `'error-part'`,
   * which lands in `error`). Forwarded verbatim to core's `readDeuzStream`.
   */
  onHttpError?: 'error-part' | 'ignore';
  /**
   * Coalesce partials to at most one React commit per `throttleMs` (trailing
   * edge). Default `0` — commit every partial, exactly as 1.8 did. The final
   * partial is ALWAYS flushed, so the completed object is never lost.
   */
  throttleMs?: number;
  /** Injectable for tests / custom transports. Defaults to global fetch. */
  fetch?: typeof fetch;
}

export interface UseObjectResult<T> {
  /** Latest partial (each `object-delta` replaces it wholesale). */
  object: DeepPartial<T> | undefined;
  isLoading: boolean;
  error: Error | undefined;
  /** POSTs `{ input }` to `api` and streams partials into `object`. */
  submit: (input: unknown) => Promise<void>;
  /** Abort the in-flight stream (not an error). */
  stop: () => void;
}

export function useObject<T = unknown>(options: UseObjectOptions): UseObjectResult<T> {
  const [object, setObject] = useState<DeepPartial<T> | undefined>(undefined);
  const [isLoading, setLoading] = useState(false);
  const [error, setError] = useState<Error | undefined>(undefined);
  const abortRef = useRef<AbortController | null>(null);

  // Coalescing plumbing (same trailing-edge shape as `useChat`, one value wide).
  const throttleMs = options.throttleMs ?? 0;
  const latestRef = useRef<DeepPartial<T> | undefined>(undefined);
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const dirtyRef = useRef(false);

  const publish = useCallback((): void => {
    timerRef.current = undefined;
    dirtyRef.current = false;
    setObject(latestRef.current);
  }, []);

  const commit = useCallback(
    (next: DeepPartial<T> | undefined): void => {
      latestRef.current = next;
      if (throttleMs <= 0) {
        publish();
        return;
      }
      dirtyRef.current = true;
      if (timerRef.current === undefined) timerRef.current = setTimeout(publish, throttleMs);
    },
    [throttleMs, publish],
  );

  const flush = useCallback((): void => {
    if (timerRef.current !== undefined) {
      clearTimeout(timerRef.current);
      timerRef.current = undefined;
    }
    if (dirtyRef.current) publish();
  }, [publish]);

  /** A coalesced frame must not fire into an unmounted tree. */
  useEffect(
    () => () => {
      if (timerRef.current !== undefined) clearTimeout(timerRef.current);
    },
    [],
  );

  const stop = useCallback((): void => {
    abortRef.current?.abort();
  }, []);

  const submit = useCallback(
    async (input: unknown): Promise<void> => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      setLoading(true);
      setError(undefined);
      commit(undefined);
      flush(); // clearing the previous object is immediate, never coalesced
      try {
        const doFetch = options.fetch ?? fetch;
        const res = await doFetch(options.api, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...options.headers },
          body: JSON.stringify({ input }),
          signal: controller.signal,
        });
        for await (const part of readDeuzStream(res, {
          ...(options.onHttpError ? { onHttpError: options.onHttpError } : {}),
        })) {
          if (part.type === 'object-delta') {
            commit(part.object as DeepPartial<T>);
          } else if (part.type === 'error') {
            setError(new Error(part.message));
            break;
          }
        }
      } catch (err) {
        if (!controller.signal.aborted) {
          setError(err instanceof Error ? err : new Error(String(err)));
        }
      } finally {
        setLoading(false);
        flush(); // the completed object is never lost to a throttle window
      }
    },
    [options.api, options.fetch, options.headers, options.onHttpError, commit, flush],
  );

  return { object, isLoading, error, submit, stop };
}
