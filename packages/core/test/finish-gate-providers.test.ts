/**
 * finish-gate-providers.test.ts (2.3, K4) — the finish-reason gate on the
 * Gemini native, OpenAI Responses and Chat Completions wires. A turn that
 * streamed a tool call and was then stopped by the provider's filter must end
 * with `content_filter`, so neither loop and no native run dispatches the call
 * (`finish-gate.test.ts` covers the Anthropic wire).
 *
 * Before K4, a Gemini call masked its turn's SAFETY stop (the STOP-bug guard
 * won), and a Responses turn cut off by its content filter ended with
 * `'tool_calls'`: the gate let the call run. Chat Completions' `content_filter`
 * was already mapped, without a fixture. Wire shapes follow `@google/genai`
 * 2.28.0 and `openai` 7.32.0 types; not live-verified.
 *
 * The Gemini stops that leave no usable answer (`OTHER`,
 * `MALFORMED_FUNCTION_CALL`, ...) are not gated: they end with 'stop', or
 * 'tool_calls' after a call, as in 2.2 (K4 review V7-2).
 */
import { describe, expect, it, vi } from 'vitest';
import { generateText, streamChat } from '../src/index';
import { createGoogleNative } from '../src/google';
import { createOpenAI, createOpenAIResponses } from '../src/openai';
import { runAgent, streamAgent } from '../src/agent-run';
import { mockFetchSequence, sseResponse } from './fixtures/sse';
import {
  GEMINI_CALL,
  GEMINI_STOPS_WITHOUT_ANSWER,
  chatTurn,
  geminiTurn,
  responsesTurn,
} from './fixtures/provider-finish';
import type { LanguageModel } from '../src/types/model';
import type { Message } from '../src/types/message';
import type { StreamPart, ToolCallDeltaPart } from '../src/types/stream';

interface Wire {
  /** A turn that streams a `get_weather` call, then is stopped by the provider's filter. */
  filtered: string;
  /** A plain answer the loop must never get to ask for. */
  answer: string;
  model: (fetch: typeof globalThis.fetch) => LanguageModel;
}

const WIRES: Record<string, Wire> = {
  'Gemini native (SAFETY)': {
    filtered: geminiTurn('SAFETY', [GEMINI_CALL]),
    answer: geminiTurn('STOP', [{ text: 'done' }]),
    model: (fetch) => createGoogleNative({ apiKey: 'AIza-k', fetch })('gemini-2.5-flash'),
  },
  'OpenAI Responses (incomplete: content_filter)': {
    filtered: responsesTurn({ call: { args: '{"city": "Ro' }, incomplete: 'content_filter' }),
    answer: responsesTurn({ text: 'done' }),
    model: (fetch) => createOpenAIResponses({ apiKey: 'k', fetch })('gpt-5.4'),
  },
  'OpenAI Chat Completions (finish_reason: content_filter)': {
    filtered: chatTurn({ call: { args: '{"city": "Ro' }, finish: 'content_filter' }),
    answer: chatTurn({ text: 'done', finish: 'stop' }),
    model: (fetch) => createOpenAI({ apiKey: 'k', fetch })('gpt-5.5'),
  },
};

/** The id of the first call the stream started. */
function firstCallId(parts: StreamPart[]): string | undefined {
  return parts.find((p): p is ToolCallDeltaPart => p.type === 'tool-call-delta')?.id;
}

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
    const id = firstCallId(parts);
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

// K4 review V7-2: K4 had mapped these stops to 'error', so a native run
// stopped with reason 'error' after one request, without an error part, where
// 2.2 went on through output repair or finalization. 2.3 keeps 2.2's mapping.
describe('a Gemini stop without a usable answer is not gated', () => {
  const OBJ = {
    type: 'object',
    properties: { answer: { type: 'string' } },
    required: ['answer'],
    additionalProperties: false,
  } as const;
  const ANSWER = geminiTurn('STOP', [{ text: '{"answer":"ok"}' }]);

  /** A Gemini model answering `turns` in order. */
  function gemini(...turns: string[]) {
    const sequence = mockFetchSequence(turns.map((turn) => () => sseResponse([turn])));
    return {
      model: createGoogleNative({ apiKey: 'AIza-k', fetch: sequence.fetch })('gemini-2.5-flash'),
      calls: sequence.calls,
    };
  }

  function output() {
    const validate = vi.fn((value: unknown) => {
      if (typeof (value as { answer?: unknown })?.answer !== 'string') throw new Error('no answer');
      return value as { answer: string };
    });
    return { schema: OBJ, validate };
  }

  it.each(GEMINI_STOPS_WITHOUT_ANSWER)(
    '%s after a call: the turn ends with tool_calls and the call runs, as in 2.2',
    async (reason) => {
      const { model, calls } = gemini(geminiTurn(reason, [GEMINI_CALL]), ANSWER);
      const { execute, tools } = weatherTool();
      const result = await generateText({ model, prompt: 'x', tools, maxSteps: 3 });
      expect(execute).toHaveBeenCalledTimes(1);
      expect(calls).toHaveLength(2);
      expect(result.steps?.map((s) => s.finishReason)).toEqual(['tool_calls', 'stop']);
    },
  );

  it.each(GEMINI_STOPS_WITHOUT_ANSWER)(
    '%s at finalization: the structured run re-asks through output repair and completes',
    async (reason) => {
      const { model, calls } = gemini(geminiTurn(reason, []), ANSWER);
      const result = await runAgent({ model, prompt: 'x', output: output() });
      expect(result).toMatchObject({ status: 'completed', output: { answer: 'ok' } });
      expect(calls).toHaveLength(2);
      expect(String(calls[1]!.init!.body)).toContain('The final output failed validation');
    },
  );

  it('a loop turn that ends OTHER ends the loop, and finalization answers', async () => {
    const { model, calls } = gemini(geminiTurn('OTHER', []), ANSWER);
    const { execute, tools } = weatherTool();
    const result = await runAgent({ model, prompt: 'x', tools, output: output() });
    expect(result).toMatchObject({ status: 'completed', output: { answer: 'ok' } });
    expect(execute).not.toHaveBeenCalled();
    expect(calls).toHaveLength(2);
  });

  it('streamAgent carries no error part, and each finish part names its stop', async () => {
    const { model } = gemini(geminiTurn('OTHER', []), ANSWER);
    const stream = streamAgent({ model, prompt: 'x', output: output() });
    const types: string[] = [];
    const raw: unknown[] = [];
    for await (const event of stream.events) {
      if (event.type !== 'part') continue;
      types.push(event.part.type);
      if (event.part.type === 'finish') raw.push(event.part.providerMetadata);
    }
    expect(types).not.toContain('error');
    expect(raw).toEqual([
      { google: { finishReason: 'OTHER' } },
      { google: { finishReason: 'STOP' } },
    ]);
    expect(await stream.result).toMatchObject({ status: 'completed', output: { answer: 'ok' } });
  });
});
