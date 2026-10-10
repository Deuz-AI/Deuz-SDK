/**
 * reasoning-blocks.test.ts (2.3, F21) — every reasoning block is its own part,
 * kept in the order the model produced it, and replayed byte-identically.
 *
 * Before the fix the Anthropic parser had no block boundaries and never read
 * `redacted_thinking.data`; both loops merged every block of a turn into ONE
 * part carrying the LAST signature (a modified block, which Anthropic rejects
 * with 400), dropped a thinking block whose text was empty (Claude 5.x's default
 * `display: 'omitted'` streams only the signature), and the request builder
 * moved every thinking block to the front of the message.
 *
 * Acceptance (roadmap F21): `[thinking ''/S0, thinking 'a'/S1, redacted, text,
 * tool_use]` is replayed byte-identically in the next request of both loops.
 * The Anthropic wire is replayed offline from documented SSE shapes.
 */
import { describe, expect, it, vi } from 'vitest';
import { generateText, streamChat } from '../src/index';
import { createAnthropic } from '../src/anthropic';
import { createInMemoryAgentRunStore, resumeAgent, runAgent } from '../src/agent-run';
import { createInMemorySessionStore, resumeFromCheckpoint } from '../src/durable';
import { mockFetchSequence, sseEvents, sseResponse } from '../src/testing';
import type { StreamPart } from '../src/types/stream';
import type { JSONSchema } from '../src/types/schema';

const S0 = 'EqQBCkgIARABGAIiQFirstSignatureOfAnEmptyThinkingBlock==';
const S1 = 'EqQBCkgIARABGAIiQSecondSignatureOfAThinkingBlock==';
const REDACTED = 'EmwKAhgBEgy3va3pzix/LafPsn4aDFIT2Xlxh0L5L8rLVyIwxtE3rAFBa8cr3qpP';

type Block =
  | { type: 'thinking'; text?: string; signature: string }
  | { type: 'redacted_thinking'; data: string }
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; json: string };

/** One Anthropic Messages SSE turn, block by block, as the API streams it. */
function turn(blocks: Block[], stop: string): string {
  const events: { event: string; data: unknown }[] = [
    {
      event: 'message_start',
      data: {
        type: 'message_start',
        message: { id: 'msg', role: 'assistant', usage: { input_tokens: 10, output_tokens: 1 } },
      },
    },
  ];
  const delta = (index: number, d: unknown) =>
    events.push({
      event: 'content_block_delta',
      data: { type: 'content_block_delta', index, delta: d },
    });
  blocks.forEach((block, index) => {
    const start = (content_block: unknown) =>
      events.push({
        event: 'content_block_start',
        data: { type: 'content_block_start', index, content_block },
      });
    if (block.type === 'thinking') {
      start({ type: 'thinking', thinking: '', signature: '' });
      if (block.text) delta(index, { type: 'thinking_delta', thinking: block.text });
      delta(index, { type: 'signature_delta', signature: block.signature });
    } else if (block.type === 'redacted_thinking') {
      start({ type: 'redacted_thinking', data: block.data });
    } else if (block.type === 'text') {
      start({ type: 'text', text: '' });
      delta(index, { type: 'text_delta', text: block.text });
    } else {
      start({ type: 'tool_use', id: block.id, name: block.name, input: {} });
      delta(index, { type: 'input_json_delta', partial_json: block.json });
    }
    events.push({ event: 'content_block_stop', data: { type: 'content_block_stop', index } });
  });
  events.push({
    event: 'message_delta',
    data: { type: 'message_delta', delta: { stop_reason: stop }, usage: { output_tokens: 5 } },
  });
  events.push({ event: 'message_stop', data: { type: 'message_stop' } });
  return sseEvents(events);
}

const LOOKUP: JSONSchema = {
  type: 'object',
  properties: { q: { type: 'string' } },
  required: ['q'],
  additionalProperties: false,
};

/** The acceptance sequence, as the model produced it. */
const SEQUENCE: Block[] = [
  { type: 'thinking', signature: S0 },
  { type: 'thinking', text: 'a', signature: S1 },
  { type: 'redacted_thinking', data: REDACTED },
  { type: 'text', text: 'Let me look that up.' },
  { type: 'tool_use', id: 'toolu_1', name: 'lookup', json: '{"q":"x"}' },
];

/** The same blocks as a request must carry them back: unmodified, in order. */
const REPLAYED = [
  { type: 'thinking', thinking: '', signature: S0 },
  { type: 'thinking', thinking: 'a', signature: S1 },
  { type: 'redacted_thinking', data: REDACTED },
  { type: 'text', text: 'Let me look that up.' },
  { type: 'tool_use', id: 'toolu_1', name: 'lookup', input: { q: 'x' } },
];

