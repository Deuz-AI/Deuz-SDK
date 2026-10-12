/**
 * native-receipt-settle.test.ts (2.3) — a resume answers a pending call whose
 * effect receipt already records its outcome from that receipt.
 *
 * A native run writes a call's receipt before the checkpoint that answers the
 * call. When the run stops in between (the process dies while other calls of
 * the step run, a store write fails, or a sub-agent beside the call suspends),
 * the next resume finds the call unanswered in the history and settles it
 * again. That settle ran the approval gate again: a call that had waited for
 * an approval was answered "Tool call denied. Reason: No approval response."
 * unless the caller passed the stored verdict again, although its effect had
 * landed and its result was recorded.
 *
 * A resume also saves what its settle answered before its next model call, so
 * a process that dies during that call leaves nothing to settle again (W3
 * review V1-1): the stored run's model step has moved on by then, and the
 * receipts of the settled calls are keyed by the step that issued them.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  createInMemoryAgentRunStore,
  resumeAgent,
  resumeStreamAgent,
  runAgent,
} from '../src/agent-run';
import { createExecutionContext } from '../src/execution-policy';
import { agentTool } from '../src/inference/agent-tool';
import { handoff } from '../src/inference/handoff';
import { wrapMcpClient, type McpClient } from '../src/mcp/shared';
import { createMockModel, type MockResponse } from '../src/testing';
import { attachConfig, readConfig } from '../src/internal/config-symbol';
import type {
  AgentEvent,
  AgentResult,
  AgentRunEnvelope,
  AgentRunOptions,
  AgentRunStore,
  AgentStream,
  AgentToolSet,
} from '../src/types/agent-run';
import type { LanguageModel } from '../src/types/model';
import type { StreamPart } from '../src/types/stream';

const parameters = { type: 'object' as const, properties: {} };
const chargeCall: MockResponse = { toolCalls: [{ toolName: 'charge', id: 'c1', args: {} }] };
const DENIED = 'No approval response';

function counted(responses: MockResponse[], modelId?: string) {
  const base = createMockModel({ responses });
  const config = readConfig(base)!;
  const fetch = vi.fn(config.fetch!);
  const model: LanguageModel = attachConfig(modelId ? { ...base, modelId } : { ...base }, {
    ...config,
    fetch,
  });
  return { model, fetch };
}

const stages = (envelope: AgentRunEnvelope | undefined): string[] =>
  Object.values(envelope?.toolResults ?? {}).map((r) => `${r.toolCallId}:${r.stage}`);

/** Fails the first save after the one that recorded `stage` (`<id>:<stage>`). */
function failingAfter(inner: AgentRunStore, stage: string): AgentRunStore {
  let recorded = false;
  let failed = false;
  return {
    load: (id) => inner.load(id),
    save(envelope) {
      if (recorded && !failed) {
        failed = true;
        throw new Error('process died');
      }
      if (stages(envelope).includes(stage)) recorded = true;
      return inner.save(envelope);
    },
  };
}

/** The tool results the model was given, from the request of the `call`-th model call. */
function toolMessages(fetch: ReturnType<typeof counted>['fetch'], call: number): unknown[] {
  const body = JSON.parse(String(fetch.mock.calls[call]![1]?.body)) as {
    messages: { role: string; content: unknown }[];
  };
  return body.messages.filter((message) => message.role === 'tool').map((m) => m.content);
}

const approveAll = (result: AgentResult) =>
  result.status === 'suspended'
    ? result.pendingApprovals.map((request) => ({ approvalId: request.approvalId, approved: true }))
    : [];

async function collect(stream: AgentStream) {
  const events: AgentEvent[] = [];
  for await (const event of stream.events) events.push(event);
  const parts = events.flatMap((event) => (event.type === 'part' ? [event.part] : []));
  return { result: await stream.result, events, parts };
}

