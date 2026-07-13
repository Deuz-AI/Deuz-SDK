/**
 * Sub-agent observation: subagent.* lifecycle under the parent's runId,
 * agentPath-tagged child events, no duplicate runs, single usage accounting,
 * durable suspension, failure self-heal visibility.
 */
import { describe, it, expect } from 'vitest';
import { generateText, agentTool } from '../src/index';
import { createInMemorySessionStore } from '../src/durable';
import { createAnthropic } from '../src/anthropic';
import { createMemoryObserver } from '../src/observe';
import { sseResponse, sseEvents, mockFetchSequence } from './fixtures/sse';
import type { Clock, ObserveEvent, JSONSchema } from '../src/index';

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

/** Parent asks the researcher sub-agent. */
const CALL_RESEARCHER = sseEvents([
  {
    event: 'message_start',
    data: { type: 'message_start', message: { usage: { input_tokens: 10, output_tokens: 1 } } },
  },
  {
    event: 'content_block_start',
    data: {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'tool_use', id: 'toolu_agent', name: 'researcher' },
    },
  },
  {
    event: 'content_block_delta',
    data: {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'input_json_delta', partial_json: '{"prompt":"research Paris"}' },
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

/** Child answers in one text turn. */
const CHILD_ANSWER = sseEvents([
  {
    event: 'message_start',
    data: { type: 'message_start', message: { usage: { input_tokens: 7, output_tokens: 1 } } },
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
      delta: { type: 'text_delta', text: 'Paris facts.' },
    },
  },
  {
    event: 'message_delta',
    data: {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn' },
      usage: { output_tokens: 3 },
    },
  },
  { event: 'message_stop', data: { type: 'message_stop' } },
]);

/** Child calls a guarded tool (drives durable suspension). */
const CHILD_TOOL_CALL = sseEvents([
  {
    event: 'message_start',
    data: { type: 'message_start', message: { usage: { input_tokens: 7, output_tokens: 1 } } },
  },
  {
    event: 'content_block_start',
    data: {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'tool_use', id: 'toolu_child', name: 'dangerous' },
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
      usage: { output_tokens: 3 },
    },
  },
  { event: 'message_stop', data: { type: 'message_stop' } },
]);

const PARENT_FINAL = sseEvents([
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
    data: {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn' },
      usage: { output_tokens: 6 },
    },
  },
  { event: 'message_stop', data: { type: 'message_stop' } },
]);

