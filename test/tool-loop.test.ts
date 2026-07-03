import { describe, it, expect, vi } from 'vitest';
import { generateText, streamChat } from '../src/index';
import type { StreamPart } from '../src/types/stream';
import { createAnthropic } from '../src/anthropic';
import { createGoogle } from '../src/google';
import type { JSONSchema } from '../src/types/schema';
import { sseResponse, sseEvents, mockFetchSequence } from './fixtures/sse';

const SCHEMA: JSONSchema = {
  type: 'object',
  properties: { city: { type: 'string' } },
  required: ['city'],
  additionalProperties: false,
};

// --- Anthropic fixtures ---
const ANTHROPIC_TOOL_CALL = sseEvents([
  {
    event: 'message_start',
    data: { type: 'message_start', message: { usage: { input_tokens: 10, output_tokens: 1 } } },
  },
  {
    event: 'content_block_start',
    data: {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'tool_use', id: 'toolu_1', name: 'getWeather' },
    },
  },
  {
    event: 'content_block_delta',
    data: {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'input_json_delta', partial_json: '{"city":' },
    },
  },
  {
    event: 'content_block_delta',
    data: {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'input_json_delta', partial_json: '"Paris"}' },
    },
  },
  { event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } },
  {
    event: 'message_delta',
    data: {
      type: 'message_delta',
      delta: { stop_reason: 'tool_use' },
      usage: { output_tokens: 5 },
    },
  },
  { event: 'message_stop', data: { type: 'message_stop' } },
]);
const ANTHROPIC_FINAL = sseEvents([
  {
    event: 'message_start',
    data: { type: 'message_start', message: { usage: { input_tokens: 20, output_tokens: 1 } } },
  },
  {
    event: 'content_block_start',
    data: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  },
  {
    event: 'content_block_delta',
    data: {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: 'Sunny in Paris.' },
    },
  },
  {
    event: 'message_delta',
    data: {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn' },
      usage: { output_tokens: 6 },
    },
  },
  { event: 'message_stop', data: { type: 'message_stop' } },
]);

