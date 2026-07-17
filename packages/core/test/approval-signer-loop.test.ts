import { describe, it, expect, vi } from 'vitest';
import { streamChat, generateText } from '../src/index';
import { createAnthropic } from '../src/anthropic';
import { createApprovalSigner } from '../src/durable';
import type { JSONSchema } from '../src/types/schema';
import { sseResponse, sseEvents, mockFetchSequence } from './fixtures/sse';

const SCHEMA: JSONSchema = {
  type: 'object',
  properties: { q: { type: 'string' } },
  required: ['q'],
  additionalProperties: false,
};

const TOOL_TURN = sseEvents([
  {
    event: 'message_start',
    data: { type: 'message_start', message: { usage: { input_tokens: 10, output_tokens: 1 } } },
  },
  {
    event: 'content_block_start',
    data: {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'tool_use', id: 'toolu_1', name: 'pay' },
    },
  },
  {
    event: 'content_block_delta',
    data: {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'input_json_delta', partial_json: '{"q":"send $100"}' },
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
const OK_TURN = sseEvents([
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
    data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Paid.' } },
  },
  {
    event: 'message_delta',
    data: {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn' },
      usage: { output_tokens: 4 },
    },
  },
  { event: 'message_stop', data: { type: 'message_stop' } },
]);

const clockAt = (t: number) => ({
  now: () => t,
  setTimeout: (fn: () => void, _ms: number) => (setTimeout(fn, 0), () => {}),
});

const HISTORY = [
  { role: 'user' as const, content: 'pay my bill' },
  {
    role: 'assistant' as const,
    content: [{ type: 'tool_use' as const, id: 'toolu_1', name: 'pay', input: { q: 'send $100' } }],
  },
];

describe('approvalSigner loop wiring (1.7, D4)', () => {
  it('signs pending approvals; a valid echoed token approves, forgery denies', async () => {
    const signer = createApprovalSigner({ secret: 'topsecret', clock: clockAt(1_000) });
    const pay = vi.fn(async () => 'transferred');
    const tools = { pay: { parameters: SCHEMA, execute: pay, needsApproval: true } };

    // Leg 1: the streamed approval request carries a signed token.
    const leg1 = mockFetchSequence([() => sseResponse([TOOL_TURN])]);
    const r1 = streamChat({
      model: createAnthropic({ apiKey: 'k', fetch: leg1.fetch })('claude-opus-4-8'),
      messages: [{ role: 'user', content: 'pay my bill' }],
      tools,
      maxSteps: 5,
      approvalSigner: signer,
    });
    let token: string | undefined;
    for await (const p of r1.fullStream) {
      if (p.type === 'tool-approval-request') token = p.token;
    }
    expect(token).toBeDefined();
    expect(await signer.verify(token!)).toMatchObject({ approvalId: 'toolu_1' });
    expect(pay).not.toHaveBeenCalled();

    // Resume with the VALID token -> the tool executes.
    const leg2 = mockFetchSequence([() => sseResponse([OK_TURN])]);
    const r2 = streamChat({
      model: createAnthropic({ apiKey: 'k', fetch: leg2.fetch })('claude-opus-4-8'),
      messages: HISTORY,
      tools,
      maxSteps: 5,
      approvalSigner: signer,
      approvalResponses: [{ approvalId: 'toolu_1', approved: true, token }],
    });
    for await (const _ of r2.fullStream) void _;
    expect(pay).toHaveBeenCalledTimes(1);

    // Resume with a FORGED token (other secret) -> denied, no second execution.
    const forged = await createApprovalSigner({ secret: 'other', clock: clockAt(1_000) }).sign({
      approvalId: 'toolu_1',
      toolCallId: 'toolu_1',
      toolName: 'pay',
      input: {},
    });
    const leg3 = mockFetchSequence([() => sseResponse([OK_TURN])]);
    const r3 = streamChat({
      model: createAnthropic({ apiKey: 'k', fetch: leg3.fetch })('claude-opus-4-8'),
      messages: HISTORY,
      tools,
      maxSteps: 5,
      approvalSigner: signer,
      approvalResponses: [{ approvalId: 'toolu_1', approved: true, token: forged }],
    });
    for await (const _ of r3.fullStream) void _;
    expect(pay).toHaveBeenCalledTimes(1); // still 1 — forgery denied
    const leg3Body = JSON.parse(String(leg3.calls[0]!.init!.body)) as { messages: unknown };
    expect(JSON.stringify(leg3Body.messages)).toContain('Approval token missing');
  });

  it('token-less approvals are denied; expiry (approvalMaxAgeMs) is enforced', async () => {
    const pay = vi.fn(async () => 'transferred');
    const tools = { pay: { parameters: SCHEMA, execute: pay, needsApproval: true } };
    const signer = createApprovalSigner({ secret: 's3', clock: clockAt(1_000) });

    // No token -> denied.
    const a = mockFetchSequence([() => sseResponse([OK_TURN])]);
    await generateText({
      model: createAnthropic({ apiKey: 'k', fetch: a.fetch })('claude-opus-4-8'),
      messages: HISTORY,
      tools,
      maxSteps: 5,
      approvalSigner: signer,
      approvalResponses: [{ approvalId: 'toolu_1', approved: true }],
    });
    expect(pay).not.toHaveBeenCalled();

    // Expired token -> denied (issued at t=1000, verified at t=100000, maxAge 5s).
    const oldToken = await signer.sign({
      approvalId: 'toolu_1',
      toolCallId: 'toolu_1',
      toolName: 'pay',
      input: { q: 'send $100' },
    });
    const lateSigner = createApprovalSigner({ secret: 's3', clock: clockAt(100_000) });
    const b = mockFetchSequence([() => sseResponse([OK_TURN])]);
    await generateText({
      model: createAnthropic({ apiKey: 'k', fetch: b.fetch })('claude-opus-4-8'),
      messages: HISTORY,
      tools,
      maxSteps: 5,
      approvalSigner: lateSigner,
      approvalMaxAgeMs: 5_000,
      approvalResponses: [{ approvalId: 'toolu_1', approved: true, token: oldToken }],
    });
    expect(pay).not.toHaveBeenCalled();

    // Denials never need tokens.
    const c = mockFetchSequence([() => sseResponse([OK_TURN])]);
    const denied = await generateText({
      model: createAnthropic({ apiKey: 'k', fetch: c.fetch })('claude-opus-4-8'),
      messages: HISTORY,
      tools,
      maxSteps: 5,
      approvalSigner: signer,
      approvalResponses: [{ approvalId: 'toolu_1', approved: false, reason: 'too expensive' }],
    });
    expect(pay).not.toHaveBeenCalled();
    expect(denied.text).toBe('Paid.'); // the loop continued after the deny
  });

  it('runId binding: a token signed for another run is denied on a durable resume', async () => {
    const { createInMemorySessionStore } = await import('../src/durable');
    const pay = vi.fn(async () => 'transferred');
    const tools = { pay: { parameters: SCHEMA, execute: pay, needsApproval: true } };
    const signer = createApprovalSigner({ secret: 's4', clock: clockAt(1_000) });
    const otherRunToken = await signer.sign(
      { approvalId: 'toolu_1', toolCallId: 'toolu_1', toolName: 'pay', input: { q: 'send $100' } },
      { runId: 'run-OTHER' },
    );
    const a = mockFetchSequence([() => sseResponse([OK_TURN])]);
    await generateText({
      model: createAnthropic({ apiKey: 'k', fetch: a.fetch })('claude-opus-4-8'),
      messages: HISTORY,
      tools,
      maxSteps: 5,
      approvalSigner: signer,
      session: { store: createInMemorySessionStore(), runId: 'run-THIS' },
      approvalResponses: [{ approvalId: 'toolu_1', approved: true, token: otherRunToken }],
    });
    expect(pay).not.toHaveBeenCalled();
  });
});
