import { describe, it, expect, vi } from 'vitest';
import { generateText, streamChat } from '../src/index';
import type { StreamPart } from '../src/types/stream';
import { createAnthropic } from '../src/anthropic';
import { createGoogle } from '../src/google';
import type { JSONSchema } from '../src/types/schema';
import type { Clock } from '../src/types/deps';
import { sseResponse, sseEvents, mockFetchSequence } from './fixtures/sse';
import { createMockModel } from '../src/testing';

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
    const approve = vi.fn(async (_call: unknown) => true);
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
    const predicate = vi.fn(
      (args: unknown, _ctx: unknown) => (args as { city: string }).city === 'Paris',
    );
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

// Two tool_use blocks in one turn: a gated server tool + a client tool.
const ANTHROPIC_TWO_TOOLS = sseEvents([
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
      delta: { type: 'input_json_delta', partial_json: '{"city":"Paris"}' },
    },
  },
  { event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } },
  {
    event: 'content_block_start',
    data: {
      type: 'content_block_start',
      index: 1,
      content_block: { type: 'tool_use', id: 'toolu_2', name: 'askUser' },
    },
  },
  {
    event: 'content_block_delta',
    data: {
      type: 'content_block_delta',
      index: 1,
      delta: { type: 'input_json_delta', partial_json: '{"q":"ok?"}' },
    },
  },
  { event: 'content_block_stop', data: { type: 'content_block_stop', index: 1 } },
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

describe('tool approval — client mode (no approveToolCall)', () => {
  it('buffered: breaks the loop and returns pendingApprovals', async () => {
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
      maxSteps: 5,
    });
    expect(calls).toHaveLength(1); // broke after step 1
    expect(weather).not.toHaveBeenCalled();
    expect(res.pendingApprovals).toEqual([
      {
        approvalId: 'toolu_1',
        toolCallId: 'toolu_1',
        toolName: 'getWeather',
        input: { city: 'Paris' },
      },
    ]);
    expect(res.finishReason).toBe('tool_calls');
    expect(res.toolResults).toEqual([]);
  });

  it('mixed batch: one break; pendingApprovals lists ONLY the gated call', async () => {
    const weather = vi.fn(async () => ({ temp: 22 }));
    const { fetch, calls } = mockFetchSequence([() => sseResponse([ANTHROPIC_TWO_TOOLS])]);
    const res = await generateText({
      model: createAnthropic({ apiKey: 'k', fetch })('claude-opus-4-8'),
      messages: [{ role: 'user', content: 'weather?' }],
      tools: {
        getWeather: { parameters: SCHEMA, execute: weather, needsApproval: true },
        askUser: { parameters: { type: 'object' } }, // client tool: no execute
      },
      maxSteps: 5,
    });
    expect(calls).toHaveLength(1);
    expect(weather).not.toHaveBeenCalled();
    expect(res.pendingApprovals).toHaveLength(1);
    expect(res.pendingApprovals![0]).toMatchObject({ toolCallId: 'toolu_1' });
    expect(res.steps![0]!.toolCalls).toHaveLength(2); // both calls visible on the step
  });

  it('streaming: emits tool-approval-request parts, then finish; usage resolves', async () => {
    const weather = vi.fn(async () => ({ temp: 22 }));
    const { fetch } = mockFetchSequence([() => sseResponse([ANTHROPIC_TOOL_CALL])]);
    const result = streamChat({
      model: createAnthropic({ apiKey: 'k', fetch })('claude-opus-4-8'),
      messages: [{ role: 'user', content: 'weather?' }],
      tools: {
        getWeather: { parameters: SCHEMA, execute: weather, needsApproval: true },
      },
      maxSteps: 5,
    });
    const parts: StreamPart[] = [];
    for await (const part of result.fullStream) parts.push(part);

    const types = parts.map((p) => p.type);
    expect(types).toContain('tool-call');
    expect(types).toContain('tool-approval-request');
    expect(types.at(-1)).toBe('finish');
    const approval = parts.find((p) => p.type === 'tool-approval-request');
    expect(approval).toMatchObject({
      approvalId: 'toolu_1',
      toolCallId: 'toolu_1',
      toolName: 'getWeather',
      input: { city: 'Paris' },
    });
    expect(weather).not.toHaveBeenCalled();
    expect((await result.usage).totalTokens).toBeGreaterThan(0);
  });
});

