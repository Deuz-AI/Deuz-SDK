/**
 * Approval lifecycle observation: server verdicts, client-mode suspension,
 * settle-on-resume resolutions, default-deny, unknown-approvalId replay safety.
 */
import { describe, it, expect } from 'vitest';
import { generateText } from '../src/index';
import { createAnthropic } from '../src/anthropic';
import { createMemoryObserver } from '../src/observe';
import { sseResponse, sseEvents, mockFetchSequence } from './fixtures/sse';
import type { Clock, Message, ObserveEvent, JSONSchema } from '../src/index';

type Ev<T extends ObserveEvent['type']> = Extract<ObserveEvent, { type: T }>;

function fastClock(): Clock {
  let now = 0;
  return {
    now: () => (now += 5),
    setTimeout: (fn, ms) => {
      if (ms < 60_000) {
        const id = setTimeout(fn, 0);
        return () => clearTimeout(id);
      }
      return () => {};
    },
  };
}

const SCHEMA: JSONSchema = {
  type: 'object',
  properties: { city: { type: 'string' } },
  required: ['city'],
  additionalProperties: false,
};

const TOOL_CALL_STREAM = sseEvents([
  {
    event: 'message_start',
    data: { type: 'message_start', message: { usage: { input_tokens: 10, output_tokens: 1 } } },
  },
  {
    event: 'content_block_start',
    data: {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'tool_use', id: 'toolu_1', name: 'guarded' },
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
    event: 'message_delta',
    data: {
      type: 'message_delta',
      delta: { stop_reason: 'tool_use' },
      usage: { output_tokens: 5 },
    },
  },
  { event: 'message_stop', data: { type: 'message_stop' } },
]);

const FINAL_STREAM = sseEvents([
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
    data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } },
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

function guardedTools(
  executed: string[],
): NonNullable<Parameters<typeof generateText>[0]['tools']> {
  return {
    guarded: {
      parameters: SCHEMA,
      needsApproval: true,
      execute: async () => {
        executed.push('ran');
        return 'result';
      },
    },
  };
}

describe('approval observation — server mode', () => {
  async function serverRun(verdict: () => boolean | Promise<boolean>): Promise<ObserveEvent[]> {
    const mem = createMemoryObserver();
    const { fetch } = mockFetchSequence([
      () => sseResponse([TOOL_CALL_STREAM]),
      () => sseResponse([FINAL_STREAM]),
    ]);
    await generateText({
      model: createAnthropic({ apiKey: 'k', fetch })('claude-opus-4-8'),
      messages: [{ role: 'user', content: 'go' }],
      tools: guardedTools([]),
      approveToolCall: verdict,
      maxSteps: 3,
      deps: { observer: mem, clock: fastClock() },
    });
    return [...mem.events()];
  }

  it('approved: requested{server} then resolved{server, approved} then tool.completed', async () => {
    const events = await serverRun(() => true);
    const requested = events.find(
      (e) => e.type === 'approval.requested',
    ) as Ev<'approval.requested'>;
    const resolved = events.find((e) => e.type === 'approval.resolved') as Ev<'approval.resolved'>;
    expect(requested).toMatchObject({ mode: 'server', toolName: 'guarded', approvalId: 'toolu_1' });
    expect(requested.capturedInput).toBeUndefined(); // capture off by default
    expect(resolved).toMatchObject({ approved: true, source: 'server' });
    // requested precedes resolved precedes tool execution
    const order = events.map((e) => e.type);
    expect(order.indexOf('approval.requested')).toBeLessThan(order.indexOf('approval.resolved'));
    expect(order.indexOf('approval.resolved')).toBeLessThan(order.indexOf('tool.started'));
    expect(order).toContain('tool.completed');
  });

  it('denied: resolved{approved:false} + tool.denied{server-denied}; run completes', async () => {
    const events = await serverRun(() => false);
    const resolved = events.find((e) => e.type === 'approval.resolved') as Ev<'approval.resolved'>;
    expect(resolved.approved).toBe(false);
    const denied = events.find((e) => e.type === 'tool.denied') as Ev<'tool.denied'>;
    expect(denied.cause).toBe('server-denied');
    expect(events.at(-1)!.type).toBe('run.completed');
    expect((events.at(-1) as Ev<'run.completed'>).approvalCount).toBe(1);
  });

  it('a THROWING approver denies (safe side)', async () => {
    const events = await serverRun(() => {
      throw new Error('approver exploded');
    });
    const resolved = events.find((e) => e.type === 'approval.resolved') as Ev<'approval.resolved'>;
    expect(resolved.approved).toBe(false);
    expect(events.some((e) => e.type === 'tool.denied')).toBe(true);
  });
});

