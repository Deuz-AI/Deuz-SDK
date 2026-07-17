import { describe, it, expect, vi } from 'vitest';
import {
  createAssistantTurn,
  applyUIPart,
  assistantMessageFromTurn,
  clientToolResultMessage,
  uiFromMessages,
  dropTrailingAssistant,
  branchBeforeUserMessage,
  createInMemoryChatStore,
  serializeChatRecord,
  deserializeChatRecord,
  type ChatRecord,
} from '../src/chat';
import { generateText, streamChat } from '../src/index';
import { createAnthropic } from '../src/anthropic';
import type { Message } from '../src/types/message';
import type { JSONSchema } from '../src/types/schema';
import { sseResponse, sseEvents, mockFetch, mockFetchSequence } from './fixtures/sse';

const SCHEMA: JSONSchema = {
  type: 'object',
  properties: { q: { type: 'string' } },
  required: ['q'],
  additionalProperties: false,
};

const TOOL_CALL = sseEvents([
  {
    event: 'message_start',
    data: { type: 'message_start', message: { usage: { input_tokens: 10, output_tokens: 1 } } },
  },
  {
    event: 'content_block_start',
    data: {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'tool_use', id: 'toolu_1', name: 'search' },
    },
  },
  {
    event: 'content_block_delta',
    data: {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'input_json_delta', partial_json: '{"q":"x"}' },
    },
  },
  { event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } },
  {
    event: 'message_delta',
    data: {
      type: 'message_delta',
      delta: { stop_reason: 'tool_use' },
      usage: { output_tokens: 5 },
    },
  },
  { event: 'message_stop', data: { type: 'message_stop' } },
]);
const FINAL = sseEvents([
  {
    event: 'message_start',
    data: { type: 'message_start', message: { usage: { input_tokens: 20, output_tokens: 1 } } },
  },
  {
    event: 'content_block_start',
    data: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  },
  {
    event: 'content_block_delta',
    data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Done.' } },
  },
  {
    event: 'message_delta',
    data: {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn' },
      usage: { output_tokens: 6 },
    },
  },
  { event: 'message_stop', data: { type: 'message_stop' } },
]);

const fixedClock = {
  now: () => 1_700_000_000_000,
  setTimeout: (fn: () => void, _ms: number) => (setTimeout(fn, 0), () => {}),
};

function makeLogger() {
  const noop = (): void => {};
  return { debug: vi.fn(noop), info: vi.fn(noop), warn: vi.fn(noop), error: vi.fn(noop) };
}