describe('tool approval — parity + mixed-batch hardening', () => {
  it('STREAMING server-mode denial: is_error tool-result on the stream, loop continues', async () => {
    const weather = vi.fn(async () => ({ temp: 22 }));
    const { fetch, calls } = mockFetchSequence([
      () => sseResponse([ANTHROPIC_TOOL_CALL]),
      () => sseResponse([ANTHROPIC_FINAL]),
    ]);
    const result = streamChat({
      model: createAnthropic({ apiKey: 'k', fetch })('claude-opus-4-8'),
      messages: [{ role: 'user', content: 'weather?' }],
      tools: {
        getWeather: { parameters: SCHEMA, execute: weather, needsApproval: true },
      },
      approveToolCall: () => false,
      maxSteps: 5,
    });
    const parts: StreamPart[] = [];
    for await (const part of result.fullStream) parts.push(part);

    expect(weather).not.toHaveBeenCalled();
    const denial = parts.find((p) => p.type === 'tool-result');
    expect(denial).toMatchObject({
      toolCallId: 'toolu_1',
      output: 'Tool call denied.',
      isError: true,
    });
    // Loop CONTINUED past the denial: two steps, final text, clean finish.
    expect(parts.filter((p) => p.type === 'step-start')).toHaveLength(2);
    expect(parts.at(-1)?.type).toBe('finish');
    expect(calls).toHaveLength(2);
  });

  it('mixed batch, server mode: approved call executes while denied call errors — same step', async () => {
    const weather = vi.fn(async () => ({ temp: 22 }));
    const ask = vi.fn(async () => ({ answer: 'yes' }));
    const { fetch, calls } = mockFetchSequence([
      () => sseResponse([ANTHROPIC_TWO_TOOLS]),
      () => sseResponse([ANTHROPIC_FINAL]),
    ]);
    const res = await generateText({
      model: createAnthropic({ apiKey: 'k', fetch })('claude-opus-4-8'),
      messages: [{ role: 'user', content: 'weather?' }],
      tools: {
        getWeather: { parameters: SCHEMA, execute: weather, needsApproval: true }, // will be DENIED
        askUser: { parameters: { type: 'object' }, execute: ask }, // ungated — must still run
      },
      approveToolCall: (call) => call.toolName !== 'getWeather',
      maxSteps: 5,
    });
    expect(weather).not.toHaveBeenCalled();
    expect(ask).toHaveBeenCalledTimes(1);
    // Both tool_use ids answered in the follow-up body; only toolu_1 is_error.
    const body2 = JSON.parse(String(calls[1]!.init!.body));
    const results = new Map<string, boolean | undefined>();
    for (const m of body2.messages) {
      if (!Array.isArray(m.content)) continue;
      for (const b of m.content)
        if (b.type === 'tool_result') results.set(b.tool_use_id, b.is_error);
    }
    expect(results.get('toolu_1')).toBe(true);
    expect(results.has('toolu_2')).toBe(true);
    expect(results.get('toolu_2')).not.toBe(true);
    expect(res.steps).toHaveLength(2);
  });
});

