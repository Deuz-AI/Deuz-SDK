/**
 * openai-refusal.test.ts (2.3, K4) — an OpenAI refusal on every path.
 *
 * The model's refusal streams as `delta.refusal` on Chat Completions and as
 * `response.refusal.delta` / `response.refusal.done` on Responses; a final
 * body carries it as `message.refusal` or a `refusal` content part (openai
 * 7.32 types). Before K4 the streaming adapters dropped it, so a refused
 * answer looked like an empty one, while the batch parser kept the text as
 * `providerMetadata.openai.refusal`.
 *
 * Every path now agrees: the turn ends with `content_filter` (as an Anthropic
 * refusal does), the refusal text is the stop's explanation (`stopDetails:
 * { type: 'refusal', explanation }`), and it stays on the finish part as
 * `providerMetadata.openai.refusal`. It never becomes answer text, and an
 * empty or `null` refusal is no refusal. Not live-verified.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  generateObject,
  generateText,
  NoObjectGeneratedError,
  streamChat,
  streamObject,
} from '../src/index';
import { createOpenAI, createOpenAIResponses } from '../src/openai';
import { runAgent } from '../src/agent-run';
import { parseReply } from '../src/batch/parse';
import { applyUIPart, createAssistantTurn, type AssistantTurnState } from '../src/chat';
import { readDeuzStream, toDeuzStreamResponse, type DeuzUIPart } from '../src/ui';
import { mockFetchSequence, sseResponse } from './fixtures/sse';
import { chatTurn, responsesTurn } from './fixtures/provider-finish';
import type { LanguageModel } from '../src/types/model';
import type { StreamPart } from '../src/types/stream';

const TEXT = 'I can’t help with that.';
const REFUSAL = { type: 'refusal', explanation: TEXT };
const messages = [{ role: 'user' as const, content: 'x' }];
const OBJ = {
  type: 'object',
  properties: { answer: { type: 'string' } },
  required: ['answer'],
  additionalProperties: false,
} as const;

interface Wire {
  /** A turn whose whole answer is the refusal, streamed in pieces. */
  refused: string;
  /** A plain answer that a refused run must never get to ask for. */
  answer: string;
  model: (fetch: typeof globalThis.fetch) => LanguageModel;
}

const WIRES: Record<string, Wire> = {
  'Chat Completions': {
    refused: chatTurn({ refusal: ['I can’t ', 'help with that.'], finish: 'stop' }),
    answer: chatTurn({ text: 'done', finish: 'stop' }),
    model: (fetch) => createOpenAI({ apiKey: 'k', fetch })('gpt-5.5'),
  },
  Responses: {
    refused: responsesTurn({ refusal: ['I can’t ', 'help with that.'] }),
    answer: responsesTurn({ text: 'done' }),
    model: (fetch) => createOpenAIResponses({ apiKey: 'k', fetch })('gpt-5.4'),
  },
};

/** The wire's model, answering `turns` in order (the last one repeats). */
function scripted(wire: Wire, ...turns: string[]) {
  const sequence = mockFetchSequence(turns.map((turn) => () => sseResponse([turn])));
  return { model: wire.model(sequence.fetch), calls: sequence.calls };
}

async function collect(stream: AsyncIterable<StreamPart>): Promise<StreamPart[]> {
  const parts: StreamPart[] = [];
  for await (const part of stream) parts.push(part);
  return parts;
}

