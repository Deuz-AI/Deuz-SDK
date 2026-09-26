import { describe, expect, it } from 'vitest';
import { createInMemoryAgentRunStore, runAgent } from '../src/agent-run';
import { createMockModel } from '../src/testing';
import type { AgentRunEnvelope, AgentRunStore } from '../src/types/agent-run';
import { agentRunStoreContracts } from './fixtures/agent-run-store-conformance';

agentRunStoreContracts('memory agent run store', createInMemoryAgentRunStore);

describe('native envelope revision', () => {
  it('advances the revision by one on every save', async () => {
    const memory = createInMemoryAgentRunStore();
    const seen: (number | undefined)[] = [];
    const store: AgentRunStore = {
      load: memory.load,
      save: async (envelope: AgentRunEnvelope) => {
        seen.push(envelope.revision);
        await memory.save(envelope);
      },
    };
    const result = await runAgent({
      model: createMockModel({ responses: [{ text: 'done' }] }),
      prompt: 'x',
      session: { store, scope: 'tenant', runId: 'r' },
    });
    expect(result.status).toBe('completed');
    expect(seen.length).toBeGreaterThan(1);
    expect(seen).toEqual(seen.map((_, index) => index + 1));
    expect((await memory.load('r'))?.revision).toBe(seen.length);
  });

  it('stops an executor whose save a newer writer fenced out', async () => {
    const memory = createInMemoryAgentRunStore();
    const store: AgentRunStore = {
      load: memory.load,
      save: async (envelope: AgentRunEnvelope) => {
        // Another executor took the run over and wrote this revision first.
        if (envelope.revision === 2) await memory.save({ ...envelope, modelSteps: 42 });
        await memory.save(envelope);
      },
    };
    const result = await runAgent({
      model: createMockModel({ responses: [{ text: 'done' }] }),
      prompt: 'x',
      session: { store, scope: 'tenant', runId: 'z' },
    });
    expect(result.status).toBe('failed');
    expect((await memory.load('z'))?.modelSteps).toBe(42);
  });
});
