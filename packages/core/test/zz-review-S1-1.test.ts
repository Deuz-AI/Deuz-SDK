import { describe, expect, it } from 'vitest';
import { createInMemoryAgentRunStore, runAgent } from '../src/agent-run';
import { createInMemoryAgentRunStoreV3 } from '../src/agent-run-v3-store';
import { createExecutionContext } from '../src/execution-policy';
import { createInMemoryMemoryStore, type MemorySeams } from '../src/memory';
import { createInMemoryVersionedMemoryStore, createMemorySession } from '../src/memory/versioned';
import type { NativeExecutionContext } from '../src/types/execution';
import { scriptedModel } from './fixtures/native-v3';

const PLANNER = { userId: 'ada', agentId: 'planner' };

function seams(): MemorySeams {
  let n = 0;
  return {
    store: createInMemoryMemoryStore(),
    llm: async () => '{"facts":[]}',
    clock: { now: () => 5_000, setTimeout: () => () => {} },
    generateId: () => `mem-${n++}`,
    hashFn: async (text) => `h:${text}`,
  };
}

async function parentWithChild(child: (execution: NativeExecutionContext) => Promise<string>) {
  const parent = scriptedModel([
    { toolCalls: [{ toolName: 'helper', id: 'h1', args: {} }] },
    { text: 'ok' },
  ]);
  let told = '';
  const result = await runAgent({
    model: parent.model,
    prompt: 'ask the helper',
    execution: createExecutionContext({ scopeId: 'planner' }),
    memory: { seams: seams(), scope: PLANNER, extract: false, recall: false },
    session: { store: createInMemoryAgentRunStore(), runId: 'planner', scope: 'eval' },
    tools: {
      helper: {
        description: 'helper',
        parameters: { type: 'object', properties: {} },
        execute: async (_args: unknown, call: { execution?: NativeExecutionContext }) => {
          told = await child(call.execution!);
          return told;
        },
      },
    },
  });
  return { result, told };
}

describe('review S1: V3 child memory scope narrowing', () => {
  it('legacy memory: a child that widens is refused (2.3 rule)', async () => {
    const { told } = await parentWithChild(async (execution) => {
      const nested = scriptedModel([{ text: 'child done' }]);
      const r = await runAgent({
        model: nested.model,
        prompt: 'what does the user drink?',
        execution,
        memory: { seams: seams(), scope: { userId: 'ada' }, extract: false },
        session: { store: createInMemoryAgentRunStore(), runId: 'helper', scope: 'eval' },
      });
      return r.status === 'failed' ? `failed: ${r.error.message}` : r.status;
    });
    expect(told).toMatch(/widens/);
  });

  it('V3 versioned memory: a child session wider than the parent scope is not refused', async () => {
    const vstore = createInMemoryVersionedMemoryStore();
    const wide = createMemorySession({ store: vstore, scope: { userId: 'ada' } });
    const { told } = await parentWithChild(async (execution) => {
      const nested = scriptedModel([
        { toolCalls: [{ toolName: 'memory_remember', id: 'm1', args: { text: 'user-wide fact' } }] },
        { text: 'child done' },
      ]);
      const r = await runAgent({
        model: nested.model,
        prompt: 'remember something',
        execution,
        checkpointVersion: 3,
        session: { store: createInMemoryAgentRunStoreV3(), runId: 'helper', scope: 'eval' },
        versionedMemory: { session: wide, tools: true },
      });
      return r.status === 'failed' ? `failed: ${r.error.message}` : r.status;
    });
    // eslint-disable-next-line no-console
    console.log('child outcome:', told);
    const hits = await wide.recall({ text: 'user-wide' });
    // eslint-disable-next-line no-console
    console.log('written into the wider scope:', hits.map((h) => JSON.stringify(h.record.scope)));
    expect(told).toBe('completed');
    expect(hits.length).toBe(1);
  });
});
