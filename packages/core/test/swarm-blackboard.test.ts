import { describe, expect, it } from 'vitest';
import { createAgent } from '../src/agent';
import { createMockModel } from '../src/testing';
import { createInMemorySwarmStore, createSwarm } from '../src/swarm';
import type { AgentToolReceipt } from '../src/types/agent-run';
import type { SwarmOptions, SwarmStore, SwarmTaskRecord } from '../src/types/swarm';

const receipts = (record: SwarmTaskRecord | undefined): AgentToolReceipt[] =>
  Object.values(record?.agentState?.toolResults ?? {});

describe('swarm blackboard (2.2)', () => {
  it('shares notes inside a group and keeps other groups out', async () => {
    const store = createInMemorySwarmStore();
    const scout = createAgent({
      model: createMockModel({
        responses: [
          { toolCalls: [{ toolName: 'blackboard_post', args: { text: 'blowup at t=1' } }] },
          { text: 'posted' },
          { toolCalls: [{ toolName: 'blackboard_read', args: {} }] },
          { text: 'read euler' },
          {
            toolCalls: [
              { toolName: 'blackboard_read', args: {} },
              { toolName: 'blackboard_read', args: { channel: 'euler' } },
            ],
          },
          { text: 'read ns' },
        ],
      }),
    });
    const swarm = createSwarm({
      store,
      concurrency: 1,
      agents: { scout: { agent: scout, blackboard: { read: 'group', post: true } } },
    });
    const outcome = await (
      await swarm.run({
        scope: 'tenant',
        runId: 'groups',
        tasks: [
          { id: 'a', agent: 'scout', prompt: 'Post a finding.', group: 'euler' },
          { id: 'b', agent: 'scout', prompt: 'Read your board.', group: 'euler', dependsOn: ['a'] },
          { id: 'c', agent: 'scout', prompt: 'Read your board.', group: 'ns', dependsOn: ['a'] },
        ],
      })
    ).result;
    expect(outcome.run.status).toBe('completed');
    const notes = await store.readChannel!(outcome.run, 'euler', 0, 10);
    expect(notes.map((note) => [note.sequence, note.taskId, note.text])).toEqual([
      [1, 'a', 'blowup at t=1'],
    ]);
    const [bRead] = receipts(outcome.tasks[1]);
    expect(bRead?.rawResult).toEqual([{ sequence: 1, from: 'a', text: 'blowup at t=1' }]);
    const cReads = receipts(outcome.tasks[2]);
    expect(cReads.map((receipt) => receipt.rawResult)).toEqual([[], undefined]);
    expect(cReads[1]?.stage).toBe('executing');
    const events = [];
    for await (const event of swarm.events(outcome.run)) events.push(event.type);
    expect(events.filter((type) => type === 'channel.posted')).toHaveLength(1);
  });

  it('replays a post interrupted after its commit exactly once', async () => {
    const inner = createInMemorySwarmStore();
    let crash = true;
    const store: SwarmStore = {
      ...inner,
      async commit(change) {
        const executed = change.tasks?.some((task) =>
          receipts(task).some(
            (receipt) => receipt.toolName === 'blackboard_post' && receipt.stage === 'executed',
          ),
        );
        if (crash && executed) throw new Error('crash after the post');
        return inner.commit(change);
      },
    };
    const options: SwarmOptions = {
      store,
      agents: {
        scout: {
          agent: createAgent({
            model: createMockModel({
              responses: [
                { toolCalls: [{ toolName: 'blackboard_post', args: { text: 'once' } }] },
                { text: 'done' },
              ],
            }),
          }),
          blackboard: { post: true },
        },
      },
    };
    const handle = await createSwarm(options).run({
      scope: 'tenant',
      runId: 'replay',
      tasks: [{ id: 'a', agent: 'scout', prompt: 'Post once.', replay: 'safe' }],
    });
    await expect(handle.result).rejects.toThrow('crash after the post');
    crash = false;
    const recovered = await (await createSwarm(options).resume(handle)).result;
    expect(recovered.tasks[0]?.status).toBe('completed');
    expect((await inner.readChannel!(handle, 'main', 0, 10)).map((note) => note.text)).toEqual([
      'once',
    ]);
    const events = await inner.readEvents(handle, 0, 100);
    expect(events.filter((event) => event.type === 'channel.posted')).toHaveLength(1);
  });

  it('lets reducers page through a channel', async () => {
    const swarm = createSwarm({
      store: createInMemorySwarmStore(),
      agents: {
        scout: {
          agent: createAgent({
            model: createMockModel({
              responses: [
                {
                  toolCalls: [
                    { toolName: 'blackboard_post', args: { text: 'one' } },
                    { toolName: 'blackboard_post', args: { text: 'two', data: { n: 2 } } },
                  ],
                },
                { text: 'done' },
              ],
            }),
          }),
          blackboard: { post: true },
        },
      },
      reducers: {
        collect: {
          async execute(_results, context) {
            const first = await context.readChannel('euler', 0, 1);
            const rest = await context.readChannel('euler', first[0]!.sequence);
            return [...first, ...rest].map((note) => [note.text, note.data ?? null]);
          },
        },
      },
    });
    const outcome = await (
      await swarm.run({
        scope: 'tenant',
        tasks: [
          { id: 'a', agent: 'scout', prompt: 'Post twice.', group: 'euler' },
          { id: 'b', reducer: 'collect', dependsOn: ['a'] },
        ],
      })
    ).result;
    expect(outcome.tasks[1]?.result?.output).toEqual([
      ['one', null],
      ['two', { n: 2 }],
    ]);
  });

  it('refuses blackboard bindings on a store without channels and rejects bad groups', async () => {
    const { capabilities: _capabilities, ...plain } = createInMemorySwarmStore();
    const scout = createAgent({ model: createMockModel({ responses: [] }) });
    expect(() =>
      createSwarm({
        store: plain,
        agents: { scout: { agent: scout, blackboard: { post: true } } },
      }),
    ).toThrow(/channels/);
    const swarm = createSwarm({ store: createInMemorySwarmStore(), agents: { scout } });
    await expect(
      swarm.run({
        scope: 'tenant',
        tasks: [{ id: 'a', agent: 'scout', prompt: 'x', group: 'bad group' }],
      }),
    ).rejects.toThrow(/group/);
  });
});
