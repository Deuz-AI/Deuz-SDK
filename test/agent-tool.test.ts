import { describe, it, expect, vi } from 'vitest';
import { generateText, streamChat, agentTool, totalTokensExceed } from '../src/index';
import type { StreamPart } from '../src/types/stream';
import type { Usage, UsageMeta } from '../src/index';
import { createAnthropic } from '../src/anthropic';
import type { JSONSchema } from '../src/types/schema';
import { sseResponse, sseEvents, mockFetchSequence } from './fixtures/sse';

const SCHEMA: JSONSchema = {
  type: 'object',
  properties: { q: { type: 'string' } },
  required: ['q'],
  additionalProperties: false,
};

/** Anthropic assistant turn that calls `toolName` with `{... }` input. Usage 10/5. */
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

/** Anthropic text turn. Usage 20/6. */
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
      data: { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 6 } },
    },
    { event: 'message_stop', data: { type: 'message_stop' } },
  ]);
}

function model(fetch: typeof globalThis.fetch, id = 'claude-opus-4-8') {
  return createAnthropic({ apiKey: 'k', fetch })(id);
}

describe('agentTool — orchestrator → worker', () => {
  it('delegates to a sub-agent and returns its answer (buffered parent)', async () => {
    const { fetch, calls } = mockFetchSequence([
      () => sseResponse([toolCallSse('worker', 'call_w', '{"prompt":"research X"}')]), // parent step 0
      () => sseResponse([textSse('worker summary')]), // sub-agent step 0
      () => sseResponse([textSse('final answer')]), // parent step 1
    ]);
    const res = await generateText({
      model: model(fetch),
      messages: [{ role: 'user', content: 'delegate please' }],
      tools: {
        worker: agentTool({
          name: 'worker',
          description: 'Does research',
          model: model(fetch, 'claude-haiku-4-5'),
        }),
      },
      maxSteps: 5,
    });
    expect(calls).toHaveLength(3);
    expect(res.text).toBe('final answer');
    // The sub-agent's answer was fed back to the parent as the tool result.
    const parentStep2Body = JSON.stringify(JSON.parse(String(calls[2]!.init!.body)).messages);
    expect(parentStep2Body).toContain('worker summary');
  });

  it('forwards the sub-agent stream live as sub-agent parts with agentPath (streaming parent)', async () => {
    const { fetch } = mockFetchSequence([
      () => sseResponse([toolCallSse('worker', 'call_w', '{"prompt":"go"}')]),
      () => sseResponse([textSse('sub result')]),
      () => sseResponse([textSse('done')]),
    ]);
    const res = streamChat({
      model: model(fetch),
      messages: [{ role: 'user', content: 'go' }],
      tools: {
        worker: agentTool({ name: 'worker', description: 'w', model: model(fetch, 'claude-haiku-4-5') }),
      },
      maxSteps: 5,
    });
    const subParts: StreamPart[] = [];
    for await (const part of res.fullStream) {
      if (part.type === 'sub-agent') subParts.push(part);
    }
    expect(subParts.length).toBeGreaterThan(0);
    // Every forwarded part carries the sub-agent's path.
    for (const p of subParts) {
      expect((p as Extract<StreamPart, { type: 'sub-agent' }>).agentPath).toEqual(['worker']);
    }
    // The sub-agent's text delta is visible inside the wrapper.
    const innerText = subParts
      .map((p) => (p as Extract<StreamPart, { type: 'sub-agent' }>).part)
      .filter((p): p is Extract<StreamPart, { type: 'text-delta' }> => p.type === 'text-delta')
      .map((p) => p.text)
      .join('');
    expect(innerText).toBe('sub result');
  });

  it('runs silently under subAgentStream:"none" (no sub-agent parts, same result)', async () => {
    const { fetch } = mockFetchSequence([
      () => sseResponse([toolCallSse('worker', 'call_w', '{"prompt":"go"}')]),
      () => sseResponse([textSse('sub result')]),
      () => sseResponse([textSse('done')]),
    ]);
    const res = streamChat({
      model: model(fetch),
      messages: [{ role: 'user', content: 'go' }],
      tools: {
        worker: agentTool({
          name: 'worker',
          description: 'w',
          model: model(fetch, 'claude-haiku-4-5'),
          subAgentStream: 'none',
        }),
      },
      maxSteps: 5,
    });
    const types: StreamPart['type'][] = [];
    for await (const part of res.fullStream) types.push(part.type);
    expect(types).not.toContain('sub-agent');
    expect(types.at(-1)).toBe('finish');
  });

  it('refuses to run past its own maxDepth with a self-healing is_error', async () => {
    // `inner` declares maxDepth 1: it would run at the root, but when `outer`
    // nests it (path ['outer','inner'], length 2 > 1) it refuses as an is_error,
    // and `outer` recovers with a text answer.
    const { fetch, calls } = mockFetchSequence([
      () => sseResponse([toolCallSse('outer', 'c1', '{"prompt":"go"}')]), // parent → outer
      () => sseResponse([toolCallSse('inner', 'c2', '{"prompt":"deep"}')]), // outer → inner (too deep)
      () => sseResponse([textSse('outer recovered')]), // outer, after is_error
      () => sseResponse([textSse('final')]), // parent
    ]);
    const inner = agentTool({
      name: 'inner',
      description: 'inner',
      model: model(fetch, 'claude-haiku-4-5'),
      maxDepth: 1, // refuses once nested one level down
    });
    const outer = agentTool({
      name: 'outer',
      description: 'outer',
      model: model(fetch, 'claude-haiku-4-5'),
      tools: { inner },
      maxSteps: 5,
    });
    const res = await generateText({
      model: model(fetch),
      messages: [{ role: 'user', content: 'go' }],
      tools: { outer },
      maxSteps: 5,
    });
    expect(res.text).toBe('final');
    // The outer sub-agent's 2nd call (after the refused inner) shows the
    // is_error depth message fed back.
    const bodies = calls.map((c) =>
      JSON.stringify(JSON.parse(String(c.init!.body)).messages),
    );
    expect(bodies.some((b) => b.includes('max agent depth'))).toBe(true);
  });
});