const DONE = turn([{ type: 'text', text: 'Found it.' }], 'end_turn');

function anthropic(turns: string[], modelId = 'claude-opus-4-8') {
  const sequence = mockFetchSequence(turns.map((body) => () => sseResponse([body])));
  const model = createAnthropic({ apiKey: 'k', fetch: sequence.fetch })(modelId);
  const bodies = () =>
    sequence.calls.map(
      (c) =>
        JSON.parse(String(c.init!.body)) as {
          messages: { role: string; content: unknown }[];
        },
    );
  return { model, calls: sequence.calls, bodies };
}

/** The assistant turn of the second request, serialized exactly as it was sent. */
function replayedTurn(bodies: { messages: { role: string; content: unknown }[] }[]): string {
  const second = bodies[1]!;
  const assistant = second.messages.find((m) => m.role === 'assistant');
  return JSON.stringify(assistant?.content);
}

async function drain(stream: AsyncIterable<StreamPart>): Promise<StreamPart[]> {
  const parts: StreamPart[] = [];
  for await (const part of stream) parts.push(part);
  return parts;
}

describe('Anthropic stream parsing keeps block boundaries', () => {
  it('emits one id per block, the empty signed block, the redacted data and the source', async () => {
    const { model } = anthropic([turn(SEQUENCE, 'tool_use')]);
    const parts = await drain(
      streamChat({ model, messages: [{ role: 'user', content: 'q' }] }).fullStream,
    );
    const reasoning = parts.filter((p) => p.type === 'reasoning-delta');
    expect(reasoning).toEqual([
      { type: 'reasoning-delta', text: '', signature: S0, id: '0', source: 'anthropic' },
      { type: 'reasoning-delta', text: 'a', id: '1', source: 'anthropic' },
      { type: 'reasoning-delta', text: '', signature: S1, id: '1', source: 'anthropic' },
      { type: 'reasoning-delta', text: REDACTED, redacted: true, id: '2', source: 'anthropic' },
    ]);
  });
});

describe('F21 acceptance: the block sequence replays byte-identically', () => {
  const tools = () => ({
    lookup: { parameters: LOOKUP, execute: vi.fn(() => 'result') },
  });

  it('buffered loop (generateText)', async () => {
    const { model, bodies } = anthropic([turn(SEQUENCE, 'tool_use'), DONE]);
    const result = await generateText({ model, prompt: 'q', tools: tools(), maxSteps: 3 });
    expect(result.text).toBe('Found it.');
    expect(replayedTurn(bodies())).toBe(JSON.stringify(REPLAYED));
  });

  it('streaming loop (streamChat)', async () => {
    const { model, bodies } = anthropic([turn(SEQUENCE, 'tool_use'), DONE]);
    await drain(streamChat({ model, prompt: 'q', tools: tools(), maxSteps: 3 }).fullStream);
    expect(replayedTurn(bodies())).toBe(JSON.stringify(REPLAYED));
  });

  it('native run (runAgent)', async () => {
    const { model, bodies } = anthropic([turn(SEQUENCE, 'tool_use'), DONE]);
    const result = await runAgent({ model, prompt: 'q', tools: tools() });
    expect(result.status).toBe('completed');
    expect(replayedTurn(bodies())).toBe(JSON.stringify(REPLAYED));
  });

  it('the canonical turn holds one part per block, each with its source', async () => {
    const { model } = anthropic([turn(SEQUENCE, 'tool_use'), DONE]);
    const result = await generateText({ model, prompt: 'q', tools: tools(), maxSteps: 3 });
    expect(result.response.messages[0]).toEqual({
      role: 'assistant',
      content: [
        { type: 'reasoning', text: '', signature: S0, source: 'anthropic' },
        { type: 'reasoning', text: 'a', signature: S1, source: 'anthropic' },
        { type: 'reasoning', text: REDACTED, redacted: true, source: 'anthropic' },
        { type: 'text', text: 'Let me look that up.' },
        { type: 'tool_use', id: 'toolu_1', name: 'lookup', input: { q: 'x' } },
      ],
    });
    // The display projection is the readable thinking only, never opaque data.
    expect(result.steps?.[0]?.reasoningText).toBe('a');
  });

  it('never reorders blocks: thinking between tool calls stays between them', async () => {
    // Progress-update thinking (display: 'updates') can sit between two calls.
    const interleaved: Block[] = [
      { type: 'thinking', text: 'first', signature: S0 },
      { type: 'tool_use', id: 'toolu_1', name: 'lookup', json: '{"q":"a"}' },
      { type: 'thinking', text: 'then', signature: S1 },
      { type: 'tool_use', id: 'toolu_2', name: 'lookup', json: '{"q":"b"}' },
    ];
    for (const loop of ['buffered', 'streaming'] as const) {
      const { model, bodies } = anthropic([turn(interleaved, 'tool_use'), DONE]);
      if (loop === 'buffered') {
        await generateText({ model, prompt: 'q', tools: tools(), maxSteps: 3 });
      } else {
        await drain(streamChat({ model, prompt: 'q', tools: tools(), maxSteps: 3 }).fullStream);
      }
      expect(replayedTurn(bodies()), loop).toBe(
        JSON.stringify([
          { type: 'thinking', thinking: 'first', signature: S0 },
          { type: 'tool_use', id: 'toolu_1', name: 'lookup', input: { q: 'a' } },
          { type: 'thinking', thinking: 'then', signature: S1 },
          { type: 'tool_use', id: 'toolu_2', name: 'lookup', input: { q: 'b' } },
        ]),
      );
    }
  });

  it('a hand-built history keeps its order on the wire', async () => {
    const { model, bodies } = anthropic([DONE, DONE]);
    const history = [
      { role: 'user' as const, content: 'q' },
      {
        role: 'assistant' as const,
        content: [
          { type: 'text' as const, text: 'Before.' },
          { type: 'reasoning' as const, text: 't', signature: S0, source: 'anthropic' },
          { type: 'text' as const, text: 'After.' },
        ],
      },
      { role: 'user' as const, content: 'go on' },
    ];
    await generateText({ model, messages: history });
    await generateText({ model, messages: history });
    expect(JSON.stringify(bodies()[1]!.messages[1]!.content)).toBe(
      JSON.stringify([
        { type: 'text', text: 'Before.' },
        { type: 'thinking', thinking: 't', signature: S0 },
        { type: 'text', text: 'After.' },
      ]),
    );
  });
});