/** The warnings about approval verdicts (the mock model also reports `unknown-model`). */
const verdictWarnings = (parts: StreamPart[]) =>
  parts.flatMap((part) =>
    part.type === 'warning' && part.warning.setting === 'approvalResponses' ? [part.warning] : [],
  );

/**
 * A gated `charge` call is approved, runs and records its outcome; the process
 * then dies at the run's next save, before the step that answers the call is
 * checkpointed. The stored run holds the receipt and the unanswered call.
 */
async function approvedThenCrashed(
  tool: Partial<AgentToolSet[string]> = {},
  extra: Partial<AgentRunOptions> = {},
  stage = 'c1:completed',
) {
  const store = createInMemoryAgentRunStore();
  const effects: string[] = [];
  const tools: AgentToolSet = {
    charge: {
      parameters,
      needsApproval: true,
      execute: () => {
        effects.push('charge');
        return 'charged';
      },
      ...tool,
    },
  };
  const { model, fetch } = counted([chargeCall, { text: 'done' }]);
  const options = { model, prompt: 'charge', tools, ...extra };
  const session = { store, runId: 'r', scope: 't' };
  const first = await runAgent({ ...options, session });
  expect(first.status).toBe('suspended');
  const verdicts = approveAll(first);
  const crashed = await resumeAgent({
    ...options,
    session: { ...session, store: failingAfter(store, stage) },
    approvalResponses: verdicts,
  });
  // The save that fails is the one that records the settle's answers, before
  // the next model call: the process dies inside the resume's settle.
  expect(crashed.status).toBe('failed');
  expect(stages(await store.load('r'))).toEqual([stage]);
  // The stored history still ends on the call, unanswered.
  const stored = (await store.load('r'))!;
  expect(stored.messages.at(-1)?.role).toBe('assistant');
  return { store, effects, fetch, options, session, verdicts };
}