describe('applyUIPart — the pure turn reducer (P6 core)', () => {
  it('folds a full tool round-trip and never mutates prior states', () => {
    const t0 = createAssistantTurn('tmp');
    const t1 = applyUIPart(t0, { type: 'start', messageId: 'm1' });
    const t2 = applyUIPart(t1, { type: 'text-delta', text: 'Hel' });
    const t3 = applyUIPart(t2, { type: 'text-delta', text: 'lo' });
    const t4 = applyUIPart(t3, {
      type: 'tool-call',
      toolCallId: 't1',
      toolName: 'search',
      input: { q: 'x' },
    });
    const t5 = applyUIPart(t4, { type: 'tool-state', toolCallId: 't1', state: 'executing' });
    const t6 = applyUIPart(t5, {
      type: 'tool-result',
      toolCallId: 't1',
      toolName: 'search',
      output: 'ok',
    });

    expect(t6.message).toMatchObject({
      id: 'm1',
      content: 'Hello',
      toolCalls: [{ toolCallId: 't1', state: 'result', output: 'ok', runState: 'executing' }],
    });
    expect(t6.serverResults).toEqual(['t1']);
    // Immutability: earlier states untouched.
    expect(t0.message.content).toBe('');
    expect(t3.message.toolCalls).toBeUndefined();
    expect(t4.message.toolCalls![0]!.state).toBe('call');
  });

  it('collects approvals, cost, budget, citations, data parts, and errors', () => {
    let turn = createAssistantTurn('m1');
    turn = applyUIPart(turn, {
      type: 'tool-call',
      toolCallId: 't1',
      toolName: 'pay',
      input: {},
    });
    turn = applyUIPart(turn, {
      type: 'tool-approval-request',
      approvalId: 'a1',
      toolCallId: 't1',
      toolName: 'pay',
      input: {},
    });
    turn = applyUIPart(turn, { type: 'cost', costUsd: 0.42, cacheSavingsUsd: 0.1 });
    turn = applyUIPart(turn, { type: 'budget-exceeded', kind: 'usd', limit: 0.4, value: 0.42 });
    turn = applyUIPart(turn, { type: 'citation', id: 'c1', snippet: 'src' });
    turn = applyUIPart(turn, { type: 'data-chart', payload: { x: 1 } });
    turn = applyUIPart(turn, { type: 'error', message: 'boom' });
    // Unknown / irrelevant parts are ignored (open union).
    turn = applyUIPart(turn, {
      type: 'compaction',
      layer: 'summarize',
      tokensBefore: 9,
      tokensAfter: 3,
    });

    expect(turn.approvals).toEqual([
      { approvalId: 'a1', toolCallId: 't1', toolName: 'pay', input: {} },
    ]);
    expect(turn.message.toolCalls![0]!.state).toBe('approval-requested');
    expect(turn.costUsd).toBe(0.42);
    expect(turn.cacheSavingsUsd).toBe(0.1);
    expect(turn.budgetExceeded).toEqual({ kind: 'usd', limit: 0.4, value: 0.42 });
    expect(turn.citations).toHaveLength(1);
    expect(turn.dataParts).toEqual([{ name: 'chart', payload: { x: 1 } }]);
    expect(turn.error).toBe('boom');
  });

  it('reconstructs the canonical assistant turn and client tool results', () => {
    let turn = createAssistantTurn('m1');
    turn = applyUIPart(turn, { type: 'text-delta', text: 'calling' });
    turn = applyUIPart(turn, {
      type: 'tool-call',
      toolCallId: 't1',
      toolName: 'search',
      input: { q: 'x' },
    });
    expect(assistantMessageFromTurn(turn)).toEqual({
      role: 'assistant',
      content: [
        { type: 'text', text: 'calling' },
        { type: 'tool_use', id: 't1', name: 'search', input: { q: 'x' } },
      ],
    });
    expect(clientToolResultMessage([{ toolCallId: 't1', result: 'ok' }])).toEqual({
      role: 'tool',
      content: [{ type: 'tool_result', toolUseId: 't1', result: 'ok' }],
    });
  });
});

