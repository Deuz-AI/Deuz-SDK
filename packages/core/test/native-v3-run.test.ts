/**
 * native-v3-run.test.ts (2.4, spec §4.1) — the V3 path of the native
 * executor: `checkpointVersion: 3` with an `AgentRunStoreV3` runs, streams,
 * resumes and reconciles on the same executor as 2.3, saves every record as
 * version 3 (terminal and bookkeeping saves included), and refuses a 2.3 or
 * Redis run store, a missing session and the V3 options on a 2.3 run before
 * any model call or write.
 */
import { describe, expect, it } from 'vitest';
import {
  createInMemoryAgentRunStore,
  reconcileAgentRun,
  resumeAgent,
  resumeStreamAgent,
  runAgent,
  streamAgent,
} from '../src/agent-run';
import { markAgentRunStoreBackend } from '../src/agent-run-v3';
import type { AgentEventV3, AgentRunOptionsV3, AgentRunStoreV3 } from '../src/types/agent-run-v3';
import type { AgentRunOptions } from '../src/types/agent-run';
import { recordingStoreV3, scriptedModel } from './fixtures/native-v3';

const parameters = { type: 'object', properties: {} };

function options(
  store: AgentRunStoreV3,
  model: AgentRunOptionsV3['model'],
  extra: Partial<AgentRunOptionsV3> = {},
): AgentRunOptionsV3 {
  return {
    model,
    prompt: 'hello',
    checkpointVersion: 3,
    session: { store, runId: 'run-1', scope: 'tenant' },
    ...extra,
  };
}

describe('V3 runs on the native executor', () => {
  it('runs to completion and saves every record as version 3, fenced', async () => {
    const { model, fetch } = scriptedModel([{ text: 'hi there' }]);
    const store = recordingStoreV3();
    const result = await runAgent(options(store, model));
    expect(result).toMatchObject({ status: 'completed', output: 'hi there', runId: 'run-1' });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(store.saves.length).toBeGreaterThan(1);
    expect(store.saves.every((save) => save.version === 3)).toBe(true);
    expect(store.saves.map((save) => save.revision)).toEqual(
      store.saves.map((_, index) => index + 1),
    );
    const stored = await store.load('run-1');
    expect(stored).toMatchObject({
      version: 3,
      phase: 'terminal',
      result: { status: 'completed' },
    });
  });

  it('streams the 2.3 events and the V3 view of them', async () => {
    const { model } = scriptedModel([{ text: 'streamed' }]);
    const store = recordingStoreV3();
    const stream = streamAgent(options(store, model));
    const v2: string[] = [];
    const v3: AgentEventV3[] = [];
    await Promise.all([
      (async () => {
        for await (const event of stream.events) v2.push(event.type);
      })(),
      (async () => {
        for await (const event of stream.eventsV3) v3.push(event);
      })(),
    ]);
    const result = await stream.result;
    expect(result.status).toBe('completed');
    expect(v2).toContain('result');
    // Every 2.3 event is in the V3 view, in the same order.
    expect(v3.map((event) => event.type).filter((type) => v2.includes(type))).toEqual(v2);
  });

  it('suspends and resumes as version 3, the resume continuing the stored run', async () => {
    const { model, fetch } = scriptedModel([
      { toolCalls: [{ toolName: 'gate', id: 'g1', args: {} }] },
      { text: 'approved and done' },
    ]);
    const store = recordingStoreV3();
    const tools = { gate: { parameters, needsApproval: true, execute: () => 'ok' } };
    const first = await runAgent(options(store, model, { tools }));
    expect(first.status).toBe('suspended');
    if (first.status !== 'suspended') return;
    const resumed = await resumeAgent({
      ...options(store, model, { tools }),
      approvalResponses: [{ approvalId: first.pendingApprovals[0]!.approvalId, approved: true }],
    });
    expect(resumed).toMatchObject({ status: 'completed', output: 'approved and done' });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(store.saves.every((save) => save.version === 3)).toBe(true);
    const stream = resumeStreamAgent(options(store, model, { tools }));
    expect(await stream.result).toMatchObject({ status: 'completed' });
  });

  it('reconciles a V3 run with its V3 store', async () => {
    const { model } = scriptedModel([{ text: 'done' }]);
    const store = recordingStoreV3();
    await runAgent(options(store, model));
    const saves = store.saves.length;
    const outcome = await reconcileAgentRun({
      checkpointVersion: 3,
      session: { store, runId: 'run-1', scope: 'tenant' },
    });
    expect(outcome).toEqual({ runId: 'run-1' });
    expect(store.saves.length).toBe(saves);
  });
});

