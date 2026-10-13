import { describe, expect, it, vi } from 'vitest';
import { createInMemoryAgentRunStore, resumeAgent, runAgent } from '../src/agent-run';
import { streamChat } from '../src/index';
import { agentTool } from '../src/inference/agent-tool';
import { createInMemorySessionStore } from '../src/durable';
import { createMockModel, type MockResponse } from '../src/testing';
import { readConfig } from '../src/internal/config-symbol';
import type { Message, ToolResultPart } from '../src/types/message';
import type { SessionStore } from '../src/types/session';

/**
 * A provider that numbers its tool calls per response (`tool_0`, `tool_1`, …)
 * hands out the SAME id at two different parent steps. A durable sub-agent is
 * keyed by that id, so the second delegation used to find the first one's
 * child checkpoint: a native run replayed the first answer without running the
 * second task at all.
 */
function counted(responses: MockResponse[]) {
  const model = createMockModel({ responses });
  const config = readConfig(model)!;
  const fetch = vi.fn(config.fetch!);
  config.fetch = fetch;
  return { model, fetch };
}

function toolResults(messages: Message[]): ToolResultPart[] {
  return messages.flatMap((message) =>
    typeof message.content === 'string'
      ? []
      : message.content.filter((part): part is ToolResultPart => part.type === 'tool_result'),
  );
}

const parentTurns: MockResponse[] = [
  { toolCalls: [{ toolName: 'helper', id: 'tool_0', args: { prompt: 'first task' } }] },
  { toolCalls: [{ toolName: 'helper', id: 'tool_0', args: { prompt: 'second task' } }] },
  { text: 'all done' },
];

describe('agentTool child sessions under recycled tool-call ids', () => {
  it('a native run delegates each recycled id to its own child run', async () => {
    const parent = counted(parentTurns);
    const child = counted([{ text: 'first answer' }, { text: 'second answer' }]);
    const store = createInMemoryAgentRunStore();
    const result = await runAgent({
      model: parent.model,
      prompt: 'delegate twice',
      session: { store, runId: 'recycled', scope: 'tenant' },
      tools: {
        helper: agentTool({ name: 'helper', description: 'helps', model: child.model }),
      },
    });
    expect(result.status).toBe('completed');
    expect(child.fetch).toHaveBeenCalledTimes(2);
    expect(toolResults(result.messages).map((part) => part.result)).toEqual([
      'first answer',
      'second answer',
    ]);
  });

  it('a resumed native run still finds the child its first delegation wrote', async () => {
    const parent = counted([
      { toolCalls: [{ toolName: 'helper', id: 'tool_0', args: { prompt: 'first task' } }] },
      {
        toolCalls: [{ toolName: 'gate', id: 'tool_0', args: {} }],
      },
      { toolCalls: [{ toolName: 'helper', id: 'tool_0', args: { prompt: 'second task' } }] },
      { text: 'all done' },
    ]);
    const child = counted([{ text: 'first answer' }, { text: 'second answer' }]);
    const store = createInMemoryAgentRunStore();
    const options = {
      model: parent.model,
      prompt: 'delegate around an approval',
      session: { store, runId: 'recycled-resume', scope: 'tenant' },
      tools: {
        helper: agentTool({ name: 'helper', description: 'helps', model: child.model }),
        gate: {
          parameters: { type: 'object', properties: {} },
          needsApproval: true,
          execute: () => 'gated',
        },
      },
    };
    expect((await runAgent(options)).status).toBe('suspended');
    const result = await resumeAgent({
      ...options,
      approvalResponses: [{ approvalId: (await pendingApprovalId(store)) ?? '', approved: true }],
    });
    expect(result.status).toBe('completed');
    expect(child.fetch).toHaveBeenCalledTimes(2);
    expect(toolResults(result.messages).map((part) => part.result)).toEqual([
      'first answer',
      'gated',
      'second answer',
    ]);
  });

  it('a native run resumes a suspended child a 2.2 run left under the plain key', async () => {
    const execute = vi.fn(() => 'paid');
    const child = counted([
      { toolCalls: [{ toolName: 'pay', id: 'pay-child', args: {} }] },
      { text: 'paid' },
    ]);
    const parent = counted([
      { toolCalls: [{ toolName: 'worker', id: 'delegate', args: { prompt: 'pay' } }] },
      { text: 'done' },
    ]);
    const store = createInMemoryAgentRunStore();
    const options = {
      model: parent.model,
      prompt: 'pay',
      session: { store, runId: 'upgrade', scope: 'tenant' },
      tools: {
        worker: agentTool({
          name: 'worker',
          description: 'worker',
          model: child.model,
          tools: {
            pay: { parameters: { type: 'object', properties: {} }, execute, needsApproval: true },
          },
        }),
      },
    };
    const first = await runAgent(options);
    if (first.status !== 'suspended') throw new Error(`Expected suspension, got ${first.status}`);
    // Rewrite the child the way 2.2 keyed it: the call id alone.
    const envelope = (await store.load('upgrade'))!;
    const [key] = Object.keys(envelope.checkpoints).filter((id) => id.includes('::worker#'));
    expect(key).toMatch(/^upgrade::worker#delegate@\d+$/);
    const legacy = 'upgrade::worker#delegate';
    const checkpoint = envelope.checkpoints[key!]!;
    delete envelope.checkpoints[key!];
    envelope.checkpoints[legacy] = {
      ...checkpoint,
      runId: legacy,
      stepId: checkpoint.stepId.replace(key!, legacy),
    };
    envelope.revision = (envelope.revision ?? 0) + 1;
    await store.save(envelope);

    // 2.3 binds an approval id to its child run; a 2.2 client answered with the
    // bare call id, which still settles a call whose id is unique in the history.
    const resumed = await resumeAgent({
      ...options,
      approvalResponses: [{ approvalId: 'pay-child', approved: true }],
    });
    expect(resumed.status).toBe('completed');
    expect(execute).toHaveBeenCalledTimes(1);
    // The child resumed where it stopped: one call before, one after.
    expect(child.fetch).toHaveBeenCalledTimes(2);
  });

  it('a legacy durable loop checkpoints each recycled id under its own child key', async () => {
    const parent = counted(parentTurns);
    const child = counted([{ text: 'first answer' }, { text: 'second answer' }]);
    const sessions = createInMemorySessionStore();
    const saved = new Set<string>();
    const store: SessionStore = {
      load: (runId) => sessions.load(runId),
      save: async (checkpoint) => {
        saved.add(checkpoint.runId);
        await sessions.save(checkpoint);
      },
    };
    const result = streamChat({
      model: parent.model,
      prompt: 'delegate twice',
      maxSteps: 5,
      session: { store, runId: 'legacy' },
      tools: {
        helper: agentTool({ name: 'helper', description: 'helps', model: child.model }),
      },
    });
    await result.consume?.();
    expect(await result.finishReason).toBe('stop');
    const childKeys = [...saved].filter((key) => key.startsWith('legacy::helper'));
    expect(childKeys).toHaveLength(2);
    expect(childKeys).toContain('legacy::helper#tool_0');
  });
});

async function pendingApprovalId(
  store: ReturnType<typeof createInMemoryAgentRunStore>,
): Promise<string | undefined> {
  const envelope = await store.load('recycled-resume');
  const result = envelope?.result;
  return result?.status === 'suspended' ? result.pendingApprovals[0]?.approvalId : undefined;
}
