/**
 * Faults at what a native run writes after its checkpoint (2.3, 23.4): its
 * chat projection and its memory extraction (native-agents.mdx, "Chat
 * projection" and "Memory"). The checkpoint is the canonical record; the chat
 * store and the memory store are written after it, never in one transaction,
 * and `reconcileAgentRun` settles what an outage or a crash left behind.
 */
import {
  createInMemoryAgentRunStore,
  reconcileAgentRun,
  resumeAgent,
  runAgent,
} from '../../../src/agent-run';
import { createInMemoryChatStore, type ChatRecord, type ChatStore } from '../../../src/chat';
import type { AgentRunStore } from '../../../src/types/agent-run';
import type { Message } from '../../../src/types/message';
import type { EvalTaskContext, EvalTaskManifest } from '../../../src/testing';
import {
  MOCK,
  costKept,
  mockPrices,
  parameters,
  ranOnce,
  scripted,
  watchedMemory,
} from './support';

const ADA = { userId: 'ada' };

/** A chat store that is down for its next write, then healthy; it keeps every write that landed. */
function chatsDownOnce(context: EvalTaskContext, boundary: string) {
  const inner = createInMemoryChatStore();
  const writes: ChatRecord[] = [];
  let down = true;
  const store: ChatStore = {
    loadChat: (chatId) => inner.loadChat(chatId),
    saveChat: (record) => {
      if (down) {
        down = false;
        context.interrupt(boundary);
        throw new Error('chat database unavailable');
      }
      writes.push(structuredClone(record));
      return inner.saveChat(record);
    },
  };
  return { store, inner, writes };
}

const textOf = (message: Message): string =>
  typeof message.content === 'string'
    ? message.content
    : message.content
        .filter((part) => part.type === 'text')
        .map((part) => (part as { text: string }).text)
        .join('');

export const chatProjectionRepair: EvalTaskManifest = {
  id: 'fault/chat-projection-repair',
  version: 1,
  title: "The chat store fails the run's projection after the run completed; it is reconciled",
  tags: ['fault', 'native', 'chat'],
  model: MOCK,
  start: { messages: [{ role: 'user', content: 'Book the 9:40 train to Ankara.' }] },
  // Documented (native-agents.mdx, Chat projection): a chat store that throws
  // never fails the run, which records the failed projection with its cursor
  // left behind; `reconcileAgentRun` writes the whole record again, once.
  fault: { boundary: 'chat-projection', recovery: 'projection-reconciled' },
  acceptance: [
    { name: 'completes', check: (outcome) => outcome.status === 'completed' },
    ranOnce('book:train-0940'),
    {
      name: 'the run recorded the failed projection and kept its checkpoint',
      check: (_outcome, context) =>
        JSON.stringify(context.store.left) ===
        JSON.stringify({ result: 'completed', chat: 'failed', cursor: 0, stored: false }),
    },
    {
      name: 'the repair wrote the whole transcript, with stable ids and the tool call mapped',
      check: (outcome, context) => {
        const record = context.store.record as ChatRecord | undefined;
        return (
          context.store.repair === 'saved' &&
          JSON.stringify(record?.messages) ===
            JSON.stringify((outcome as { messages?: unknown }).messages) &&
          JSON.stringify(record?.messageIds) ===
            JSON.stringify(['trip-1:0', 'trip-1:1', 'trip-1:2', 'trip-1:3']) &&
          JSON.stringify(context.store.chat) ===
            JSON.stringify({
              status: 'saved',
              cursor: 4,
              invocations: [
                { toolCallId: 'b1', modelStep: 1, messageId: 'trip-1:1', resultId: 'trip-1:2' },
              ],
            })
        );
      },
    },
    {
      name: 'a settled projection is not written again',
      check: (_outcome, context) =>
        context.store.again === 'current' && context.store.chatWrites === 1,
    },
    costKept,
  ],
  async run(context) {
    const chats = chatsDownOnce(context, 'chat-projection');
    const runs = createInMemoryAgentRunStore();
    const { model, calls } = scripted([
      { toolCalls: [{ toolName: 'book', id: 'b1', args: {} }] },
      { text: 'Booked the 9:40 train to Ankara.' },
    ]);
    const chat = { store: chats.store, chatId: 'chat-ada', scope: ADA };
    const session = { store: runs, runId: 'trip-1', scope: 'eval' };
    const result = await runAgent({
      model,
      messages: context.messages,
      chat,
      session,
      tools: {
        book: {
          description: 'Book a train.',
          parameters,
          execute: () => {
            context.effect('book:train-0940');
            ((context.store.effects as string[] | undefined) ??= []).push('book:train-0940');
            return 'booked';
          },
        },
      },
      deps: { observer: context.observer, priceProvider: mockPrices },
    });
    const left = (await runs.load('trip-1'))!;
    context.store.left = {
      result: left.result?.status,
      chat: left.chat?.status,
      cursor: left.chat?.cursor,
      stored: (await chats.inner.loadChat('chat-ada')) !== undefined,
    };
    // Once the chat database is back, the application settles the run.
    const repaired = await reconcileAgentRun({ session, chat });
    context.store.repair = repaired.chat;
    context.store.record = structuredClone(await chats.inner.loadChat('chat-ada'));
    const settled = (await runs.load('trip-1'))!.chat;
    context.store.chat = {
      status: settled?.status,
      cursor: settled?.cursor,
      invocations: settled?.invocations,
    };
    context.store.again = (await reconcileAgentRun({ session, chat })).chat;
    context.store.chatWrites = chats.writes.length;
    context.store.billedCalls = calls();
    return {
      ...result,
      recovery:
        left.chat?.status === 'failed' && repaired.chat === 'saved' && calls() === 2
          ? 'projection-reconciled'
          : 'other',
    };
  },
};

