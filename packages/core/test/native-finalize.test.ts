/**
 * native-finalize.test.ts (2.3, F15) — the native finalization request is one
 * more turn of the same conversation.
 *
 * Before the fix, a run with tools AND `output` sent its finalization request
 * with the loop's last assistant text as the FINAL message — a prefill, which
 * Claude 5.x models reject with HTTP 400 (inferred from Anthropic's documented
 * rules; not live-verified) — and with the tools removed or swapped for a
 * `json_output` tool. It also stored the answer as a bare text buffer, dropping
 * the turn's reasoning.
 *
 * Now the request ends with a user turn, carries the loop's tools with
 * `tool_choice: 'none'`, and the full assistant message is stored.
 */
import { describe, expect, it, vi } from 'vitest';
import * as inference from '../src/core/inference';
import { createInMemoryAgentRunStore, resumeAgent, runAgent, streamAgent } from '../src/agent-run';
import { createAnthropic } from '../src/anthropic';
import { createGoogleNative } from '../src/google';
import { createOpenAI, createOpenAIResponses } from '../src/openai';
import { createMockModel, mockFetchSequence, sseEvents, sseResponse } from '../src/testing';
import { handoff } from '../src/inference/handoff';
import type { LanguageModel } from '../src/types/model';
import { attachConfig, readConfig } from '../src/internal/config-symbol';
import type { AgentEvent, AgentRunStore } from '../src/types/agent-run';
import type { MockResponse } from '../src/testing';

vi.mock('../src/core/inference', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/inference')>();
  return { ...actual, runStream: vi.fn(actual.runStream) };
});

const parameters = { type: 'object' as const, properties: {} };
const schema = { type: 'object', properties: { answer: { type: 'number' } }, required: ['answer'] };
const output = {
  schema,
  mode: 'json' as const,
  validate(value: unknown) {
    if (!value || typeof (value as { answer?: unknown }).answer !== 'number')
      throw new Error('answer must be a number');
    return value as { answer: number };
  },
};

interface WireBody {
  messages: { role: string; content: unknown }[];
  tools?: { function: { name: string } }[];
  tool_choice?: unknown;
  response_format?: unknown;
}

function mocked(responses: MockResponse[], modelId?: string) {
  const base = createMockModel({ responses });
  const config = readConfig(base)!;
  const fetch = vi.fn(config.fetch!);
  const model = attachConfig({ ...base, ...(modelId ? { modelId } : {}) }, { ...config, fetch });
  const bodies = (): WireBody[] =>
    fetch.mock.calls.map(([, init]) => JSON.parse(String(init?.body)) as WireBody);
  return { model, fetch, bodies };
}

const toolNames = (body: WireBody): string[] => (body.tools ?? []).map((t) => t.function.name);

