/**
 * finish-gate.test.ts (2.3, F16) — a model turn that the provider refused
 * (`content_filter`, Anthropic `stop_reason: 'refusal'`) or cut off (`length`,
 * `max_tokens`) must never dispatch its `tool_use` parts.
 *
 * Before the gate, a half-streamed `tool_use` whose JSON never closed was parsed
 * into a raw string, executed by both loops, sent back as a string `input`, and a
 * native run went on to report `completed`. Refusal `stop_details` reached only a
 * single-turn `streamChat` finish part, `doneWhen` re-drove a refusal with "keep
 * working", and a thinking-only `max_tokens` turn was stored as `content: []`.
 *
 * The Anthropic wire is replayed offline; the 400 responses that the old shapes
 * would trigger are inferred from Anthropic's documented rules, not live-verified.
 */
import { describe, expect, it, vi } from 'vitest';
import { generateText, streamChat } from '../src/index';
import { createAnthropic } from '../src/anthropic';
import { runAgent } from '../src/agent-run';
import { createMockModel, mockFetchSequence, sseEvents, sseResponse } from '../src/testing';
import type { Message } from '../src/types/message';
import type { StreamPart } from '../src/types/stream';
import type { JSONSchema } from '../src/types/schema';

const WEATHER: JSONSchema = {
  type: 'object',
  properties: { city: { type: 'string' } },
  required: ['city'],
  additionalProperties: false,
};
const STOP_DETAILS = { type: 'refusal', category: 'cyber', explanation: 'declined' };

type Block =
  | { type: 'thinking'; text?: string; signature: string }
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; json: string; close?: boolean };

/** One Anthropic SSE turn built from content blocks and a stop reason. */
function turn(blocks: Block[], stop: string, stopDetails?: unknown): string {
  const events: { event: string; data: unknown }[] = [
    {
      event: 'message_start',
      data: {
        type: 'message_start',
        message: { id: 'msg', role: 'assistant', usage: { input_tokens: 10, output_tokens: 1 } },
      },
    },
  ];
  blocks.forEach((block, index) => {
    if (block.type === 'thinking') {
      events.push({
        event: 'content_block_start',
        data: {
          type: 'content_block_start',
          index,
          content_block: { type: 'thinking', thinking: '', signature: '' },
        },
      });
      if (block.text)
        events.push({
          event: 'content_block_delta',
          data: {
            type: 'content_block_delta',
            index,
            delta: { type: 'thinking_delta', thinking: block.text },
          },
        });
      events.push({
        event: 'content_block_delta',
        data: {
          type: 'content_block_delta',
          index,
          delta: { type: 'signature_delta', signature: block.signature },
        },
      });
    } else if (block.type === 'text') {
      events.push({
        event: 'content_block_start',
        data: { type: 'content_block_start', index, content_block: { type: 'text', text: '' } },
      });
      events.push({
        event: 'content_block_delta',
        data: {
          type: 'content_block_delta',
          index,
          delta: { type: 'text_delta', text: block.text },
        },
      });
    } else {
      events.push({
        event: 'content_block_start',
        data: {
          type: 'content_block_start',
          index,
          content_block: { type: 'tool_use', id: block.id, name: block.name, input: {} },
        },
      });
      events.push({
        event: 'content_block_delta',
        data: {
          type: 'content_block_delta',
          index,
          delta: { type: 'input_json_delta', partial_json: block.json },
        },
      });
    }
    // A block cut off by the stop never receives its content_block_stop.
    if (block.type !== 'tool_use' || block.close !== false)
      events.push({ event: 'content_block_stop', data: { type: 'content_block_stop', index } });
  });
  events.push({
    event: 'message_delta',
    data: {
      type: 'message_delta',
      delta: { stop_reason: stop, ...(stopDetails ? { stop_details: stopDetails } : {}) },
      usage: { output_tokens: 5 },
    },
  });
  events.push({ event: 'message_stop', data: { type: 'message_stop' } });
  return sseEvents(events);
}

const partialCall = (stop: 'refusal' | 'max_tokens'): string =>
  turn(
    [{ type: 'tool_use', id: 'tu1', name: 'get_weather', json: '{"city": "Ro', close: false }],
    stop,
    stop === 'refusal' ? STOP_DETAILS : undefined,
  );
const done = (): string => turn([{ type: 'text', text: 'done' }], 'end_turn');