describe('a pending call whose receipt holds an outcome settles from it (2.3)', () => {
  it('answers an approved call from its completed receipt without the verdict', async () => {
    const { effects, fetch, options, session } = await approvedThenCrashed();
    const resumed = await resumeAgent({ ...options, session });
    expect(resumed).toMatchObject({ status: 'completed', output: 'done' });
    // The recorded result reaches the model; the tool never runs again.
    expect(toolMessages(fetch, 1)).toEqual(['charged']);
    expect(effects).toEqual(['charge']);
  });

  it('streams the recorded result like a call no gate holds', async () => {
    const { effects, options, session } = await approvedThenCrashed();
    const { result, parts } = await collect(resumeStreamAgent({ ...options, session }));
    expect(result).toMatchObject({ status: 'completed', output: 'done' });
    expect(effects).toEqual(['charge']);
    expect(parts).toContainEqual({
      type: 'tool-result',
      toolCallId: 'c1',
      toolName: 'charge',
      output: 'charged',
    });
    const states = parts.flatMap((part) =>
      part.type === 'tool-state' && part.toolCallId === 'c1' ? [part] : [],
    );
    expect(states.map((part) => part.state)).toEqual(['executing', 'complete']);
    expect(states.some((part) => part.denied || part.outcome)).toBe(false);
    // Nothing was passed for the call, so nothing is reported about a verdict.
    expect(verdictWarnings(parts)).toEqual([]);
  });

  it('answers a call the execution policy gates', async () => {
    const policy = { requireApproval: true };
    const { store, effects, fetch, options, session } = await approvedThenCrashed(
      { needsApproval: undefined },
      { execution: createExecutionContext({ scopeId: 'r', policy }) },
    );
    const saved = (await store.load('r'))!;
    const resumed = await resumeAgent({
      ...options,
      session,
      execution: createExecutionContext({ snapshot: saved.execution! }),
    });
    expect(resumed).toMatchObject({ status: 'completed', output: 'done' });
    expect(toolMessages(fetch, 1)).toEqual(['charged']);
    expect(effects).toEqual(['charge']);
  });

  it('answers a call that failed with its recorded error, not a denial', async () => {
    const attempts: string[] = [];
    const { fetch, options, session } = await approvedThenCrashed(
      {
        execute: () => {
          attempts.push('charge');
          throw new Error('card declined');
        },
      },
      {},
      'c1:failed',
    );
    const resumed = await resumeAgent({ ...options, session });
    expect(resumed).toMatchObject({ status: 'completed', output: 'done' });
    const answer = JSON.stringify(toolMessages(fetch, 1));
    expect(answer).toContain('card declined');
    expect(answer).not.toContain(DENIED);
    expect(attempts).toEqual(['charge']);
  });

  it('answers a reconciled call that waited for an approval without the verdict', async () => {
    const store = createInMemoryAgentRunStore();
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
    const session = { store, runId: 'g', scope: 't' };
    const first = await runAgent({ ...options, session });
    // The store fails right after the effect: its outcome is unknown.
    let ran = false;
    await resumeAgent({
      ...options,
      session: {
        ...session,
        store: {
          load: (id) => store.load(id),
          save(envelope) {
            if (effects.length > 0 && !ran) {
              ran = true;
              throw new Error('store down');
            }
            return store.save(envelope);
          },
        },
      },
      approvalResponses: approveAll(first),
    });
    expect(stages(await store.load('g'))).toEqual(['c1:executing']);
    const resumed = await resumeAgent({
      ...options,
      session,
      reconciledToolResults: [{ toolCallId: 'c1', output: 'charged' }],
    });
    expect(resumed).toMatchObject({ status: 'completed', output: 'done' });
    expect(effects).toEqual(['charge']);
    expect(toolMessages(fetch, 1)).toEqual(['charged']);
    expect(Object.values((await store.load('g'))!.toolResults!)).toEqual([
      expect.objectContaining({ stage: 'completed', reconciled: true, modelOutput: 'charged' }),
    ]);
  });

  it("answers a handoff target's approved call from its receipt", async () => {
    const effects: string[] = [];
    const triage = counted(
      [{ toolCalls: [{ toolName: 'transfer_to_billing', id: 'h1', args: {} }] }],
      'triage-model',
    );
    const billing = counted(
      [{ toolCalls: [{ toolName: 'refund', id: 'r1', args: {} }] }, { text: 'Refund issued.' }],
      'billing-model',
    );
    const store = createInMemoryAgentRunStore();
    const options = {
      model: triage.model,
      prompt: 'Refund me.',
      tools: handoff({
        billing: {
          model: billing.model,
          instructions: 'You are billing.',
          tools: {
            refund: {
              parameters,
              needsApproval: true,
              execute: () => {
                effects.push('refund');
                return 'refunded';
              },
            },
          },
        },
      }),
    };
    const session = { store, runId: 'target', scope: 't' };
    const first = await runAgent({ ...options, session });
    expect(first.status).toBe('suspended');
    const crashed = await resumeAgent({
      ...options,
      session: { ...session, store: failingAfter(store, 'r1:completed') },
      approvalResponses: approveAll(first),
    });
    expect(crashed.status).toBe('failed');
    const resumed = await resumeAgent({ ...options, session });
    expect(resumed).toMatchObject({ status: 'completed', output: 'Refund issued.' });
    expect(effects).toEqual(['refund']);
    const answers = JSON.stringify(toolMessages(billing.fetch, 1));
    expect(answers).toContain('refunded');
    expect(answers).not.toContain(DENIED);
  });

  it('answers an MCP call from its receipt', async () => {
    const effects: string[] = [];
    // A scripted server behind the SDK's own wrapper: every call is an effect.
    const server: McpClient = wrapMcpClient({
      connect: async () => {},
      listTools: async () => ({
        tools: [
          {
            name: 'charge',
            description: 'Charge a card',
            inputSchema: { type: 'object', properties: { amount: { type: 'number' } } },
          },
        ],
      }),
      callTool: async ({ name }) => {
        effects.push(name);
        return { content: [{ type: 'text', text: `${name} done` }] };
      },
      close: async () => {},
    });
    const { model, fetch } = counted([
      { toolCalls: [{ toolName: 'charge', id: 'c1', args: { amount: 5 } }] },
      { text: 'done' },
    ]);
    const store = createInMemoryAgentRunStore();
    const options = { model, prompt: 'charge 5', mcp: [server] };
    const session = { store, runId: 'mcp', scope: 't' };
    const first = await runAgent({
      ...options,
      session,
      execution: createExecutionContext({ scopeId: 'mcp', policy: { requireApproval: true } }),
    });
    expect(first.status).toBe('suspended');
    const restored = async () =>
      createExecutionContext({ snapshot: (await store.load('mcp'))!.execution! });
    const crashed = await resumeAgent({
      ...options,
      session: { ...session, store: failingAfter(store, 'c1:completed') },
      approvalResponses: approveAll(first),
      execution: await restored(),
    });
    expect(crashed.status).toBe('failed');
    const resumed = await resumeAgent({ ...options, session, execution: await restored() });
    expect(resumed).toMatchObject({ status: 'completed', output: 'done' });
    expect(effects).toEqual(['charge']);
    const answer = JSON.stringify(toolMessages(fetch, 1));
    expect(answer).toContain('charge done');
    expect(answer).not.toContain(DENIED);
  });

  it('answers an approved sibling of a sub-agent that suspended beside it', async () => {
    const effects: string[] = [];
    const child = counted([
      { toolCalls: [{ toolName: 'pay', id: 'p1', args: {} }] },
      { text: 'paid' },
    ]);
    const parent = counted([
      {
        toolCalls: [
          { toolName: 'charge', id: 'c1', args: {} },
          { toolName: 'worker', id: 'w1', args: { prompt: 'pay' } },
        ],
      },
      { text: 'done' },
    ]);
    const options = {
      model: parent.model,
      prompt: 'charge and pay',
      // One call at a time, so the charge has its receipt before the child suspends.
      maxToolConcurrency: 1,
      tools: {
        charge: {
          parameters,
          needsApproval: true,
          execute: () => {
            effects.push('charge');
            return 'charged';
          },
        },
        worker: agentTool({
          name: 'worker',
          description: 'Pays.',
          model: child.model,
          tools: {
            pay: {
              parameters,
              needsApproval: true,
              execute: () => {
                effects.push('pay');
                return 'paid';
              },
            },
          },
        }),
      },
      session: { store: createInMemoryAgentRunStore(), runId: 'sibling', scope: 't' },
    };
    const first = await runAgent(options);
    expect(first.status).toBe('suspended');
    // The charge is approved and runs; the worker's child then waits for its own verdict.
    const second = await resumeAgent({ ...options, approvalResponses: approveAll(first) });
    expect(second.status).toBe('suspended');
    expect(effects).toEqual(['charge']);
    // The caller answers what the run waits for now: the child's approval only.
    const resumed = await resumeAgent({ ...options, approvalResponses: approveAll(second) });
    expect(resumed).toMatchObject({ status: 'completed', output: 'done' });
    expect(effects).toEqual(['charge', 'pay']);
    expect(toolMessages(parent.fetch, 1)).toEqual(['charged', 'paid']);
  });

  it('ignores a verdict passed for such a call, and says so', async () => {
    const { effects, fetch, options, session, verdicts } = await approvedThenCrashed();
    const { result, parts } = await collect(
      resumeStreamAgent({
        ...options,
        session,
        // A denial cannot undo an effect that landed.
        approvalResponses: verdicts.map((verdict) => ({ ...verdict, approved: false })),
      }),
    );
    expect(result).toMatchObject({ status: 'completed', output: 'done' });
    expect(toolMessages(fetch, 1)).toEqual(['charged']);
    expect(effects).toEqual(['charge']);
    expect(verdictWarnings(parts)).toEqual([
      {
        type: 'other',
        setting: 'approvalResponses',
        message:
          'Tool call c1 (charge) already ran, so its recorded outcome answers it; the denial passed for it was ignored.',
      },
    ]);
  });
});