describe('tool approval — settle-on-resume (approvalResponses)', () => {
  const PENDING_HISTORY = [
    { role: 'user' as const, content: 'weather in Paris?' },
    {
      role: 'assistant' as const,
      content: [
        { type: 'tool_use' as const, id: 'toolu_1', name: 'getWeather', input: { city: 'Paris' } },
      ],
    },
  ];

  it('approved: executes, appends a NEW tool message, and continues', async () => {
    const weather = vi.fn(async (_args: unknown) => ({ temp: 22 }));
    const { fetch, calls } = mockFetchSequence([() => sseResponse([ANTHROPIC_FINAL])]);
    const res = await generateText({
      model: createAnthropic({ apiKey: 'k', fetch })('claude-opus-4-8'),
      messages: PENDING_HISTORY,
      tools: {
        getWeather: { parameters: SCHEMA, execute: weather, needsApproval: true },
      },
      approvalResponses: [{ approvalId: 'toolu_1', approved: true }],
      maxSteps: 5,
    });
    expect(weather).toHaveBeenCalledTimes(1);
    expect(weather.mock.calls[0]![0]).toEqual({ city: 'Paris' });
    // The settled tool_result rode INTO the first model call.
    const body1 = JSON.parse(String(calls[0]!.init!.body));
    const hasResult = body1.messages.some(
      (m: { content: unknown }) =>
        Array.isArray(m.content) &&
        m.content.some(
          (b: { type?: string; tool_use_id?: string }) =>
            b.type === 'tool_result' && b.tool_use_id === 'toolu_1',
        ),
    );
    expect(hasResult).toBe(true);
    // The settled tool message is a NEW message included in response.messages.
    expect(res.response.messages.some((m) => m.role === 'tool')).toBe(true);
    expect(res.text).toBe('Sunny in Paris.');
  });

  it('denied with reason: no execution; the reason reaches the wire as is_error', async () => {
    const weather = vi.fn(async () => ({ temp: 22 }));
    const { fetch, calls } = mockFetchSequence([() => sseResponse([ANTHROPIC_FINAL])]);
    await generateText({
      model: createAnthropic({ apiKey: 'k', fetch })('claude-opus-4-8'),
      messages: PENDING_HISTORY,
      tools: {
        getWeather: { parameters: SCHEMA, execute: weather, needsApproval: true },
      },
      approvalResponses: [{ approvalId: 'toolu_1', approved: false, reason: 'not allowed here' }],
      maxSteps: 5,
    });
    expect(weather).not.toHaveBeenCalled();
    const body1 = String(calls[0]!.init!.body);
    expect(body1).toContain('Tool call denied.');
    expect(body1).toContain('not allowed here');
  });

  it('unknown approvalIds are ignored; unmatched gated calls deny by default', async () => {
    const weather = vi.fn(async () => ({ temp: 22 }));
    const { fetch, calls } = mockFetchSequence([() => sseResponse([ANTHROPIC_FINAL])]);
    await generateText({
      model: createAnthropic({ apiKey: 'k', fetch })('claude-opus-4-8'),
      messages: PENDING_HISTORY,
      tools: {
        getWeather: { parameters: SCHEMA, execute: weather, needsApproval: true },
      },
      approvalResponses: [{ approvalId: 'bogus-id', approved: true }],
      maxSteps: 5,
    });
    expect(weather).not.toHaveBeenCalled(); // gated + no verdict → denied (safe side)
    expect(String(calls[0]!.init!.body)).toContain('No approval response');
  });

  it('mixed resume: caller-answered client tool + approved gated tool — every id answered', async () => {
    const weather = vi.fn(async () => ({ temp: 22 }));
    const { fetch, calls } = mockFetchSequence([() => sseResponse([ANTHROPIC_FINAL])]);
    await generateText({
      model: createAnthropic({ apiKey: 'k', fetch })('claude-opus-4-8'),
      messages: [
        { role: 'user', content: 'weather?' },
        {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'toolu_1', name: 'getWeather', input: { city: 'Paris' } },
            { type: 'tool_use', id: 'toolu_2', name: 'askUser', input: { q: 'ok?' } },
          ],
        },
        // Caller already answered the client tool round-trip:
        { role: 'tool', content: [{ type: 'tool_result', toolUseId: 'toolu_2', result: 'yes' }] },
      ],
      tools: {
        getWeather: { parameters: SCHEMA, execute: weather, needsApproval: true },
        askUser: { parameters: { type: 'object' } },
      },
      approvalResponses: [{ approvalId: 'toolu_1', approved: true }],
      maxSteps: 5,
    });
    expect(weather).toHaveBeenCalledTimes(1); // ONLY the gated call settled
    // Anthropic 400 guard: BOTH tool_use ids answered in the wire body.
    const body1 = JSON.parse(String(calls[0]!.init!.body));
    const answered = new Set<string>();
    for (const m of body1.messages) {
      if (!Array.isArray(m.content)) continue;
      for (const b of m.content) if (b.type === 'tool_result') answered.add(b.tool_use_id);
    }
    expect(answered).toEqual(new Set(['toolu_1', 'toolu_2']));
  });

  it('deferred non-gated server tool auto-executes on resume (no verdict needed)', async () => {
    const weather = vi.fn(async () => ({ temp: 22 }));
    const lookup = vi.fn(async () => ({ found: true }));
    const { fetch, calls } = mockFetchSequence([() => sseResponse([ANTHROPIC_FINAL])]);
    await generateText({
      model: createAnthropic({ apiKey: 'k', fetch })('claude-opus-4-8'),
      messages: [
        { role: 'user', content: 'weather?' },
        {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'toolu_1', name: 'getWeather', input: { city: 'Paris' } },
            { type: 'tool_use', id: 'toolu_2', name: 'lookup', input: { q: 'x' } },
          ],
        },
      ],
      tools: {
        getWeather: { parameters: SCHEMA, execute: weather, needsApproval: true },
        lookup: { parameters: { type: 'object' }, execute: lookup }, // deferred by the break, NOT gated
      },
      approvalResponses: [{ approvalId: 'toolu_1', approved: true }], // no verdict for toolu_2
      maxSteps: 5,
    });
    expect(weather).toHaveBeenCalledTimes(1); // approved
    expect(lookup).toHaveBeenCalledTimes(1); // auto-executed — no verdict required
    const body1 = JSON.parse(String(calls[0]!.init!.body));
    const errored: Record<string, boolean | undefined> = {};
    for (const m of body1.messages) {
      if (!Array.isArray(m.content)) continue;
      for (const b of m.content) if (b.type === 'tool_result') errored[b.tool_use_id] = b.is_error;
    }
    expect(Object.keys(errored).sort()).toEqual(['toolu_1', 'toolu_2']);
    expect(errored.toolu_1).not.toBe(true);
    expect(errored.toolu_2).not.toBe(true);
  });

  it('streaming resume: settled tool-result parts arrive before the first step-start', async () => {
    const weather = vi.fn(async () => ({ temp: 22 }));
    const { fetch } = mockFetchSequence([() => sseResponse([ANTHROPIC_FINAL])]);
    const result = streamChat({
      model: createAnthropic({ apiKey: 'k', fetch })('claude-opus-4-8'),
      messages: PENDING_HISTORY,
      tools: {
        getWeather: { parameters: SCHEMA, execute: weather, needsApproval: true },
      },
      approvalResponses: [{ approvalId: 'toolu_1', approved: true }],
      maxSteps: 5,
    });
    const types: StreamPart['type'][] = [];
    for await (const part of result.fullStream) types.push(part.type);
    expect(weather).toHaveBeenCalledTimes(1);
    const firstStepStart = types.indexOf('step-start');
    const settledResult = types.indexOf('tool-result');
    expect(settledResult).toBeGreaterThanOrEqual(0);
    expect(settledResult).toBeLessThan(firstStepStart); // settle precedes step 1
    expect(types.at(-1)).toBe('finish');
  });

  it('streaming resume emits approved settlement lifecycle in execution order', async () => {
    const weather = vi.fn(async () => ({ temp: 22 }));
    const { fetch } = mockFetchSequence([() => sseResponse([ANTHROPIC_FINAL])]);
    const result = streamChat({
      model: createAnthropic({ apiKey: 'k', fetch })('claude-opus-4-8'),
      messages: PENDING_HISTORY,
      tools: {
        getWeather: { parameters: SCHEMA, execute: weather, needsApproval: true },
      },
      approvalResponses: [{ approvalId: 'toolu_1', approved: true }],
      maxSteps: 5,
    });
    const lifecycle: string[] = [];
    for await (const part of result.fullStream) {
      if (part.type === 'tool-state') lifecycle.push(`state:${part.state}`);
      if (part.type === 'tool-result') {
        lifecycle.push(part.isError ? 'result:error' : 'result:ok');
      }
    }
    expect(lifecycle).toEqual(['state:executing', 'result:ok', 'state:complete']);
  });

  it('streaming resume emits execution failures after executing and before error', async () => {
    const weather = vi.fn(async () => {
      throw new Error('weather backend down');
    });
    const { fetch } = mockFetchSequence([() => sseResponse([ANTHROPIC_FINAL])]);
    const result = streamChat({
      model: createAnthropic({ apiKey: 'k', fetch })('claude-opus-4-8'),
      messages: PENDING_HISTORY,
      tools: {
        getWeather: { parameters: SCHEMA, execute: weather, needsApproval: true },
      },
      approvalResponses: [{ approvalId: 'toolu_1', approved: true }],
      maxSteps: 5,
    });
    const lifecycle: string[] = [];
    for await (const part of result.fullStream) {
      if (part.type === 'tool-state') lifecycle.push(`state:${part.state}`);
      if (part.type === 'tool-result') {
        lifecycle.push(part.isError ? 'result:error' : 'result:ok');
      }
    }
    expect(lifecycle).toEqual(['state:executing', 'result:error', 'state:error']);
  });

  it.each([
    {
      name: 'explicit denial',
      tools: {
        getWeather: {
          parameters: SCHEMA,
          execute: vi.fn(async () => ({ temp: 22 })),
          needsApproval: true,
        },
      },
      approvalResponses: [{ approvalId: 'toolu_1', approved: false as const }],
      // A verdict with no `reason`: the part still says REFUSED, just silently.
      deniedReason: undefined,
    },
    {
      name: 'explicit denial with a reason',
      tools: {
        getWeather: {
          parameters: SCHEMA,
          execute: vi.fn(async () => ({ temp: 22 })),
          needsApproval: true,
        },
      },
      approvalResponses: [
        { approvalId: 'toolu_1', approved: false as const, reason: 'not allowed here' },
      ],
      // The CLIENT's own words reach the UI verbatim (1.9).
      deniedReason: 'not allowed here',
    },
    {
      name: 'default denial',
      tools: {
        getWeather: {
          parameters: SCHEMA,
          execute: vi.fn(async () => ({ temp: 22 })),
          needsApproval: true,
        },
      },
      approvalResponses: [],
      deniedReason: 'No approval response.',
    },
    {
      name: 'missing client result',
      tools: { getWeather: { parameters: SCHEMA } },
      approvalResponses: [],
      deniedReason: 'No result provided for this client tool.',
    },
  ])(
    'streaming resume emits $name without an executing state, marked denied',
    async ({ tools, approvalResponses, deniedReason }) => {
      const { fetch, calls } = mockFetchSequence([() => sseResponse([ANTHROPIC_FINAL])]);
      const result = streamChat({
        model: createAnthropic({ apiKey: 'k', fetch })('claude-opus-4-8'),
        messages: PENDING_HISTORY,
        tools,
        approvalResponses,
        maxSteps: 5,
      });
      const lifecycle: string[] = [];
      const states: Extract<StreamPart, { type: 'tool-state' }>[] = [];
      for await (const part of result.fullStream) {
        if (part.type === 'tool-state') {
          lifecycle.push(`state:${part.state}`);
          states.push(part);
        }
        if (part.type === 'tool-result') {
          lifecycle.push(part.isError ? 'result:error' : 'result:ok');
        }
      }
      expect(lifecycle).toEqual(['result:error', 'state:error']);
      // 1.9: the terminal part distinguishes REFUSED from failed, and carries
      // the reason the denier gave — this is what the reducer/useChat read.
      expect(states.at(-1)).toMatchObject({ state: 'error', denied: true });
      expect(states.at(-1)!.deniedReason).toBe(deniedReason);
      // Unchanged: the MODEL is still told the call failed (is_error), so it can
      // pick another route — only the UI learns it was a denial.
      expect(String(calls[0]!.init!.body)).toContain('Tool call denied.');
    },
  );
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