describe.each(Object.entries(WIRES))('a %s refusal', (_name, wire) => {
  it('streamChat: content_filter, the explanation, and no answer text', async () => {
    const result = streamChat({ model: scripted(wire, wire.refused).model, messages });
    const parts = await collect(result.fullStream);
    expect(await result.finishReason).toBe('content_filter');
    expect(await result.stopDetails).toEqual(REFUSAL);
    expect(parts.find((p) => p.type === 'finish')).toMatchObject({
      finishReason: 'content_filter',
      providerMetadata: { openai: { refusal: TEXT } },
    });
    expect(parts.some((p) => p.type === 'text-delta' && p.text !== '')).toBe(false);
  });

  it('generateText: the same finish and explanation, and no turn to append', async () => {
    const result = await generateText({ model: scripted(wire, wire.refused).model, messages });
    expect(result).toMatchObject({
      text: '',
      finishReason: 'content_filter',
      stopDetails: REFUSAL,
    });
    expect(result.response.messages).toEqual([]);
  });

  it('the loops end on it: no doneWhen re-drive, the step carries the explanation', async () => {
    const execute = vi.fn(() => 'ok');
    const tools = { lookup: { parameters: { type: 'object' as const, properties: {} }, execute } };
    const doneWhen = vi.fn(() => false);
    const buffered = scripted(wire, wire.refused, wire.answer);
    const result = await generateText({ model: buffered.model, messages, tools, doneWhen });
    expect(buffered.calls).toHaveLength(1);
    expect(result).toMatchObject({ finishReason: 'content_filter', stopDetails: REFUSAL });
    expect(result.steps?.at(-1)?.stopDetails).toEqual(REFUSAL);

    const streaming = scripted(wire, wire.refused, wire.answer);
    const stream = streamChat({ model: streaming.model, messages, tools, doneWhen });
    const parts = await collect(stream.fullStream);
    expect(streaming.calls).toHaveLength(1);
    expect(await stream.stopDetails).toEqual(REFUSAL);
    expect(parts.find((p) => p.type === 'step-finish')).toMatchObject({
      finishReason: 'content_filter',
      providerMetadata: { openai: { refusal: TEXT } },
    });
    expect(doneWhen).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it('generateObject: no object, and the error says it was a refusal', async () => {
    const error = await generateObject({
      model: scripted(wire, wire.refused).model,
      messages,
      schema: OBJ,
      mode: 'json',
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NoObjectGeneratedError);
    expect(error).toMatchObject({ finishReason: 'content_filter', stopDetails: REFUSAL, text: '' });
  });

  it('streamObject: the object rejects, finishReason and stopDetails resolve', async () => {
    const result = streamObject({
      model: scripted(wire, wire.refused).model,
      messages,
      schema: OBJ,
      mode: 'json',
    });
    const error = await result.object.catch((e: unknown) => e);
    expect(error).toMatchObject({ finishReason: 'content_filter', stopDetails: REFUSAL });
    expect(await result.finishReason).toBe('content_filter');
    expect(await result.stopDetails).toEqual(REFUSAL);
  });

  it('a native run stops with reason refusal and the explanation', async () => {
    const { model } = scripted(wire, wire.refused, wire.answer);
    const result = await runAgent({ model, prompt: 'x' });
    expect(result).toMatchObject({ status: 'stopped', reason: 'refusal', stopDetails: REFUSAL });
  });

  it('a native run refused at finalization stops the same way, with no output', async () => {
    const { model, calls } = scripted(wire, wire.refused, wire.answer);
    const validate = vi.fn((value: unknown) => value);
    const result = await runAgent({ model, prompt: 'x', output: { schema: OBJ, validate } });
    expect(result).toMatchObject({ status: 'stopped', reason: 'refusal', stopDetails: REFUSAL });
    expect(result).not.toHaveProperty('output');
    expect(validate).not.toHaveBeenCalled();
    expect(calls).toHaveLength(1);
  });

  it('the UI wire carries the explanation to the turn', async () => {
    const result = streamChat({ model: scripted(wire, wire.refused).model, messages });
    const parts: DeuzUIPart[] = [];
    for await (const part of readDeuzStream(toDeuzStreamResponse(result))) parts.push(part);
    expect(parts.find((p) => p.type === 'finish')).toMatchObject({
      finishReason: 'content_filter',
      stopDetails: REFUSAL,
    });
    let turn: AssistantTurnState = createAssistantTurn('m');
    for (const part of parts) turn = applyUIPart(turn, part);
    expect(turn.stopDetails).toEqual(REFUSAL);
  });
});

describe('what is and is not a refusal', () => {
  it('Responses: the done event’s text is the refusal, never doubled', async () => {
    const turn = responsesTurn({ refusal: ['I can'], refusalDone: TEXT });
    const result = await generateText({ model: scripted(WIRES.Responses!, turn).model, messages });
    expect(result.stopDetails).toEqual(REFUSAL);
  });

  it('a null or empty refusal is none: the answer stands, with no metadata', async () => {
    // chatTurn sends `refusal: null` on every content delta, as OpenAI does.
    const cases: [Wire, string][] = [
      [WIRES['Chat Completions']!, chatTurn({ text: 'Hi.', refusal: [''], finish: 'stop' })],
      [WIRES.Responses!, responsesTurn({ text: 'Hi.', refusal: [''] })],
    ];
    for (const [wire, turn] of cases) {
      const result = streamChat({ model: scripted(wire, turn).model, messages });
      const parts = await collect(result.fullStream);
      expect(await result.finishReason).toBe('stop');
      expect(await result.stopDetails).toBeUndefined();
      expect(parts.find((p) => p.type === 'finish')).not.toHaveProperty('providerMetadata');
    }
  });

  it('a refused turn dispatches none of its calls, whatever finish the provider sent', async () => {
    const call = { args: '{"city": "Rome"}' };
    const cases: [Wire, string][] = [
      [WIRES['Chat Completions']!, chatTurn({ refusal: [TEXT], call, finish: 'tool_calls' })],
      [WIRES.Responses!, responsesTurn({ refusal: [TEXT], call })],
    ];
    for (const [wire, turn] of cases) {
      const execute = vi.fn(() => ({ temp: 20 }));
      const parameters = { type: 'object' as const, properties: { city: { type: 'string' } } };
      const { model, calls } = scripted(wire, turn);
      const tools = { get_weather: { parameters, execute } };
      const result = await generateText({ model, messages, tools });
      expect(result).toMatchObject({ finishReason: 'content_filter', stopDetails: REFUSAL });
      expect(execute).not.toHaveBeenCalled();
      expect(calls).toHaveLength(1);
    }
  });

  it('a limit the provider reported stays: a refusal cut off by length ends with length', async () => {
    const chat = chatTurn({ refusal: ['I can’t'], finish: 'length' });
    const result = await generateText({
      model: scripted(WIRES['Chat Completions']!, chat).model,
      messages,
    });
    expect(result).toMatchObject({
      finishReason: 'length',
      stopDetails: { type: 'refusal', explanation: 'I can’t' },
    });
  });

  it('Responses keeps the message phase beside the refusal', async () => {
    const turn = responsesTurn({ refusal: [TEXT], phase: 'final_answer' });
    const result = streamChat({ model: scripted(WIRES.Responses!, turn).model, messages });
    const finish = (await collect(result.fullStream)).find((p) => p.type === 'finish');
    expect(finish).toMatchObject({
      providerMetadata: { openai: { phase: 'final_answer', refusal: TEXT } },
    });
  });
});

describe('batch results agree with the stream', () => {
  it('a Chat Completions refusal', () => {
    const reply = parseReply('chat_completions', {
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: null, refusal: TEXT },
          finish_reason: 'stop',
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    });
    expect(reply).toMatchObject({
      text: '',
      finishReason: 'content_filter',
      stopDetails: REFUSAL,
      providerMetadata: { openai: { refusal: TEXT } },
    });
  });

  it('a Responses refusal', () => {
    const reply = parseReply('responses', {
      status: 'completed',
      output: [
        {
          type: 'message',
          id: 'msg_2',
          role: 'assistant',
          status: 'completed',
          content: [{ type: 'refusal', refusal: TEXT }],
        },
      ],
      usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
    });
    expect(reply).toMatchObject({
      text: '',
      finishReason: 'content_filter',
      stopDetails: REFUSAL,
      providerMetadata: { openai: { refusal: TEXT } },
    });
  });
});