/**
 * The process dies during the model call that follows the save recording
 * `stage` (`<id>:<stage>`; without one, the leg's first save): that call's
 * budget reservation, the first save at a later model step, lands, and every
 * save after it fails.
 */
function diesDuringNextModelCall(inner: AgentRunStore, stage?: string): AgentRunStore {
  let step: number | undefined;
  let dead = false;
  return {
    load: (id) => inner.load(id),
    save(envelope) {
      if (dead) throw new Error('process died');
      if (step === undefined) {
        if (stage === undefined || stages(envelope).includes(stage)) step = envelope.modelSteps;
      } else if (envelope.modelSteps > step) dead = true;
      return inner.save(envelope);
    },
  };
}

describe('the resume settle is recorded before the next model call (2.3)', () => {
  /** An approved `charge` runs in the resume's settle; the process dies during the next model call. */
  async function approvedThenDiedMidCall() {
    const store = createInMemoryAgentRunStore();
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
    const { model, fetch } = counted([chargeCall, { text: 'done' }, { text: 'done' }]);
    const options = { model, prompt: 'charge', tools };
    const session = { store, runId: 'mid-call', scope: 't' };
    const first = await runAgent({ ...options, session });
    expect(first.status).toBe('suspended');
    const verdicts = approveAll(first);
    const crashed = await resumeAgent({
      ...options,
      session: { ...session, store: diesDuringNextModelCall(store, 'c1:completed') },
      approvalResponses: verdicts,
    });
    expect(crashed.status).toBe('failed');
    // The leg reached its next model call, and the stored run is at that step.
    expect(fetch).toHaveBeenCalledTimes(2);
    expect((await store.load('mid-call'))!.modelSteps).toBe(2);
    expect(effects).toEqual(['charge']);
    return { effects, fetch, options, session, verdicts };
  }

  it('answers an approved call with its recorded result, without the verdict', async () => {
    const { effects, fetch, options, session } = await approvedThenDiedMidCall();
    const resumed = await resumeAgent({ ...options, session });
    expect(resumed).toMatchObject({ status: 'completed', output: 'done' });
    expect(toolMessages(fetch, 2)).toEqual(['charged']);
    expect(effects).toEqual(['charge']);
  });

  it('never runs the approved call again when its verdict is passed again', async () => {
    const { effects, fetch, options, session, verdicts } = await approvedThenDiedMidCall();
    const resumed = await resumeAgent({ ...options, session, approvalResponses: verdicts });
    expect(resumed).toMatchObject({ status: 'completed', output: 'done' });
    expect(toolMessages(fetch, 2)).toEqual(['charged']);
    expect(effects).toEqual(['charge']);
  });

  it('never runs an ungated call that waited beside a client call again', async () => {
    const store = createInMemoryAgentRunStore();
    const effects: string[] = [];
    const tools: AgentToolSet = {
      ship: {
        parameters,
        execute: () => {
          effects.push('ship');
          return 'shipped';
        },
      },
      ask: { parameters },
    };
    const { model, fetch } = counted([
      {
        toolCalls: [
          { toolName: 'ship', id: 's1', args: {} },
          { toolName: 'ask', id: 'a1', args: {} },
        ],
      },
      { text: 'done' },
      { text: 'done' },
    ]);
    const options = { model, prompt: 'go', tools };
    const session = { store, runId: 'ungated', scope: 't' };
    // The server call waits for the batch's client call: it runs on the resume.
    expect((await runAgent({ ...options, session })).status).toBe('suspended');
    expect(effects).toEqual([]);
    const crashed = await resumeAgent({
      ...options,
      session: { ...session, store: diesDuringNextModelCall(store, 's1:completed') },
      clientToolResults: [{ toolCallId: 'a1', output: 'yes' }],
    });
    expect(crashed.status).toBe('failed');
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(effects).toEqual(['ship']);
    const resumed = await resumeAgent({ ...options, session });
    expect(resumed).toMatchObject({ status: 'completed', output: 'done' });
    expect(toolMessages(fetch, 2)).toEqual(['shipped', 'yes']);
    expect(effects).toEqual(['ship']);
  });

  it('keeps the model step an idempotent tool keys its write by', async () => {
    const store = createInMemoryAgentRunStore();
    const board = new Map<string, string>();
    const tools: AgentToolSet = {
      note: {
        parameters,
        needsApproval: true,
        replay: 'idempotent',
        execute: (_args, context) => {
          board.set(`${context.toolCallId}@${context.modelStep}`, 'noted');
          return 'noted';
        },
      },
    };
    const { model } = counted([
      { toolCalls: [{ toolName: 'note', id: 'n1', args: {} }] },
      { text: 'done' },
      { text: 'done' },
    ]);
    const options = { model, prompt: 'note', tools };
    const session = { store, runId: 'keyed', scope: 't' };
    const first = await runAgent({ ...options, session });
    const crashed = await resumeAgent({
      ...options,
      session: { ...session, store: diesDuringNextModelCall(store, 'n1:completed') },
      approvalResponses: approveAll(first),
    });
    expect(crashed.status).toBe('failed');
    const resumed = await resumeAgent({
      ...options,
      session,
      approvalResponses: approveAll(first),
    });
    expect(resumed).toMatchObject({ status: 'completed', output: 'done' });
    expect([...board.keys()]).toEqual(['n1@1']);
  });

  it('keeps a denial, so the next resume goes on from it without the verdict', async () => {
    const store = createInMemoryAgentRunStore();
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
    const { model, fetch } = counted([chargeCall, { text: 'lost' }, { text: 'not charged' }]);
    const options = { model, prompt: 'charge', tools };
    const session = { store, runId: 'denied', scope: 't' };
    const first = await runAgent({ ...options, session });
    expect(first.status).toBe('suspended');
    // The denial executes nothing, so no receipt records it: the settle's own
    // save does, before the next model call, during which the process dies.
    const crashed = await resumeAgent({
      ...options,
      session: { ...session, store: diesDuringNextModelCall(store) },
      approvalResponses: approveAll(first).map((verdict) => ({ ...verdict, approved: false })),
    });
    expect(crashed.status).toBe('failed');
    expect(fetch).toHaveBeenCalledTimes(2);
    const stored = (await store.load('denied'))!;
    expect(stored.checkpoints.denied).toMatchObject({ status: 'running' });
    expect(stored.checkpoints.denied!.pendingApprovals).toBeUndefined();
    // No verdict now: the run neither waits for one nor denies the call again.
    const resumed = await resumeAgent({ ...options, session });
    expect(resumed).toMatchObject({ status: 'completed', output: 'not charged' });
    expect(effects).toEqual([]);
    const denials = JSON.stringify(toolMessages(fetch, 2));
    expect(denials).toContain('Tool call denied.');
    expect(denials).not.toContain(DENIED);
  });
});