// 1.9: a name the model INVENTED is not a client tool — it self-heals as an
// is_error tool_result instead of silently breaking the loop forever.
describe('hallucinated tool names (unknown name ≠ client tool)', () => {
  const EMPTY: JSONSchema = { type: 'object' };
  const UNKNOWN_MESSAGE = 'No such tool: "search_web". Available tools: getWeather, search.';

  it('buffered: an unregistered name becomes an is_error tool_result and the loop CONTINUES', async () => {
    const weather = vi.fn(async () => ({ temp: 22 }));
    const search = vi.fn(async () => 'ok');
    const model = createMockModel({
      responses: [
        { toolCalls: [{ toolName: 'search_web', args: { q: 'deuz' } }] },
        { text: 'Sunny in Paris.' },
      ],
    });
    const res = await generateText({
      model,
      messages: [{ role: 'user', content: 'search the web' }],
      tools: {
        getWeather: { parameters: SCHEMA, execute: weather },
        search: { parameters: EMPTY, execute: search },
      },
      maxSteps: 5,
    });

    // Not treated as a client tool: no break, a second model call happened.
    expect(res.steps).toHaveLength(2);
    expect(res.text).toBe('Sunny in Paris.');
    expect(res.pendingApprovals).toBeUndefined();
    expect(weather).not.toHaveBeenCalled();
    expect(search).not.toHaveBeenCalled();

    // Actionable self-heal feedback listing the REAL tool names.
    const results = res.steps![0]!.toolResults;
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      toolCallId: 'call_1',
      toolName: 'search_web',
      result: UNKNOWN_MESSAGE,
      isError: true,
    });

    // Every tool_use_id answered in the SAME turn (Anthropic 400 guard).
    const toolMessage = res.response.messages.find((m) => m.role === 'tool');
    expect(toolMessage).toBeDefined();
    expect(toolMessage!.content).toMatchObject([
      { type: 'tool_result', toolUseId: 'call_1', result: UNKNOWN_MESSAGE, isError: true },
    ]);
  });

  it('a REAL client tool (key present, no execute) still breaks the loop unchanged', async () => {
    const model = createMockModel({
      responses: [{ toolCalls: [{ toolName: 'askUser', args: { q: 'ok?' } }] }, { text: 'done' }],
    });
    const res = await generateText({
      model,
      messages: [{ role: 'user', content: 'ask me' }],
      tools: { askUser: { parameters: EMPTY } }, // client tool: no execute
      maxSteps: 5,
    });

    expect(res.steps).toHaveLength(1); // broke after step 1 — the caller owns the round-trip
    expect(res.steps![0]!.toolCalls).toHaveLength(1);
    expect(res.steps![0]!.toolResults).toEqual([]); // nothing fabricated
    expect(res.finishReason).toBe('tool_calls');
    expect(res.response.messages.some((m) => m.role === 'tool')).toBe(false);
  });

  it('a gated client tool still surfaces in pendingApprovals', async () => {
    const model = createMockModel({
      responses: [{ toolCalls: [{ toolName: 'askUser', args: { q: 'ok?' } }] }],
    });
    const res = await generateText({
      model,
      messages: [{ role: 'user', content: 'ask me' }],
      tools: { askUser: { parameters: EMPTY, needsApproval: true } },
      maxSteps: 5,
    });

    expect(res.steps).toHaveLength(1);
    expect(res.pendingApprovals).toEqual([
      {
        approvalId: 'call_1',
        toolCallId: 'call_1',
        toolName: 'askUser',
        input: { q: 'ok?' },
      },
    ]);
  });

  it('a provider-executed tool never breaks the loop as a client tool', async () => {
    const model = createMockModel({
      responses: [{ toolCalls: [{ toolName: 'web_search', args: {} }] }, { text: 'done' }],
    });
    const res = await generateText({
      model,
      messages: [{ role: 'user', content: 'search' }],
      tools: {
        web_search: {
          type: 'provider',
          parameters: EMPTY,
          providerTool: { type: 'web_search_20250305', name: 'web_search' },
        },
      },
      maxSteps: 5,
    });

    expect(res.steps).toHaveLength(2); // continued, exactly as before
    expect(res.pendingApprovals).toBeUndefined();
    // Registered-but-not-locally-executable → the executor message, NOT the
    // unknown-tool one (the name IS a key of `tools`).
    expect(res.steps![0]!.toolResults[0]).toMatchObject({
      toolName: 'web_search',
      result: 'No server-side executor.',
      isError: true,
    });
  });

  it('streaming: same self-heal — tool-state ends in error with no executing state', async () => {
    const weather = vi.fn(async () => ({ temp: 22 }));
    const search = vi.fn(async () => 'ok');
    const model = createMockModel({
      responses: [
        { toolCalls: [{ toolName: 'search_web', args: { q: 'deuz' } }] },
        { text: 'Sunny in Paris.' },
      ],
    });
    const result = streamChat({
      model,
      messages: [{ role: 'user', content: 'search the web' }],
      tools: {
        getWeather: { parameters: SCHEMA, execute: weather },
        search: { parameters: EMPTY, execute: search },
      },
      maxSteps: 5,
    });

    const parts: StreamPart[] = [];
    for await (const part of result.fullStream) parts.push(part);

    const lifecycle = parts
      .filter((p) => p.type === 'tool-state' || p.type === 'tool-result')
      .map((p) =>
        p.type === 'tool-state' ? `state:${p.state}` : p.isError ? 'result:error' : 'result:ok',
      );
    expect(lifecycle).toEqual([
      'state:input-streaming',
      'state:input-complete',
      'result:error',
      'state:error',
    ]);

    const toolResults = parts.filter(
      (p): p is Extract<StreamPart, { type: 'tool-result' }> => p.type === 'tool-result',
    );
    expect(toolResults[0]!.output).toBe(UNKNOWN_MESSAGE);
    // The loop CONTINUED: a second step ran and the stream finished cleanly.
    expect(parts.filter((p) => p.type === 'step-start')).toHaveLength(2);
    expect(parts.at(-1)!.type).toBe('finish');
    expect(weather).not.toHaveBeenCalled();
  });

  it('a model looping on the same invented name trips the runaway guard', async () => {
    // Documented decision: unknown-tool errors DO count toward
    // MAX_SAME_TOOL_ERRORS (unlike approval denials).
    const model = createMockModel({
      responses: [{ toolCalls: [{ toolName: 'search_web', args: {} }] }], // repeats forever
    });
    const res = await generateText({
      model,
      messages: [{ role: 'user', content: 'go' }],
      tools: { search: { parameters: EMPTY, execute: async () => 'ok' } },
      maxSteps: 10,
    });

    expect(res.steps).toHaveLength(3); // MAX_SAME_TOOL_ERRORS
    expect(res.providerMetadata?.deuz).toBeUndefined(); // runaway, not a stop condition
  });
});