describe('agentTool — approval', () => {
  it('inherits the parent server-mode approver — a denied sub-agent tool is an is_error (AI SDK cannot)', async () => {
    const workerTool = vi.fn(async () => 'should not run');
    const { fetch, calls } = mockFetchSequence([
      () => sseResponse([toolCallSse('worker', 'call_w', '{"prompt":"go"}')]), // parent → worker
      () => sseResponse([toolCallSse('danger', 'call_d', '{"q":"rm -rf"}')]), // worker → danger (gated)
      () => sseResponse([textSse('worker recovered')]), // worker after denial
      () => sseResponse([textSse('final')]), // parent
    ]);
    const approveToolCall = vi.fn(async () => false); // deny everything
    const res = await generateText({
      model: model(fetch),
      messages: [{ role: 'user', content: 'go' }],
      tools: {
        worker: agentTool({
          name: 'worker',
          description: 'w',
          model: model(fetch, 'claude-haiku-4-5'),
          tools: { danger: { parameters: SCHEMA, execute: workerTool, needsApproval: true } },
          maxSteps: 5,
        }),
      },
      approveToolCall,
      maxSteps: 5,
    });
    expect(res.text).toBe('final');
    expect(workerTool).not.toHaveBeenCalled(); // gated call denied inside the sub-agent
    expect(approveToolCall).toHaveBeenCalled();
    const workerRecoverBody = JSON.stringify(JSON.parse(String(calls[2]!.init!.body)).messages);
    expect(workerRecoverBody).toContain('Tool call denied');
  });

  it('client-mode approval inside a sub-agent surfaces a clear is_error', async () => {
    const { fetch, calls } = mockFetchSequence([
      () => sseResponse([toolCallSse('worker', 'call_w', '{"prompt":"go"}')]), // parent → worker
      () => sseResponse([toolCallSse('danger', 'call_d', '{"q":"x"}')]), // worker → gated, no approver
      () => sseResponse([textSse('final')]), // parent after is_error
    ]);
    const res = await generateText({
      model: model(fetch),
      messages: [{ role: 'user', content: 'go' }],
      tools: {
        worker: agentTool({
          name: 'worker',
          description: 'w',
          model: model(fetch, 'claude-haiku-4-5'),
          tools: { danger: { parameters: SCHEMA, execute: vi.fn(), needsApproval: true } },
          maxSteps: 5,
        }),
      },
      // no approveToolCall → client mode
      maxSteps: 5,
    });
    expect(res.text).toBe('final');
    const parentBody = JSON.stringify(JSON.parse(String(calls[2]!.init!.body)).messages);
    expect(parentBody).toContain('not supported yet');
  });
});