describe('what a V3 run refuses before any model call or write', () => {
  it('a 2.3 AgentRunStore: TypeError', async () => {
    const { model, fetch } = scriptedModel([{ text: 'never' }]);
    const store = createInMemoryAgentRunStore();
    const result = await runAgent({
      model,
      prompt: 'hello',
      checkpointVersion: 3,
      session: { store: store as unknown as AgentRunStoreV3, runId: 'run-1', scope: 'tenant' },
    });
    expect(result).toMatchObject({ status: 'failed', error: { name: 'TypeError' } });
    expect(fetch).not.toHaveBeenCalled();
    expect(await store.load('run-1')).toBeUndefined();
  });

  it('a Redis run store: UnsupportedStoreError', async () => {
    const { model, fetch } = scriptedModel([{ text: 'never' }]);
    const redis = markAgentRunStoreBackend(createInMemoryAgentRunStore(), 'redis');
    const result = await runAgent({
      model,
      prompt: 'hello',
      checkpointVersion: 3,
      session: { store: redis as unknown as AgentRunStoreV3, runId: 'run-1', scope: 'tenant' },
    });
    expect(result).toMatchObject({
      status: 'failed',
      error: { name: 'UnsupportedStoreError', code: 'unsupported_store' },
    });
    expect(fetch).not.toHaveBeenCalled();
    await expect(
      reconcileAgentRun({
        checkpointVersion: 3,
        session: { store: redis as unknown as AgentRunStoreV3, runId: 'run-1', scope: 'tenant' },
      }),
    ).rejects.toMatchObject({ code: 'unsupported_store' });
  });

  it('a missing session: TypeError', async () => {
    const { model, fetch } = scriptedModel([{ text: 'never' }]);
    const result = await runAgent({
      model,
      prompt: 'hello',
      checkpointVersion: 3,
    } as unknown as AgentRunOptionsV3);
    expect(result).toMatchObject({ status: 'failed', error: { name: 'TypeError' } });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('a checkpoint version other than 3, and a V3 store without checkpointVersion: 3', async () => {
    const { model, fetch } = scriptedModel([{ text: 'never' }]);
    const store = recordingStoreV3();
    const wrongVersion = await runAgent({
      ...options(store, model),
      checkpointVersion: 2,
    } as unknown as AgentRunOptionsV3);
    expect(wrongVersion).toMatchObject({ status: 'failed', error: { name: 'TypeError' } });
    const noVersion = await runAgent({
      model,
      prompt: 'hello',
      session: { store, runId: 'run-1', scope: 'tenant' },
    } as unknown as AgentRunOptions);
    expect(noVersion).toMatchObject({
      status: 'failed',
      error: { name: 'TypeError', message: expect.stringMatching(/checkpointVersion: 3/) },
    });
    expect(fetch).not.toHaveBeenCalled();
    expect(store.saves).toEqual([]);
  });

  it('the 2.4 run options on a 2.3 run: TypeError', async () => {
    for (const extra of [
      { context: { sources: [] } },
      { workingMemory: { create: { scope: 'tenant', now: 1 } } },
      { versionedMemory: { session: {} } },
    ]) {
      const { model, fetch } = scriptedModel([{ text: 'never' }]);
      const result = await runAgent({
        model,
        prompt: 'hello',
        ...extra,
      } as unknown as AgentRunOptions);
      expect(result).toMatchObject({
        status: 'failed',
        error: { name: 'TypeError', message: expect.stringMatching(/checkpointVersion: 3/) },
      });
      expect(fetch).not.toHaveBeenCalled();
    }
  });
});