function anthropic(turns: string[]) {
  const sequence = mockFetchSequence(turns.map((body) => () => sseResponse([body])));
  const model = createAnthropic({ apiKey: 'k', fetch: sequence.fetch })('claude-opus-4-8');
  return { model, calls: sequence.calls };
}

function weatherTool() {
  const execute = vi.fn(() => ({ temp: 20 }));
  return { execute, tools: { get_weather: { parameters: WEATHER, execute } } };
}

function toolUseCount(messages: Message[]): number {
  return messages
    .flatMap((m) => (typeof m.content === 'string' ? [] : m.content))
    .filter((p) => p.type === 'tool_use').length;
}

function emptyTurns(messages: Message[]): Message[] {
  return messages.filter((m) => Array.isArray(m.content) && m.content.length === 0);
}

async function collect(stream: AsyncIterable<StreamPart>): Promise<StreamPart[]> {
  const parts: StreamPart[] = [];
  for await (const part of stream) parts.push(part);
  return parts;
}

describe('finish-reason gate: buffered loop', () => {
  it.each([
    ['refusal', 'content_filter'],
    ['max_tokens', 'length'],
  ] as const)('never executes a tool_use cut off by %s', async (stop, finishReason) => {
    const { model, calls } = anthropic([partialCall(stop), done()]);
    const { execute, tools } = weatherTool();
    const result = await generateText({ model, prompt: 'x', tools, maxSteps: 3 });
    expect(execute).not.toHaveBeenCalled();
    expect(calls).toHaveLength(1);
    expect(result.finishReason).toBe(finishReason);
    expect(toolUseCount(result.response.messages)).toBe(0);
    expect(emptyTurns(result.response.messages)).toEqual([]);
    if (stop === 'refusal') expect(result.stopDetails).toEqual(STOP_DETAILS);
    else expect(result.stopDetails).toBeUndefined();
  });

  it('does not let doneWhen or verifyStep re-drive a refusal', async () => {
    for (const hooks of [
      { doneWhen: () => false },
      { verifyStep: () => ({ ok: false, feedback: 'try again' }) },
    ]) {
      const { model, calls } = anthropic([
        turn([], 'refusal', STOP_DETAILS),
        turn([], 'refusal', STOP_DETAILS),
      ]);
      const result = await generateText({ model, prompt: 'x', maxSteps: 5, ...hooks });
      expect(calls).toHaveLength(1);
      expect(result.finishReason).toBe('content_filter');
      expect(result.stopDetails?.category).toBe('cyber');
    }
  });

  it('surfaces stop details on a single-turn generateText refusal', async () => {
    const { model } = anthropic([turn([{ type: 'text', text: 'No.' }], 'refusal', STOP_DETAILS)]);
    const result = await generateText({ model, prompt: 'x' });
    expect(result).toMatchObject({ finishReason: 'content_filter', stopDetails: STOP_DETAILS });
  });

  it('never stores an empty assistant turn after a thinking-only max_tokens turn', async () => {
    // Display omitted: the thinking block carries a signature and no text.
    const thinkingOnly = (): string => turn([{ type: 'thinking', signature: 'SIG' }], 'max_tokens');
    const single = await generateText({ model: anthropic([thinkingOnly()]).model, prompt: 'x' });
    expect(single.finishReason).toBe('length');
    expect(single.response.messages).toEqual([]);
    const { execute, tools } = weatherTool();
    const looped = await generateText({
      model: anthropic([thinkingOnly()]).model,
      prompt: 'x',
      tools,
    });
    expect(looped.response.messages).toEqual([]);
    expect(execute).not.toHaveBeenCalled();
  });

  it('never executes a tool call whose arguments are not a JSON object', async () => {
    const { execute, tools } = weatherTool();
    // Finished normally (`tool_calls`) but the arguments never parsed.
    const model = createMockModel({
      responses: [
        { toolCalls: [{ toolName: 'get_weather', id: 'bad', args: '{"city": "Ro' }] },
        { text: 'ok' },
      ],
    });
    const result = await generateText({ model, prompt: 'x', tools, maxSteps: 3 });
    expect(execute).not.toHaveBeenCalled();
    expect(result.steps?.[0]?.toolResults).toEqual([
      expect.objectContaining({ toolCallId: 'bad', isError: true }),
    ]);
    expect(String(result.steps?.[0]?.toolResults[0]?.result)).toContain('not a JSON object');
  });

  it('never executes a pending call with unparsed arguments on the settle path', async () => {
    const { execute, tools } = weatherTool();
    const { model } = anthropic([done()]);
    const result = await generateText({
      model,
      tools,
      approvalResponses: [],
      messages: [
        { role: 'user', content: 'x' },
        {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'tu1', name: 'get_weather', input: '{"city": "Ro' }],
        },
      ],
    });
    expect(execute).not.toHaveBeenCalled();
    const answer = result.response.messages[0]!;
    expect(answer.role).toBe('tool');
    expect(answer.content).toEqual([
      expect.objectContaining({ type: 'tool_result', toolUseId: 'tu1', isError: true }),
    ]);
  });
});