// ===================================================================
// 1.9 — per-tool timeout (`Tool.timeoutMs` + `timeout.toolMs`)
// A tool that never resolves (hung MCP server, signal-less fetch, a Playwright
// click on a missing selector) used to hold the agent forever: `executeTools`
// passed `options.signal` straight through with no per-call timer.
// ===================================================================
describe('per-tool timeout (self-healing, clock-driven)', () => {
  const EMPTY: JSONSchema = { type: 'object' };

  interface FakeTimer {
    ms: number;
    fn: () => void;
    cleared: boolean;
    fired: boolean;
  }

  /** A clock that ARMS nothing by itself — the test decides when a timer fires. */
  function fakeClock(): { clock: Clock; timers: FakeTimer[]; fire: (ms: number) => void } {
    const timers: FakeTimer[] = [];
    const clock: Clock = {
      now: () => 0,
      setTimeout: (fn, ms) => {
        const timer: FakeTimer = { ms, fn, cleared: false, fired: false };
        timers.push(timer);
        return () => {
          timer.cleared = true;
        };
      },
    };
    const fire = (ms: number): void => {
      const timer = timers.find((t) => t.ms === ms && !t.fired && !t.cleared);
      if (!timer)
        throw new Error(`no armed timer for ${ms}ms (armed: ${timers.map((t) => t.ms).join()})`);
      timer.fired = true;
      timer.fn();
    };
    return { clock, timers, fire };
  }

  const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
  async function until(predicate: () => boolean): Promise<void> {
    for (let i = 0; i < 500; i++) {
      if (predicate()) return;
      await tick();
    }
    throw new Error('condition never became true');
  }

  it('a tool that never resolves is capped, self-heals as is_error, and the loop CONTINUES', async () => {
    const { clock, timers, fire } = fakeClock();
    let started = 0;
    let seenSignal: AbortSignal | undefined;
    const model = createMockModel({
      responses: [{ toolCalls: [{ toolName: 'hang', args: {} }] }, { text: 'recovered' }],
    });
    const run = generateText({
      model,
      prompt: 'go',
      tools: {
        hang: {
          parameters: EMPTY,
          execute: async (_args, ctx) => {
            started += 1;
            seenSignal = ctx.signal;
            return new Promise<never>(() => {}); // never settles
          },
        },
      },
      maxSteps: 3,
      timeout: { toolMs: 50 },
      deps: { clock },
    });

    await until(() => started === 1);
    expect(timers.some((t) => t.ms === 50)).toBe(true); // armed from deps.clock, not setTimeout
    fire(50);
    const res = await run;

    const first = res.steps![0]!.toolResults[0]!;
    expect(first.isError).toBe(true);
    expect(String(first.result)).toBe("Tool 'hang' timed out after 50ms and was abandoned.");
    // Every tool_use_id still answered → the model got a turn and the run finished.
    expect(res.steps).toHaveLength(2);
    expect(res.text).toBe('recovered');
    // The tool's own signal was aborted so a well-behaved tool stops working.
    expect(seenSignal?.aborted).toBe(true);
  });

  it('Tool.timeoutMs BEATS the call-level timeout.toolMs', async () => {
    const { clock, timers, fire } = fakeClock();
    let started = 0;
    const model = createMockModel({
      responses: [{ toolCalls: [{ toolName: 'hang', args: {} }] }, { text: 'done' }],
    });
    const run = generateText({
      model,
      prompt: 'go',
      tools: {
        hang: {
          parameters: EMPTY,
          timeoutMs: 25,
          execute: async () => {
            started += 1;
            return new Promise<never>(() => {});
          },
        },
      },
      maxSteps: 3,
      timeout: { toolMs: 5_000 },
      deps: { clock },
    });

    await until(() => started === 1);
    expect(timers.some((t) => t.ms === 25)).toBe(true);
    expect(timers.some((t) => t.ms === 5_000)).toBe(false); // the call-level cap never armed
    fire(25);
    const res = await run;
    expect(String(res.steps![0]!.toolResults[0]!.result)).toContain('timed out after 25ms');
  });

  it('no cap = 1.8 behaviour: the caller’s signal passes through untouched', async () => {
    const controller = new AbortController();
    let seenSignal: AbortSignal | undefined;
    const model = createMockModel({
      responses: [{ toolCalls: [{ toolName: 'echo', args: {} }] }, { text: 'done' }],
    });
    const res = await generateText({
      model,
      prompt: 'go',
      signal: controller.signal,
      tools: {
        echo: {
          parameters: EMPTY,
          execute: async (_args, ctx) => {
            seenSignal = ctx.signal;
            return 'ok';
          },
        },
      },
      maxSteps: 3,
    });
    expect(seenSignal).toBe(controller.signal); // identity: no combined signal built
    expect(res.steps![0]!.toolResults[0]!.isError).toBeUndefined();
    expect(res.text).toBe('done');
  });

  it('clears the tool timer on the happy path (no leaked timers)', async () => {
    const { clock, timers } = fakeClock();
    const model = createMockModel({
      responses: [{ toolCalls: [{ toolName: 'echo', args: {} }] }, { text: 'done' }],
    });
    const res = await generateText({
      model,
      prompt: 'go',
      tools: { echo: { parameters: EMPTY, execute: async () => 'ok' } },
      maxSteps: 3,
      timeout: { toolMs: 7_000 },
      deps: { clock },
    });
    expect(res.text).toBe('done');
    const toolTimers = timers.filter((t) => t.ms === 7_000);
    expect(toolTimers).toHaveLength(1);
    expect(toolTimers[0]!.cleared).toBe(true);
  });

  it('a thrown tool still self-heals with its own message when a cap is armed', async () => {
    const { clock, timers } = fakeClock();
    const model = createMockModel({
      responses: [{ toolCalls: [{ toolName: 'boom', args: {} }] }, { text: 'done' }],
    });
    const res = await generateText({
      model,
      prompt: 'go',
      tools: {
        boom: {
          parameters: EMPTY,
          execute: async () => {
            throw new Error('File not found');
          },
        },
      },
      maxSteps: 3,
      timeout: { toolMs: 7_000 },
      deps: { clock },
    });
    expect(String(res.steps![0]!.toolResults[0]!.result)).toContain('File not found');
    expect(timers.filter((t) => t.ms === 7_000)[0]!.cleared).toBe(true);
    expect(res.text).toBe('done');
  });

  it('timeouts DO count toward MAX_SAME_TOOL_ERRORS (documented decision)', async () => {
    const { clock, fire } = fakeClock();
    let started = 0;
    const model = createMockModel({
      responses: [{ toolCalls: [{ toolName: 'hang', args: {} }] }], // repeats forever
    });
    const run = generateText({
      model,
      prompt: 'go',
      tools: {
        hang: {
          parameters: EMPTY,
          execute: async () => {
            started += 1;
            return new Promise<never>(() => {});
          },
        },
      },
      maxSteps: 10,
      timeout: { toolMs: 50 },
      deps: { clock },
    });

    for (let step = 1; step <= 3; step++) {
      await until(() => started === step);
      fire(50);
    }
    const res = await run;
    // A tool that hangs forever costs the FULL cap per attempt — the runaway
    // guard is the only thing that stops it.
    expect(res.steps).toHaveLength(3);
    expect(started).toBe(3);
  });
});