describe('agentic tool loop (generateText)', () => {
  it('executes a tool, feeds the result back, and finishes (2 steps)', async () => {
    const weather = vi.fn(async (args: unknown) => ({
      city: (args as { city: string }).city,
      temp: 22,
    }));
    const { fetch, calls } = mockFetchSequence([
      () => sseResponse([ANTHROPIC_TOOL_CALL]),
      () => sseResponse([ANTHROPIC_FINAL]),
    ]);
    const res = await generateText({
      model: createAnthropic({ apiKey: 'k', fetch })('claude-opus-4-8'),
      messages: [{ role: 'user', content: 'weather in Paris?' }],
      tools: { getWeather: { description: 'Get weather', parameters: SCHEMA, execute: weather } },
      maxSteps: 5,
    });

    expect(weather).toHaveBeenCalledTimes(1);
    expect(weather.mock.calls[0]![0]).toEqual({ city: 'Paris' });
    expect(res.steps).toHaveLength(2);
    expect(res.text).toBe('Sunny in Paris.');
    expect(res.usage.totalTokens).toBe(41); // step1 15 + step2 26

    // call 1 sent the tool definition
    const body1 = JSON.parse(String(calls[0]!.init!.body));
    expect(body1.tools[0]).toMatchObject({ name: 'getWeather', input_schema: SCHEMA });

    // call 2 included a tool_result for toolu_1 (Anthropic: every tool_use answered)
    const body2 = JSON.parse(String(calls[1]!.init!.body));
    const hasResult = body2.messages.some(
      (m: { content: unknown }) =>
        Array.isArray(m.content) &&
        m.content.some(
          (b: { type?: string; tool_use_id?: string }) =>
            b.type === 'tool_result' && b.tool_use_id === 'toolu_1',
        ),
    );
    expect(hasResult).toBe(true);
  });

  it('GEMINI GUARD: loops even when finish_reason is "stop" with a tool call', async () => {
    const GEMINI_TOOL_STOP = sseEvents([
      {
        data: {
          choices: [
            {
              delta: {
                tool_calls: [
                  { index: 0, id: 'call_1', function: { name: 'getWeather', arguments: '' } },
                ],
              },
              finish_reason: null,
            },
          ],
        },
      },
      {
        data: {
          choices: [
            {
              delta: { tool_calls: [{ index: 0, function: { arguments: '{"city":"Paris"}' } }] },
              finish_reason: 'stop',
            },
          ],
        },
      }, // BUG: stop + tool call
      { data: { choices: [], usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } } },
      { data: '[DONE]' },
    ]);
    const GEMINI_FINAL = sseEvents([
      { data: { choices: [{ delta: { content: 'Sunny.' }, finish_reason: 'stop' }] } },
      {
        data: { choices: [], usage: { prompt_tokens: 8, completion_tokens: 2, total_tokens: 10 } },
      },
      { data: '[DONE]' },
    ]);
    const weather = vi.fn(async () => ({ ok: true }));
    const { fetch } = mockFetchSequence([
      () => sseResponse([GEMINI_TOOL_STOP]),
      () => sseResponse([GEMINI_FINAL]),
    ]);
    const res = await generateText({
      model: createGoogle({ apiKey: 'k', fetch })('gemini-3.5-flash'),
      messages: [{ role: 'user', content: 'weather?' }],
      tools: { getWeather: { parameters: SCHEMA, execute: weather } },
      maxSteps: 5,
    });
    expect(weather).toHaveBeenCalledTimes(1); // continued despite finish_reason 'stop'
    expect(res.steps).toHaveLength(2);
    expect(res.text).toBe('Sunny.');
  });

  it('RUNAWAY GUARD: a tool that always throws stops after 3 errors (self-healed)', async () => {
    const failing = vi.fn(async () => {
      throw new Error('boom');
    });
    const { fetch } = mockFetchSequence([() => sseResponse([ANTHROPIC_TOOL_CALL])]); // always a tool call
    const res = await generateText({
      model: createAnthropic({ apiKey: 'k', fetch })('claude-opus-4-8'),
      messages: [{ role: 'user', content: 'go' }],
      tools: { getWeather: { parameters: SCHEMA, execute: failing } },
      maxSteps: 10,
    });
    expect(failing).toHaveBeenCalledTimes(3);
    expect(res.steps).toHaveLength(3);
  });

  it('round-trips Gemini thought_signature (extra_content) across the loop', async () => {
    const GEMINI_TOOL = sseEvents([
      {
        data: {
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: 'call_1',
                    function: { name: 'getWeather', arguments: '{"city":"Paris"}' },
                    extra_content: { google: { thought_signature: 'SIG123' } },
                  },
                ],
              },
              finish_reason: 'stop',
            },
          ],
        },
      },
      { data: { choices: [], usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } } },
      { data: '[DONE]' },
    ]);
    const GEMINI_FINAL = sseEvents([
      { data: { choices: [{ delta: { content: 'Sunny.' }, finish_reason: 'stop' }] } },
      {
        data: { choices: [], usage: { prompt_tokens: 8, completion_tokens: 2, total_tokens: 10 } },
      },
      { data: '[DONE]' },
    ]);
    const weather = vi.fn(async () => ({ ok: true }));
    const { fetch, calls } = mockFetchSequence([
      () => sseResponse([GEMINI_TOOL]),
      () => sseResponse([GEMINI_FINAL]),
    ]);
    await generateText({
      model: createGoogle({ apiKey: 'k', fetch })('gemini-3.5-flash'),
      messages: [{ role: 'user', content: 'weather?' }],
      tools: { getWeather: { parameters: SCHEMA, execute: weather } },
      maxSteps: 5,
    });
    // call 2 must echo the thought_signature or Gemini 400s.
    const body2 = JSON.parse(String(calls[1]!.init!.body));
    const assistant = body2.messages.find(
      (m: { role: string; tool_calls?: unknown }) => m.role === 'assistant' && m.tool_calls,
    );
    expect(assistant.tool_calls[0].extra_content).toEqual({
      google: { thought_signature: 'SIG123' },
    });
  });

  it('without tools, generateText is unchanged (single turn)', async () => {
    const { fetch } = mockFetchSequence([() => sseResponse([ANTHROPIC_FINAL])]);
    const res = await generateText({
      model: createAnthropic({ apiKey: 'k', fetch })('claude-opus-4-8'),
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(res.text).toBe('Sunny in Paris.');
    expect(res.steps).toBeUndefined();
  });
});