describe('agentTool — usage', () => {
  it('folds sub-agent usage into the parent total and tags onUsage with agentPath', async () => {
    const events: { total: number; agentPath?: string[] }[] = [];
    const onUsage = (u: Usage, m: UsageMeta) =>
      events.push({ total: u.totalTokens, ...(m.agentPath ? { agentPath: m.agentPath } : {}) });
    const { fetch } = mockFetchSequence([
      () => sseResponse([toolCallSse('worker', 'call_w', '{"prompt":"go"}')]), // parent step 0: 15
      () => sseResponse([textSse('sub')]), // sub-agent: 26
      () => sseResponse([textSse('done')]), // parent step 1: 26
    ]);
    const res = await generateText({
      model: model(fetch),
      messages: [{ role: 'user', content: 'go' }],
      tools: {
        worker: agentTool({ name: 'worker', description: 'w', model: model(fetch, 'claude-haiku-4-5') }),
      },
      maxSteps: 5,
      deps: { onUsage },
    });
    // Parent total = parent step0 (15) + sub-agent (26) + parent step1 (26) = 67.
    expect(res.usage.totalTokens).toBe(67);
    // The sub-agent's usage event carries its agentPath; parent events do not.
    const tagged = events.filter((e) => e.agentPath);
    expect(tagged.length).toBeGreaterThan(0);
    expect(tagged[0]!.agentPath).toEqual(['worker']);
    expect(events.some((e) => !e.agentPath)).toBe(true);
  });

  it('sub-agent usage counts toward a parent budget stop', async () => {
    const { fetch, calls } = mockFetchSequence([
      () => sseResponse([toolCallSse('worker', 'call_w', '{"prompt":"go"}')]), // parent step 0: 15
      () => sseResponse([textSse('sub')]), // sub-agent: 26 → parent total now 41
      () => sseResponse([textSse('done')]), // would be parent step 1, but budget already exceeded
    ]);
    const res = await generateText({
      model: model(fetch),
      messages: [{ role: 'user', content: 'go' }],
      tools: {
        worker: agentTool({ name: 'worker', description: 'w', model: model(fetch, 'claude-haiku-4-5') }),
      },
      maxSteps: 5,
      stopWhen: totalTokensExceed(40), // 15 alone < 40; +26 sub-agent = 41 ≥ 40 → stop after step 0
    });
    // Parent step 0 (15) + sub-agent (26) = 41 ≥ 40 → loop stops; parent step 1 never runs.
    expect(calls).toHaveLength(2);
    expect(res.providerMetadata?.deuz).toMatchObject({ stoppedBy: 'totalTokensExceed' });
  });
});

describe('agentTool — abort', () => {
  it('propagates the parent signal down to the sub-agent tools', async () => {
    const controller = new AbortController();
    let seenSignal: AbortSignal | undefined;
    const probe = vi.fn(async (_args: unknown, ctx: { signal?: AbortSignal }) => {
      seenSignal = ctx.signal;
      return 'probed';
    });
    const { fetch } = mockFetchSequence([
      () => sseResponse([toolCallSse('worker', 'call_w', '{"prompt":"go"}')]), // parent → worker
      () => sseResponse([toolCallSse('probe', 'call_p', '{"q":"x"}')]), // worker → probe
      () => sseResponse([textSse('sub done')]), // worker after probe
      () => sseResponse([textSse('done')]), // parent
    ]);
    const res = streamChat({
      model: model(fetch),
      messages: [{ role: 'user', content: 'go' }],
      tools: {
        worker: agentTool({
          name: 'worker',
          description: 'w',
          model: model(fetch, 'claude-haiku-4-5'),
          tools: { probe: { parameters: SCHEMA, execute: probe } },
          maxSteps: 5,
        }),
      },
      maxSteps: 5,
      signal: controller.signal,
    });
    const types: StreamPart['type'][] = [];
    for await (const part of res.fullStream) types.push(part.type);
    expect(types.at(-1)).toBe('finish');
    // The sub-agent's tool received the SAME signal object as the parent call —
    // aborting the parent cancels the sub-agent's in-flight work.
    expect(seenSignal).toBe(controller.signal);
  });
});
