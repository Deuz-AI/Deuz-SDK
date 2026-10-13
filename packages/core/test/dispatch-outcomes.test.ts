/**
 * dispatch-outcomes.test.ts (2.3, roadmap 23.2) — the dispatch contract decides
 * the policy BEFORE the approval gate, and every way a tool call can end is
 * observable as its own outcome on results and stream parts.
 *
 * Before 2.3 a call the execution policy forbids was checked only when it was
 * about to run: under `requireApproval` (or `needsApproval`) the run first
 * suspended and asked a human to approve a call it would then refuse, and its
 * siblings in the batch had already started. A guardrail block, an approver's
 * denial and a thrown tool all reached results and `tool-result` parts as the
 * same `isError: true`.
 */
import { describe, expect, it, vi } from 'vitest';
import { generateText } from '../src/generate';
import { streamChat } from '../src/index';
import { createExecutionContext } from '../src/execution-policy';
import {
  createInMemoryAgentRunStore,
  resumeAgent,
  resumeStreamAgent,
  runAgent,
} from '../src/agent-run';
import { prepareAgentTools } from '../src/inference/agent-tools';
import { createMockModel, type MockResponse } from '../src/testing';
import type { AgentEvent, AgentRunEnvelope, AgentRunStore } from '../src/types/agent-run';
import type { StreamPart } from '../src/types/stream';
import type { ToolExecuteContext, ToolSet } from '../src/types/tool';

const parameters = { type: 'object' as const, properties: {} };

const batch = (...calls: Array<[name: string, id: string]>): MockResponse => ({
  toolCalls: calls.map(([toolName, id]) => ({ toolName, id, args: {} })),
});

async function parts(result: { fullStream: AsyncIterable<StreamPart> }): Promise<StreamPart[]> {
  const out: StreamPart[] = [];
  for await (const part of result.fullStream) out.push(part);
  return out;
}

describe('the policy is decided before the approval gate', () => {
  it('fails a native run on a forbidden call before asking for approval or running a sibling', async () => {
    const read = vi.fn(async () => 'read');
    const pay = vi.fn(async () => 'paid');
    const store = createInMemoryAgentRunStore();
    const result = await runAgent({
      model: createMockModel({ responses: [batch(['read', 'r1'], ['pay', 'p1']), { text: 'x' }] }),
      prompt: 'read then pay',
      tools: {
        read: { parameters, execute: read },
        pay: { parameters, needsApproval: true, execute: pay },
      },
      execution: createExecutionContext({ policy: { allowedTools: ['read'] } }),
      session: { store, runId: 'policy', scope: 't' },
    });
    expect(result).toMatchObject({
      status: 'failed',
      error: { name: 'ExecutionPolicyError', code: 'tool_not_allowed' },
    });
    expect(read).not.toHaveBeenCalled();
    expect(pay).not.toHaveBeenCalled();
    expect((await store.load('policy'))?.toolResults ?? {}).toEqual({});
  });

  it('never streams an approval request for a call the policy forbids, and names the call', async () => {
    const pay = vi.fn(async () => 'paid');
    const result = streamChat({
      model: createMockModel({ responses: [batch(['pay', 'p1']), { text: 'x' }] }),
      messages: [{ role: 'user', content: 'pay' }],
      tools: { pay: { parameters, execute: pay } },
      maxSteps: 3,
      execution: createExecutionContext({ policy: { allowedTools: [], requireApproval: true } }),
    });
    const seen = await parts(result);
    expect(seen.some((p) => p.type === 'tool-approval-request')).toBe(false);
    expect(seen).toContainEqual(
      expect.objectContaining({
        type: 'tool-state',
        toolCallId: 'p1',
        state: 'error',
        outcome: 'permission-denied',
      }),
    );
    expect(seen.at(-1)).toMatchObject({
      type: 'error',
      error: { name: 'ExecutionPolicyError', code: 'tool_not_allowed' },
    });
    expect(pay).not.toHaveBeenCalled();
  });
});