export const chatProjectionSuperseded: EvalTaskManifest = {
  id: 'fault/chat-projection-superseded',
  version: 1,
  title: 'A late repair finds the chat moved on without the run: it overwrites nothing',
  tags: ['fault', 'native', 'chat'],
  model: MOCK,
  start: {
    messages: [{ role: 'user', content: 'Which platform does the 9:40 train leave from?' }],
  },
  // Documented (native-agents.mdx, Chat projection): a late repair never
  // overwrites a chat that moved on without the run. The run records
  // 'superseded', `reconcileAgentRun` reports it, the run's turns stay in its
  // checkpoint, and no later repair tries again. The repair stands down, so
  // the run's projection never lands: contained.
  fault: { boundary: 'chat-projection', recovery: 'superseded-left-alone' },
  acceptance: [
    {
      name: 'the late repair stood down as superseded',
      check: (outcome, context) =>
        outcome.status === 'stopped' &&
        context.store.repair === 'superseded' &&
        context.store.runA === 'completed',
    },
    {
      name: 'the newer chat record is left as the later run saved it',
      check: (_outcome, context) =>
        context.store.chatAfterRepair === context.store.chatAfterB &&
        JSON.stringify(context.store.chatTexts) ===
          JSON.stringify(['Is there a later train?', 'Yes, at 11:10.']),
    },
    {
      name: "the first run's turns stay in its checkpoint",
      check: (_outcome, context) =>
        JSON.stringify(context.store.transcriptA) ===
          JSON.stringify(['Which platform does the 9:40 train leave from?', 'Platform 4.']) &&
        context.store.chatStateA === 'superseded',
    },
    {
      name: 'no later repair writes again',
      check: (_outcome, context) =>
        context.store.again === 'current' && context.store.chatWrites === 1,
    },
    costKept,
  ],
  async run(context) {
    const chats = chatsDownOnce(context, 'chat-projection');
    const runs = createInMemoryAgentRunStore();
    const chat = { store: chats.store, chatId: 'chat-ada', scope: ADA };
    const first = scripted([{ text: 'Platform 4.' }]);
    const sessionA = { store: runs, runId: 'run-a', scope: 'eval' };
    const a = await runAgent({
      model: first.model,
      messages: context.messages,
      chat,
      session: sessionA,
      deps: { observer: context.observer, priceProvider: mockPrices },
    });
    // The user goes on from what the chat store holds, without run A's turns.
    const second = scripted([{ text: 'Yes, at 11:10.' }]);
    const b = await runAgent({
      model: second.model,
      messages: [
        ...((await chats.inner.loadChat('chat-ada'))?.messages ?? []),
        { role: 'user', content: 'Is there a later train?' },
      ],
      chat,
      session: { store: runs, runId: 'run-b', scope: 'eval' },
      deps: { observer: context.observer, priceProvider: mockPrices },
    });
    const afterB = JSON.stringify(await chats.inner.loadChat('chat-ada'));
    // Later, the application repairs run A's projection.
    const repaired = await reconcileAgentRun({ session: sessionA, chat });
    const storedA = (await runs.load('run-a'))!;
    context.store.runA = a.status;
    context.store.runB = b.status;
    context.store.repair = repaired.chat;
    context.store.chatAfterB = afterB;
    context.store.chatAfterRepair = JSON.stringify(await chats.inner.loadChat('chat-ada'));
    context.store.chatTexts = (await chats.inner.loadChat('chat-ada'))?.messages.map(textOf);
    context.store.transcriptA = storedA.transcript?.messages.map(textOf);
    context.store.chatStateA = storedA.chat?.status;
    context.store.again = (await reconcileAgentRun({ session: sessionA, chat })).chat;
    context.store.chatWrites = chats.writes.length;
    // Run A's calls are billed to run A; run B keeps its own accounting.
    context.store.billedCalls = first.calls();
    return {
      // The outcome is the repair's: it stopped without writing run A's turns.
      status: 'stopped',
      reason: 'chat-projection-superseded',
      ...(a.accounting ? { accounting: a.accounting } : {}),
      recovery:
        a.status === 'completed' && b.status === 'completed' && repaired.chat === 'superseded'
          ? 'superseded-left-alone'
          : 'other',
    };
  },
};

