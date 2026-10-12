/**
 * native-envelope-version.test.ts (2.3, W3 K1) — which native envelopes a 2.2
 * process may resume.
 *
 * 2.2.0 resumes `version: 1` and refuses any other version with "Native
 * checkpoint version, identity, or scope mismatch." before it writes anything.
 * Besides the state it would silently ignore (memory, transcript, chat,
 * fail-over), a save writes version 2 while the stored turn has an open call a
 * 2.2 resume would answer wrongly, and version 1 again once a checkpoint
 * answers it:
 * - its receipt records `failed`: 2.2 does not know the stage, replays the
 *   receipt's undefined raw result as the call's output and records it
 *   completed;
 * - its receipt is `suspended`: 2.2 looks the sub-agent's checkpoint up without
 *   the model step 2.3 keys it by, and starts the sub-agent over;
 * - it is a client call a resume took up and still waits on: 2.2 waits for a
 *   client result only while the run is suspended, and denies the call.
 * The published 2.2.0 package was checked against these envelopes once (lane
 * notes); this file pins what 2.3 writes.
 */
import { describe, expect, it } from 'vitest';
import { createInMemoryAgentRunStore, resumeAgent, runAgent } from '../src/agent-run';
import { agentTool } from '../src/inference/agent-tool';
import { createMockModel, type MockResponse } from '../src/testing';
import type { AgentRunEnvelope, AgentRunStore, AgentToolSet } from '../src/types/agent-run';

const parameters = { type: 'object' as const, properties: {} };
const chargeCall: MockResponse = { toolCalls: [{ toolName: 'charge', id: 'c1', args: {} }] };

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

/** Every version the store was given, in order. */
function recordingVersions(inner: AgentRunStore) {
  const versions: number[] = [];
  const store: AgentRunStore = {
    load: (id) => inner.load(id),
    save(envelope) {
      versions.push(envelope.version);
      return inner.save(envelope);
    },
  };
  return { store, versions };
}

const approveAll = (result: Awaited<ReturnType<typeof runAgent>>) =>
  result.status === 'suspended'
    ? result.pendingApprovals.map((request) => ({ approvalId: request.approvalId, approved: true }))
    : [];

describe('native envelope versions for a 2.2 reader (2.3)', () => {
  it('writes a call that failed and is left open as version 2, until a checkpoint answers it', async () => {
    const store = createInMemoryAgentRunStore();
    const tools: AgentToolSet = {
      charge: {
        parameters,
        execute: () => {
          throw new Error('card declined');
        },
      },
    };
    const options = {
      model: createMockModel({ responses: [chargeCall, { text: 'declined' }] }),
      prompt: 'charge',
      tools,
    };
    const session = { store, runId: 'failed', scope: 't' };
    // The process dies before the step that answers the call is saved.
    const crashed = await runAgent({
      ...options,
      session: { ...session, store: failingAfter(store, 'c1:failed') },
    });
    expect(crashed.status).toBe('failed');
    const open = (await store.load('failed'))!;
    expect(stages(open)).toEqual(['c1:failed']);
    expect(open.version).toBe(2);
    // The resume answers the call with its recorded error; from then on a 2.2
    // reader never consults that receipt again, so the run is version 1.
    const { store: watched, versions } = recordingVersions(store);
    const resumed = await resumeAgent({ ...options, session: { ...session, store: watched } });
    expect(resumed).toMatchObject({ status: 'completed', output: 'declined' });
    expect(versions[0]).toBe(2);
    expect(versions.at(-1)).toBe(1);
    const done = (await store.load('failed'))!;
    expect(stages(done)).toEqual(['c1:failed']);
    expect(done.version).toBe(1);
  });

  it('writes a sub-agent call left open as version 2', async () => {
    const child = createMockModel({
      responses: [{ toolCalls: [{ toolName: 'pay', id: 'p1', args: {} }] }, { text: 'paid' }],
    });
    const options = {
      model: createMockModel({
        responses: [
          { toolCalls: [{ toolName: 'worker', id: 'w1', args: { prompt: 'pay' } }] },
          { text: 'done' },
        ],
      }),
      prompt: 'pay',
      tools: {
        worker: agentTool({
          name: 'worker',
          description: 'Pays.',
          model: child,
          tools: { pay: { parameters, needsApproval: true, execute: () => 'paid' } },
        }),
      },
      session: { store: createInMemoryAgentRunStore(), runId: 'child', scope: 't' },
    };
    const first = await runAgent(options);
    expect(first.status).toBe('suspended');
    const stored = (await options.session.store.load('child'))!;
    expect(stages(stored)).toEqual(['w1:suspended']);
    expect(stored.version).toBe(2);
    const resumed = await resumeAgent({ ...options, approvalResponses: approveAll(first) });
    expect(resumed).toMatchObject({ status: 'completed', output: 'done' });
    expect((await options.session.store.load('child'))!.version).toBe(1);
  });

  it('writes a client call a resume took up as version 2 until its result is saved', async () => {
    const store = createInMemoryAgentRunStore();
    const options = {
      model: createMockModel({
        responses: [
          {
            toolCalls: [
              { toolName: 'ship', id: 's1', args: {} },
              { toolName: 'ask', id: 'a1', args: {} },
            ],
          },
          { text: 'done' },
        ],
      }),
      prompt: 'ship and ask',
      maxToolConcurrency: 1,
      tools: {
        ship: { parameters, execute: () => 'shipped' },
        ask: { description: 'Ask the user.', parameters },
      },
    };
    const session = { store, runId: 'client', scope: 't' };
    // Suspended on the client call: 2.2 waits for its result too.
    expect((await runAgent({ ...options, session })).status).toBe('suspended');
    expect((await store.load('client'))!.version).toBe(1);
    // The resume runs ship, then dies before the client result is recorded.
    const crashed = await resumeAgent({
      ...options,
      session: { ...session, store: failingAfter(store, 's1:completed') },
      clientToolResults: [{ toolCallId: 'a1', output: 'blue' }],
    });
    expect(crashed.status).toBe('failed');
    const open = (await store.load('client'))!;
    expect(open.checkpoints.client!.status).toBe('running');
    expect(open.pendingClientCalls).toEqual([expect.objectContaining({ toolCallId: 'a1' })]);
    expect(open.version).toBe(2);
    const resumed = await resumeAgent({
      ...options,
      session,
      clientToolResults: [{ toolCallId: 'a1', output: 'blue' }],
    });
    expect(resumed).toMatchObject({ status: 'completed', output: 'done' });
    expect((await store.load('client'))!.version).toBe(1);
  });

  it('keeps version 1 for an open turn a 2.2 resume settles the same way', async () => {
    const store = createInMemoryAgentRunStore();
    const effects: string[] = [];
    const options = {
      model: createMockModel({ responses: [chargeCall, { text: 'charged' }] }),
      prompt: 'charge',
      tools: {
        charge: {
          parameters,
          execute: () => {
            effects.push('charge');
            return 'ok';
          },
        },
      },
    };
    const session = { store, runId: 'replayed', scope: 't' };
    // The call completed; the process dies before the step is saved. Any
    // resume, a 2.2 one included, answers it from its completed receipt.
    const crashed = await runAgent({
      ...options,
      session: { ...session, store: failingAfter(store, 'c1:completed') },
    });
    expect(crashed.status).toBe('failed');
    const open = (await store.load('replayed'))!;
    expect(open.messages.at(-1)?.role).toBe('assistant');
    expect(open.version).toBe(1);
    expect(await resumeAgent({ ...options, session })).toMatchObject({ status: 'completed' });
    expect(effects).toEqual(['charge']);
  });
});