describe('tool approval — server mode (approveToolCall)', () => {
  it('approved: the tool executes and the loop continues (2 steps)', async () => {
    const weather = vi.fn(async () => ({ temp: 22 }));
    const approve = vi.fn(async () => true);
    const { fetch } = mockFetchSequence([
      () => sseResponse([ANTHROPIC_TOOL_CALL]),
      () => sseResponse([ANTHROPIC_FINAL]),
    ]);
    const res = await generateText({
      model: createAnthropic({ apiKey: 'k', fetch })('claude-opus-4-8'),
      messages: [{ role: 'user', content: 'weather?' }],
      tools: {
        getWeather: { parameters: SCHEMA, execute: weather, needsApproval: true },
      },
      approveToolCall: approve,
      maxSteps: 5,
    });
    expect(approve).toHaveBeenCalledTimes(1);
    expect(approve.mock.calls[0]![0]).toMatchObject({
      toolCallId: 'toolu_1',
      toolName: 'getWeather',
    });
    expect(weather).toHaveBeenCalledTimes(1);
    expect(res.steps).toHaveLength(2);
    expect(res.text).toBe('Sunny in Paris.');
  });

  it('denied: execute is NOT called, the model sees an is_error tool_result', async () => {
    const weather = vi.fn(async () => ({ temp: 22 }));
    const { fetch, calls } = mockFetchSequence([
      () => sseResponse([ANTHROPIC_TOOL_CALL]),
      () => sseResponse([ANTHROPIC_FINAL]),
    ]);
    const res = await generateText({
      model: createAnthropic({ apiKey: 'k', fetch })('claude-opus-4-8'),
      messages: [{ role: 'user', content: 'weather?' }],
      tools: {
        getWeather: { parameters: SCHEMA, execute: weather, needsApproval: true },
      },
      approveToolCall: () => false,
      maxSteps: 5,
    });
    expect(weather).not.toHaveBeenCalled();
    expect(res.steps).toHaveLength(2); // loop CONTINUED after the denial
    const body2 = String(calls[1]!.init!.body);
    expect(body2).toContain('Tool call denied.');
    expect(
      JSON.parse(body2).messages.some(
        (m: { content: unknown }) =>
          Array.isArray(m.content) &&
          m.content.some(
            (b: { type?: string; is_error?: boolean }) =>
              b.type === 'tool_result' && b.is_error === true,
          ),
      ),
    ).toBe(true);
  });

  it('denials do NOT count toward the runaway error guard', async () => {
    const weather = vi.fn(async () => ({ temp: 22 }));
    const { fetch, calls } = mockFetchSequence([() => sseResponse([ANTHROPIC_TOOL_CALL])]); // always a tool call
    const res = await generateText({
      model: createAnthropic({ apiKey: 'k', fetch })('claude-opus-4-8'),
      messages: [{ role: 'user', content: 'go' }],
      tools: {
        getWeather: { parameters: SCHEMA, execute: weather, needsApproval: true },
      },
      approveToolCall: () => false,
      maxSteps: 5,
    });
    // 5 denials, 5 steps — MAX_SAME_TOOL_ERRORS (3) must NOT have tripped.
    expect(res.steps).toHaveLength(5);
    expect(calls).toHaveLength(5);
    expect(weather).not.toHaveBeenCalled();
  });

  it('predicate form receives parsed args + ctx; a THROWING predicate requires approval', async () => {
    const weather = vi.fn(async () => ({ temp: 22 }));
    const predicate = vi.fn((args: unknown) => (args as { city: string }).city === 'Paris');
    const approve = vi.fn(async () => true);
    const { fetch } = mockFetchSequence([
      () => sseResponse([ANTHROPIC_TOOL_CALL]),
      () => sseResponse([ANTHROPIC_FINAL]),
    ]);
    await generateText({
      model: createAnthropic({ apiKey: 'k', fetch })('claude-opus-4-8'),
      messages: [{ role: 'user', content: 'weather?' }],
      tools: {
        getWeather: { parameters: SCHEMA, execute: weather, needsApproval: predicate },
      },
      approveToolCall: approve,
      maxSteps: 5,
    });
    expect(predicate).toHaveBeenCalledTimes(1);
    expect(predicate.mock.calls[0]![0]).toEqual({ city: 'Paris' });
    expect(predicate.mock.calls[0]![1]).toMatchObject({ toolCallId: 'toolu_1' });
    expect(approve).toHaveBeenCalledTimes(1); // predicate said yes → approver consulted

    // Throwing predicate → safe side: approval required (approver consulted again).
    const approve2 = vi.fn(async () => true);
    const { fetch: fetch2 } = mockFetchSequence([
      () => sseResponse([ANTHROPIC_TOOL_CALL]),
      () => sseResponse([ANTHROPIC_FINAL]),
    ]);
    await generateText({
      model: createAnthropic({ apiKey: 'k', fetch: fetch2 })('claude-opus-4-8'),
      messages: [{ role: 'user', content: 'weather?' }],
      tools: {
        getWeather: {
          parameters: SCHEMA,
          execute: weather,
          needsApproval: () => {
            throw new Error('predicate exploded');
          },
        },
      },
      approveToolCall: approve2,
      maxSteps: 5,
    });
    expect(approve2).toHaveBeenCalledTimes(1);
  });

  it('a THROWING approveToolCall is a denial (safe side)', async () => {
    const weather = vi.fn(async () => ({ temp: 22 }));
    const { fetch, calls } = mockFetchSequence([
      () => sseResponse([ANTHROPIC_TOOL_CALL]),
      () => sseResponse([ANTHROPIC_FINAL]),
    ]);
    await generateText({
      model: createAnthropic({ apiKey: 'k', fetch })('claude-opus-4-8'),
      messages: [{ role: 'user', content: 'weather?' }],
      tools: {
        getWeather: { parameters: SCHEMA, execute: weather, needsApproval: true },
      },
      approveToolCall: () => {
        throw new Error('approver exploded');
      },
      maxSteps: 5,
    });
    expect(weather).not.toHaveBeenCalled();
    expect(String(calls[1]!.init!.body)).toContain('Tool call denied.');
  });
});

