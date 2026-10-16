import { describe, expect, it, vi } from 'vitest';
import { generateText, streamChat } from '../src/index';
import {
  createGoogleNative,
  type GoogleContinuationCheckpoint,
  type GoogleContinuationHandler,
} from '../src/google';
import { createVertexGoogleNative } from '../src/vertex';
import { readDeuzStream, toDeuzStreamResponse } from '../src/ui';
import { saveGoogleContinuation } from '../src/internal/google-continuation';
import { mockFetchSequence, sseEvents, sseResponse } from './fixtures/sse';

const token = 'opaque-private-checkpoint-token';
function reply(finishReason?: string, continuationToken: unknown = token, blocked = false) {
  return () =>
    sseResponse([
      sseEvents([
        {
          data: {
            candidates: [
              {
                content: { role: 'model', parts: [{ text: 'partial answer' }] },
                ...(finishReason ? { finishReason } : {}),
                ...(continuationToken === undefined ? {} : { continuationToken }),
              },
            ],
            usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 2, totalTokenCount: 6 },
            ...(blocked ? { promptFeedback: { blockReason: 'SAFETY' } } : {}),
          },
        },
      ]),
    ]);
}
const providers = [
  {
    name: 'Gemini',
    version: 'v1beta',
    create: (
      fetch: typeof globalThis.fetch,
      onContinuationCheckpoint?: GoogleContinuationHandler,
    ) =>
      createGoogleNative({
        apiKey: 'private-key-not-in-checkpoint',
        fetch,
        onContinuationCheckpoint,
      })('gemini-4-argon'),
  },
  {
    name: 'Vertex',
    version: 'v1',
    create: (
      fetch: typeof globalThis.fetch,
      onContinuationCheckpoint?: GoogleContinuationHandler,
    ) =>
      createVertexGoogleNative({
        project: 'test-project',
        location: 'global',
        accessToken: 'private-key-not-in-checkpoint',
        fetch,
        onContinuationCheckpoint,
      })('gemini-4-argon'),
  },
];

