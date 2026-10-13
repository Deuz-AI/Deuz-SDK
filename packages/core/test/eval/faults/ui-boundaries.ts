/**
 * The UI bridge's disconnect and replay (2.3, 23.5): a native run streamed by
 * `toDeuzAgentStreamResponse` into a stream journal loses its client in the
 * middle of a leg; a second tab tries to resume the running run; the client
 * comes back with its cursor while the leg still runs (ui-streaming.mdx,
 * "Native agent runs" and "Server: resumeDeuzStreamResponse").
 */
import {
  createInMemoryAgentRunStore,
  resumeStreamAgent,
  streamAgent,
} from '../../../src/agent-run';
import { createDeferred } from '../../../src/internal/async-iter';
import {
  agentStateFromParts,
  createInMemoryStreamStateStore,
  readDeuzStream,
  resumeDeuzStreamResponse,
  toDeuzAgentStreamResponse,
  type DeuzUIPart,
} from '../../../src/ui';
import type { EvalTaskManifest } from '../../../src/testing';
import { MOCK, costKept, mockPrices, parameters, ranOnce, scripted } from './support';

/**
 * Read a Deuz stream, each part with its event id. `each` sees every part and
 * the count so far; `'stop'` hangs up, and the reader cancels the body.
 */
async function read(
  response: Response,
  each: (part: DeuzUIPart, count: number) => 'stop' | void = () => {},
): Promise<{ id?: number; part: DeuzUIPart }[]> {
  const seen: { id?: number; part: DeuzUIPart }[] = [];
  let id: string | undefined;
  for await (const part of readDeuzStream(response, { onEventId: (value) => (id = value) })) {
    seen.push({ ...(id !== undefined ? { id: Number(id) } : {}), part });
    id = undefined;
    if (each(part, seen.length) === 'stop') break;
  }
  return seen;
}

export const uiDisconnectReplay: EvalTaskManifest = {
  id: 'fault/ui-disconnect-replay',
  version: 1,
  title: 'The client of a journaled native UI stream drops mid-leg and reconnects with its cursor',
  tags: ['fault', 'native', 'ui', 'replay'],
  model: MOCK,
  start: { messages: [{ role: 'user', content: 'Publish doc 7.' }] },
  // Documented (ui-streaming.mdx): the journal keeps recording when the client
  // goes; a reconnect replays every frame after its cursor and follows the
  // live leg to its end; a leg the run refused goes out on its own response,
  // without event ids, and writes nothing to the journal.
  fault: { boundary: 'ui-disconnect-replay', recovery: 'replayed-from-cursor' },
  acceptance: [
    { name: 'the run completes', check: (outcome) => outcome.status === 'completed' },
    ranOnce('publish:doc-7'),
    {
      name: 'the client got every journaled frame once, in order',
      check: (_outcome, context) =>
        context.store.clientFrames === context.store.journalFrames &&
        JSON.stringify(context.store.clientIds) === JSON.stringify(context.store.journalIds),
    },
    {
      name: 'the reconnect replayed what the client missed, then followed the leg live',
      check: (_outcome, context) => {
        const reconnect = context.store.reconnect as { missed: number; followed: number };
        return reconnect.missed > 0 && reconnect.followed > 0;
      },
    },
    {
      name: "the client's state is the run's terminal state",
      check: (_outcome, context) =>
        JSON.stringify(context.store.clientState) ===
        JSON.stringify({ status: 'completed', output: 'Published doc 7.' }),
    },
    {
      name: 'the refused resume went out on its own response and left the journal alone',
      check: (_outcome, context) =>
        JSON.stringify(context.store.refused) ===
        JSON.stringify({
          status: 'failed',
          message: 'This native run already has an active executor.',
          eventIds: 0,
          journalChanged: false,
        }),
    },
    costKept,
  ],
  async run(context) {
    const runs = createInMemoryAgentRunStore();
    const streams = createInMemoryStreamStateStore();
    const entered = createDeferred<void>();
    const release = createDeferred<void>();
    const { model, calls } = scripted([
      { toolCalls: [{ toolName: 'publish', id: 'p1', args: {} }] },
      { text: 'Published doc 7.' },
    ]);
    const options = {
      model,
      messages: context.messages,
      session: { store: runs, runId: 'run-ui', scope: 'eval' },
      tools: {
        publish: {
          description: 'Publish a document.',
          parameters,
          execute: async () => {
            entered.resolve();
            await release.promise; // the leg is in flight while the client is away
            context.effect('publish:doc-7');
            ((context.store.effects as string[] | undefined) ??= []).push('publish:doc-7');
            return 'published';
          },
        },
      },
      deps: { observer: context.observer, priceProvider: mockPrices },
    };
    // One journal per run, under its run id.
    const wire = { store: streams, streamId: 'run-ui', runId: 'run-ui', messageId: 'msg-1' };
    const journal = async () => {
      const records: { seq: number; part: string }[] = [];
      for await (const record of streams.read('run-ui'))
        if (record.part.type !== 'done')
          records.push({ seq: record.seq, part: JSON.stringify(record.part) });
      return records;
    };

    const stream = streamAgent(options);
    const live = toDeuzAgentStreamResponse(stream, wire);
    // The client reads until the run calls the tool, then its connection drops.
    const before = await read(live, (part) => (part.type === 'tool-call' ? 'stop' : undefined));
    await entered.promise;
    context.interrupt('ui-disconnect-replay');

    // Another tab resumes the same run while it executes.
    const journaled = await journal();
    let eventIds = 0;
    const refusedParts: DeuzUIPart[] = [];
    for await (const part of readDeuzStream(
      toDeuzAgentStreamResponse(resumeStreamAgent(options), wire),
      { onEventId: () => (eventIds += 1) },
    ))
      refusedParts.push(part);
    const refusedState = agentStateFromParts(refusedParts);
    context.store.refused = {
      status: refusedState.status,
      message: refusedState.status === 'failed' ? refusedState.error.message : undefined,
      eventIds,
      journalChanged: JSON.stringify(await journal()) !== JSON.stringify(journaled),
    };

    // The client comes back with the cursor it had, while the tool still runs:
    // it catches up on what was journaled meanwhile, then the leg goes on.
    const cursor = before.at(-1)?.id;
    const missed = journaled.filter((record) => record.seq > (cursor ?? -1)).length;
    const caughtUp = createDeferred<void>();
    if (missed === 0) caughtUp.resolve();
    const reconnect = read(
      resumeDeuzStreamResponse(streams, 'run-ui', {
        lastEventId: cursor ?? null,
        pollIntervalMs: 1,
        idleTimeoutMs: 5_000,
      }),
      (_part, count) => {
        if (count === missed) caughtUp.resolve();
      },
    );
    await caughtUp.promise;
    release.resolve();
    const result = await stream.result;
    const after = await reconnect;

    const client = [...before, ...after];
    const records = await journal();
    context.store.clientIds = client.map((entry) => entry.id);
    context.store.journalIds = records.map((record) => record.seq);
    context.store.clientFrames = JSON.stringify(client.map((entry) => entry.part));
    context.store.journalFrames = JSON.stringify(records.map((record) => JSON.parse(record.part)));
    context.store.reconnect = { missed, followed: after.length - missed };
    const state = agentStateFromParts(client.map((entry) => entry.part));
    context.store.clientState = {
      status: state.status,
      output: state.status === 'completed' ? state.output : undefined,
    };
    context.store.billedCalls = calls();
    return {
      ...result,
      recovery:
        cursor !== undefined && after.length > 0 && after[0]!.id === cursor + 1
          ? 'replayed-from-cursor'
          : 'other',
    };
  },
};