describe('sub-agent observation', () => {
  it('subagent.started/completed under the parent runId; child events tagged with agentPath', async () => {
    const mem = createMemoryObserver();
    const { fetch } = mockFetchSequence([
      () => sseResponse([CALL_RESEARCHER]), // parent step 1
      () => sseResponse([CHILD_ANSWER]), // child's single turn
      () => sseResponse([PARENT_FINAL]), // parent step 2
    ]);
    const model = createAnthropic({ apiKey: 'k', fetch })('claude-opus-4-8');
    const res = await generateText({
      model,
      messages: [{ role: 'user', content: 'research Paris' }],
      tools: { researcher: agentTool({ name: 'researcher', description: 'Research', model }) },
      maxSteps: 5,
      deps: { observer: mem, clock: fastClock() },
    });
    expect(res.text).toBe('Done.');

    // exactly ONE run — the child loop never opens its own
    expect(mem.events().filter((e) => e.type === 'run.started')).toHaveLength(1);
    expect(new Set(mem.events().map((e) => e.runId)).size).toBe(1);

    const started = mem
      .events()
      .find((e) => e.type === 'subagent.started') as Ev<'subagent.started'>;
    expect(started).toMatchObject({
      agentName: 'researcher',
      depth: 1,
      parentToolCallId: 'toolu_agent',
      model: 'claude-opus-4-8',
      durable: false,
    });
    expect(started.agentPath).toEqual(['researcher']);
    // parents under the researcher TOOL call's span
    const toolStart = mem
      .events()
      .find(
        (e) => e.type === 'tool.started' && (e as Ev<'tool.started'>).toolName === 'researcher',
      );
    expect(started.parentSpanId).toBe(toolStart!.spanId);

    const completed = mem
      .events()
      .find((e) => e.type === 'subagent.completed') as Ev<'subagent.completed'>;
    expect(completed).toMatchObject({ agentName: 'researcher', depth: 1, stepCount: 1 });
    expect(completed.usage.totalTokens).toBe(10); // child's 7+3
    expect(completed.spanId).toBe(started.spanId);

    // the child's model call is visible WITH the agentPath tag
    const childModel = mem
      .events()
      .find((e) => e.type === 'model.started' && e.agentPath?.length === 1) as Ev<'model.started'>;
    expect(childModel.agentPath).toEqual(['researcher']);

    // usage counted ONCE: parent total includes the child exactly once
    const done = mem.events().at(-1) as Ev<'run.completed'>;
    expect(done.usage.totalTokens).toBe(res.usage.totalTokens);
    expect(done.subAgentCount).toBe(1);
    // parent steps + child step all report model calls (2 parent + 1 child)
    expect(done.modelCallCount).toBe(3);
  });

  it('non-durable child approval → subagent.failed (self-heals) and the run completes', async () => {
    const mem = createMemoryObserver();
    const { fetch } = mockFetchSequence([
      () => sseResponse([CALL_RESEARCHER]),
      () => sseResponse([CHILD_TOOL_CALL]), // child hits a gated tool, no session → error
      () => sseResponse([PARENT_FINAL]),
    ]);
    const model = createAnthropic({ apiKey: 'k', fetch })('claude-opus-4-8');
    const res = await generateText({
      model,
      messages: [{ role: 'user', content: 'go' }],
      tools: {
        researcher: agentTool({
          name: 'researcher',
          description: 'Research',
          model,
          tools: {
            dangerous: { parameters: SCHEMA, needsApproval: true, execute: async () => 'x' },
          },
        }),
      },
      maxSteps: 5,
      deps: { observer: mem, clock: fastClock() },
    });
    expect(res.text).toBe('Done.'); // self-healed
    const failed = mem.events().find((e) => e.type === 'subagent.failed') as Ev<'subagent.failed'>;
    expect(failed.agentName).toBe('researcher');
    expect(failed.error.category).toBe('unknown');
    // the researcher tool call itself reports tool.failed{selfHealed}
    const toolFailed = mem
      .events()
      .find(
        (e) => e.type === 'tool.failed' && (e as Ev<'tool.failed'>).toolName === 'researcher',
      ) as Ev<'tool.failed'>;
    expect(toolFailed.selfHealed).toBe(true);
    expect(mem.events().at(-1)!.type).toBe('run.completed');
  });

  it('durable child approval → subagent.suspended, parent run.suspended{sub-agent-approval}, childRunId reported', async () => {
    const mem = createMemoryObserver();
    const store = createInMemorySessionStore();
    const { fetch } = mockFetchSequence([
      () => sseResponse([CALL_RESEARCHER]),
      () => sseResponse([CHILD_TOOL_CALL]),
    ]);
    const model = createAnthropic({ apiKey: 'k', fetch })('claude-opus-4-8');
    const res = await generateText({
      model,
      messages: [{ role: 'user', content: 'go' }],
      tools: {
        researcher: agentTool({
          name: 'researcher',
          description: 'Research',
          model,
          tools: {
            dangerous: { parameters: SCHEMA, needsApproval: true, execute: async () => 'x' },
          },
        }),
      },
      maxSteps: 5,
      session: { store, runId: 'parent-run' },
      deps: { observer: mem, clock: fastClock() },
    });
    expect(res.pendingApprovals).toHaveLength(1);

    const started = mem
      .events()
      .find((e) => e.type === 'subagent.started') as Ev<'subagent.started'>;
    expect(started.durable).toBe(true);
    expect(started.childRunId).toBe('parent-run::researcher#toolu_agent');
    // everything still correlates under the PARENT runId
    expect(started.runId).toBe('parent-run');

    const suspended = mem
      .events()
      .find((e) => e.type === 'subagent.suspended') as Ev<'subagent.suspended'>;
    expect(suspended).toMatchObject({ agentName: 'researcher', pendingApprovalCount: 1 });

    const runSuspended = mem.events().at(-1) as Ev<'run.suspended'>;
    expect(runSuspended.reason).toBe('sub-agent-approval');
    expect(mem.events().some((e) => e.type === 'subagent.failed')).toBe(false);

    // the child's approval request is visible with the child agentPath
    const requested = mem
      .events()
      .find((e) => e.type === 'approval.requested') as Ev<'approval.requested'>;
    expect(requested.agentPath).toEqual(['researcher']);
  });
});
