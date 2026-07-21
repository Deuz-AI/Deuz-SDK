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
    },
    {
      name: 'missing client result',
      tools: { getWeather: { parameters: SCHEMA } },
      approvalResponses: [],
    },
  ])(
    'streaming resume emits $name without an executing state',
    async ({ tools, approvalResponses }) => {
      const { fetch } = mockFetchSequence([() => sseResponse([ANTHROPIC_FINAL])]);
      const result = streamChat({
        model: createAnthropic({ apiKey: 'k', fetch })('claude-opus-4-8'),
        messages: PENDING_HISTORY,
        tools,
        approvalResponses,
        maxSteps: 5,
      });
      const lifecycle: string[] = [];
      for await (const part of result.fullStream) {
        if (part.type === 'tool-state') lifecycle.push(`state:${part.state}`);
        if (part.type === 'tool-result') {
          lifecycle.push(part.isError ? 'result:error' : 'result:ok');
        }
      }
      expect(lifecycle).toEqual(['result:error', 'state:error']);
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