describe('a call without a recorded outcome is gated as before', () => {
  it('denies a call that never started when the resume has no verdict for it', async () => {
    const effects: string[] = [];
    const tools: AgentToolSet = {
      charge: {
        parameters,
        needsApproval: true,
        execute: (_args, context) => {
          effects.push(context.toolCallId);
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
    const store = createInMemoryAgentRunStore();
    const options = { model, prompt: 'charge twice', tools, maxToolConcurrency: 1 };
    const session = { store, runId: 'two', scope: 't' };
    const first = await runAgent({ ...options, session });
    // c1 runs and records its outcome; the process dies before c2 starts.
    const crashed = await resumeAgent({
      ...options,
      session: { ...session, store: failingAfter(store, 'c1:completed') },
      approvalResponses: approveAll(first),
    });
    expect(crashed.status).toBe('failed');
    expect(stages(await store.load('two'))).toEqual(['c1:completed']);
    const resumed = await resumeAgent({ ...options, session });
    expect(resumed).toMatchObject({ status: 'completed', output: 'done' });
    // c1 is answered from its receipt; c2 is gated exactly as before.
    const all = JSON.stringify(toolMessages(fetch, 1));
    expect(all).toContain('charged c1');
    expect(all).toContain(DENIED);
    expect(effects).toEqual(['c1']);
  });

  it('runs a retried call again only with its verdict', async () => {
    /** The effect lands, and the store fails before its receipt records it. */
    async function unknownEffect(runId: string) {
      const store = createInMemoryAgentRunStore();
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
      const session = { store, runId, scope: 't' };
      const verdicts = approveAll(await runAgent({ ...options, session }));
      let down = false;
      await resumeAgent({
        ...options,
        session: {
          ...session,
          store: {
            load: (id) => store.load(id),
            save(envelope) {
              if (effects.length > 0 && !down) {
                down = true;
                throw new Error('store down');
              }
              return store.save(envelope);
            },
          },
        },
        approvalResponses: verdicts,
      });
      expect(stages(await store.load(runId))).toEqual(['c1:executing']);
      return { effects, fetch, options, session, verdicts };
    }

    const without = await unknownEffect('retry-without');
    expect(
      await resumeAgent({ ...without.options, session: without.session, retryToolCallIds: ['c1'] }),
    ).toMatchObject({ status: 'completed' });
    expect(without.effects).toEqual(['charge']);
    expect(JSON.stringify(toolMessages(without.fetch, 1))).toContain(DENIED);

    const withVerdict = await unknownEffect('retry-with');
    expect(
      await resumeAgent({
        ...withVerdict.options,
        session: withVerdict.session,
        retryToolCallIds: ['c1'],
        approvalResponses: withVerdict.verdicts,
      }),
    ).toMatchObject({ status: 'completed' });
    expect(withVerdict.effects).toEqual(['charge', 'charge']);
    expect(toolMessages(withVerdict.fetch, 1)).toEqual(['charged']);
  });
});

describe('a client tool keeps its rule', () => {
  it('answers a client call only from clientToolResults, also once its result was recorded', async () => {
    const store = createInMemoryAgentRunStore();
    const { model, fetch } = counted([
      { toolCalls: [{ toolName: 'ask', id: 'a1', args: {} }] },
      { text: 'done' },
    ]);
    const options = {
      model,
      prompt: 'ask',
      tools: { ask: { description: 'Ask the user.', parameters } },
    };
    const session = { store, runId: 'client', scope: 't' };
    expect((await runAgent({ ...options, session })).status).toBe('suspended');
    // The resume applies the client's result, and the process dies before the
    // step that answers the call is checkpointed.
    const crashed = await resumeAgent({
      ...options,
      session: { ...session, store: failingAfter(store, 'a1:completed') },
      clientToolResults: [{ toolCallId: 'a1', output: 'blue' }],
    });
    expect(crashed.status).toBe('failed');
    expect(stages(await store.load('client'))).toEqual(['a1:completed']);
    // The resume that took it up cleared the run's pending client calls, so the
    // result cannot be supplied again: that resume fails and writes nothing.
    const before = await store.load('client');
    expect(
      await resumeAgent({
        ...options,
        session,
        clientToolResults: [{ toolCallId: 'a1', output: 'blue' }],
      }),
    ).toMatchObject({
      status: 'failed',
      error: {
        name: 'TypeError',
        message: 'Client tool results must match unique pending call IDs on resume.',
      },
    });
    expect(await store.load('client')).toEqual(before);
    const resumed = await resumeAgent({ ...options, session });
    expect(resumed).toMatchObject({ status: 'completed', output: 'done' });
    expect(toolMessages(fetch, 1)).toEqual([
      'Tool call denied. Reason: No result provided for this client tool.',
    ]);
  });
});