describe('every way a tool call ends is a distinct outcome', () => {
  const tools = (): ToolSet => ({
    ok: { parameters, execute: async () => 'fine' },
    boom: {
      parameters,
      execute: async () => {
        throw new Error('broke');
      },
    },
    guarded: { parameters, execute: async () => 'never' },
    gated: { parameters, needsApproval: true, execute: async () => 'never' },
  });
  const options = {
    messages: [{ role: 'user' as const, content: 'go' }],
    maxSteps: 3,
    guardrails: {
      onToolCall: (ctx: { toolCall: { toolName: string } }) =>
        ctx.toolCall.toolName === 'guarded'
          ? { action: 'block' as const, reason: 'not today' }
          : undefined,
    },
    approveToolCall: () => false,
  };
  const step = batch(['ok', 'a'], ['boom', 'b'], ['nope', 'c'], ['guarded', 'd'], ['gated', 'e']);
  const expected = {
    b: 'tool-error',
    c: 'tool-error',
    d: 'permission-denied',
    e: 'approval-denied',
  };

  it('on the step results of generateText', async () => {
    const result = await generateText({
      ...options,
      model: createMockModel({ responses: [step, { text: 'done' }] }),
      tools: tools(),
    });
    const outcomes = Object.fromEntries(
      result.steps![0]!.toolResults.map((r) => [r.toolCallId, r.outcome]),
    );
    expect(outcomes).toEqual({ a: undefined, ...expected });
  });

  it('on the tool-result and tool-state parts of streamChat', async () => {
    const seen = await parts(
      streamChat({
        ...options,
        model: createMockModel({ responses: [step, { text: 'done' }] }),
        tools: tools(),
      }),
    );
    const results = Object.fromEntries(
      seen.flatMap((p) => (p.type === 'tool-result' ? [[p.toolCallId, p.outcome]] : [])),
    );
    expect(results).toEqual({ a: undefined, ...expected });
    const terminal = Object.fromEntries(
      seen.flatMap((p) =>
        p.type === 'tool-state' && (p.state === 'error' || p.state === 'complete')
          ? [[p.toolCallId, p.outcome]]
          : [],
      ),
    );
    expect(terminal).toEqual({ a: undefined, ...expected });
  });

  it('marks a call waiting for a verdict as approval-pending', async () => {
    const seen = await parts(
      streamChat({
        messages: [{ role: 'user', content: 'go' }],
        model: createMockModel({ responses: [batch(['gated', 'g'])] }),
        tools: tools(),
        maxSteps: 3,
      }),
    );
    expect(seen).toContainEqual(
      expect.objectContaining({
        type: 'tool-state',
        toolCallId: 'g',
        state: 'awaiting-approval',
        outcome: 'approval-pending',
      }),
    );
  });

  it('reports an interrupted call as an unknown effect, with the receipt to reconcile', async () => {
    const effects: string[] = [];
    const inner = createInMemoryAgentRunStore();
    let failed = false;
    // The save right after the effect fails: its receipt stays 'executing'.
    const store: AgentRunStore = {
      load: (id) => inner.load(id),
      save(envelope: AgentRunEnvelope) {
        if (effects.length > 0 && !failed) {
          failed = true;
          throw new Error('store down');
        }
        return inner.save(envelope);
      },
    };
    const options = {
      model: createMockModel({ responses: [batch(['charge', 'c1']), { text: 'x' }] }),
      prompt: 'charge',
      tools: {
        charge: {
          parameters,
          execute: async () => {
            effects.push('charge');
            return 'charged';
          },
        },
      },
    };
    const first = await runAgent({ ...options, session: { store, runId: 'u', scope: 't' } });
    expect(first.status).toBe('failed');
    const resumed = resumeStreamAgent({
      ...options,
      session: { store: inner, runId: 'u', scope: 't' },
    });
    const events: AgentEvent[] = [];
    for await (const event of resumed.events) events.push(event);
    const result = await resumed.result;
    expect(result).toMatchObject({
      status: 'stopped',
      reason: 'tool-reconciliation-required',
      unknownEffects: [{ toolCallId: 'c1', toolName: 'charge', stage: 'executing' }],
    });
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'part',
        part: expect.objectContaining({
          type: 'tool-state',
          toolCallId: 'c1',
          state: 'error',
          outcome: 'unknown-effect',
        }),
      }),
    );
    expect(effects).toEqual(['charge']);
    // Same result from the buffered entry point.
    expect(
      await resumeAgent({ ...options, session: { store: inner, runId: 'u', scope: 't' } }),
    ).toMatchObject({ unknownEffects: [{ toolCallId: 'c1' }] });
  });
});

describe('admission comes before the effect identity', () => {
  it('a call whose deadline has passed leaves no executing receipt behind', async () => {
    const saves: string[] = [];
    const execute = vi.fn(async () => 'ran');
    const prepared = await prepareAgentTools({ t: { parameters, execute } }, {}, undefined, {
      load: () => undefined,
      save: async (receipt) => {
        saves.push(receipt.stage);
      },
    });
    const ctx = {
      toolCallId: 'late',
      messages: [],
      execution: createExecutionContext({ policy: { deadlineAt: 1_000 } }),
      deps: { clock: { now: () => 2_000, setTimeout: () => () => {} } },
    } as unknown as ToolExecuteContext;
    await expect(prepared.t!.execute!({}, ctx)).rejects.toMatchObject({
      code: 'deadline_exceeded',
    });
    expect(execute).not.toHaveBeenCalled();
    expect(saves).toEqual([]);
  });
});
