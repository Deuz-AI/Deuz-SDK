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
import {
  createInMemoryAgentRunStore,
  resumeAgent,
  resumeStreamAgent,
  runAgent,
} from '../src/agent-run';
import { createMockModel, type MockResponse } from '../src/testing';
import { attachConfig, readConfig } from '../src/internal/config-symbol';
import type {
  AgentEvent,
  AgentRunEnvelope,
  AgentRunStore,
  AgentToolSet,
} from '../src/types/agent-run';

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

/**
 * The fourth way to go on (2.3, EV1 F-EV1-3): the caller checked the system the
 * effect touched, it landed, and its outcome is recorded instead of running the
 * call again.
 */
describe('a landed effect is recorded with reconciledToolResults (2.3)', () => {
  /** Run until the save right after the effect fails; the receipt stays 'executing'. */
  async function interrupted(tools?: AgentToolSet) {
    const inner = createInMemoryAgentRunStore();
    const charged = charging();
    const effects = charged.effects;
    const { model, fetch } = counted([chargeCall, { text: 'done' }]);
    const options = { model, prompt: 'charge', tools: tools ?? charged.tools };
    const ran = () => (tools ? (tools.charge as { ran?: number }).ran : effects.length);
    await runAgent({
      ...options,
      session: {
        store: failingOnce(inner, () => (ran() ?? 0) > 0),
        runId: 'r',
        scope: 't',
      },
    });
    expect(stages(await inner.load('r'))).toEqual(['c1:executing']);
    return { inner, effects, fetch, options, session: { store: inner, runId: 'r', scope: 't' } };
  }

  /** The tool results the model was given, from the request of the `call`-th model call. */
  function toolMessages(fetch: ReturnType<typeof counted>['fetch'], call: number): unknown[] {
    const body = JSON.parse(String(fetch.mock.calls[call]![1]?.body)) as {
      messages: { role: string; content: unknown }[];
    };
    return body.messages.filter((message) => message.role === 'tool').map((m) => m.content);
  }

  it('goes on from the recorded result and never runs the call again', async () => {
    const { inner, effects, fetch, options, session } = await interrupted();
    const resumed = await resumeAgent({
      ...options,
      session,
      reconciledToolResults: [{ toolCallId: 'c1', output: 'charged' }],
    });
    expect(resumed).toMatchObject({ status: 'completed', output: 'done' });
    expect(effects).toHaveLength(1);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(toolMessages(fetch, 1)).toEqual(['charged']);
    const receipts = Object.values((await inner.load('r'))!.toolResults!);
    expect(receipts).toEqual([
      expect.objectContaining({
        toolCallId: 'c1',
        stage: 'completed',
        rawResult: 'charged',
        modelOutput: 'charged',
        reconciled: true,
      }),
    ]);
    // A completed run is not reconciled again.
    expect(
      await resumeAgent({
        ...options,
        session,
        reconciledToolResults: [{ toolCallId: 'c1', output: 'charged' }],
      }),
    ).toEqual(resumed);
    expect(effects).toHaveLength(1);
  });

  it('streams the recorded result like one the tool reported', async () => {
    const { effects, options, session } = await interrupted();
    const stream = resumeStreamAgent({
      ...options,
      session,
      reconciledToolResults: [{ toolCallId: 'c1', output: 'charged' }],
    });
    const events: AgentEvent[] = [];
    for await (const event of stream.events) events.push(event);
    expect(await stream.result).toMatchObject({ status: 'completed', output: 'done' });
    expect(effects).toHaveLength(1);
    expect(events).toContainEqual({
      type: 'tool-output',
      toolCallId: 'c1',
      toolName: 'charge',
      rawResult: 'charged',
      modelOutput: 'charged',
    });
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'part',
        part: expect.objectContaining({ type: 'tool-result', toolCallId: 'c1', output: 'charged' }),
      }),
    );
    // Settled, so no longer an unknown effect.
    expect(
      events.some(
        (event) =>
          event.type === 'part' &&
          event.part.type === 'tool-state' &&
          event.part.outcome === 'unknown-effect',
      ),
    ).toBe(false);
  });

  it("validates and projects the result like the tool's own", async () => {
    let ran = 0;
    const tools: AgentToolSet = {
      charge: {
        parameters,
        validateResult: (value) => {
          if (typeof value !== 'string') throw new TypeError('not a charge id');
          return value;
        },
        toModelOutput: (value) => `charge ${String(value)} is booked`,
        execute: () => {
          ran += 1;
          (tools.charge as { ran?: number }).ran = ran;
          return 'ch_1';
        },
      },
    };
    const { inner, fetch, options, session } = await interrupted(tools);
    const resumed = await resumeAgent({
      ...options,
      session,
      reconciledToolResults: [{ toolCallId: 'c1', output: 'ch_1' }],
    });
    expect(resumed).toMatchObject({ status: 'completed' });
    expect(ran).toBe(1);
    expect(toolMessages(fetch, 1)).toEqual(['charge ch_1 is booked']);
    expect(Object.values((await inner.load('r'))!.toolResults!)).toEqual([
      expect.objectContaining({
        stage: 'completed',
        rawResult: 'ch_1',
        modelOutput: 'charge ch_1 is booked',
        reconciled: true,
      }),
    ]);
  });

  it('answers the call with the error when the effect failed in that system', async () => {
    const { inner, effects, fetch, options, session } = await interrupted();
    const resumed = await resumeAgent({
      ...options,
      session,
      reconciledToolResults: [{ toolCallId: 'c1', output: 'card declined', isError: true }],
    });
    expect(resumed).toMatchObject({ status: 'completed', output: 'done' });
    expect(effects).toHaveLength(1);
    expect(JSON.stringify(toolMessages(fetch, 1))).toContain('card declined');
    expect(Object.values((await inner.load('r'))!.toolResults!)).toEqual([
      expect.objectContaining({ stage: 'failed', error: 'card declined', reconciled: true }),
    ]);
  });

  it('takes the stored verdict again for a call that waited for an approval', async () => {
    const inner = createInMemoryAgentRunStore();
    const effects: string[] = [];
    const tools: AgentToolSet = {
      charge: {
        parameters,
        needsApproval: true,
        execute: () => {
          effects.push('charge');
          return 'charged';
        },
      },
    };
    const { model, fetch } = counted([chargeCall, { text: 'done' }]);
    const options = { model, prompt: 'charge', tools };
    const session = { store: inner, runId: 'g', scope: 't' };
    const first = await runAgent({ ...options, session });
    const approvalResponses =
      first.status === 'suspended'
        ? first.pendingApprovals.map((request) => ({
            approvalId: request.approvalId,
            approved: true,
          }))
        : [];
    expect(approvalResponses).toHaveLength(1);
    await resumeAgent({
      ...options,
      session: { ...session, store: failingOnce(inner, () => effects.length > 0) },
      approvalResponses,
    });
    expect(stages(await inner.load('g'))).toEqual(['c1:executing']);
    // As for a retry, the gate answers the call again on resume: with the verdict
    // the application stored, the recorded outcome answers it.
    const resumed = await resumeAgent({
      ...options,
      session,
      approvalResponses,
      reconciledToolResults: [{ toolCallId: 'c1', output: 'charged' }],
    });
    expect(resumed).toMatchObject({ status: 'completed', output: 'done' });
    expect(effects).toEqual(['charge']);
    expect(toolMessages(fetch, 1)).toEqual(['charged']);
  });

  it('refuses anything but the unknown effects, before writing anything', async () => {
    const { inner, effects, fetch, options, session } = await interrupted();
    const before = await inner.load('r');
    const refusals: [string, Record<string, unknown>][] = [
      [
        'an id that is no unknown effect',
        { reconciledToolResults: [{ toolCallId: 'c9', output: 1 }] },
      ],
      [
        'an id listed twice',
        {
          reconciledToolResults: [
            { toolCallId: 'c1', output: 1 },
            { toolCallId: 'c1', output: 2 },
          ],
        },
      ],
      [
        'an id also listed for a retry',
        {
          reconciledToolResults: [{ toolCallId: 'c1', output: 1 }],
          retryToolCallIds: ['c1'],
        },
      ],
      ['an entry without an id', { reconciledToolResults: [{ output: 1 }] }],
      ['a value that is no list', { reconciledToolResults: { toolCallId: 'c1', output: 1 } }],
    ];
    for (const [label, extra] of refusals) {
      const resumed = await resumeAgent({ ...options, session, ...extra });
      expect(resumed, label).toMatchObject({
        status: 'failed',
        error: { name: 'TypeError', message: expect.stringContaining('reconciledToolResults') },
      });
      expect(await inner.load('r'), label).toEqual(before);
    }
    expect(effects).toHaveLength(1);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('refuses an idempotent call, which runs again by itself, and a fresh run', async () => {
    const { inner, options } = await (async () => {
      const store = createInMemoryAgentRunStore();
      const { effects, tools } = charging('idempotent');
      const { model } = counted([chargeCall, { text: 'done' }]);
      const options = { model, prompt: 'charge', tools };
      await runAgent({
        ...options,
        session: { store: failingOnce(store, () => effects.length > 0), runId: 'i', scope: 't' },
      });
      return { inner: store, options };
    })();
    const before = await inner.load('i');
    expect(
      await resumeAgent({
        ...options,
        session: { store: inner, runId: 'i', scope: 't' },
        reconciledToolResults: [{ toolCallId: 'c1', output: 'charged' }],
      }),
    ).toMatchObject({ status: 'failed', error: { name: 'TypeError' } });
    expect(await inner.load('i')).toEqual(before);
    const fresh = createInMemoryAgentRunStore();
    expect(
      await runAgent({
        ...options,
        session: { store: fresh, runId: 'new', scope: 't' },
        reconciledToolResults: [{ toolCallId: 'c1', output: 'charged' }],
      }),
    ).toMatchObject({ status: 'failed', error: { name: 'TypeError' } });
    expect(await fresh.load('new')).toBeUndefined();
  });

  it('settles every unknown effect of a turn in one resume, or stops and records nothing', async () => {
    const inner = createInMemoryAgentRunStore();
    const effects: string[] = [];
    let release!: () => void;
    const bothStarted = new Promise<void>((resolve) => (release = resolve));
    const tools: AgentToolSet = {
      charge: {
        parameters,
        execute: async (_args, context) => {
          effects.push(context.toolCallId);
          if (effects.length === 2) release();
          await bothStarted;
          return `charged ${context.toolCallId}`;
        },
      },
    };
    const { model, fetch } = counted([
      {
        toolCalls: [
          { toolName: 'charge', id: 'c1', args: {} },
          { toolName: 'charge', id: 'c2', args: {} },
        ],
      },
      { text: 'done' },
    ]);
    const options = { model, prompt: 'charge twice', tools };
    await runAgent({
      ...options,
      session: { store: failingOnce(inner, () => effects.length === 2), runId: 'p', scope: 't' },
    });
    expect(stages(await inner.load('p')).sort()).toEqual(['c1:executing', 'c2:executing']);
    const session = { store: inner, runId: 'p', scope: 't' };
    const before = await inner.load('p');
    const partly = await resumeAgent({
      ...options,
      session,
      reconciledToolResults: [{ toolCallId: 'c1', output: 'charged c1' }],
    });
    // Both stay unknown in the store, so the stop names both.
    expect(partly).toMatchObject({ status: 'stopped', reason: 'tool-reconciliation-required' });
    expect(
      (partly.status === 'stopped' ? (partly.unknownEffects ?? []) : [])
        .map((receipt) => receipt.toolCallId)
        .sort(),
    ).toEqual(['c1', 'c2']);
    expect(await inner.load('p')).toEqual(before);
    const resumed = await resumeAgent({
      ...options,
      session,
      reconciledToolResults: [{ toolCallId: 'c1', output: 'charged c1' }],
      retryToolCallIds: ['c2'],
    });
    expect(resumed).toMatchObject({ status: 'completed', output: 'done' });
    // c1 landed once and was recorded; c2 was retried as the caller decided.
    expect(effects).toEqual(['c1', 'c2', 'c2']);
    expect(fetch).toHaveBeenCalledTimes(2);
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