describe('finish-reason gate: streaming loop', () => {
  it('ends the run without tool parts and carries the stop details', async () => {
    const { model, calls } = anthropic([partialCall('refusal'), done()]);
    const { execute, tools } = weatherTool();
    const parts = await collect(
      streamChat({ model, prompt: 'x', tools, maxSteps: 3, doneWhen: () => false }).fullStream,
    );
    expect(execute).not.toHaveBeenCalled();
    expect(calls).toHaveLength(1);
    expect(parts.some((p) => p.type === 'tool-call' || p.type === 'tool-result')).toBe(false);
    // The call that started streaming is closed for a UI, never left mid-input.
    expect(
      parts.flatMap((p) => (p.type === 'tool-state' && p.toolCallId === 'tu1' ? [p.state] : [])),
    ).toEqual(['input-streaming', 'error']);
    const stepFinish = parts.find((p) => p.type === 'step-finish');
    expect(stepFinish).toMatchObject({
      finishReason: 'content_filter',
      providerMetadata: { anthropic: { stop_details: STOP_DETAILS } },
    });
    const finish = parts.find((p) => p.type === 'finish');
    expect(finish).toMatchObject({
      finishReason: 'content_filter',
      providerMetadata: { anthropic: { stop_details: STOP_DETAILS } },
    });
    expect(parts.some((p) => p.type === 'false-finish')).toBe(false);
  });

  it('does not let verifyStep re-drive a refusal', async () => {
    const { model, calls } = anthropic([
      turn([], 'refusal', STOP_DETAILS),
      turn([], 'refusal', STOP_DETAILS),
    ]);
    const verifyStep = vi.fn(() => ({ ok: false, feedback: 'try again' }));
    const parts = await collect(
      streamChat({ model, prompt: 'x', maxSteps: 5, verifyStep }).fullStream,
    );
    expect(calls).toHaveLength(1);
    expect(verifyStep).not.toHaveBeenCalled();
    expect(parts.find((p) => p.type === 'finish')).toMatchObject({
      finishReason: 'content_filter',
    });
  });
});

describe('finish-reason gate: native runs', () => {
  it('stops a refused native run with reason refusal and the stop details', async () => {
    const { model, calls } = anthropic([partialCall('refusal'), done()]);
    const { execute, tools } = weatherTool();
    const result = await runAgent({ model, prompt: 'x', tools });
    expect(result).toMatchObject({
      status: 'stopped',
      reason: 'refusal',
      stopDetails: STOP_DETAILS,
    });
    expect(execute).not.toHaveBeenCalled();
    expect(calls).toHaveLength(1);
    expect(toolUseCount(result.messages)).toBe(0);
  });

  it('stops a native run whose tool call was cut off by max_tokens', async () => {
    const { model, calls } = anthropic([partialCall('max_tokens'), done()]);
    const { execute, tools } = weatherTool();
    const result = await runAgent({ model, prompt: 'x', tools });
    expect(result).toMatchObject({ status: 'stopped', reason: 'length' });
    expect(result).not.toHaveProperty('stopDetails');
    expect(execute).not.toHaveBeenCalled();
    expect(calls).toHaveLength(1);
  });

  it('reports a plain-text native refusal as refusal, not completed', async () => {
    const { model } = anthropic([turn([{ type: 'text', text: 'No.' }], 'refusal', STOP_DETAILS)]);
    const verify = vi.fn(() => ({ status: 'verified' as const }));
    const result = await runAgent({ model, prompt: 'x', verify });
    expect(result).toMatchObject({
      status: 'stopped',
      reason: 'refusal',
      stopDetails: STOP_DETAILS,
    });
    expect(verify).not.toHaveBeenCalled();
  });
});