describe.each(providers)('$name opt-in terminal continuation capture', ({ create, version }) => {
  it.each(['CONTINUATION', 'MAX_TOKENS'])(
    'captures %s with the exact request and hop usage, without another HTTP request',
    async (finishReason) => {
      const transport = mockFetchSequence([reply(finishReason)]);
      const checkpoints: GoogleContinuationCheckpoint[] = [];
      let stored = false;
      const handler: GoogleContinuationHandler = async (checkpoint) => {
        await Promise.resolve();
        checkpoints.push(JSON.parse(JSON.stringify(checkpoint)));
        stored = true;
        // Host mutation must not mutate the call or its returned usage.
        checkpoint.request.contents = [];
        checkpoint.usage.outputTokens = 999;
      };
      const model = create(transport.fetch, handler);
      const result = await generateText({
        model,
        instructions: 'Private original instructions',
        prompt: 'Long task',
        maxOutputTokens: 8192,
      });
      expect(stored).toBe(true);
      expect(transport.calls).toHaveLength(1);
      expect(checkpoints).toHaveLength(1);
      expect(checkpoints[0]).toMatchObject({
        continuationToken: token,
        finishReason,
        modelId: 'gemini-4-argon',
        apiVersion: version,
        usage: { outputTokens: 2 },
      });
      expect(checkpoints[0]!.request).toEqual(JSON.parse(String(transport.calls[0]!.init!.body)));
      expect(checkpoints[0]!.request.generationConfig).toMatchObject({ maxOutputTokens: 8192 });
      expect(result.finishReason).toBe('length');
      expect(result.usage.outputTokens).toBe(2);
      expect(JSON.stringify(checkpoints)).not.toContain('private-key-not-in-checkpoint');
      expect(JSON.stringify(model)).not.toContain('onContinuationCheckpoint');
      expect(JSON.stringify(result)).not.toContain(token);
    },
  );

  it('does not leak the token or private request through public UI frames', async () => {
    const transport = mockFetchSequence([reply('CONTINUATION')]);
    const handler = vi.fn();
    const frames = [];
    for await (const frame of readDeuzStream(
      toDeuzStreamResponse(
        streamChat({
          model: create(transport.fetch, handler),
          instructions: 'PRIVATE_INPUT_MARKER',
          prompt: 'Explain',
        }),
      ),
    ))
      frames.push(frame);
    expect(handler).toHaveBeenCalledTimes(1);
    const json = JSON.stringify(frames);
    expect(json).not.toContain(token);
    expect(json).not.toContain('PRIVATE_INPUT_MARKER');
    expect(json).not.toContain('private-key-not-in-checkpoint');
    expect(json).toContain('automaticContinuation');
    expect(transport.calls).toHaveLength(1);
  });

  it('leaves capture disabled by default and reports an incomplete continuation boundary', async () => {
    const transport = mockFetchSequence([reply('CONTINUATION')]);
    const result = await generateText({ model: create(transport.fetch), prompt: 'Explain' });
    expect(result.finishReason).toBe('length');
    expect(result.warnings).toContainEqual(
      expect.objectContaining({ setting: 'automaticContinuation', type: 'unsupported-setting' }),
    );
    expect(JSON.stringify(result)).not.toContain(token);
    expect(transport.calls).toHaveLength(1);
  });

  it.each([
    { name: 'STOP', finish: 'STOP', token, blocked: false },
    { name: 'SAFETY', finish: 'SAFETY', token, blocked: false },
    { name: 'blocked prompt', finish: 'CONTINUATION', token, blocked: true },
    { name: 'missing finish', finish: undefined, token, blocked: false },
    { name: 'missing token', finish: 'CONTINUATION', token: null, blocked: false },
    { name: 'empty token', finish: 'CONTINUATION', token: '', blocked: false },
    { name: 'malformed token', finish: 'CONTINUATION', token: { private: true }, blocked: false },
  ])('does not offer stale or invalid state for $name', async (value) => {
    const transport = mockFetchSequence([reply(value.finish, value.token, value.blocked)]);
    const handler = vi.fn();
    await generateText({ model: create(transport.fetch, handler), prompt: 'Explain' });
    expect(handler).not.toHaveBeenCalled();
    expect(transport.calls).toHaveLength(1);
  });

  it('does not present an earlier in-flight token as a terminal checkpoint', async () => {
    const transport = mockFetchSequence([
      () =>
        sseResponse([
          sseEvents([
            {
              data: {
                candidates: [
                  {
                    content: { role: 'model', parts: [{ text: 'before' }] },
                    continuationToken: token,
                  },
                ],
              },
            },
            {
              data: {
                candidates: [
                  {
                    content: { role: 'model', parts: [{ text: 'after' }] },
                    finishReason: 'CONTINUATION',
                  },
                ],
              },
            },
          ]),
        ]),
    ]);
    const handler = vi.fn();
    const result = await generateText({
      model: create(transport.fetch, handler),
      prompt: 'Explain',
    });
    expect(result.finishReason).toBe('length');
    expect(handler).not.toHaveBeenCalled();
  });

  it('enforces the overall deadline while waiting for storage', async () => {
    const transport = mockFetchSequence([reply('CONTINUATION')]);
    let expire: (() => void) | undefined;
    const handler = vi.fn<GoogleContinuationHandler>(() => {
      expect(expire).toBeTypeOf('function');
      expire!();
      return new Promise<void>(() => {});
    });
    const result = generateText({
      model: create(transport.fetch, handler),
      prompt: 'Explain',
      timeout: { totalMs: 25, ttftMs: 1000, chunkMs: 1000 },
      deps: {
        clock: {
          now: () => 0,
          setTimeout: (callback, milliseconds) => {
            if (milliseconds === 25) expire = callback;
            return () => {};
          },
        },
      },
      maxRetries: 2,
    });
    await expect(result).rejects.toMatchObject({ name: 'TimeoutError' });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0]![1].aborted).toBe(true);
    expect(transport.calls).toHaveLength(1);
  });

  it('fails without copying private data from a checkpoint-storage exception or retrying', async () => {
    const transport = mockFetchSequence([reply('CONTINUATION')]);
    const handler = vi.fn(() => {
      throw new Error(token);
    });
    const failure = generateText({
      model: create(transport.fetch, handler),
      prompt: 'Explain',
      maxRetries: 2,
    });
    await expect(failure).rejects.toThrow('checkpoint handler failed');
    await failure.catch((error) => expect(JSON.stringify(error)).not.toContain(token));
    expect(handler).toHaveBeenCalledTimes(1);
    expect(transport.calls).toHaveLength(1);
  });

  it('never executes tools from a turn ending at a continuation boundary', async () => {
    const execute = vi.fn(() => 'side effect');
    const transport = mockFetchSequence([
      () =>
        sseResponse([
          sseEvents([
            {
              data: {
                candidates: [
                  {
                    content: {
                      role: 'model',
                      parts: [{ functionCall: { name: 'change', args: {} } }],
                    },
                    finishReason: 'CONTINUATION',
                    continuationToken: token,
                  },
                ],
                usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 2, totalTokenCount: 6 },
              },
            },
          ]),
        ]),
    ]);
    const handler = vi.fn();
    const result = await generateText({
      model: create(transport.fetch, handler),
      prompt: 'Change',
      tools: { change: { parameters: { type: 'object', properties: {} }, execute } },
      maxSteps: 3,
    });
    expect(execute).not.toHaveBeenCalled();
    expect(result.finishReason).toBe('length');
    expect(handler).toHaveBeenCalledTimes(1);
    expect(transport.calls).toHaveLength(1);
  });
});

describe('checkpoint storage respects cancellation', () => {
  it('does not call storage after an existing abort', async () => {
    const controller = new AbortController();
    controller.abort(new Error('cancelled'));
    const handler = vi.fn();
    await expect(
      saveGoogleContinuation(handler, {} as GoogleContinuationCheckpoint, controller.signal),
    ).rejects.toThrow('cancelled');
    expect(handler).not.toHaveBeenCalled();
  });
  it('interrupts an unresponsive storage callback without starting another hop', async () => {
    const controller = new AbortController();
    const handler = vi.fn(() => new Promise<void>(() => {}));
    const saved = saveGoogleContinuation(
      handler,
      {} as GoogleContinuationCheckpoint,
      controller.signal,
    );
    await Promise.resolve();
    controller.abort(new Error('cancelled'));
    await expect(saved).rejects.toThrow('cancelled');
    expect(handler).toHaveBeenCalledTimes(1);
  });
});