describe('checkpoints and native envelopes keep every block', () => {
  const gated = () => ({
    lookup: { parameters: LOOKUP, execute: vi.fn(() => 'result'), needsApproval: true },
  });

  it('a durable checkpoint resumes with the blocks byte-identical', async () => {
    const store = createInMemorySessionStore();
    const first = anthropic([turn(SEQUENCE, 'tool_use')]);
    const suspended = await generateText({
      model: first.model,
      prompt: 'q',
      tools: gated(),
      maxSteps: 3,
      session: { store, runId: 'cp' },
    });
    expect(suspended.pendingApprovals).toHaveLength(1);
    const resumed = anthropic([DONE]);
    await resumeFromCheckpoint(store, 'cp', {
      model: resumed.model,
      tools: gated(),
      approvalResponses: [{ approvalId: 'toolu_1', approved: true }],
      maxSteps: 3,
    });
    const body = resumed.bodies()[0]!;
    const assistant = body.messages.find((m) => m.role === 'assistant');
    expect(JSON.stringify(assistant?.content)).toBe(JSON.stringify(REPLAYED));
  });

  it('a native envelope resumes with the blocks byte-identical', async () => {
    const store = createInMemoryAgentRunStore();
    const first = anthropic([turn(SEQUENCE, 'tool_use')]);
    const suspended = await runAgent({
      model: first.model,
      prompt: 'q',
      tools: gated(),
      session: { store, runId: 'native', scope: 't' },
    });
    expect(suspended.status).toBe('suspended');
    const saved = await store.load('native');
    const stored = saved!.messages.find((m) => m.role === 'assistant');
    expect(stored?.content).toEqual([
      { type: 'reasoning', text: '', signature: S0, source: 'anthropic' },
      { type: 'reasoning', text: 'a', signature: S1, source: 'anthropic' },
      { type: 'reasoning', text: REDACTED, redacted: true, source: 'anthropic' },
      { type: 'text', text: 'Let me look that up.' },
      { type: 'tool_use', id: 'toolu_1', name: 'lookup', input: { q: 'x' } },
    ]);
    const resumed = anthropic([DONE]);
    const result = await resumeAgent({
      model: resumed.model,
      prompt: 'q',
      tools: gated(),
      session: { store, runId: 'native', scope: 't' },
      approvalResponses: [{ approvalId: 'toolu_1', approved: true }],
    });
    expect(result.status).toBe('completed');
    const body = resumed.bodies()[0]!;
    const assistant = body.messages.find((m) => m.role === 'assistant');
    expect(JSON.stringify(assistant?.content)).toBe(JSON.stringify(REPLAYED));
  });
});
