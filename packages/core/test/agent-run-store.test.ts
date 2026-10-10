import { describe, expect, it } from 'vitest';
import { createInMemoryAgentRunStore, runAgent } from '../src/agent-run';
import { createMockModel } from '../src/testing';
import type { AgentRunEnvelope, AgentRunStore } from '../src/types/agent-run';
import {
  agentRunListContracts,
  agentRunStoreContracts,
  envelope,
} from './fixtures/agent-run-store-conformance';
import { manualClock } from './fixtures/manual-clock';

agentRunStoreContracts('memory agent run store', () => createInMemoryAgentRunStore());

agentRunListContracts('memory agent run listing', async () => {
  const { clock, advance } = manualClock();
  return {
    store: createInMemoryAgentRunStore({ clock }),
    advance,
    now: () => clock.now(),
    frozen: true,
  };
});

describe('memory agent run listing (2.3)', () => {
  it('pages on a clock with sub-millisecond time', async () => {
    let time = 1_000.25;
    const store = createInMemoryAgentRunStore({
      clock: { now: () => time, setTimeout: () => () => {} },
    });
    for (const runId of ['a', 'b', 'c']) {
      await store.save(envelope(runId, 1));
      time += 0.5;
    }
    const first = await store.list({ limit: 2 });
    expect(first.runs.map((run) => run.runId)).toEqual(['c', 'b']);
    const second = await store.list({ limit: 2, cursor: first.cursor });
    expect(second).toEqual({
      runs: [expect.objectContaining({ runId: 'a', updatedAt: 1_000.25 })],
    });
  });
});

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

describe('native executor claim (2.3)', () => {
  it('gives the run back when the store fails while the executor starts', async () => {
    const memory = createInMemoryAgentRunStore();
    let down = true;
    const store: AgentRunStore = {
      load: async (runId) => {
        if (down) {
          down = false;
          throw new Error('store down');
        }
        return memory.load(runId);
      },
      save: memory.save,
    };
    const session = { store, scope: 'tenant', runId: 'claimed' };
    const first = await runAgent({
      model: createMockModel({ responses: [{ text: 'done' }] }),
      prompt: 'x',
      session,
    });
    expect(first).toMatchObject({ status: 'failed', error: { message: 'store down' } });
    // No stale claim is left behind: the next executor runs.
    const second = await runAgent({
      model: createMockModel({ responses: [{ text: 'done' }] }),
      prompt: 'x',
      session,
    });
    expect(second.status).toBe('completed');
  });

  it('still refuses a second executor while the first one runs', async () => {
    const memory = createInMemoryAgentRunStore();
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const store: AgentRunStore = {
      load: memory.load,
      save: async (envelope: AgentRunEnvelope) => {
        await held;
        await memory.save(envelope);
      },
    };
    const session = { store, scope: 'tenant', runId: 'busy' };
    const first = runAgent({
      model: createMockModel({ responses: [{ text: 'done' }] }),
      prompt: 'x',
      session,
    });
    const second = await runAgent({
      model: createMockModel({ responses: [{ text: 'done' }] }),
      prompt: 'x',
      session,
    });
    expect(second).toMatchObject({
      status: 'failed',
      error: { message: 'This native run already has an active executor.' },
    });
    release();
    expect((await first).status).toBe('completed');
  });
});