// ===================================================================
// 1.9 — approval DENIAL reaches the UI (`ToolStatePart.denied`)
// The field existed canonically, on the wire, in the reducer and in useChat —
// but the loop never SET it, so a call a human refused rendered identically to
// a tool that crashed ("getWeather failed"). These pin the distinction.
// ===================================================================
describe('approval denial on the stream (tool-state.denied)', () => {
  const EMPTY: JSONSchema = { type: 'object' };

  /** Every `tool-state` part of a streaming run, in emission order. */
  async function drainStates(
    result: ReturnType<typeof streamChat>,
  ): Promise<{ parts: StreamPart[]; states: Extract<StreamPart, { type: 'tool-state' }>[] }> {
    const parts: StreamPart[] = [];
    const states: Extract<StreamPart, { type: 'tool-state' }>[] = [];
    for await (const part of result.fullStream) {
      parts.push(part);
      if (part.type === 'tool-state') states.push(part);
    }
    return { parts, states };
  }

  it('server mode: denied is state:error + denied, and the model still gets is_error', async () => {
    const weather = vi.fn(async () => ({ temp: 22 }));
    const { fetch, calls } = mockFetchSequence([
      () => sseResponse([ANTHROPIC_TOOL_CALL]),
      () => sseResponse([ANTHROPIC_FINAL]),
    ]);
    const { parts, states } = await drainStates(
      streamChat({
        model: createAnthropic({ apiKey: 'k', fetch })('claude-opus-4-8'),
        messages: [{ role: 'user', content: 'weather?' }],
        tools: { getWeather: { parameters: SCHEMA, execute: weather, needsApproval: true } },
        approveToolCall: () => false,
        maxSteps: 5,
      }),
    );

    // Nothing executed, and no 'executing' state was claimed.
    expect(weather).not.toHaveBeenCalled();
    expect(states.map((s) => s.state)).toEqual(['input-streaming', 'input-complete', 'error']);
    expect(states.at(-1)).toMatchObject({
      toolCallId: 'toolu_1',
      toolName: 'getWeather',
      state: 'error',
      denied: true,
    });
    // `approveToolCall` returns a boolean — there is no reason string to relay,
    // so the flag alone carries the story (and none is invented here).
    expect(states.at(-1)!.deniedReason).toBeUndefined();
    // Unchanged model-facing contract: the is_error tool_result still rides out…
    expect(String(calls[1]!.init!.body)).toContain('Tool call denied.');
    // …and the loop continued to a clean finish.
    expect(parts.filter((p) => p.type === 'step-start')).toHaveLength(2);
    expect(parts.at(-1)!.type).toBe('finish');
  });

  it('a denial still does NOT count toward the runaway guard (streaming)', async () => {
    const weather = vi.fn(async () => ({ temp: 22 }));
    // Always a tool call: 5 denials over 5 steps. MAX_SAME_TOOL_ERRORS is 3, so
    // a denial leaking into the error counters would stop the run at step 3.
    const { fetch, calls } = mockFetchSequence([() => sseResponse([ANTHROPIC_TOOL_CALL])]);
    const { states } = await drainStates(
      streamChat({
        model: createAnthropic({ apiKey: 'k', fetch })('claude-opus-4-8'),
        messages: [{ role: 'user', content: 'go' }],
        tools: { getWeather: { parameters: SCHEMA, execute: weather, needsApproval: true } },
        approveToolCall: () => false,
        maxSteps: 5,
      }),
    );
    expect(calls).toHaveLength(5);
    expect(weather).not.toHaveBeenCalled();
    const errors = states.filter((s) => s.state === 'error');
    expect(errors).toHaveLength(5);
    expect(errors.every((s) => s.denied === true)).toBe(true);
  });

  it('a tool that THREW is state:error WITHOUT denied (the whole point)', async () => {
    const model = createMockModel({
      responses: [{ toolCalls: [{ toolName: 'boom', args: {} }] }, { text: 'recovered' }],
    });
    const { states } = await drainStates(
      streamChat({
        model,
        messages: [{ role: 'user', content: 'go' }],
        tools: {
          boom: {
            parameters: EMPTY,
            execute: async () => {
              throw new Error('File not found');
            },
          },
        },
        maxSteps: 5,
      }),
    );
    expect(states.map((s) => s.state)).toEqual([
      'input-streaming',
      'input-complete',
      'executing',
      'error',
    ]);
    const terminal = states.at(-1)!;
    expect(terminal.denied).toBeUndefined();
    expect(terminal.deniedReason).toBeUndefined();
  });

  it('an approved tool completes with no denial fields', async () => {
    const weather = vi.fn(async () => ({ temp: 22 }));
    const { fetch } = mockFetchSequence([
      () => sseResponse([ANTHROPIC_TOOL_CALL]),
      () => sseResponse([ANTHROPIC_FINAL]),
    ]);
    const { states } = await drainStates(
      streamChat({
        model: createAnthropic({ apiKey: 'k', fetch })('claude-opus-4-8'),
        messages: [{ role: 'user', content: 'weather?' }],
        tools: { getWeather: { parameters: SCHEMA, execute: weather, needsApproval: true } },
        approveToolCall: () => true,
        maxSteps: 5,
      }),
    );
    expect(weather).toHaveBeenCalledTimes(1);
    expect(states.at(-1)).toEqual({
      type: 'tool-state',
      toolCallId: 'toolu_1',
      toolName: 'getWeather',
      state: 'complete',
    });
  });
});

