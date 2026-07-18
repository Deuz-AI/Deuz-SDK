/**
 * useObject — streams `toDeuzObjectStreamResponse` output (`object-delta`
 * parts) into React state. Ported from the frozen `@deuz-sdk/core/react` hook.
 */
import { useCallback, useRef, useState } from 'react';
import type { DeepPartial } from '@deuz-sdk/core';
import { readDeuzStream } from '@deuz-sdk/core/ui';

export interface UseObjectOptions {
  /** Endpoint serving `toDeuzObjectStreamResponse` output. */
  api: string;
  headers?: Record<string, string>;
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
      setObject(undefined);
      try {
        const doFetch = options.fetch ?? fetch;
        const res = await doFetch(options.api, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...options.headers },
          body: JSON.stringify({ input }),
          signal: controller.signal,
        });
        for await (const part of readDeuzStream(res)) {
          if (part.type === 'object-delta') {
            setObject(part.object as DeepPartial<T>);
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
      }
    },
    [options.api, options.fetch, options.headers],
  );

  return { object, isLoading, error, submit, stop };
}