describe('native finalization request (F15)', () => {
  it('ends with a user turn after the loop’s final assistant answer', async () => {
    const { model, bodies } = mocked([
      { toolCalls: [{ toolName: 'lookup', id: 'l1', args: {} }] },
      { text: 'The answer is seven.' },
      { text: '{"answer":7}' },
    ]);
    const result = await runAgent({
      model,
      prompt: 'Find the answer.',
      output,
      tools: { lookup: { parameters, execute: () => 7 } },
    });
    expect(result).toMatchObject({ status: 'completed', output: { answer: 7 } });
    const finalize = bodies()[2]!;
    expect(finalize.messages.at(-1)?.role).toBe('user');
    expect(finalize.messages.at(-2)?.role).toBe('assistant');
    expect(JSON.stringify(finalize.messages.at(-2))).toContain('The answer is seven.');
    // The finalize turn is part of the durable, append-only transcript.
    const roles = result.messages.map((m) => m.role);
    expect(roles).toEqual(['user', 'assistant', 'tool', 'assistant', 'user', 'assistant']);
  });

  it('asks for the loop’s tools with tool_choice none alongside the structured format', async () => {
    const runStream = vi.mocked(inference.runStream);
    runStream.mockClear();
    const { model } = mocked([
      { toolCalls: [{ toolName: 'lookup', id: 'l1', args: {} }] },
      { text: 'ready' },
      { text: '{"answer":1}' },
    ]);
    const result = await runAgent({
      model,
      prompt: 'x',
      output,
      tools: {
        lookup: { description: 'Look it up.', parameters, execute: () => 1 },
        other: { parameters, execute: () => 2 },
      },
    });
    expect(result.status).toBe('completed');
    const [loopCall, finalizeCall] = [runStream.mock.calls[0]!, runStream.mock.calls.at(-1)!];
    const loopWire = loopCall[1]!.tools!;
    expect(finalizeCall[1]).toMatchObject({
      object: { strategy: 'json' },
      tools: { tools: loopWire.tools, toolChoice: 'none' },
    });
  });

  it('keeps the loop’s tools on the wire when a verifier re-drives a text answer', async () => {
    const { model, bodies } = mocked([
      { toolCalls: [{ toolName: 'lookup', id: 'l1', args: {} }] },
      { text: 'first draft' },
      { text: 'second draft' },
    ]);
    let calls = 0;
    const result = await runAgent({
      model,
      prompt: 'x',
      tools: { lookup: { parameters, execute: () => 1 } },
      verify: () =>
        calls++ === 0
          ? { status: 'rejected', feedback: 'Be more precise.' }
          : { status: 'verified' },
    });
    expect(result).toMatchObject({ status: 'completed', output: 'second draft' });
    const [loopBody, , redrive] = bodies();
    expect(toolNames(redrive!)).toEqual(toolNames(loopBody!));
    expect(redrive!.tool_choice).toBe('none');
    expect(redrive!.messages.at(-1)).toMatchObject({ role: 'user', content: 'Be more precise.' });
  });

  it('appends the finalize turn once, even when finalization is resumed', async () => {
    const { model } = mocked([
      { toolCalls: [{ toolName: 'lookup', id: 'l1', args: {} }] },
      { text: 'ready' },
      { text: '{"answer":2}' },
    ]);
    const inner = createInMemoryAgentRunStore();
    let crash = true;
    const store: AgentRunStore = {
      load: (id) => inner.load(id),
      save(envelope) {
        // Lose the write that records the finalization candidate.
        if (crash && envelope.candidateText !== undefined) {
          crash = false;
          throw new Error('crash after the finalize call');
        }
        return inner.save(envelope);
      },
    };
    const options = {
      model,
      prompt: 'x',
      output,
      tools: { lookup: { parameters, execute: () => 2 } },
      session: { store, runId: 'finalize-once', scope: 't' },
    };
    expect((await runAgent(options)).status).toBe('failed');
    const result = await resumeAgent(options);
    expect(result).toMatchObject({ status: 'completed', output: { answer: 2 } });
    const userTurns = result.messages.filter((m) => m.role === 'user');
    expect(userTurns).toHaveLength(2); // the prompt and one finalize turn
  });

  it('reports the finalization cost on the native stream', async () => {
    const { model } = mocked([
      { toolCalls: [{ toolName: 'lookup', id: 'l1', args: {} }] },
      { text: 'ready' },
      { text: '{"answer":3}' },
    ]);
    const stream = streamAgent({
      model,
      prompt: 'x',
      output,
      deps: { priceProvider: { priceUsage: () => 0.001 } },
      tools: { lookup: { parameters, execute: () => 3 } },
    });
    const events: AgentEvent<{ answer: number }>[] = [];
    for await (const event of stream.events) events.push(event);
    expect((await stream.result).status).toBe('completed');
    const finalizingCost = events.filter(
      (e) => e.type === 'part' && e.phase === 'finalizing' && e.part.type === 'cost',
    );
    expect(finalizingCost).toHaveLength(1);
    expect(finalizingCost[0]).toMatchObject({ part: { costUsd: 0.003, deltaUsd: 0.001 } });
  });
});