export const memoryWriteCheckpointFailure: EvalTaskManifest = {
  id: 'fault/memory-write-checkpoint-failure',
  version: 1,
  title: 'The memory write lands, then the save that records it fails',
  tags: ['fault', 'native', 'memory'],
  model: MOCK,
  start: { messages: [{ role: 'user', content: 'I always take a window seat.' }] },
  // Documented (native-agents.mdx, Memory): the terminal commit records the
  // extraction as pending before anything is written to memory; a terminal
  // resume never extracts again or calls a model; `reconcileAgentRun` finds
  // the operation's records and settles it without another memory LLM call.
  fault: { boundary: 'memory-write', recovery: 'extraction-reconciled' },
  acceptance: [
    { name: 'completes', check: (outcome) => outcome.status === 'completed' },
    {
      name: "the fact was written once, under the run's operation",
      check: (_outcome, context) =>
        JSON.stringify(context.store.facts) ===
        JSON.stringify([{ text: 'prefers window seats', runId: 'seat-1', ofOperation: true }]),
    },
    {
      name: 'the failed save left the extraction pending in the checkpoint',
      check: (_outcome, context) =>
        JSON.stringify(context.store.left) ===
        JSON.stringify({ result: 'completed', extraction: 'pending' }),
    },
    {
      name: 'the resume neither called a model nor extracted again',
      check: (_outcome, context) =>
        JSON.stringify(context.store.resumed) ===
        JSON.stringify({ status: 'completed', modelCalls: 1, memoryLlmCalls: 2, writes: 1 }),
    },
    {
      name: 'reconcileAgentRun settled it without another memory LLM call',
      check: (_outcome, context) =>
        JSON.stringify(context.store.reconciled) ===
        JSON.stringify({ memory: 'completed', mutations: 1, memoryLlmCalls: 2, writes: 1 }),
    },
    costKept,
  ],
  async run(context) {
    const memory = await watchedMemory([], ['prefers window seats']);
    // Every record written to the user's memory is a real-world effect.
    const upsert = memory.seams.store.upsert;
    memory.seams.store.upsert = (records) => {
      for (const record of records) context.effect(`memory:${record.text}`);
      return upsert(records);
    };
    const durable = createInMemoryAgentRunStore();
    let failed = false;
    // The save that records the extraction's outcome fails, as when the
    // process dies right after the memory write.
    const store: AgentRunStore = {
      load: (runId) => durable.load(runId),
      save(envelope) {
        if (!failed && envelope.memory?.extraction?.status === 'completed') {
          failed = true;
          context.interrupt('memory-write');
          throw new Error('disk full');
        }
        return durable.save(envelope);
      },
    };
    const { model, calls } = scripted([{ text: 'Noted: window seats from now on.' }]);
    const options = {
      model,
      messages: context.messages,
      memory: { seams: memory.seams, scope: ADA },
      deps: { observer: context.observer, priceProvider: mockPrices },
    };
    const result = await runAgent({
      ...options,
      session: { store, runId: 'seat-1', scope: 'eval' },
    });
    const left = (await durable.load('seat-1'))!;
    context.store.left = {
      result: left.result?.status,
      extraction: left.memory?.extraction?.status,
    };
    // The next process finds the run ended: a terminal resume.
    const session = { store: durable, runId: 'seat-1', scope: 'eval' };
    const resumed = await resumeAgent({ ...options, session });
    context.store.resumed = {
      status: resumed.status,
      modelCalls: calls(),
      memoryLlmCalls: memory.llmCalls(),
      writes: memory.writes.length,
    };
    const reconciled = await reconcileAgentRun({ session, memory: options.memory });
    const extraction = (await durable.load('seat-1'))?.memory?.extraction;
    context.store.reconciled = {
      memory: reconciled.memory,
      mutations: extraction?.mutations,
      memoryLlmCalls: memory.llmCalls(),
      writes: memory.writes.length,
    };
    context.store.facts = (await memory.store.list(ADA)).map((record) => {
      const deuz = (record.metadata?.deuz ?? {}) as { runId?: string; operationId?: string };
      return {
        text: record.text,
        runId: deuz.runId,
        ofOperation: deuz.operationId === extraction?.operationId,
      };
    });
    context.store.billedCalls = calls();
    return {
      ...result,
      recovery:
        left.memory?.extraction?.status === 'pending' && reconciled.memory === 'completed'
          ? 'extraction-reconciled'
          : 'other',
    };
  },
};
