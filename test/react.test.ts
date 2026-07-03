// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useObject } from '../src/react';

/** Build a Deuz-wire SSE Response from raw data lines (jsdom's Blob lacks .stream()). */
function sseResponseOf(lines: string[]): Response {
  const bytes = new TextEncoder().encode(lines.map((l) => `data: ${l}\n\n`).join(''));
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    }),
    { headers: { 'content-type': 'text/event-stream', 'x-deuz-stream': 'v1' } },
  );
}

describe('useObject', () => {
  it('accumulates object-delta parts and finishes', async () => {
    const bodies: unknown[] = [];
    const fetchMock: typeof fetch = async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return sseResponseOf([
        JSON.stringify({ type: 'start', messageId: 'm1' }),
        JSON.stringify({ type: 'object-delta', object: { city: 'Par' } }),
        JSON.stringify({ type: 'object-delta', object: { city: 'Paris' } }),
        JSON.stringify({ type: 'finish', finishReason: 'stop', usage: { totalTokens: 1 } }),
        '[DONE]',
      ]);
    };
    const { result } = renderHook(() =>
      useObject<{ city: string }>({ api: '/api/object', fetch: fetchMock }),
    );
    expect(result.current.object).toBeUndefined();
    expect(result.current.isLoading).toBe(false);

    await act(async () => {
      await result.current.submit({ prompt: 'capital of France' });
    });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.object).toEqual({ city: 'Paris' });
    expect(result.current.error).toBeUndefined();
    expect(bodies[0]).toEqual({ input: { prompt: 'capital of France' } });
  });

  it('surfaces wire error parts as error state', async () => {
    const fetchMock: typeof fetch = async () =>
      sseResponseOf([JSON.stringify({ type: 'error', message: 'boom' }), '[DONE]']);
    const { result } = renderHook(() => useObject({ api: '/x', fetch: fetchMock }));
    await act(async () => {
      await result.current.submit({});
    });
    await waitFor(() => expect(result.current.error?.message).toBe('boom'));
    expect(result.current.isLoading).toBe(false);
    expect(result.current.object).toBeUndefined();
  });

  it('a rejected fetch becomes error state (not a throw)', async () => {
    const fetchMock: typeof fetch = async () => {
      throw new Error('network down');
    };
    const { result } = renderHook(() => useObject({ api: '/x', fetch: fetchMock }));
    await act(async () => {
      await result.current.submit({});
    });
    await waitFor(() => expect(result.current.error?.message).toBe('network down'));
    expect(result.current.isLoading).toBe(false);
  });
});
