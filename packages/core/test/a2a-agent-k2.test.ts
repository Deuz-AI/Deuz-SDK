/**
 * Lane B3 wiring test, for packages/core/test/ once BOTH wip/2.3-b1 (K2) and
 * wip/2.3-b3 are merged. It fails on wip/2.3-b3 alone: the engine there drops
 * the run's pending client calls at a resume's first write (K2).
 *
 * The mixed case of W3 review V2-5: a run waits for an approval and a client
 * tool result; the client answers both; the resume leg dies right after the
 * engine's first write (one database behind both stores). With K2 fixed the
 * stored run still lists the client call, so the A2A executor asks for both
 * answers again (pendingOf in src/a2a/agent.ts reads envelope.pendingClientCalls),
 * and the re-sent answers complete the run with the client result applied.
 * Verified in a throwaway merge of both branches on 2026-10-12: passes.
 */
import { describe, it, expect } from 'vitest';
import {
  createA2AAgentExecutor,
  createA2AClient,
  createA2AHandler,
  createInMemoryA2ATaskStore,
  type A2AAgentAction,
  type A2ATask,
  type A2ATaskStore,
} from '../src/a2a';
import {
  createInMemoryAgentRunStore,
  resumeStreamAgent,
  streamAgent,
  type AgentRunStore,
} from '../src/agent';
import { createMockModel } from '../src/testing';

const RPC_URL = 'https://agent.test/a2a/jsonrpc';
const CARD = {
  name: 'Publisher',
  description: 'Writes and publishes posts.',
  version: '1.0.0',
  supportedInterfaces: [{ url: RPC_URL, protocolBinding: 'JSONRPC', protocolVersion: '1.0' }],
  capabilities: { streaming: true },
  defaultInputModes: ['text/plain', 'application/json'],
  defaultOutputModes: ['text/plain', 'application/json'],
  skills: [{ id: 'publish', name: 'Publish', description: 'Publishes posts.', tags: ['posts'] }],
};
const parameters = {
  type: 'object' as const,
  properties: { text: { type: 'string' } },
  additionalProperties: true,
};

describe('createA2AAgentExecutor — a leg that died after its first write, with a client call', () => {
  it('takes the approval and the client result again once the stores are back', async () => {
    const published: unknown[] = [];
    const runs = createInMemoryAgentRunStore();
    let runWritesLeft = Infinity;
    const store: AgentRunStore = {
      load: (runId) => runs.load(runId),
      save: async (envelope) => {
        if (runWritesLeft <= 0) throw new Error('database unavailable');
        runWritesLeft--;
        await runs.save(envelope);
      },
    };
    const tasks = createInMemoryA2ATaskStore();
    let tasksDown = false;
    const taskStore: A2ATaskStore = {
      load: (taskId, scope) => tasks.load(taskId, scope),
      save: (task, scope) => {
        const state = task.status.state;
        if (tasksDown && (state === 'TASK_STATE_WORKING' || state === 'TASK_STATE_FAILED')) {
          throw new Error('database unavailable');
        }
        return tasks.save(task, scope);
      },
    };
    const handler = createA2AHandler({
      card: CARD,
      taskStore,
      onError: () => {},
      executor: createA2AAgentExecutor({
        agent: { streamAgent, resumeStreamAgent },
        store,
        run: {
          model: createMockModel({
            responses: [
              {
                toolCalls: [
                  { toolName: 'publish', args: { text: 'hi' } },
                  { toolName: 'browser', args: {} },
                ],
              },
              { text: 'Done.' },
            ],
          }),
          bindingId: 'publisher-v1',
          tools: {
            publish: {
              description: 'Publish a post.',
              parameters,
              needsApproval: true,
              execute: (args: unknown) => {
                published.push(args);
                return 'published';
              },
            },
            browser: { description: 'Read the page the user has open.', parameters },
          },
        },
      }),
    });
    const fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
      handler(new Request(input, init))) as typeof globalThis.fetch;
    const client = createA2AClient({ url: RPC_URL, binding: 'JSONRPC', deps: { fetch } });

    const asked = (await client.sendMessage('Publish "hi" and read my page.')).task as A2ATask;
    const actions = (asked.status.message?.parts[1]?.data as { actions: A2AAgentAction[] }).actions;
    const approval = actions.find((action) => action.kind === 'approval') as Extract<
      A2AAgentAction,
      { kind: 'approval' }
    >;
    const answer = [
      {
        data: {
          approvalResponses: [{ approvalId: approval.approvalId, approved: true }],
          clientToolResults: [{ toolCallId: 'call_2', output: { title: 'Weather' } }],
        },
      },
    ];

    runWritesLeft = 1;
    tasksDown = true;
    await expect(client.sendMessage(answer, { taskId: asked.id })).rejects.toMatchObject({
      reason: 'INTERNAL_ERROR',
    });
    runWritesLeft = Infinity;
    tasksDown = false;

    // The stored run still waits for both answers.
    const stored = await runs.load(asked.id);
    expect(stored?.phase).toBe('running');
    expect(stored?.result).toBeUndefined();
    expect(stored?.checkpoints[asked.id]?.status).toBe('suspended');
    expect(stored?.pendingClientCalls?.map((call) => call.toolCallId)).toEqual(['call_2']);

    const done = (await client.sendMessage(answer, { taskId: asked.id })).task as A2ATask;
    expect(done.status.state).toBe('TASK_STATE_COMPLETED');
    expect(published).toEqual([{ text: 'hi' }]);
    expect(JSON.stringify((await runs.load(asked.id))?.messages)).toContain('Weather');
  });
});