describe('history projection + branching (P6 core)', () => {
  const canonical: Message[] = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'first question' },
    {
      role: 'assistant',
      content: [
        { type: 'text', text: 'let me check' },
        { type: 'tool_use', id: 't1', name: 'search', input: { q: 'x' } },
      ],
    },
    { role: 'tool', content: [{ type: 'tool_result', toolUseId: 't1', result: 'found' }] },
    { role: 'assistant', content: 'first answer' },
    { role: 'user', content: 'second question' },
    { role: 'assistant', content: 'second answer' },
  ];

  it('uiFromMessages projects canonical history (tool results merged, system skipped)', () => {
    let n = 0;
    const ui = uiFromMessages(canonical, () => `id-${n++}`);
    expect(ui.map((m) => m.role)).toEqual(['user', 'assistant', 'assistant', 'user', 'assistant']);
    expect(ui[1]!.toolCalls).toEqual([
      {
        toolCallId: 't1',
        toolName: 'search',
        input: { q: 'x' },
        state: 'result',
        output: 'found',
      },
    ]);
  });

  it('dropTrailingAssistant cuts both views back to the last user turn (regenerate)', () => {
    let n = 0;
    const ui = uiFromMessages(canonical, () => `id-${n++}`);
    const branched = dropTrailingAssistant({ ui, canonical });
    expect(branched.canonical.at(-1)).toEqual({ role: 'user', content: 'second question' });
    expect(branched.ui.at(-1)!.role).toBe('user');
    expect(canonical).toHaveLength(7); // inputs untouched
  });

  it('branchBeforeUserMessage cuts by user-turn ordinal (edit-and-resend)', () => {
    let n = 0;
    const ui = uiFromMessages(canonical, () => `id-${n++}`);
    const secondUser = ui.find((m) => m.role === 'user' && m.content === 'second question')!;
    const branched = branchBeforeUserMessage({ ui, canonical }, secondUser.id)!;
    expect(branched.canonical.at(-1)).toEqual({ role: 'assistant', content: 'first answer' });
    expect(branched.ui.at(-1)!.content).toBe('first answer');
    expect(branchBeforeUserMessage({ ui, canonical }, 'nope')).toBeUndefined();
    // Non-user ids do not branch.
    expect(branchBeforeUserMessage({ ui, canonical }, ui[1]!.id)).toBeUndefined();
  });
});