// After a handoff the target's model and tools drive every following step
// (handoffs.mdx), and finalization is one more turn of that conversation.
describe('native finalization after a handoff', () => {
  const answer = {
    schema: { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'] },
    mode: 'json' as const,
    validate(value: unknown) {
      if (!value || typeof (value as { answer?: unknown }).answer !== 'string')
        throw new Error('answer must be a string');
      return value as { answer: string };
    },
  };
  const transfer = { toolCalls: [{ toolName: 'transfer_to_billing', id: 'h1', args: {} }] };

  it('asks the target agent’s model for the structured output', async () => {
    const triage = mocked([transfer, { text: '{"answer":"from-triage"}' }], 'triage-model');
    const billing = mocked(
      [{ text: 'Billing handled it.' }, { text: '{"answer":"from-billing"}' }],
      'billing-model',
    );
    const result = await runAgent({
      model: triage.model,
      prompt: 'Refund me.',
      output: answer,
      tools: handoff({ billing: { model: billing.model, instructions: 'You are billing.' } }),
    });
    expect(result).toMatchObject({ status: 'completed', output: { answer: 'from-billing' } });
    expect(triage.fetch).toHaveBeenCalledTimes(1);
    expect(billing.fetch).toHaveBeenCalledTimes(2);
  });

  it('lets the target agent answer a verifier re-drive', async () => {
    const triage = mocked([transfer, { text: 'triage second draft' }], 'triage-model');
    const billing = mocked(
      [{ text: 'billing first draft' }, { text: 'billing second draft' }],
      'billing-model',
    );
    let verdicts = 0;
    const result = await runAgent({
      model: triage.model,
      prompt: 'Refund me.',
      tools: handoff({ billing: { model: billing.model, instructions: 'You are billing.' } }),
      verify: () =>
        verdicts++ === 0 ? { status: 'rejected', feedback: 'Again.' } : { status: 'verified' },
    });
    expect(result).toMatchObject({ status: 'completed', output: 'billing second draft' });
    expect(triage.fetch).toHaveBeenCalledTimes(1);
    expect(billing.fetch).toHaveBeenCalledTimes(2);
  });

  it('keeps the target’s model and tools when a finalizing leg is resumed', async () => {
    const triage = mocked([transfer, { text: 'triage redraft' }], 'triage-model');
    const billing = mocked(
      [{ text: 'billing draft' }, { text: 'billing redraft' }],
      'billing-model',
    );
    const inner = createInMemoryAgentRunStore();
    let lost = false;
    const store: AgentRunStore = {
      load: (id) => inner.load(id),
      save(envelope) {
        // Lose the write that records the re-drive attempt: the run stays `finalizing`.
        if (!lost && envelope.phase === 'finalizing' && envelope.finalizationAttempts === 1) {
          lost = true;
          throw new Error('disk full');
        }
        return inner.save(envelope);
      },
    };
    let verdicts = 0;
    const options = {
      model: triage.model,
      prompt: 'Refund me.',
      tools: handoff({
        billing: {
          model: billing.model,
          instructions: 'You are billing.',
          tools: { refund: { parameters, execute: () => 'ok' } },
        },
      }),
      verify: () =>
        verdicts++ === 0
          ? { status: 'rejected' as const, feedback: 'Again.' }
          : { status: 'verified' as const },
    };
    const first = await runAgent({ ...options, session: { store, runId: 'fin', scope: 't' } });
    expect(first.status).toBe('failed');
    expect((await inner.load('fin'))?.phase).toBe('finalizing');
    const resumed = await resumeAgent({
      ...options,
      session: { store: inner, runId: 'fin', scope: 't' },
    });
    expect(resumed).toMatchObject({ status: 'completed', output: 'billing redraft' });
    expect(triage.fetch).toHaveBeenCalledTimes(1);
    expect(billing.fetch).toHaveBeenCalledTimes(2);
    const [loopBody, redrive] = billing.bodies();
    expect(toolNames(loopBody!)).toEqual(['refund']);
    expect(toolNames(redrive!)).toEqual(['refund']);
    expect(redrive!.tool_choice).toBe('none');
  });
});

// --- Anthropic wire: the four current Claude identities -------------------------

const OVERRIDE = {
  reasoning: true,
  effortWire: 'output_config' as const,
  samplingRestrictions: true,
  structuredOutput: true,
  caching: true,
  maxOutput: 128_000,
  contextWindow: 1_000_000,
};
const OBJ = {
  type: 'object',
  properties: { a: { type: 'string' } },
  required: ['a'],
  additionalProperties: false,
};

type Block =
  | { type: 'thinking'; text?: string; signature: string }
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown };

