/**
 * native-chat.test.ts (2.3, 23.4) — a native run's chat projection: the run's
 * transcript written to the ChatStore AFTER its canonical checkpoint, with
 * stable message ids and the run / turn / tool-invocation mapping recorded in
 * the envelope; a failed write never fails the run and is repaired by the next
 * save, a resume or `reconcileAgentRun`; a resume never appends twice.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  createInMemoryAgentRunStore,
  reconcileAgentRun,
  resumeAgent,
  runAgent,
  streamAgent,
} from '../src/agent-run';
import { createInMemoryChatStore, type ChatRecord, type ChatStore } from '../src/chat';
import { createAnthropic } from '../src/anthropic';
import { createMockModel, type MockResponse } from '../src/testing';
import { readConfig } from '../src/internal/config-symbol';
import type {
  AgentEvent,
  AgentRunEnvelope,
  AgentRunOptions,
  AgentRunSession,
  AgentRunStore,
} from '../src/types/agent-run';
import type { Message } from '../src/types/message';
import { claudeTurn, scriptedFetch } from './fixtures/wire-turns';

const parameters = { type: 'object', properties: {} };
type Resumable = AgentRunOptions & { session: AgentRunSession };

function mocked(responses: MockResponse[]) {
  const model = createMockModel({ responses });
  const config = readConfig(model)!;
  const fetch = vi.fn(config.fetch!);
  config.fetch = fetch;
  return { model, fetch };
}

/** A chat store whose writes can be made to fail, recording when each landed. */
function chatStore() {
  const inner = createInMemoryChatStore();
  let failures = 0;
  const writes: ChatRecord[] = [];
  const store: ChatStore = {
    loadChat: (id) => inner.loadChat(id),
    saveChat: (record) => {
      if (failures > 0) {
        failures--;
        throw new Error('chat db unavailable');
      }
      writes.push(structuredClone(record));
      return inner.saveChat(record);
    },
  };
  return {
    store,
    inner,
    writes,
    failNext: (n = 1) => {
      failures = n;
    },
  };
}

function runStore() {
  const inner = createInMemoryAgentRunStore();
  const saves: AgentRunEnvelope[] = [];
  const store: AgentRunStore = {
    load: inner.load,
    save: async (envelope) => {
      await inner.save(envelope);
      saves.push(structuredClone(envelope));
    },
  };
  return { store, inner, saves };
}

const roles = (messages: Message[]) => messages.map((message) => message.role);
const approval = (result: Awaited<ReturnType<typeof runAgent>>) =>
  result.status === 'suspended' ? result.pendingApprovals[0]!.approvalId : '';