// ===================================================================
// 1.9 — `activeTools` typos become WARNINGS, not silence
// Both notices were logger-only, and the default logger is a no-op, so a single
// typo'd name quietly sent the full tool list with nothing visible anywhere.
// FAIL-OPEN is unchanged: a warning never drops a tool.
// ===================================================================
describe('activeTools warnings (unsupported-tool)', () => {
  const EMPTY: JSONSchema = { type: 'object' };
  const TOOLS = {
    getWeather: { parameters: SCHEMA, execute: vi.fn(async () => ({ temp: 22 })) },
    search: { parameters: EMPTY, execute: vi.fn(async () => 'ok') },
  };

  function makeLogger() {
    const noop = (_message: string, _fields?: Record<string, unknown>): void => {};
    return { debug: vi.fn(noop), info: vi.fn(noop), warn: vi.fn(noop), error: vi.fn(noop) };
  }
  function toolNames(call: { init?: RequestInit }): string[] {
    const body = JSON.parse(String(call.init!.body)) as { tools?: { name: string }[] };
    return (body.tools ?? []).map((t) => t.name);
  }

  it('an unknown name warns; the valid names still filter (nothing else changes)', async () => {
    const logger = makeLogger();
    const { fetch, calls } = mockFetchSequence([() => sseResponse([ANTHROPIC_FINAL])]);
    const result = streamChat({
      model: createAnthropic({ apiKey: 'k', fetch })('claude-opus-4-8'),
      messages: [{ role: 'user', content: 'go' }],
      tools: TOOLS,
      activeTools: ['getWeather', 'getWeahter'], // typo
      maxSteps: 5,
      deps: { logger },
    });
    const parts: StreamPart[] = [];
    for await (const part of result.fullStream) parts.push(part);

    // The bulk readout was `undefined` on every real result before 1.9.
    await expect(result.warnings!).resolves.toEqual([
      {
        type: 'unsupported-tool',
        setting: 'activeTools',
        message: "activeTools: unknown tool name 'getWeahter' ignored",
      },
    ]);
    // …and the same notice arrives live on the canonical stream.
    const live = parts.filter(
      (p): p is Extract<StreamPart, { type: 'warning' }> => p.type === 'warning',
    );
    expect(live).toHaveLength(1);
    expect(live[0]!.warning.type).toBe('unsupported-tool');
    // The log line a pre-1.9 caller relied on is still emitted exactly once.
    expect(logger.warn).toHaveBeenCalledTimes(1);
    // Fail-open: the typo is ignored, the valid name still filters the wire.
    expect(toolNames(calls[0]!)).toEqual(['getWeather']);
  });

  it('an all-unknown list warns twice and sends EVERY tool (fail-open)', async () => {
    const { fetch, calls } = mockFetchSequence([() => sseResponse([ANTHROPIC_FINAL])]);
    const result = streamChat({
      model: createAnthropic({ apiKey: 'k', fetch })('claude-opus-4-8'),
      messages: [{ role: 'user', content: 'go' }],
      tools: TOOLS,
      activeTools: ['nope'],
      maxSteps: 5,
    });
    for await (const _part of result.fullStream) void _part;

    const warnings = await result.warnings!;
    expect(warnings.map((w) => w.type)).toEqual(['unsupported-tool', 'unsupported-tool']);
    expect(warnings[0]!.message).toContain("unknown tool name 'nope'");
    expect(warnings[1]!.message).toContain('sending the full tool list');
    expect(toolNames(calls[0]!)).toEqual(['getWeather', 'search']); // no tool dropped
  });

  it('a clean run resolves an EMPTY warning set (never undefined, never a reject)', async () => {
    const { fetch } = mockFetchSequence([() => sseResponse([ANTHROPIC_FINAL])]);
    const result = streamChat({
      model: createAnthropic({ apiKey: 'k', fetch })('claude-opus-4-8'),
      messages: [{ role: 'user', content: 'go' }],
      tools: TOOLS,
      activeTools: ['search'],
      maxSteps: 5,
    });
    for await (const _part of result.fullStream) void _part;
    await expect(result.warnings!).resolves.toEqual([]);
  });

  it('a per-step prepareStep typo is reported ONCE across steps (deduped)', async () => {
    const logger = makeLogger();
    const { fetch } = mockFetchSequence([
      () => sseResponse([ANTHROPIC_TOOL_CALL]),
      () => sseResponse([ANTHROPIC_FINAL]),
    ]);
    const result = streamChat({
      model: createAnthropic({ apiKey: 'k', fetch })('claude-opus-4-8'),
      messages: [{ role: 'user', content: 'weather?' }],
      tools: TOOLS,
      maxSteps: 5,
      prepareStep: () => ({ activeTools: ['getWeather', 'getWeahter'] }),
      deps: { logger },
    });
    const parts: StreamPart[] = [];
    for await (const part of result.fullStream) parts.push(part);

    // Two steps re-derived the same bad list; the sink collapses it to one
    // entry (and one log line) instead of one per step.
    const warnings = await result.warnings!;
    expect(warnings).toHaveLength(1);
    expect(parts.filter((p) => p.type === 'warning')).toHaveLength(1);
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });
});