function turn(blocks: Block[], stop = 'end_turn'): string {
  const events: { event: string; data: unknown }[] = [
    {
      event: 'message_start',
      data: { type: 'message_start', message: { usage: { input_tokens: 10, output_tokens: 1 } } },
    },
  ];
  blocks.forEach((block, index) => {
    const start =
      block.type === 'thinking'
        ? { type: 'thinking', thinking: '', signature: '' }
        : block.type === 'text'
          ? { type: 'text', text: '' }
          : { type: 'tool_use', id: block.id, name: block.name, input: {} };
    events.push({
      event: 'content_block_start',
      data: { type: 'content_block_start', index, content_block: start },
    });
    const deltas =
      block.type === 'thinking'
        ? [
            ...(block.text ? [{ type: 'thinking_delta', thinking: block.text }] : []),
            { type: 'signature_delta', signature: block.signature },
          ]
        : block.type === 'text'
          ? [{ type: 'text_delta', text: block.text }]
          : [{ type: 'input_json_delta', partial_json: JSON.stringify(block.input) }];
    for (const delta of deltas)
      events.push({
        event: 'content_block_delta',
        data: { type: 'content_block_delta', index, delta },
      });
    events.push({ event: 'content_block_stop', data: { type: 'content_block_stop', index } });
  });
  events.push({
    event: 'message_delta',
    data: { type: 'message_delta', delta: { stop_reason: stop }, usage: { output_tokens: 5 } },
  });
  events.push({ event: 'message_stop', data: { type: 'message_stop' } });
  return sseEvents(events);
}

describe('native finalization on the Anthropic wire (F15)', () => {
  it.each(['claude-fable-5-1', 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'])(
    '%s: finalization ends with a user turn and keeps the full assistant message',
    async (modelId) => {
      const sequence = mockFetchSequence([
        () =>
          sseResponse([
            turn(
              [
                { type: 'thinking', signature: 'SIG_A' },
                { type: 'tool_use', id: 'tu1', name: 'get_weather', input: { city: 'Rome' } },
              ],
              'tool_use',
            ),
          ]),
        () =>
          sseResponse([
            turn([
              { type: 'thinking', signature: 'SIG_B' },
              { type: 'text', text: 'It is 20C.' },
            ]),
          ]),
        () =>
          sseResponse([
            turn([
              { type: 'thinking', text: 'Format it.', signature: 'SIG_C' },
              { type: 'text', text: '{"a":"20C"}' },
            ]),
          ]),
      ]);
      const model = createAnthropic({ apiKey: 'k', fetch: sequence.fetch })(modelId);
      const result = await runAgent({
        model,
        prompt: 'Weather in Rome as JSON.',
        effort: 'high',
        capabilities: OVERRIDE,
        tools: {
          get_weather: {
            description: 'Weather',
            parameters: {
              type: 'object',
              properties: { city: { type: 'string' } },
              required: ['city'],
            },
            execute: () => ({ temp: 20 }),
          },
        },
        output: { schema: OBJ, validate: (value: unknown) => value as { a: string } },
      });
      expect(result).toMatchObject({ status: 'completed', output: { a: '20C' } });
      const finalize = JSON.parse(String(sequence.calls[2]!.init!.body)) as {
        messages: { role: string }[];
        output_config?: { format?: unknown };
        temperature?: unknown;
        thinking?: unknown;
      };
      // No prefill: the request ends with a user turn (a 400 on these models
      // otherwise — inferred from Anthropic's rules, not live-verified).
      expect(finalize.messages.at(-1)?.role).toBe('user');
      expect(finalize.output_config?.format).toMatchObject({ type: 'json_schema' });
      expect(finalize).not.toHaveProperty('temperature');
      expect(finalize).not.toHaveProperty('thinking');
      // The finalize turn is stored whole: its reasoning survives with its signature.
      expect(result.messages.at(-1)).toEqual({
        role: 'assistant',
        content: [
          { type: 'reasoning', text: 'Format it.', signature: 'SIG_C' },
          { type: 'text', text: '{"a":"20C"}' },
        ],
      });
    },
  );
});

/** One streamed text answer, in each wire's own event shape. */
const wireText = {
  anthropic: (text: string) =>
    sseEvents([
      {
        event: 'message_start',
        data: { type: 'message_start', message: { usage: { input_tokens: 2 } } },
      },
      {
        event: 'content_block_delta',
        data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
      },
      {
        event: 'message_delta',
        data: {
          type: 'message_delta',
          delta: { stop_reason: 'end_turn' },
          usage: { output_tokens: 1 },
        },
      },
      { event: 'message_stop', data: { type: 'message_stop' } },
    ]),
  chat: (text: string) =>
    sseEvents([
      { data: { choices: [{ index: 0, delta: { content: text }, finish_reason: null }] } },
      { data: { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] } },
      { data: { choices: [], usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 } } },
      { data: '[DONE]' },
    ]),
  responses: (text: string) =>
    sseEvents([
      {
        event: 'response.output_text.delta',
        data: { type: 'response.output_text.delta', delta: text },
      },
      {
        event: 'response.completed',
        data: {
          type: 'response.completed',
          response: { status: 'completed', usage: { input_tokens: 2, output_tokens: 1 } },
        },
      },
    ]),
  google: (text: string) =>
    sseEvents([
      { data: { candidates: [{ content: { role: 'model', parts: [{ text }] } }] } },
      {
        data: {
          candidates: [{ content: { role: 'model', parts: [] }, finishReason: 'STOP' }],
          usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 1, totalTokenCount: 3 },
        },
      },
    ]),
};

