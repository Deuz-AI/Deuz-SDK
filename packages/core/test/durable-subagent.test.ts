import { describe, it, expect, vi } from 'vitest';
import { generateText, streamChat, agentTool } from '../src/index';
import { createInMemorySessionStore, resumeFromCheckpoint } from '../src/durable';
import type { SessionStore } from '../src/types/session';
import type { StreamPart } from '../src/types/stream';
import type { ToolSet } from '../src/types/tool';
import { createAnthropic } from '../src/anthropic';
import type { JSONSchema } from '../src/types/schema';
import { sseResponse, sseEvents, mockFetchSequence } from './fixtures/sse';

const SCHEMA: JSONSchema = {
  type: 'object',
  properties: { q: { type: 'string' } },
  required: ['q'],
  additionalProperties: false,
};

/** Anthropic assistant turn calling `toolName` with `argsJson`. Usage 10 in / 5 out. */
function toolCallSse(toolName: string, id: string, argsJson: string) {
  return sseEvents([
    {
      event: 'message_start',
      data: { type: 'message_start', message: { usage: { input_tokens: 10, output_tokens: 1 } } },
    },
    {
      event: 'content_block_start',
      data: {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id, name: toolName },
      },
    },
    {
      event: 'content_block_delta',
      data: {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: argsJson },
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
}

/** Anthropic final text turn. Usage 20 in / 6 out. */
function textSse(text: string) {
  return sseEvents([
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
      data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
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
}

function model(fetch: typeof globalThis.fetch, id = 'claude-opus-4-8') {
  return createAnthropic({ apiKey: 'k', fetch })(id);
}

/** Parent toolset: one `worker` agentTool whose `danger` tool is approval-gated (client mode). */
function workerTools(
  fetch: typeof globalThis.fetch,
  danger: (args: unknown) => Promise<unknown>,
): ToolSet {
  return {
    worker: agentTool({
      name: 'worker',
      description: 'does gated work',
      model: model(fetch, 'claude-haiku-4-5'),
      tools: { danger: { parameters: SCHEMA, execute: danger, needsApproval: true } },
      maxSteps: 5,
    }),
  };
}

describe('durable sub-agent client-mode approval — suspend', () => {
  async function suspendLeg(store: SessionStore) {
    const dangerFn = vi.fn(async () => 'dangerous result');
    const { fetch, calls } = mockFetchSequence([
      () => sseResponse([toolCallSse('worker', 'call_w', '{"prompt":"go"}')]), // parent → worker
      () => sseResponse([toolCallSse('danger', 'call_d', '{"q":"x"}')]), // worker → danger (gated)
    ]);
    const res = await generateText({
      model: model(fetch),
      messages: [{ role: 'user', content: 'go' }],
      tools: workerTools(fetch, dangerFn),
      maxSteps: 5,
      session: { store, runId: 'run-sub' },
    });
    return { res, dangerFn, calls };
  }

  it('suspends the parent with agentPath-tagged pendingApprovals instead of an is_error', async () => {
    const store = createInMemorySessionStore();
    const { res, dangerFn, calls } = await suspendLeg(store);

    expect(calls).toHaveLength(2); // parent step + child step, then suspend
    expect(dangerFn).not.toHaveBeenCalled();
    expect(res.runId).toBe('run-sub');
    expect(res.pendingApprovals).toEqual([
      {
        approvalId: 'call_d',
        toolCallId: 'call_d',
        toolName: 'danger',
        input: { q: 'x' },
        agentPath: ['worker'],
      },
    ]);
  });

  it('persists a suspended parent checkpoint AND a suspended child checkpoint', async () => {
    const store = createInMemorySessionStore();
    await suspendLeg(store);

    const parent = await store.load('run-sub');
    expect(parent?.status).toBe('suspended');
    expect(parent?.pendingApprovals?.[0]).toMatchObject({
      approvalId: 'call_d',
      agentPath: ['worker'],
    });
    // Parent usage: parent step (15) + child step (15).
    expect(parent?.usage.totalTokens).toBe(30);
    // The worker tool_use in the parent history stays UNANSWERED (settled on resume).
    expect(parent?.messages.at(-1)?.role).toBe('assistant');

    const child = await store.load('run-sub::worker#call_w');
    expect(child?.status).toBe('suspended');
    expect(child?.agentPath).toEqual(['worker']);
    expect(child?.usage.totalTokens).toBe(15);
    expect(child?.pendingApprovals?.[0]).toMatchObject({
      approvalId: 'call_d',
      toolName: 'danger',
      agentPath: ['worker'],
    });
  });

  it('streaming parent: emits a top-level agentPath-tagged tool-approval-request and suspends', async () => {
    const store = createInMemorySessionStore();
    const { fetch } = mockFetchSequence([
      () => sseResponse([toolCallSse('worker', 'call_w', '{"prompt":"go"}')]),
      () => sseResponse([toolCallSse('danger', 'call_d', '{"q":"x"}')]),
    ]);
    const result = streamChat({
      model: model(fetch),
      messages: [{ role: 'user', content: 'go' }],
      tools: workerTools(
        fetch,
        vi.fn(async () => 'r'),
      ),
      maxSteps: 5,
      session: { store, runId: 'run-st-sub' },
    });
    expect(result.runId).toBe('run-st-sub');
    const parts: StreamPart[] = [];
    for await (const part of result.fullStream) parts.push(part);

    const approvals = parts.filter(
      (p): p is Extract<StreamPart, { type: 'tool-approval-request' }> =>
        p.type === 'tool-approval-request',
    );
    expect(approvals).toHaveLength(1);
    expect(approvals[0]).toMatchObject({ approvalId: 'call_d', agentPath: ['worker'] });
    expect((await store.load('run-st-sub'))?.status).toBe('suspended');
    expect((await store.load('run-st-sub::worker#call_w'))?.status).toBe('suspended');
    // The parent's own step finished on tool_calls — no new FinishReason invented.
    await expect(result.finishReason).resolves.toBe('tool_calls');
  });

  it('without a durable session the legacy clear is_error is preserved', async () => {
    const { fetch, calls } = mockFetchSequence([
      () => sseResponse([toolCallSse('worker', 'call_w', '{"prompt":"go"}')]),
      () => sseResponse([toolCallSse('danger', 'call_d', '{"q":"x"}')]),
      () => sseResponse([textSse('final')]), // parent recovers from the is_error
    ]);
    const res = await generateText({
      model: model(fetch),
      messages: [{ role: 'user', content: 'go' }],
      tools: workerTools(
        fetch,
        vi.fn(async () => 'r'),
      ),
      maxSteps: 5,
      // no session
    });
    expect(res.text).toBe('final');
    expect(res.pendingApprovals).toBeUndefined();
    const parentBody = JSON.stringify(JSON.parse(String(calls[2]!.init!.body)).messages);
    expect(parentBody).toContain('not supported yet');
  });
});

describe('durable sub-agent client-mode approval — resume', () => {
  async function suspend(store: SessionStore, danger: (args: unknown) => Promise<unknown>) {
    const { fetch } = mockFetchSequence([
      () => sseResponse([toolCallSse('worker', 'call_w', '{"prompt":"go"}')]),
      () => sseResponse([toolCallSse('danger', 'call_d', '{"q":"x"}')]),
    ]);
    await generateText({
      model: model(fetch),
      messages: [{ role: 'user', content: 'go' }],
      tools: workerTools(fetch, danger),
      maxSteps: 5,
      session: { store, runId: 'run-sub' },
    });
  }

  it('approved verdict resumes the suspended child, executes the tool, and completes the parent', async () => {
    const store = createInMemorySessionStore();
    const dangerFn = vi.fn(async () => 'dangerous result');
    await suspend(store, dangerFn);

    const { fetch, calls } = mockFetchSequence([
      () => sseResponse([textSse('child done')]), // resumed child, after the settled tool
      () => sseResponse([textSse('parent done')]), // parent final step
    ]);
    const res = await resumeFromCheckpoint(store, 'run-sub', {
      model: model(fetch),
      tools: workerTools(fetch, dangerFn),
      approvalResponses: [{ approvalId: 'call_d', approved: true }],
      maxSteps: 5,
    });

    expect(dangerFn).toHaveBeenCalledTimes(1);
    expect(res.text).toBe('parent done');
    expect(res.runId).toBe('run-sub');
    // The resumed CHILD answered its pending danger tool_use (Anthropic 400 guard).
    const childBody = String(calls[0]!.init!.body);
    expect(childBody).toContain('tool_result');
    expect(childBody).toContain('call_d');
    expect(childBody).toContain('dangerous result');
    // The parent's worker tool_use got the child's final answer as its result.
    const parentBody = String(calls[1]!.init!.body);
    expect(parentBody).toContain('call_w');
    expect(parentBody).toContain('child done');

    // Checkpoints: child completed (15 + 26 = 41), parent completed across all legs
    // (leg1 30 + child leg 26 + parent final 26 = 82).
    const child = await store.load('run-sub::worker#call_w');
    expect(child?.status).toBe('completed');
    expect(child?.usage.totalTokens).toBe(41);
    const parent = await store.load('run-sub');
    expect(parent?.status).toBe('completed');
    expect(parent?.usage.totalTokens).toBe(82);
  });

  it('denied verdict feeds an is_error into the child, which recovers', async () => {
    const store = createInMemorySessionStore();
    const dangerFn = vi.fn(async () => 'dangerous result');
    await suspend(store, dangerFn);

    const { fetch, calls } = mockFetchSequence([
      () => sseResponse([textSse('child recovered')]),
      () => sseResponse([textSse('parent done')]),
    ]);
    const res = await resumeFromCheckpoint(store, 'run-sub', {
      model: model(fetch),
      tools: workerTools(fetch, dangerFn),
      approvalResponses: [{ approvalId: 'call_d', approved: false, reason: 'too risky' }],
      maxSteps: 5,
    });

    expect(dangerFn).not.toHaveBeenCalled();
    expect(res.text).toBe('parent done');
    const childBody = String(calls[0]!.init!.body);
    expect(childBody).toContain('Tool call denied.');
    expect(childBody).toContain('too risky');
  });

  it('a second suspension during the resume leg suspends the parent again (multi-round approvals)', async () => {
    const store = createInMemorySessionStore();
    const dangerFn = vi.fn(async (args: unknown) => `did ${JSON.stringify(args)}`);
    await suspend(store, dangerFn);

    // Resume leg 2: the child settles call_d, then immediately calls danger AGAIN.
    const { fetch: f2 } = mockFetchSequence([
      () => sseResponse([toolCallSse('danger', 'call_d2', '{"q":"y"}')]),
    ]);
    const res2 = await resumeFromCheckpoint(store, 'run-sub', {
      model: model(f2),
      tools: workerTools(f2, dangerFn),
      approvalResponses: [{ approvalId: 'call_d', approved: true }],
      maxSteps: 5,
    });
    expect(dangerFn).toHaveBeenCalledTimes(1); // call_d ran; call_d2 is pending
    expect(res2.pendingApprovals).toEqual([
      {
        approvalId: 'call_d2',
        toolCallId: 'call_d2',
        toolName: 'danger',
        input: { q: 'y' },
        agentPath: ['worker'],
      },
    ]);
    expect((await store.load('run-sub'))?.status).toBe('suspended');

    // Resume leg 3: settle call_d2 → child final → parent final.
    const { fetch: f3 } = mockFetchSequence([
      () => sseResponse([textSse('child done')]),
      () => sseResponse([textSse('parent done')]),
    ]);
    const res3 = await resumeFromCheckpoint(store, 'run-sub', {
      model: model(f3),
      tools: workerTools(f3, dangerFn),
      approvalResponses: [{ approvalId: 'call_d2', approved: true }],
      maxSteps: 5,
    });
    expect(dangerFn).toHaveBeenCalledTimes(2);
    expect(res3.text).toBe('parent done');
    expect((await store.load('run-sub'))?.status).toBe('completed');
    // All legs: 15+15 (leg1) + 15 (child d2 step) + 26+26 (leg3) = 97.
    expect((await store.load('run-sub'))?.usage.totalTokens).toBe(97);
  });
});