describe('approval observation — client mode + settle-on-resume', () => {
  it('pending: requested{client} then run.suspended{approval} — nothing executes', async () => {
    const mem = createMemoryObserver();
    const executed: string[] = [];
    const { fetch } = mockFetchSequence([() => sseResponse([TOOL_CALL_STREAM])]);
    const res = await generateText({
      model: createAnthropic({ apiKey: 'k', fetch })('claude-opus-4-8'),
      messages: [{ role: 'user', content: 'go' }],
      tools: guardedTools(executed),
      maxSteps: 3,
      deps: { observer: mem, clock: fastClock() },
    });
    expect(res.pendingApprovals).toHaveLength(1);
    expect(executed).toHaveLength(0);
    const requested = mem
      .events()
      .find((e) => e.type === 'approval.requested') as Ev<'approval.requested'>;
    expect(requested.mode).toBe('client');
    const suspended = mem.events().at(-1) as Ev<'run.suspended'>;
    expect(suspended.reason).toBe('approval');
    expect(suspended.pendingApprovalCount).toBe(1);
  });

  /** Resume history: assistant turn with the unanswered tool_use. */
  function pendingHistory(): Message[] {
    return [
      { role: 'user', content: 'go' },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'toolu_1', name: 'guarded', input: { city: 'Paris' } }],
      },
    ];
  }

  it('approved verdict: resolved{client-response} then the tool runs (settle path, step-less)', async () => {
    const mem = createMemoryObserver();
    const executed: string[] = [];
    const { fetch } = mockFetchSequence([() => sseResponse([FINAL_STREAM])]);
    await generateText({
      model: createAnthropic({ apiKey: 'k', fetch })('claude-opus-4-8'),
      messages: pendingHistory(),
      tools: guardedTools(executed),
      approvalResponses: [{ approvalId: 'toolu_1', approved: true }],
      maxSteps: 3,
      deps: { observer: mem, clock: fastClock() },
    });
    expect(executed).toEqual(['ran']);
    const resolved = mem
      .events()
      .find((e) => e.type === 'approval.resolved') as Ev<'approval.resolved'>;
    expect(resolved).toMatchObject({ approved: true, source: 'client-response' });
    // settle-phase tool events run OUTSIDE any step (no stepIndex)
    const toolStart = mem.events().find((e) => e.type === 'tool.started') as Ev<'tool.started'>;
    expect(toolStart.stepIndex).toBeUndefined();
    // and they precede the first step.started
    const order = mem.events().map((e) => e.type);
    expect(order.indexOf('tool.completed')).toBeLessThan(order.indexOf('step.started'));
  });

  it('verdict-less resume: default-deny → resolved{default-deny} + tool.denied{no-response}', async () => {
    const mem = createMemoryObserver();
    const executed: string[] = [];
    const { fetch } = mockFetchSequence([() => sseResponse([FINAL_STREAM])]);
    await generateText({
      model: createAnthropic({ apiKey: 'k', fetch })('claude-opus-4-8'),
      messages: pendingHistory(),
      tools: guardedTools(executed),
      approvalResponses: [],
      maxSteps: 3,
      deps: { observer: mem, clock: fastClock() },
    });
    expect(executed).toHaveLength(0);
    const resolved = mem
      .events()
      .find((e) => e.type === 'approval.resolved') as Ev<'approval.resolved'>;
    expect(resolved).toMatchObject({ approved: false, source: 'default-deny' });
    const denied = mem.events().find((e) => e.type === 'tool.denied') as Ev<'tool.denied'>;
    expect(denied.cause).toBe('no-response');
    expect(denied.reason).toBe('No approval response.');
  });

  it('denied verdict with reason: resolved{client-response} + tool.denied{response-denied, reason}', async () => {
    const mem = createMemoryObserver();
    const { fetch } = mockFetchSequence([() => sseResponse([FINAL_STREAM])]);
    await generateText({
      model: createAnthropic({ apiKey: 'k', fetch })('claude-opus-4-8'),
      messages: pendingHistory(),
      tools: guardedTools([]),
      approvalResponses: [{ approvalId: 'toolu_1', approved: false, reason: 'too risky' }],
      maxSteps: 3,
      deps: { observer: mem, clock: fastClock() },
    });
    const denied = mem.events().find((e) => e.type === 'tool.denied') as Ev<'tool.denied'>;
    expect(denied).toMatchObject({ cause: 'response-denied', reason: 'too risky' });
  });

  it('unknown approvalIds are ignored silently (replay-safe) — no events for them', async () => {
    const mem = createMemoryObserver();
    const { fetch } = mockFetchSequence([() => sseResponse([FINAL_STREAM])]);
    await generateText({
      model: createAnthropic({ apiKey: 'k', fetch })('claude-opus-4-8'),
      messages: pendingHistory(),
      tools: guardedTools([]),
      approvalResponses: [
        { approvalId: 'toolu_1', approved: true },
        { approvalId: 'ghost-id', approved: true },
      ],
      maxSteps: 3,
      deps: { observer: mem, clock: fastClock() },
    });
    const resolutions = mem
      .events()
      .filter((e) => e.type === 'approval.resolved') as Ev<'approval.resolved'>[];
    expect(resolutions).toHaveLength(1);
    expect(resolutions[0]!.approvalId).toBe('toolu_1');
  });
});
