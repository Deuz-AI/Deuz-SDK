/**
 * native-chat-conditional.test.ts (2.4) — a native run's chat projection into
 * a ConditionalChatStore: written with `writeChat` at the revision it read
 * (compare-and-set) instead of the legacy load-then-save, re-read and
 * re-decided when another writer got in between, and never over a deletion
 * tombstone, so a late repair (or a leg still running) cannot bring a deleted
 * chat back. The legacy path is `native-chat.test.ts`, unchanged.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  createInMemoryAgentRunStore,
  reconcileAgentRun,
  runAgent,
  streamAgent,
} from '../src/agent-run';
import type { ChatRecord } from '../src/chat';
import { createInMemoryConditionalChatStore } from '../src/chat-conditional';
import { createMockModel, type MockResponse } from '../src/testing';
import type { ConditionalChatStore } from '../src/types/chat-conditional';
import type { AgentEvent, AgentRunOptions, AgentRunSession } from '../src/types/agent-run';
import type { Message } from '../src/types/message';

const parameters = { type: 'object', properties: {} };
type Resumable = AgentRunOptions & { session: AgentRunSession };
const SCOPE = { userId: 'ada' };

const model = (responses: MockResponse[]) => createMockModel({ responses });

/** A conditional store that records writes and can fail or interleave a writer before them. */
function conditionalStore() {
  const inner = createInMemoryConditionalChatStore();
  const hooks = { failWrites: 0, beforeWrite: undefined as (() => Promise<void>) | undefined };
  const writes: { revision: number; record: ChatRecord }[] = [];
  const store: ConditionalChatStore = {
    ...inner,
    saveChat: vi.fn(inner.saveChat),
    async writeChat(record, options) {
      if (hooks.failWrites > 0) {
        hooks.failWrites--;
        throw new Error('chat db unavailable');
      }
      const before = hooks.beforeWrite;
      hooks.beforeWrite = undefined;
      await before?.();
      const result = await inner.writeChat(record, options);
      if (result.status === 'committed')
        writes.push({ revision: result.record.revision, record: structuredClone(record) });
      return result;
    },
  };
  return { store, inner, hooks, writes };
}

const texts = (messages: Message[]) =>
  messages.map((message) =>
    typeof message.content === 'string'
      ? message.content
      : message.content
          .filter((part) => part.type === 'text')
          .map((part) => (part as { text: string }).text)
          .join(''),
  );