describe('agentic tool loop (streamChat)', () => {
  it('emits one fullStream across steps with step + tool parts', async () => {
    const weather = vi.fn(async () => ({ temp: 22 }));
    const { fetch } = mockFetchSequence([
      () => sseResponse([ANTHROPIC_TOOL_CALL]),
      () => sseResponse([ANTHROPIC_FINAL]),
    ]);
    const result = streamChat({
      model: createAnthropic({ apiKey: 'k', fetch })('claude-opus-4-8'),
      messages: [{ role: 'user', content: 'weather?' }],
      tools: { getWeather: { parameters: SCHEMA, execute: weather } },
      maxSteps: 5,
    });

    const types: StreamPart['type'][] = [];
    let text = '';
    for await (const part of result.fullStream) {
      types.push(part.type);
      if (part.type === 'text-delta') text += part.text;
    }

    expect(weather).toHaveBeenCalledTimes(1);
    expect(types[0]).toBe('step-start');
    expect(types.filter((t) => t === 'step-start')).toHaveLength(2);
    expect(types).toContain('tool-call');
    expect(types).toContain('tool-result');
    expect(types.at(-1)).toBe('finish');
    expect(text).toBe('Sunny in Paris.'); // only the final step has text
    expect((await result.usage).totalTokens).toBe(41);
  });
});
