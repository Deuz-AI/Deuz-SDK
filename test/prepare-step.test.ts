import { describe, it, expect, vi } from 'vitest';
import { generateText, streamChat } from '../src/index';
import type { PrepareStepResult } from '../src/index';
import { createAnthropic } from '../src/anthropic';
import type { JSONSchema } from '../src/types/schema';
import { sseResponse, sseEvents, mockFetchSequence } from './fixtures/sse';

const SCHEMA: JSONSchema = {
  type: 'object',
  properties: { q: { type: 'string' } },
  required: ['q'],
  additionalProperties: false,
};

/** Anthropic turn that calls the `search` tool. */
const TOOL_CALL = sseEvents([
  {
    event: 'message_start',
    data: { type: 'message_start', message: { usage: { input_tokens: 10, output_tokens: 1 } } },
  },
  {
    event: 'content_block_start',
    data: {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'tool_use', id: 'toolu_1', name: 'search' },
    },
  },
  {
    event: 'content_block_delta',
    data: {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'input_json_delta', partial_json: '{"q":"deuz"}' },
    },
  },
  { event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } },
  {
    event: 'message_delta',
    data: { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 5 } },
  },
  { event: 'message_stop', data: { type: 'message_stop' } },
]);

/** Anthropic final text turn. */
const FINAL = sseEvents([
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
    data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Done.' } },
  },
  {
    event: 'message_delta',
    data: { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 6 } },
  },
  { event: 'message_stop', data: { type: 'message_stop' } },
]);

const search = vi.fn(async () => 'result');
const TOOLS = {
  search: { description: 'Search', parameters: SCHEMA, execute: search },
  analyze: { description: 'Analyze', parameters: SCHEMA, execute: vi.fn(async () => 'ok') },
};

function toolNames(call: { init?: RequestInit }): string[] {
  const body = JSON.parse(String(call.init!.body)) as { tools?: { name: string }[] };
  return (body.tools ?? []).map((t) => t.name);
}

function makeLogger() {
  const noop = (_message: string, _fields?: Record<string, unknown>): void => {};
  return { debug: vi.fn(noop), info: vi.fn(noop), warn: vi.fn(noop), error: vi.fn(noop) };
}

describe('activeTools (static)', () => {
  it('sends only the listed tools on every step', async () => {
    const { fetch, calls } = mockFetchSequence([
      () => sseResponse([TOOL_CALL]),
      () => sseResponse([FINAL]),
    ]);
    const res = await generateText({
      model: createAnthropic({ apiKey: 'k', fetch })('claude-opus-4-8'),
      messages: [{ role: 'user', content: 'go' }],
      tools: TOOLS,
      activeTools: ['search'],
      maxSteps: 5,
    });
    expect(res.text).toBe('Done.');
    expect(toolNames(calls[0]!)).toEqual(['search']);
    expect(toolNames(calls[1]!)).toEqual(['search']);
  });

  it('warns and ignores unknown names; all-unknown falls open to the full list', async () => {
    const logger = makeLogger();
    const { fetch: f1, calls: c1 } = mockFetchSequence([() => sseResponse([FINAL])]);
    await generateText({
      model: createAnthropic({ apiKey: 'k', fetch: f1 })('claude-opus-4-8'),
      messages: [{ role: 'user', content: 'go' }],
      tools: TOOLS,
      activeTools: ['search', 'nope'],
      deps: { logger },
    });
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(toolNames(c1[0]!)).toEqual(['search']);

    const logger2 = makeLogger();
    const { fetch: f2, calls: c2 } = mockFetchSequence([() => sseResponse([FINAL])]);
    await generateText({
      model: createAnthropic({ apiKey: 'k', fetch: f2 })('claude-opus-4-8'),
      messages: [{ role: 'user', content: 'go' }],
      tools: TOOLS,
      activeTools: ['nope'],
      deps: { logger: logger2 },
    });
    expect(logger2.warn).toHaveBeenCalled();
    expect(toolNames(c2[0]!)).toEqual(['search', 'analyze']); // fail-open
  });
});