describe('ChatStore + auto-persist (P2)', () => {
  it('in-memory store round-trips and filters listChats by scope', async () => {
    const store = createInMemoryChatStore();
    const record: ChatRecord = {
      chatId: 'c1',
      scope: { userId: 'u1', chatId: 'c1' },
      messages: [{ role: 'user', content: 'hi' }],
      updatedAt: 1,
    };
    await store.saveChat(record);
    await store.saveChat({ ...record, chatId: 'c2', scope: { userId: 'u2', chatId: 'c2' } });
    expect((await store.loadChat('c1'))!.messages).toHaveLength(1);
    expect(await store.listChats({ userId: 'u1' })).toEqual(['c1']);
    expect(await store.listChats()).toEqual(['c1', 'c2']);
    await store.deleteChat('c1');
    expect(await store.loadChat('c1')).toBeUndefined();
  });

  it('serialize/deserialize preserves binary parts via $deuzBytes', () => {
    const record: ChatRecord = {
      chatId: 'c1',
      scope: { chatId: 'c1' },
      messages: [
        {
          role: 'user',
          content: [{ type: 'image', image: new Uint8Array([1, 2, 255]), mediaType: 'image/png' }],
        },
      ],
      updatedAt: 5,
    };
    const back = deserializeChatRecord(serializeChatRecord(record));
    const part = (back.messages[0]!.content as Array<{ image: Uint8Array }>)[0]!;
    expect(part.image).toBeInstanceOf(Uint8Array);
    expect([...part.image]).toEqual([1, 2, 255]);
  });

  it('streaming agentic run persists the FULL history at completion', async () => {
    const store = createInMemoryChatStore();
    const { fetch } = mockFetchSequence([
      () => sseResponse([TOOL_CALL]),
      () => sseResponse([FINAL]),
    ]);
    const result = streamChat({
      model: createAnthropic({ apiKey: 'k', fetch })('claude-opus-4-8'),
      messages: [{ role: 'user', content: 'go' }],
      tools: { search: { parameters: SCHEMA, execute: vi.fn(async () => 'found') } },
      maxSteps: 5,
      chat: { store, chatId: 'chat-1', scope: { userId: 'u1', chatId: 'chat-1' } },
      deps: { clock: fixedClock },
    });
    for await (const _ of result.fullStream) void _;

    const saved = (await store.loadChat('chat-1'))!;
    expect(saved.updatedAt).toBe(1_700_000_000_000);
    expect(saved.scope).toEqual({ userId: 'u1', chatId: 'chat-1' });
    expect(saved.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant']);
  });

  it('suspension (client-mode approval) persists too', async () => {
    const store = createInMemoryChatStore();
    const { fetch } = mockFetchSequence([() => sseResponse([TOOL_CALL])]);
    const result = streamChat({
      model: createAnthropic({ apiKey: 'k', fetch })('claude-opus-4-8'),
      messages: [{ role: 'user', content: 'go' }],
      tools: {
        search: { parameters: SCHEMA, execute: vi.fn(async () => 'found'), needsApproval: true },
      },
      maxSteps: 5,
      chat: { store, chatId: 'chat-1', scope: { chatId: 'chat-1' } },
      deps: { clock: fixedClock },
    });
    for await (const _ of result.fullStream) void _;
    const saved = (await store.loadChat('chat-1'))!;
    expect(saved.messages.map((m) => m.role)).toEqual(['user', 'assistant']); // gated turn saved, unexecuted
  });

  it('tool-less calls route through the loop and persist (both surfaces)', async () => {
    const store = createInMemoryChatStore();
    const { fetch } = mockFetch(() => sseResponse([FINAL]));
    const model = createAnthropic({ apiKey: 'k', fetch })('claude-opus-4-8');
    const chat = { store, chatId: 'plain', scope: { chatId: 'plain' } };

    const gen = await generateText({
      model,
      messages: [{ role: 'user', content: 'hi' }],
      chat,
      deps: { clock: fixedClock },
    });
    expect(gen.text).toBe('Done.');
    expect((await store.loadChat('plain'))!.messages.map((m) => m.role)).toEqual([
      'user',
      'assistant',
    ]);

    const result = streamChat({
      model,
      messages: [{ role: 'user', content: 'hi again' }],
      chat: { ...chat, chatId: 'plain-2' },
      deps: { clock: fixedClock },
    });
    for await (const _ of result.fullStream) void _;
    expect((await store.loadChat('plain-2'))!.messages.map((m) => m.role)).toEqual([
      'user',
      'assistant',
    ]);
  });

  it('a throwing store logs and never kills the run (best-effort rule)', async () => {
    const logger = makeLogger();
    const { fetch } = mockFetch(() => sseResponse([FINAL]));
    const result = await generateText({
      model: createAnthropic({ apiKey: 'k', fetch })('claude-opus-4-8'),
      messages: [{ role: 'user', content: 'hi' }],
      chat: {
        store: {
          saveChat() {
            throw new Error('db down');
          },
          loadChat: () => undefined,
        },
        chatId: 'c1',
        scope: { chatId: 'c1' },
      },
      deps: { clock: fixedClock, logger },
    });
    expect(result.text).toBe('Done.');
    expect(logger.error).toHaveBeenCalledWith('chat store save failed', expect.anything());
  });
});

describe('JSONL node store (./chat/node)', () => {
  it('round-trips records on disk (binary-safe)', async () => {
    const { createJsonlChatStore } = await import('../src/node/chat-store');
    const { mkdtemp } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = await mkdtemp(join(tmpdir(), 'deuz-chat-'));
    const store = createJsonlChatStore({ dir });

    await store.saveChat({
      chatId: 'c/1', // path-hostile id → encoded file name
      scope: { userId: 'u1' },
      messages: [
        { role: 'user', content: [{ type: 'image', image: new Uint8Array([9, 8]) }] },
        { role: 'assistant', content: 'seen' },
      ],
      updatedAt: 42,
    });
    const back = (await store.loadChat('c/1'))!;
    expect(back.updatedAt).toBe(42);
    expect(back.messages[1]).toEqual({ role: 'assistant', content: 'seen' });
    const img = (back.messages[0]!.content as Array<{ image: Uint8Array }>)[0]!;
    expect([...img.image]).toEqual([9, 8]);

    expect(await store.listChats({ userId: 'u1' })).toEqual(['c/1']);
    expect(await store.listChats({ userId: 'nope' })).toEqual([]);
    await store.deleteChat('c/1');
    expect(await store.loadChat('c/1')).toBeUndefined();
  });
});
