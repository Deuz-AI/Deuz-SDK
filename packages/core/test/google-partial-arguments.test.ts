import { describe, expect, it, vi } from 'vitest';
import { generateText, streamChat } from '../src/index';
import { runAgent } from '../src/agent-run';
import { createGoogleNative } from '../src/google';
import { createVertexGoogleNative } from '../src/vertex';
import { APICallError, UnsupportedCapabilityError } from '../src/errors';
import { mockFetchSequence, sseEvents, sseResponse } from './fixtures/sse';

// The optional Vertex partial-argument protocol is deliberately fail-closed until
// arguments can be assembled safely. These are injected frames, not live calls.
const providers = [
  {
    name: 'Gemini',
    key: 'google',
    create: (fetch: typeof globalThis.fetch) =>
      createGoogleNative({ apiKey: 'test-key', fetch })('gemini-3.8-flash'),
  },
  {
    name: 'Vertex',
    key: 'vertex-google',
    create: (fetch: typeof globalThis.fetch) =>
      createVertexGoogleNative({
        project: 'test-project',
        location: 'global',
        accessToken: 'test-token',
        fetch,
      })('gemini-3.8-flash'),
  },
];
const complete = { functionCall: { name: 'lookup', args: { key: 'complete' } } };
const partial = {
  functionCall: {
    id: 'provider-A',
    name: 'lookup',
    partialArgs: [{ jsonPath: '$.key', stringValue: 'private-fragment', willContinue: true }],
    willContinue: true,
  },
};
function reply(frames: unknown[][]) {
  return () =>
    sseResponse([
      sseEvents(
        frames.map((parts, i) => ({
          data: {
            candidates: [
              {
                content: { role: 'model', parts },
                ...(i === frames.length - 1 ? { finishReason: 'STOP' } : {}),
              },
            ],
            usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 2, totalTokenCount: 6 },
          },
        })),
      ),
    ]);
}
function tools() {
  const execute = vi.fn((input: unknown) => input);
  return {
    execute,
    definitions: { lookup: { parameters: { type: 'object' as const, properties: {} }, execute } },
  };
}

describe.each(providers)('$name partial function argument boundary', ({ create, key }) => {
  it.each([false, true])(
    'rejects opt-in before HTTP with canonical tools=%s',
    async (withTools) => {
      const transport = mockFetchSequence([reply([[{ text: 'done' }]])]);
      const t = tools();
      const options = {
        providerOptions: {
          [key]: { toolConfig: { functionCallingConfig: { streamFunctionCallArguments: true } } },
        },
      };
      await expect(
        generateText({
          ...options,
          model: create(transport.fetch),
          prompt: 'Look up',
          ...(withTools ? { tools: t.definitions } : {}),
          maxRetries: 0,
        }),
      ).rejects.toBeInstanceOf(UnsupportedCapabilityError);
      expect(transport.calls).toHaveLength(0);
      expect(t.execute).not.toHaveBeenCalled();
      expect(
        options.providerOptions[key]!.toolConfig.functionCallingConfig.streamFunctionCallArguments,
      ).toBe(true);
    },
  );

  it.each([
    { name: 'partial alone', frames: [[partial]] },
    { name: 'complete and partial in one frame', frames: [[complete, partial]] },
    { name: 'complete before partial in a later frame', frames: [[complete], [partial]] },
    {
      name: 'empty partial array',
      frames: [[{ functionCall: { name: 'lookup', partialArgs: [] } }]],
    },
    {
      name: 'final incremental marker without args',
      frames: [[{ functionCall: { name: 'lookup', willContinue: false } }]],
    },
  ])('never executes $name on buffered, streamed or native runs', async ({ frames }) => {
    for (const mode of ['buffered', 'streamed', 'native'] as const) {
      const transport = mockFetchSequence([reply(frames), reply([[{ text: 'done' }]])]);
      const t = tools();
      const options = {
        model: create(transport.fetch),
        prompt: 'Look up',
        tools: t.definitions,
        maxSteps: 3,
        maxRetries: 0,
      };
      if (mode === 'buffered') {
        await expect(generateText(options)).rejects.toBeInstanceOf(APICallError);
      } else if (mode === 'native') {
        let error: unknown;
        try {
          const result = await runAgent(options);
          expect(result.status).not.toBe('completed');
        } catch (caught) {
          error = caught;
        }
        if (error) expect(error).toBeInstanceOf(APICallError);
      } else {
        const output = [];
        for await (const part of streamChat(options).fullStream) output.push(part);
        expect(output.some((part) => part.type === 'error')).toBe(true);
        expect(output.some((part) => part.type === 'tool-result')).toBe(false);
        const failure = output.find((part) => part.type === 'error');
        expect(failure && JSON.stringify(failure)).not.toContain('private-fragment');
      }
      expect(transport.calls, mode).toHaveLength(1);
      expect(t.execute, mode).not.toHaveBeenCalled();
    }
  });

  it('continues to execute complete zero-argument calls without incremental markers', async () => {
    const transport = mockFetchSequence([
      reply([[{ functionCall: { name: 'lookup' } }]]),
      reply([[{ text: 'done' }]]),
    ]);
    const t = tools();
    const result = await generateText({
      model: create(transport.fetch),
      prompt: 'Look up',
      tools: t.definitions,
      maxSteps: 2,
    });
    expect(result.text).toBe('done');
    expect(t.execute).toHaveBeenCalledTimes(1);
    expect(t.execute.mock.calls[0]![0]).toEqual({});
  });

  it('allows explicitly disabled partial streaming and preserves the complete call path', async () => {
    const transport = mockFetchSequence([reply([[{ text: 'done' }]])]);
    await generateText({
      model: create(transport.fetch),
      prompt: 'Explain',
      providerOptions: {
        [key]: { toolConfig: { functionCallingConfig: { streamFunctionCallArguments: false } } },
      },
    });
    expect(transport.calls).toHaveLength(1);
  });
});