describe('prepareStep', () => {
  it('receives stepIndex/messages/usage and switches activeTools per step', async () => {
    const seen: { stepIndex: number; usageTotal: number; msgCount: number }[] = [];
    const { fetch, calls } = mockFetchSequence([
      () => sseResponse([TOOL_CALL]),
      () => sseResponse([FINAL]),
    ]);
    await generateText({
      model: createAnthropic({ apiKey: 'k', fetch })('claude-opus-4-8'),
      messages: [{ role: 'user', content: 'go' }],
      tools: TOOLS,
      maxSteps: 5,
      prepareStep: ({ stepIndex, messages, usage }) => {
        seen.push({ stepIndex, usageTotal: usage.totalTokens, msgCount: messages.length });
        return stepIndex === 0 ? { activeTools: ['search'] } : { activeTools: ['analyze'] };
      },
    });
    expect(seen.map((s) => s.stepIndex)).toEqual([0, 1]);
    expect(seen[0]!.usageTotal).toBe(0); // nothing consumed yet
    expect(seen[1]!.usageTotal).toBe(15); // step 1 sees step 0's real usage
    expect(seen[1]!.msgCount).toBe(3); // user + assistant + tool
    expect(toolNames(calls[0]!)).toEqual(['search']);
    expect(toolNames(calls[1]!)).toEqual(['analyze']);
  });

  it('per-step activeTools overrides the static filter (not intersects)', async () => {
    const { fetch, calls } = mockFetchSequence([() => sseResponse([FINAL])]);
    await generateText({
      model: createAnthropic({ apiKey: 'k', fetch })('claude-opus-4-8'),
      messages: [{ role: 'user', content: 'go' }],
      tools: TOOLS,
      activeTools: ['search'],
      prepareStep: () => ({ activeTools: ['analyze'] }),
    });
    expect(toolNames(calls[0]!)).toEqual(['analyze']);
  });

  it('swaps the model per step (body.model changes on step 2)', async () => {
    const { fetch, calls } = mockFetchSequence([
      () => sseResponse([TOOL_CALL]),
      () => sseResponse([FINAL]),
    ]);
    const anthropic = createAnthropic({ apiKey: 'k', fetch });
    await generateText({
      model: anthropic('claude-opus-4-8'),
      messages: [{ role: 'user', content: 'go' }],
      tools: TOOLS,
      maxSteps: 5,
      prepareStep: ({ stepIndex }) =>
        stepIndex === 1 ? { model: anthropic('claude-haiku-4-5') } : undefined,
    });
    expect(JSON.parse(String(calls[0]!.init!.body)).model).toBe('claude-opus-4-8');
    expect(JSON.parse(String(calls[1]!.init!.body)).model).toBe('claude-haiku-4-5');
  });

  it('a returned messages array becomes the base for this and later steps', async () => {
    const { fetch, calls } = mockFetchSequence([
      () => sseResponse([TOOL_CALL]),
      () => sseResponse([FINAL]),
    ]);
    const res = await generateText({
      model: createAnthropic({ apiKey: 'k', fetch })('claude-opus-4-8'),
      messages: [
        { role: 'user', content: 'old noise' },
        { role: 'user', content: 'go' },
      ],
      tools: TOOLS,
      maxSteps: 5,
      prepareStep: ({ stepIndex, messages }) =>
        stepIndex === 0 ? { messages: messages.slice(1) } : undefined,
    });
    const body1 = JSON.parse(String(calls[0]!.init!.body));
    expect(body1.messages).toHaveLength(1); // noise trimmed
    const body2 = JSON.parse(String(calls[1]!.init!.body));
    expect(body2.messages).toHaveLength(3); // trimmed base + assistant + tool_result
    expect(JSON.stringify(body2.messages[0])).not.toContain('old noise');
    // response.messages still returns exactly what the loop appended
    expect(res.response.messages).toHaveLength(2);
    expect(res.response.messages[0]!.role).toBe('assistant');
    expect(res.response.messages[1]!.role).toBe('tool');
  });

  it('toolChoice override applies to that step', async () => {
    const { fetch, calls } = mockFetchSequence([() => sseResponse([FINAL])]);
    await generateText({
      model: createAnthropic({ apiKey: 'k', fetch })('claude-opus-4-8'),
      messages: [{ role: 'user', content: 'go' }],
      tools: TOOLS,
      prepareStep: () => ({ toolChoice: { type: 'tool', toolName: 'search' } }),
    });
    const body = JSON.parse(String(calls[0]!.init!.body));
    expect(body.tool_choice).toMatchObject({ type: 'tool', name: 'search' });
  });

  it('a throwing prepareStep fails the buffered call (never swallowed)', async () => {
    const { fetch } = mockFetchSequence([() => sseResponse([FINAL])]);
    await expect(
      generateText({
        model: createAnthropic({ apiKey: 'k', fetch })('claude-opus-4-8'),
        messages: [{ role: 'user', content: 'go' }],
        tools: TOOLS,
        prepareStep: () => {
          throw new Error('boom in prepareStep');
        },
      }),
    ).rejects.toThrow('boom in prepareStep');
  });

  it('streaming: per-step activeTools + throw surfaces as error part', async () => {
    const { fetch, calls } = mockFetchSequence([
      () => sseResponse([TOOL_CALL]),
      () => sseResponse([FINAL]),
    ]);
    const res = streamChat({
      model: createAnthropic({ apiKey: 'k', fetch })('claude-opus-4-8'),
      messages: [{ role: 'user', content: 'go' }],
      tools: TOOLS,
      maxSteps: 5,
      prepareStep: ({ stepIndex }: { stepIndex: number }): PrepareStepResult => ({
        activeTools: stepIndex === 0 ? ['search'] : ['analyze'],
      }),
    });
    let text = '';
    for await (const chunk of res.textStream) text += chunk;
    expect(text).toBe('Done.');
    expect(toolNames(calls[0]!)).toEqual(['search']);
    expect(toolNames(calls[1]!)).toEqual(['analyze']);

    const { fetch: f2 } = mockFetchSequence([() => sseResponse([FINAL])]);
    const bad = streamChat({
      model: createAnthropic({ apiKey: 'k', fetch: f2 })('claude-opus-4-8'),
      messages: [{ role: 'user', content: 'go' }],
      tools: TOOLS,
      prepareStep: () => {
        throw new Error('stream boom');
      },
    });
    const parts: string[] = [];
    for await (const p of bad.fullStream) parts.push(p.type);
    expect(parts).toContain('error');
    await expect(bad.usage).rejects.toThrow('stream boom');
  });
});
