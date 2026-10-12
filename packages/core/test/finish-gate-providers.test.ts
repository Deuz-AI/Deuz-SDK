/**
 * finish-gate-providers.test.ts (2.3, K4) — the finish-reason gate on the
 * Gemini native and OpenAI Responses wires. A turn that streamed a tool call
 * and was then stopped by the provider's filter must end with
 * `content_filter`, so neither loop and no native run dispatches the call
 * (`finish-gate.test.ts` covers the Anthropic wire).
 *
 * Before K4, a Gemini call masked its turn's SAFETY stop (the STOP-bug guard
 * won), and a Responses turn cut off by its content filter ended with
 * `'tool_calls'`: the gate let the call run. Wire shapes follow
 * `@google/genai` 2.28.0 and `openai` 7.32.0 types; not live-verified.
 */
import { describe, expect, it, vi } from 'vitest';
import { generateText, streamChat } from '../src/index';
import { createGoogleNative } from '../src/google';
import { runAgent } from '../src/agent-run';
import { mockFetchSequence, sseResponse } from './fixtures/sse';
import { GEMINI_CALL, geminiTurn } from './fixtures/provider-finish';
import type { LanguageModel } from '../src/types/model';
import type { Message } from '../src/types/message';
import type { StreamPart } from '../src/types/stream';

interface Wire {
  /** A turn that streams a `get_weather` call, then is stopped by the provider's filter. */
  filtered: string;
  /** A plain answer the loop must never get to ask for. */
  answer: string;
  /** The id the streamed call carries on this wire. */
  callId: (parts: StreamPart[]) => string | undefined;
  model: (fetch: typeof globalThis.fetch) => LanguageModel;
}

const WIRES: Record<string, Wire> = {
  'Gemini native (SAFETY)': {
    filtered: geminiTurn('SAFETY', [GEMINI_CALL]),
    answer: geminiTurn('STOP', [{ text: 'done' }]),
    callId: (parts) =>
      parts.find((p): p is Extract<StreamPart, { type: 'tool-call-delta' }> => {
        return p.type === 'tool-call-delta';
      })?.id,
    model: (fetch) => createGoogleNative({ apiKey: 'AIza-k', fetch })('gemini-2.5-flash'),
  },
};

function scripted(wire: Wire) {
  const sequence = mockFetchSequence(
    [wire.filtered, wire.answer].map((b) => () => sseResponse([b])),
  );
  return { model: wire.model(sequence.fetch), calls: sequence.calls };
}

function weatherTool() {
  const execute = vi.fn(() => ({ temp: 20 }));
  const parameters = {
    type: 'object' as const,
    properties: { city: { type: 'string' as const } },
    required: ['city'],
    additionalProperties: false,
  };
  return { execute, tools: { get_weather: { parameters, execute } } };
}

function toolUseCount(messages: Message[]): number {
  return messages
    .flatMap((m) => (typeof m.content === 'string' ? [] : m.content))
    .filter((p) => p.type === 'tool_use').length;
}

async function collect(stream: AsyncIterable<StreamPart>): Promise<StreamPart[]> {
  const parts: StreamPart[] = [];
  for await (const part of stream) parts.push(part);
  return parts;
}

describe.each(Object.entries(WIRES))('finish-reason gate on the %s wire', (_name, wire) => {
  it('the buffered loop never executes the call and ends with content_filter', async () => {
    const { model, calls } = scripted(wire);
    const { execute, tools } = weatherTool();
    const result = await generateText({ model, prompt: 'x', tools, maxSteps: 3 });
    expect(execute).not.toHaveBeenCalled();
    expect(calls).toHaveLength(1);
    expect(result.finishReason).toBe('content_filter');
    expect(toolUseCount(result.response.messages)).toBe(0);
  });

  it('the streaming loop closes the call without running it', async () => {
    const { model, calls } = scripted(wire);
    const { execute, tools } = weatherTool();
    const parts = await collect(
      streamChat({ model, prompt: 'x', tools, maxSteps: 3, doneWhen: () => false }).fullStream,
    );
    expect(execute).not.toHaveBeenCalled();
    expect(calls).toHaveLength(1);
    expect(parts.some((p) => p.type === 'tool-call' || p.type === 'tool-result')).toBe(false);
    const id = wire.callId(parts);
    expect(id).toBeDefined();
    expect(
      parts.flatMap((p) => (p.type === 'tool-state' && p.toolCallId === id ? [p.state] : [])),
    ).toEqual(['input-streaming', 'error']);
    expect(parts.find((p) => p.type === 'step-finish')).toMatchObject({
      finishReason: 'content_filter',
    });
    expect(parts.find((p) => p.type === 'finish')).toMatchObject({
      finishReason: 'content_filter',
    });
    expect(parts.some((p) => p.type === 'false-finish')).toBe(false);
  });

  it('a native run stops with reason refusal and never executes the call', async () => {
    const { model, calls } = scripted(wire);
    const { execute, tools } = weatherTool();
    const result = await runAgent({ model, prompt: 'x', tools });
    expect(result).toMatchObject({ status: 'stopped', reason: 'refusal' });
    expect(execute).not.toHaveBeenCalled();
    expect(calls).toHaveLength(1);
    expect(toolUseCount(result.messages)).toBe(0);
  });
});