describe('native chat projection into a conditional store', () => {
  it('writes each projection with compare-and-set, one revision per write', async () => {
    const chats = conditionalStore();
    const runs = createInMemoryAgentRunStore();
    const first = await runAgent({
      model: model([{ text: 'hello' }]),
      prompt: 'hi',
      chat: { store: chats.store, chatId: 'c', scope: SCOPE },
      session: { store: runs, runId: 'r1', scope: 'tenant' },
    });
    expect(first.status).toBe('completed');
    await runAgent({
      model: model([{ text: 'fine' }]),
      messages: [...first.messages, { role: 'user', content: 'how are you' }],
      chat: { store: chats.store, chatId: 'c', scope: SCOPE },
      session: { store: runs, runId: 'r2', scope: 'tenant' },
    });
    expect(chats.store.saveChat).not.toHaveBeenCalled();
    expect(chats.writes.map((write) => write.revision)).toEqual([1, 2]);
    const read = await chats.inner.readChat('c');
    expect(read).toMatchObject({ status: 'found', record: { revision: 2 } });
    if (read.status !== 'found') return;
    expect(texts(read.record.messages)).toEqual(['hi', 'hello', 'how are you', 'fine']);
    expect(read.record.messageIds).toEqual(['r1:0', 'r1:1', 'r2:2', 'r2:3']);
    expect((await runs.load('r2'))!.chat).toMatchObject({ status: 'saved', cursor: 4 });
  });

  it('a late repair never brings back a chat deleted after its failed write', async () => {
    const chats = conditionalStore();
    const options: Resumable = {
      model: model([{ text: 'answer' }]),
      prompt: 'question',
      chat: { store: chats.store, chatId: 'deleted', scope: SCOPE },
      session: { store: createInMemoryAgentRunStore(), runId: 'late', scope: 'tenant' },
    };
    chats.hooks.failWrites = 1;
    expect((await runAgent(options)).status).toBe('completed');
    // The chat never existed in the store; the user deletes it anyway.
    await chats.store.deleteChat('deleted');
    expect(await reconcileAgentRun({ session: options.session, chat: options.chat })).toEqual({
      runId: 'late',
      chat: 'superseded',
    });
    expect(await chats.inner.readChat('deleted')).toMatchObject({ status: 'deleted' });
    expect(chats.writes).toHaveLength(0);
    // Settled: a later repair does nothing.
    expect(await reconcileAgentRun({ session: options.session, chat: options.chat })).toEqual({
      runId: 'late',
      chat: 'current',
    });
  });

  it('a leg still running never recreates a chat deleted under it', async () => {
    const chats = conditionalStore();
    await chats.store.saveChat({
      chatId: 'live',
      scope: SCOPE,
      messages: [{ role: 'user', content: 'earlier' }],
      updatedAt: 1,
    });
    const stream = streamAgent({
      model: model([{ toolCalls: [{ toolName: 'forget', id: 'f1', args: {} }] }, { text: 'done' }]),
      messages: [{ role: 'user', content: 'earlier' }],
      chat: { store: chats.store, chatId: 'live', scope: SCOPE },
      session: { store: createInMemoryAgentRunStore(), runId: 'running', scope: 'tenant' },
      tools: {
        forget: {
          parameters,
          execute: async () => {
            await chats.store.deleteChat('live');
            return 'deleted';
          },
        },
      },
    });
    const events: AgentEvent[] = [];
    for await (const event of stream.events) events.push(event as AgentEvent);
    expect((await stream.result).status).toBe('completed');
    expect(await chats.inner.readChat('live')).toMatchObject({ status: 'deleted' });
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'part',
        part: {
          type: 'warning',
          warning: {
            type: 'other',
            setting: 'chat',
            message: expect.stringContaining('moved on without run running'),
          },
        },
      }),
    );
  });

  it('re-reads when another writer got in between, and keeps a chat that moved ahead', async () => {
    const chats = conditionalStore();
    const runs = createInMemoryAgentRunStore();
    // Between the projection's read and its write, a later turn continues the
    // very history the run is about to write.
    chats.hooks.beforeWrite = async () => {
      await chats.inner.saveChat({
        chatId: 'ahead',
        scope: SCOPE,
        messages: [
          { role: 'user', content: 'question' },
          { role: 'assistant', content: [{ type: 'text', text: 'answer' }] },
          { role: 'user', content: 'follow-up' },
        ],
        updatedAt: 2,
      });
    };
    await runAgent({
      model: model([{ text: 'answer' }]),
      prompt: 'question',
      chat: { store: chats.store, chatId: 'ahead', scope: SCOPE },
      session: { store: runs, runId: 'cas', scope: 'tenant' },
    });
    const read = await chats.inner.readChat('ahead');
    expect(read).toMatchObject({ status: 'found', record: { revision: 1 } });
    if (read.status === 'found')
      expect(texts(read.record.messages)).toEqual(['question', 'answer', 'follow-up']);
    expect((await runs.load('cas'))!.chat).toMatchObject({ status: 'saved', cursor: 2 });
  });

  it('a repair that finds another write between its read and its write leaves it alone', async () => {
    const chats = conditionalStore();
    const runs = createInMemoryAgentRunStore();
    const options: Resumable = {
      model: model([{ text: 'answer A' }]),
      prompt: 'question A',
      chat: { store: chats.store, chatId: 'race', scope: SCOPE },
      session: { store: runs, runId: 'repair', scope: 'tenant' },
    };
    chats.hooks.failWrites = 1;
    expect((await runAgent(options)).status).toBe('completed');
    // The repair reads an empty chat; before its write lands, another
    // conversation writes the chat. The legacy fingerprint path would now
    // overwrite it; compare-and-set re-reads, sees it moved, and stops.
    chats.hooks.beforeWrite = async () => {
      await chats.inner.saveChat({
        chatId: 'race',
        scope: SCOPE,
        messages: [{ role: 'user', content: 'question B' }],
        updatedAt: 5,
      });
    };
    expect(await reconcileAgentRun({ session: options.session, chat: options.chat })).toEqual({
      runId: 'repair',
      chat: 'superseded',
    });
    const read = await chats.inner.readChat('race');
    if (read.status !== 'found') throw new Error('the other write is gone');
    expect(texts(read.record.messages)).toEqual(['question B']);
    expect(chats.writes).toHaveLength(0);
  });

  it('gives up after three conflicts and records the failure for a later repair', async () => {
    const chats = conditionalStore();
    const runs = createInMemoryAgentRunStore();
    let interleaved = 0;
    const store: ConditionalChatStore = {
      ...chats.store,
      async writeChat(record, options) {
        interleaved++;
        await chats.inner.saveChat({
          chatId: record.chatId,
          scope: SCOPE,
          messages: [{ role: 'user', content: `noise ${interleaved}` }],
          updatedAt: interleaved,
        });
        return chats.inner.writeChat(record, options);
      },
    };
    const result = await runAgent({
      model: model([{ text: 'answer' }]),
      prompt: 'question',
      chat: { store, chatId: 'busy', scope: SCOPE },
      session: { store: runs, runId: 'busy', scope: 'tenant' },
    });
    expect(result.status).toBe('completed');
    expect(interleaved).toBe(3);
    expect((await runs.load('busy'))!.chat).toMatchObject({
      status: 'failed',
      cursor: 0,
      error: { name: 'RevisionConflictError' },
      found: expect.any(String),
    });
  });

  it('never writes a chat that belongs to another scope', async () => {
    const chats = conditionalStore();
    await chats.store.saveChat({
      chatId: 'shared',
      scope: { userId: 'bob' },
      messages: [{ role: 'user', content: 'bob only' }],
      updatedAt: 1,
    });
    const runs = createInMemoryAgentRunStore();
    await runAgent({
      model: model([{ text: 'hi' }]),
      prompt: 'hello',
      chat: { store: chats.store, chatId: 'shared', scope: SCOPE },
      session: { store: runs, runId: 'other', scope: 'tenant' },
    });
    expect(chats.writes).toHaveLength(0);
    expect((await runs.load('other'))!.chat?.status).toBe('scope-mismatch');
    expect(await chats.inner.readChat('shared')).toMatchObject({ record: { revision: 1 } });
  });
});