describe('native chat projection', () => {
  it('writes the transcript after the checkpoint, with stable ids and the tool mapping', async () => {
    const chat = chatStore();
    const runs = runStore();
    const order: string[] = [];
    const store: AgentRunStore = {
      load: runs.store.load,
      save: async (envelope) => {
        await runs.store.save(envelope);
        order.push(`run:${envelope.phase}`);
      },
    };
    const saveChat = chat.store.saveChat;
    chat.store.saveChat = (record) => {
      order.push('chat');
      return saveChat(record);
    };
    const result = await runAgent({
      model: mocked([
        { toolCalls: [{ toolName: 'lookup', id: 'c1', args: {} }] },
        { text: 'found' },
      ]).model,
      prompt: 'look it up',
      chat: { store: chat.store, chatId: 'chat-1', scope: { userId: 'ada' } },
      session: { store, runId: 'projected', scope: 'tenant' },
      tools: { lookup: { parameters, execute: () => 'the answer' } },
    });
    expect(result.status).toBe('completed');
    // Canonical commit first, the projection after, its acknowledgement last.
    expect(order.slice(-3)).toEqual(['run:terminal', 'chat', 'run:terminal']);
    const record = (await chat.inner.loadChat('chat-1'))!;
    expect(roles(record.messages)).toEqual(['user', 'assistant', 'tool', 'assistant']);
    expect(record.messages).toEqual(result.messages);
    expect(record.messageIds).toEqual(['projected:0', 'projected:1', 'projected:2', 'projected:3']);
    const envelope = (await runs.inner.load('projected'))!;
    expect(envelope.version).toBe(2);
    expect(envelope.chat).toEqual({
      chatId: 'chat-1',
      cursor: 4,
      messageIds: record.messageIds,
      turns: ['projected:1', 'projected:3'],
      invocations: [
        { toolCallId: 'c1', modelStep: 1, messageId: 'projected:1', resultId: 'projected:2' },
      ],
      status: 'saved',
    });
  });

  it('a resume never appends a message twice and keeps every id', async () => {
    const chat = chatStore();
    const options: Resumable = {
      model: mocked([{ toolCalls: [{ toolName: 'gate', id: 'g1', args: {} }] }, { text: 'done' }])
        .model,
      prompt: 'gated',
      chat: { store: chat.store, chatId: 'chat-2', scope: { userId: 'ada' } },
      session: { store: createInMemoryAgentRunStore(), runId: 'twice', scope: 'tenant' },
      tools: { gate: { parameters, needsApproval: true, execute: () => 'ok' } },
    };
    const first = await runAgent(options);
    expect(roles(chat.writes[0]!.messages)).toEqual(['user', 'assistant']);
    await resumeAgent({
      ...options,
      approvalResponses: [{ approvalId: approval(first), approved: true }],
    });
    // A terminal resume has nothing to repair.
    await resumeAgent(options);
    expect(chat.writes).toHaveLength(2);
    const record = chat.writes[1]!;
    expect(roles(record.messages)).toEqual(['user', 'assistant', 'tool', 'assistant']);
    expect(record.messageIds!.slice(0, 2)).toEqual(chat.writes[0]!.messageIds);
  });

  it('an input message keeps the id the stored chat gave it', async () => {
    const chat = chatStore();
    const earlier: Message[] = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
    ];
    await chat.inner.saveChat({
      chatId: 'chat-3',
      scope: { userId: 'ada' },
      messages: earlier,
      messageIds: ['m-a', 'm-b'],
      updatedAt: 1,
    });
    await runAgent({
      model: mocked([{ text: 'fine' }]).model,
      messages: [...earlier, { role: 'user', content: 'how are you' }],
      chat: { store: chat.store, chatId: 'chat-3', scope: { userId: 'ada' } },
      session: { store: createInMemoryAgentRunStore(), runId: 'continued', scope: 'tenant' },
    });
    expect((await chat.inner.loadChat('chat-3'))!.messageIds).toEqual([
      'm-a',
      'm-b',
      'continued:2',
      'continued:3',
    ]);
  });

  it('a failing chat store never fails the run; the next save repairs it', async () => {
    const chat = chatStore();
    const runs = runStore();
    const options: Resumable = {
      model: mocked([{ toolCalls: [{ toolName: 'gate', id: 'g1', args: {} }] }, { text: 'done' }])
        .model,
      prompt: 'gated',
      chat: { store: chat.store, chatId: 'chat-4', scope: { userId: 'ada' } },
      session: { store: runs.store, runId: 'repair-next', scope: 'tenant' },
      tools: { gate: { parameters, needsApproval: true, execute: () => 'ok' } },
    };
    chat.failNext();
    const events: AgentEvent[] = [];
    const stream = streamAgent(options);
    for await (const event of stream.events) events.push(event as AgentEvent);
    const first = await stream.result;
    expect(first.status).toBe('suspended');
    const warning = events.find(
      (event) =>
        event.type === 'part' &&
        event.part.type === 'warning' &&
        event.part.warning.setting === 'chat',
    ) as Extract<AgentEvent, { type: 'part' }>;
    expect(warning.part).toMatchObject({
      type: 'warning',
      warning: {
        type: 'other',
        setting: 'chat',
        message: expect.stringContaining('chat db unavailable'),
      },
    });
    expect((await runs.inner.load('repair-next'))!.chat).toMatchObject({
      status: 'failed',
      cursor: 0,
      error: { message: 'chat db unavailable' },
    });
    expect(await chat.inner.loadChat('chat-4')).toBeUndefined();
    const resumed = await resumeAgent({
      ...options,
      approvalResponses: [{ approvalId: approval(first), approved: true }],
    });
    expect(resumed.status).toBe('completed');
    expect(roles((await chat.inner.loadChat('chat-4'))!.messages)).toEqual([
      'user',
      'assistant',
      'tool',
      'assistant',
    ]);
    expect((await runs.inner.load('repair-next'))!.chat).toMatchObject({
      status: 'saved',
      cursor: 4,
    });
  });

  it('reconcileAgentRun and a terminal resume repair a projection left behind', async () => {
    for (const repair of ['reconcile', 'resume'] as const) {
      const chat = chatStore();
      const { model, fetch } = mocked([{ text: 'done' }]);
      const options: Resumable = {
        model,
        prompt: 'hello',
        chat: { store: chat.store, chatId: 'chat-5', scope: { userId: 'ada' } },
        session: { store: createInMemoryAgentRunStore(), runId: `left-${repair}`, scope: 'tenant' },
      };
      chat.failNext();
      expect((await runAgent(options)).status).toBe('completed');
      expect(await chat.inner.loadChat('chat-5')).toBeUndefined();
      if (repair === 'reconcile')
        expect(await reconcileAgentRun({ session: options.session, chat: options.chat })).toEqual({
          runId: 'left-reconcile',
          chat: 'saved',
        });
      else expect((await resumeAgent(options)).status).toBe('completed');
      expect(roles((await chat.inner.loadChat('chat-5'))!.messages)).toEqual(['user', 'assistant']);
      expect(fetch).toHaveBeenCalledTimes(1);
      // Settled: nothing is written again.
      expect(await reconcileAgentRun({ session: options.session, chat: options.chat })).toEqual({
        runId: `left-${repair}`,
        chat: 'current',
      });
      expect(chat.writes).toHaveLength(1);
    }
  });

  it('never overwrites a chat that belongs to another scope', async () => {
    const chat = chatStore();
    const theirs: ChatRecord = {
      chatId: 'shared',
      scope: { userId: 'bob' },
      messages: [{ role: 'user', content: 'bob’s secret' }],
      updatedAt: 1,
    };
    await chat.inner.saveChat(theirs);
    const runs = runStore();
    const result = await runAgent({
      model: mocked([{ text: 'hi' }]).model,
      prompt: 'hello',
      chat: { store: chat.store, chatId: 'shared', scope: { userId: 'ada' } },
      session: { store: runs.store, runId: 'mismatch', scope: 'tenant' },
    });
    expect(result.status).toBe('completed');
    expect(await chat.inner.loadChat('shared')).toEqual(theirs);
    expect((await runs.inner.load('mismatch'))!.chat?.status).toBe('scope-mismatch');
  });

  it('refuses a resume whose chat changed', async () => {
    const chat = chatStore();
    const options: Resumable = {
      model: mocked([{ toolCalls: [{ toolName: 'gate', args: {} }] }]).model,
      prompt: 'x',
      chat: { store: chat.store, chatId: 'chat-6', scope: { userId: 'ada' } },
      session: { store: createInMemoryAgentRunStore(), runId: 'chat-bound', scope: 'tenant' },
      tools: { gate: { parameters, needsApproval: true, execute: () => 'ok' } },
    };
    await runAgent(options);
    for (const changed of [
      { ...options, chat: { ...options.chat!, chatId: 'chat-7' } },
      { ...options, chat: { ...options.chat!, scope: { userId: 'bob' } } },
      { ...options, chat: undefined },
    ])
      expect(await resumeAgent(changed)).toMatchObject({
        status: 'failed',
        error: { message: expect.stringContaining('binding changed') },
      });
  });

  it('a prepareStep history rewrite never shortens the projection', async () => {
    const chat = chatStore();
    const result = await runAgent({
      model: mocked([
        { toolCalls: [{ toolName: 'lookup', id: 'c1', args: {} }] },
        { toolCalls: [{ toolName: 'lookup', id: 'c2', args: {} }] },
        { text: 'done' },
      ]).model,
      prompt: 'look twice',
      chat: { store: chat.store, chatId: 'chat-8', scope: { userId: 'ada' } },
      session: { store: createInMemoryAgentRunStore(), runId: 'rewritten', scope: 'tenant' },
      tools: { lookup: { parameters, execute: () => 'value' } },
      // The model sees only the first user turn and the last tool exchange.
      prepareStep: ({ stepIndex, messages }) =>
        stepIndex === 2 ? { messages: [messages[0]!, ...messages.slice(-2)] } : undefined,
    });
    expect(result.status).toBe('completed');
    expect(result.messages).toHaveLength(4);
    const record = (await chat.inner.loadChat('chat-8'))!;
    expect(roles(record.messages)).toEqual([
      'user',
      'assistant',
      'tool',
      'assistant',
      'tool',
      'assistant',
    ]);
  });

  it('keeps the raw transcript: a turn prepareStep shows only the model stays out', async () => {
    const chat = chatStore();
    const result = await runAgent({
      model: mocked([{ toolCalls: [{ toolName: 'lookup', id: 'c1', args: {} }] }, { text: 'done' }])
        .model,
      prompt: 'look',
      chat: { store: chat.store, chatId: 'chat-hint', scope: { userId: 'ada' } },
      session: { store: createInMemoryAgentRunStore(), runId: 'hinted', scope: 'tenant' },
      tools: { lookup: { parameters, execute: () => 'value' } },
      prepareStep: ({ stepIndex, messages }) =>
        stepIndex === 1
          ? { messages: [...messages, { role: 'user', content: 'model-only hint' }] }
          : undefined,
    });
    expect(result.messages.some((message) => message.content === 'model-only hint')).toBe(true);
    const record = (await chat.inner.loadChat('chat-hint'))!;
    expect(roles(record.messages)).toEqual(['user', 'assistant', 'tool', 'assistant']);
  });

  it('a crash after the tool ran loses no turn and repeats no effect', async () => {
    const chat = chatStore();
    const inner = createInMemoryAgentRunStore();
    let crash = true;
    const store: AgentRunStore = {
      load: inner.load,
      save: (envelope) => {
        // The loop's step-end checkpoint, after the tool ran and its receipt landed.
        const checkpoint = envelope.checkpoints[envelope.runId];
        if (
          crash &&
          checkpoint?.stepIndex === 1 &&
          checkpoint.messages.some((message) => message.role === 'tool')
        ) {
          crash = false;
          throw new Error('process died');
        }
        return inner.save(envelope);
      },
    };
    const execute = vi.fn(() => 'value');
    const { model } = mocked([
      { toolCalls: [{ toolName: 'lookup', id: 'c1', args: {} }] },
      { text: 'done' },
    ]);
    const options: Resumable = {
      model,
      prompt: 'look once',
      chat: { store: chat.store, chatId: 'chat-9', scope: { userId: 'ada' } },
      session: { store, runId: 'cut-short', scope: 'tenant' },
      tools: { lookup: { parameters, execute } },
    };
    expect((await runAgent(options)).status).toBe('failed');
    // The failed commit published nothing.
    expect(chat.writes).toHaveLength(0);
    const resumed = await resumeAgent(options);
    expect(resumed.status).toBe('completed');
    expect(execute).toHaveBeenCalledTimes(1);
    expect(roles((await chat.inner.loadChat('chat-9'))!.messages)).toEqual([
      'user',
      'assistant',
      'tool',
      'assistant',
    ]);
  });

  it('keeps every reasoning block byte for byte, and the next request replays them', async () => {
    const chat = chatStore();
    const blocks = [
      { type: 'thinking' as const, signature: 'S0' },
      { type: 'thinking' as const, text: 'a', signature: 'S1' },
      { type: 'redacted_thinking' as const, data: 'RED' },
      { type: 'text' as const, text: 'Checking.' },
      { type: 'tool_use' as const, id: 'toolu_1', name: 'lookup', json: '{}' },
    ];
    const wire = scriptedFetch([
      claudeTurn(blocks, 'tool_use'),
      claudeTurn([{ type: 'text', text: 'Found it.' }]),
    ]);
    const result = await runAgent({
      model: createAnthropic({ apiKey: 'k', fetch: wire.fetch })('claude-opus-5-5'),
      prompt: 'q',
      chat: { store: chat.store, chatId: 'chat-10', scope: { userId: 'ada' } },
      tools: { lookup: { parameters, execute: () => 'value' } },
    });
    expect(result.status).toBe('completed');
    const record = (await chat.inner.loadChat('chat-10'))!;
    expect(record.messages[1]!.content).toEqual([
      { type: 'reasoning', text: '', signature: 'S0', source: 'anthropic' },
      { type: 'reasoning', text: 'a', signature: 'S1', source: 'anthropic' },
      { type: 'reasoning', text: 'RED', redacted: true, source: 'anthropic' },
      { type: 'text', text: 'Checking.' },
      { type: 'tool_use', id: 'toolu_1', name: 'lookup', input: {} },
    ]);
    const replayed = (wire.bodies[1]!.messages as { content: unknown }[])[1]!.content;
    expect(replayed).toEqual([
      { type: 'thinking', thinking: '', signature: 'S0' },
      { type: 'thinking', thinking: 'a', signature: 'S1' },
      { type: 'redacted_thinking', data: 'RED' },
      { type: 'text', text: 'Checking.' },
      { type: 'tool_use', id: 'toolu_1', name: 'lookup', input: {} },
    ]);
  });
});
