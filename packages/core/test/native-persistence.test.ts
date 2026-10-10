/**
 * native-persistence.test.ts (2.3, roadmap 23.2) — what a native run does when
 * its store fails around a tool call, and the three ways to go on: the
 * reconciliation stop, `retryToolCallIds`, and `replay: 'idempotent'`.
 *
 * The receipt of a call is written `'executing'` before the effect and
 * `'completed'` after it. A store that fails in between leaves the effect's
 * outcome unknown: a resume never repeats it blindly.
 */
import { describe, expect, it, vi } from 'vitest';
import { createInMemoryAgentRunStore, resumeAgent, runAgent } from '../src/agent-run';
import { createMockModel, type MockResponse } from '../src/testing';
import { attachConfig, readConfig } from '../src/internal/config-symbol';
import type { AgentRunEnvelope, AgentRunStore, AgentToolSet } from '../src/types/agent-run';

const parameters = { type: 'object' as const, properties: {} };

function counted(responses: MockResponse[]) {
  const base = createMockModel({ responses });
  const config = readConfig(base)!;
  const fetch = vi.fn(config.fetch!);
  return { model: attachConfig({ ...base }, { ...config, fetch }), fetch };
}

const stages = (envelope: AgentRunEnvelope | undefined): string[] =>
  Object.values(envelope?.toolResults ?? {}).map((r) => `${r.toolCallId}:${r.stage}`);

/** Fails the first save `when` selects; every other save goes through. */
function failingOnce(
  inner: AgentRunStore,
  when: (envelope: AgentRunEnvelope) => boolean,
): AgentRunStore {
  let failed = false;
  return {
    load: (id) => inner.load(id),
    save(envelope) {
      if (!failed && when(envelope)) {
        failed = true;
        throw new Error('store down');
      }
      return inner.save(envelope);
    },
  };
}

function charging(replay?: 'idempotent') {
  const effects: Array<{ id: string; step: number | undefined }> = [];
  const tools: AgentToolSet = {
    charge: {
      parameters,
      ...(replay ? { replay } : {}),
      execute: async (_args, context) => {
        effects.push({ id: context.toolCallId, step: context.modelStep });
        return 'charged';
      },
    },
  };
  return { effects, tools };
}

const chargeCall: MockResponse = { toolCalls: [{ toolName: 'charge', id: 'c1', args: {} }] };

describe('the store fails after the effect: the outcome is unknown', () => {
  /** Run until the save right after the effect fails; the receipt stays 'executing'. */
  async function interrupted(replay?: 'idempotent') {
    const inner = createInMemoryAgentRunStore();
    const { effects, tools } = charging(replay);
    const { model, fetch } = counted([chargeCall, { text: 'done' }]);
    const options = { model, prompt: 'charge', tools };
    const first = await runAgent({
      ...options,
      session: {
        store: failingOnce(inner, () => effects.length > 0),
        runId: 'r',
        scope: 't',
      },
    });
    expect(first.status).toBe('failed');
    expect(stages(await inner.load('r'))).toEqual(['c1:executing']);
    return { inner, effects, fetch, options };
  }

  it('stops for reconciliation and names the call, without repeating it', async () => {
    const { inner, effects, fetch, options } = await interrupted();
    const resumed = await resumeAgent({
      ...options,
      session: { store: inner, runId: 'r', scope: 't' },
    });
    expect(resumed).toMatchObject({
      status: 'stopped',
      reason: 'tool-reconciliation-required',
      unknownEffects: [{ toolCallId: 'c1', toolName: 'charge', stage: 'executing' }],
    });
    expect(effects).toHaveLength(1);
    expect(fetch).toHaveBeenCalledTimes(1);
    // The stop is not terminal: nothing was written, so the run can still be reconciled.
    expect(stages(await inner.load('r'))).toEqual(['c1:executing']);
  });

  it('runs the call once more when the caller lists it in retryToolCallIds', async () => {
    const { inner, effects, fetch, options } = await interrupted();
    const session = { store: inner, runId: 'r', scope: 't' };
    const resumed = await resumeAgent({ ...options, session, retryToolCallIds: ['c1'] });
    expect(resumed).toMatchObject({ status: 'completed', output: 'done' });
    expect(effects).toHaveLength(2);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(stages(await inner.load('r'))).toEqual(['c1:completed']);
    // A completed run never runs it again, retry list or not.
    expect(await resumeAgent({ ...options, session, retryToolCallIds: ['c1'] })).toEqual(resumed);
    expect(effects).toHaveLength(2);
  });

  it('runs an idempotent call again by itself, with the same identity', async () => {
    const { inner, effects, options } = await interrupted('idempotent');
    const resumed = await resumeAgent({
      ...options,
      session: { store: inner, runId: 'r', scope: 't' },
    });
    expect(resumed).toMatchObject({ status: 'completed', output: 'done' });
    // The effect identity [modelStep, toolCallId] is stable across the replay.
    expect(effects).toEqual([
      { id: 'c1', step: 1 },
      { id: 'c1', step: 1 },
    ]);
  });
});

describe('the store fails elsewhere: nothing is unknown', () => {
  it('a receipt that could not be written means the effect never ran', async () => {
    const inner = createInMemoryAgentRunStore();
    const { effects, tools } = charging();
    const { model, fetch } = counted([chargeCall, chargeCall, { text: 'done' }]);
    const options = { model, prompt: 'charge', tools };
    const first = await runAgent({
      ...options,
      session: {
        store: failingOnce(inner, (envelope) => stages(envelope).includes('c1:executing')),
        runId: 'b',
        scope: 't',
      },
    });
    expect(first.status).toBe('failed');
    expect(effects).toHaveLength(0);
    // The step that asked for it is replayed from the last durable boundary.
    const resumed = await resumeAgent({
      ...options,
      session: { store: inner, runId: 'b', scope: 't' },
    });
    expect(resumed).toMatchObject({ status: 'completed', output: 'done' });
    expect(effects).toHaveLength(1);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('a step checkpoint that failed after a completed call replays the recorded result', async () => {
    const inner = createInMemoryAgentRunStore();
    const { effects, tools } = charging();
    const { model } = counted([chargeCall, { text: 'done' }]);
    const options = { model, prompt: 'charge', tools };
    let completedSaved = false;
    const first = await runAgent({
      ...options,
      session: {
        store: failingOnce(inner, (envelope) => {
          // The save after the one that recorded the completed receipt.
          const after = completedSaved;
          if (stages(envelope).includes('c1:completed')) completedSaved = true;
          return after;
        }),
        runId: 'c',
        scope: 't',
      },
    });
    expect(first.status).toBe('failed');
    expect(stages(await inner.load('c'))).toEqual(['c1:completed']);
    const resumed = await resumeAgent({
      ...options,
      session: { store: inner, runId: 'c', scope: 't' },
    });
    expect(resumed).toMatchObject({ status: 'completed', output: 'done' });
    expect(effects).toHaveLength(1);
  });
});