describe('native finalization across provider wires (F15)', () => {
  // Tools plus `output` is the trigger: the loop's final answer is an assistant
  // turn, and finalization must follow it with a user turn on every wire.
  const lastRole: Record<keyof typeof wireText, (body: Record<string, unknown>) => unknown> = {
    anthropic: (body) => (body.messages as { role: string }[]).at(-1)?.role,
    chat: (body) => (body.messages as { role: string }[]).at(-1)?.role,
    responses: (body) => (body.input as { role?: string }[]).at(-1)?.role,
    google: (body) => (body.contents as { role: string }[]).at(-1)?.role,
  };
  const models: Record<keyof typeof wireText, (fetch: typeof globalThis.fetch) => LanguageModel> = {
    anthropic: (fetch) => createAnthropic({ apiKey: 'k', fetch })('claude-opus-4-8'),
    chat: (fetch) => createOpenAI({ apiKey: 'k', fetch })('gpt-5.5'),
    responses: (fetch) => createOpenAIResponses({ apiKey: 'k', fetch })('gpt-5.5'),
    google: (fetch) => createGoogleNative({ apiKey: 'k', fetch })('gemini-2.5-flash'),
  };

  it.each(Object.keys(wireText) as (keyof typeof wireText)[])(
    '%s: the finalization request ends with a user turn',
    async (wire) => {
      const sequence = mockFetchSequence([
        () => sseResponse([wireText[wire]('Rome is mild today.')]),
        () => sseResponse([wireText[wire]('{"a":"mild"}')]),
      ]);
      const result = await runAgent({
        model: models[wire](sequence.fetch),
        prompt: 'Weather in Rome as JSON.',
        maxRetries: 0,
        tools: { lookup: { parameters, execute: () => 'mild' } },
        output: { schema: OBJ, validate: (value: unknown) => value as { a: string } },
      });
      expect(result).toMatchObject({ status: 'completed', output: { a: 'mild' } });
      expect(sequence.calls).toHaveLength(2);
      const finalize = JSON.parse(String(sequence.calls[1]!.init!.body)) as Record<string, unknown>;
      expect(lastRole[wire](finalize)).toBe('user');
    },
  );
});

describe("runAgent reports an output mode 'tool' the model cannot take (2.3, F26)", () => {
  it('streams one clamped-setting warning in the finalizing phase', async () => {
    const sequence = mockFetchSequence([
      () => sseResponse([turn([{ type: 'text', text: 'Rome is mild.' }])]),
      () => sseResponse([turn([{ type: 'text', text: '{"a":"mild"}' }])]),
    ]);
    const stream = streamAgent({
      model: createAnthropic({ apiKey: 'k', fetch: sequence.fetch })('claude-opus-5-5'),
      prompt: 'Weather in Rome as JSON.',
      output: { schema: OBJ, mode: 'tool', validate: (value: unknown) => value as { a: string } },
    });
    const events: AgentEvent<{ a: string }>[] = [];
    for await (const event of stream.events) events.push(event);
    expect(await stream.result).toMatchObject({ status: 'completed', output: { a: 'mild' } });
    const clamps = events.filter(
      (e) => e.type === 'part' && e.part.type === 'warning' && e.part.warning.setting === 'mode',
    );
    expect(clamps).toHaveLength(1);
    expect(clamps[0]).toMatchObject({
      phase: 'finalizing',
      part: { warning: { type: 'clamped-setting' } },
    });
  });
});
