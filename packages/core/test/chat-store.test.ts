import { describe, it, expect, vi } from 'vitest';
import {
  createAssistantTurn,
  applyUIPart,
  assistantMessageFromTurn,
  clientToolResultMessage,
  uiFromMessages,
  canonicalFromUI,
  sealAssistantTurn,
  userMessageFromInput,
  filesToImageParts,
  dropTrailingAssistant,
  branchBeforeUserMessage,
  createInMemoryChatStore,
  serializeChatRecord,
  deserializeChatRecord,
  type ChatRecord,
  type UIMessage,
  type UIMessagePart,
} from '../src/chat';
import { generateText, streamChat } from '../src/index';
import {
  createInMemorySessionStore,
  resumeFromCheckpoint,
  resumeStreamFromCheckpoint,
} from '../src/durable';
import { createAnthropic } from '../src/anthropic';
import type { Message, Part } from '../src/types/message';
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
      token: 'v1.signed.token',
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
      { approvalId: 'a1', toolCallId: 't1', toolName: 'pay', input: {}, token: 'v1.signed.token' },
    ]);
    expect(turn.message.toolCalls![0]!.state).toBe('approval-requested');
    expect(turn.costUsd).toBe(0.42);
    expect(turn.cacheSavingsUsd).toBe(0.1);
    expect(turn.budgetExceeded).toEqual({ kind: 'usd', limit: 0.4, value: 0.42 });
    expect(turn.citations).toHaveLength(1);
    expect(turn.dataParts).toEqual([{ name: 'chart', payload: { x: 1 } }]);
    expect(turn.error).toBe('boom');
  });

  it('records finish + step-finish usage/finishReason (1.9 — no longer discarded)', () => {
    const usage = {
      inputTokens: 20,
      outputTokens: 6,
      reasoningTokens: 0,
      cachedReadTokens: 4,
      cacheWriteTokens: 0,
      cacheWrite1hTokens: 0,
      totalTokens: 26,
    };
    let turn = createAssistantTurn('m1');
    expect(turn.usage).toBeUndefined(); // OPTIONAL — not a defaulted shape
    expect(turn.steps).toBeUndefined();

    turn = applyUIPart(turn, { type: 'step-finish', step: 0, finishReason: 'tool_calls', usage });
    const afterFirstStep = turn;
    turn = applyUIPart(turn, { type: 'step-finish', step: 1, finishReason: 'stop', usage });
    turn = applyUIPart(turn, { type: 'finish', finishReason: 'length', usage });

    expect(turn.steps).toEqual([
      { step: 0, usage, finishReason: 'tool_calls' },
      { step: 1, usage, finishReason: 'stop' },
    ]);
    expect(turn.usage).toEqual(usage);
    expect(turn.finishReason).toBe('length'); // a UI can now say "truncated"
    // Immutability: the earlier state keeps its own array.
    expect(afterFirstStep.steps).toHaveLength(1);
  });

  it('folds a malformed/hostile finish payload without throwing (applyUIPart is TOTAL)', () => {
    let turn = createAssistantTurn('m1');
    // An older server sends a partial usage; a hostile one sends junk.
    const hostile = [
      { type: 'finish', finishReason: 'stop', usage: { totalTokens: 7 } },
      { type: 'finish', finishReason: 42, usage: null },
      { type: 'finish', usage: 'nope' },
      { type: 'step-finish', usage: { inputTokens: 'x', outputTokens: 3 } },
      { type: 'step-finish', step: Number.NaN, finishReason: null, usage: undefined },
    ] as unknown as Parameters<typeof applyUIPart>[1][];
    for (const part of hostile) {
      expect(() => (turn = applyUIPart(turn, part))).not.toThrow();
    }
    // Every count is a real number; totalTokens falls back to input+output.
    expect(turn.usage).toMatchObject({ inputTokens: 0, outputTokens: 0, totalTokens: 0 });
    // A non-string finishReason is DROPPED, never written — the last valid one
    // (the first part's 'stop') survives instead of being clobbered by junk.
    expect(turn.finishReason).toBe('stop');
    expect(
      applyUIPart(createAssistantTurn('m2'), {
        type: 'finish',
        finishReason: 42,
        usage: {},
      } as unknown as Parameters<typeof applyUIPart>[1]).finishReason,
    ).toBeUndefined();
    // A malformed `step` falls back to the arrival ordinal (positional UIs).
    expect(turn.steps).toEqual([
      {
        step: 0,
        usage: expect.objectContaining({ outputTokens: 3, totalTokens: 3 }),
        finishReason: 'stop',
      },
      { step: 1, usage: expect.objectContaining({ totalTokens: 0 }), finishReason: 'stop' },
    ]);
  });

  it('accumulates verify parts in arrival order (1.9 — the wire verdict reaches the UI)', () => {
    let turn = createAssistantTurn('m1');
    expect(turn.verifications).toBeUndefined(); // OPTIONAL until a verdict lands
    turn = applyUIPart(turn, {
      type: 'verify',
      stepIndex: 0,
      attempt: 0,
      ok: false,
      willRetry: true,
      feedback: 'be more precise',
    });
    const afterFirst = turn;
    turn = applyUIPart(turn, {
      type: 'verify',
      stepIndex: 1,
      attempt: 1,
      ok: true,
      willRetry: false,
    });
    expect(turn.verifications?.map((v) => v.attempt)).toEqual([0, 1]);
    expect(turn.verifications?.[0]).toMatchObject({ ok: false, feedback: 'be more precise' });
    expect(afterFirst.verifications).toHaveLength(1); // immutable append
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

  it('buffered prepareStep rewrites model/checkpoint history but preserves raw ChatStore history', async () => {
    const chatStore = createInMemoryChatStore();
    const sessionStore = createInMemorySessionStore();
    const { fetch, calls } = mockFetchSequence([() => sseResponse([FINAL])]);
    await generateText({
      model: createAnthropic({ apiKey: 'k', fetch })('claude-opus-4-8'),
      messages: [
        { role: 'user', content: 'raw history marker' },
        { role: 'user', content: 'current question' },
      ],
      tools: { search: { parameters: SCHEMA, execute: async () => 'unused' } },
      prepareStep: ({ messages }) => ({ messages: messages.slice(1) }),
      session: { store: sessionStore, runId: 'prepared-run' },
      chat: { store: chatStore, chatId: 'prepared-chat', scope: { userId: 'u1' } },
      deps: { clock: fixedClock },
    });

    expect(String(calls[0]!.init!.body)).not.toContain('raw history marker');
    expect(JSON.stringify((await sessionStore.load('prepared-run'))!.messages)).not.toContain(
      'raw history marker',
    );
    expect(JSON.stringify((await chatStore.loadChat('prepared-chat'))!.messages)).toContain(
      'raw history marker',
    );
  });

  it('streaming compaction stays effective for model/checkpoint but raw in ChatStore', async () => {
    const chatStore = createInMemoryChatStore();
    const sessionStore = createInMemorySessionStore();
    const history: Message[] = [
      { role: 'user', content: 'first question' },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'old-tool', name: 'search', input: { q: 'old' } }],
      },
      {
        role: 'tool',
        content: [
          { type: 'tool_result', toolUseId: 'old-tool', result: 'raw-secret-result'.repeat(40) },
        ],
      },
      { role: 'user', content: 'follow-up' },
      { role: 'assistant', content: 'previous answer' },
      { role: 'user', content: 'current question' },
    ];
    const { fetch, calls } = mockFetchSequence([() => sseResponse([FINAL])]);
    const result = streamChat({
      model: createAnthropic({ apiKey: 'k', fetch })('claude-opus-4-8'),
      messages: history,
      tools: { search: { parameters: SCHEMA, execute: async () => 'unused' } },
      compaction: { threshold: 0, keepRecentSteps: 1, layers: ['prune-tool-results'] },
      session: { store: sessionStore, runId: 'compact-run' },
      chat: { store: chatStore, chatId: 'compact-chat', scope: { userId: 'u1' } },
      deps: { clock: fixedClock },
    });
    for await (const _ of result.fullStream) void _;

    expect(String(calls[0]!.init!.body)).not.toContain('raw-secret-result');
    expect(JSON.stringify((await sessionStore.load('compact-run'))!.messages)).not.toContain(
      'raw-secret-result',
    );
    expect(JSON.stringify((await chatStore.loadChat('compact-chat'))!.messages)).toContain(
      'raw-secret-result',
    );
  });

  it.each(['buffered', 'streaming'] as const)(
    'durable %s resume loads matching raw history once without loss or duplication',
    async (surface) => {
      const sessionStore = createInMemorySessionStore();
      const innerChat = createInMemoryChatStore();
      const chatStore = {
        saveChat: vi.fn((record: ChatRecord) => innerChat.saveChat(record)),
        loadChat: vi.fn((chatId: string) => innerChat.loadChat(chatId)),
      };
      const chat = { store: chatStore, chatId: 'resume-chat', scope: { userId: 'u1' } };
      const first = mockFetchSequence([() => sseResponse([TOOL_CALL])]);
      await generateText({
        model: createAnthropic({ apiKey: 'k', fetch: first.fetch })('claude-opus-4-8'),
        messages: [
          { role: 'user', content: 'raw history marker' },
          { role: 'user', content: 'go' },
        ],
        tools: {
          search: { parameters: SCHEMA, execute: async () => 'found', needsApproval: true },
        },
        prepareStep: ({ messages }) => ({ messages: messages.slice(1) }),
        maxSteps: 5,
        session: { store: sessionStore, runId: `resume-${surface}` },
        chat,
        deps: { clock: fixedClock },
      });
      expect(chatStore.loadChat).not.toHaveBeenCalled();
      expect(
        JSON.stringify((await sessionStore.load(`resume-${surface}`))!.messages),
      ).not.toContain('raw history marker');

      const second = mockFetchSequence([() => sseResponse([FINAL])]);
      const resumeOptions = {
        model: createAnthropic({ apiKey: 'k', fetch: second.fetch })('claude-opus-4-8'),
        tools: {
          search: { parameters: SCHEMA, execute: async () => 'found', needsApproval: true },
        },
        approvalResponses: [{ approvalId: 'toolu_1', approved: true }],
        maxSteps: 5,
        chat,
        deps: { clock: fixedClock },
      };
      if (surface === 'buffered') {
        await resumeFromCheckpoint(sessionStore, `resume-${surface}`, resumeOptions);
      } else {
        const resumed = resumeStreamFromCheckpoint(
          sessionStore,
          `resume-${surface}`,
          resumeOptions,
        );
        for await (const _ of resumed.fullStream) void _;
        await new Promise((resolve) => setTimeout(resolve, 0));
      }

      expect(chatStore.loadChat).toHaveBeenCalledTimes(1);
      const saved = (await innerChat.loadChat('resume-chat'))!;
      expect(saved.messages.map((message) => message.role)).toEqual([
        'user',
        'user',
        'assistant',
        'tool',
        'assistant',
      ]);
      expect(JSON.stringify(saved.messages).match(/raw history marker/g)).toHaveLength(1);
    },
  );

  it('durable resume falls back to checkpoint history when ChatStore has no record', async () => {
    const sessionStore = createInMemorySessionStore();
    await sessionStore.save({
      version: 1,
      runId: 'missing-chat',
      stepId: 'missing-chat#1',
      stepIndex: 1,
      status: 'suspended',
      messages: [
        { role: 'user', content: 'checkpoint-only history' },
        {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'toolu_1', name: 'search', input: { q: 'x' } }],
        },
      ],
      usage: {
        inputTokens: 1,
        outputTokens: 1,
        reasoningTokens: 0,
        cachedReadTokens: 0,
        cacheWriteTokens: 0,
        cacheWrite1hTokens: 0,
        totalTokens: 2,
      },
      createdAt: 1,
    });
    const chatStore = createInMemoryChatStore();
    const loadChat = vi.spyOn(chatStore, 'loadChat');
    const { fetch } = mockFetchSequence([() => sseResponse([FINAL])]);
    await resumeFromCheckpoint(sessionStore, 'missing-chat', {
      model: createAnthropic({ apiKey: 'k', fetch })('claude-opus-4-8'),
      tools: {
        search: { parameters: SCHEMA, execute: async () => 'found', needsApproval: true },
      },
      approvalResponses: [{ approvalId: 'toolu_1', approved: true }],
      chat: { store: chatStore, chatId: 'missing-chat', scope: { userId: 'u1' } },
      deps: { clock: fixedClock },
    });

    expect(loadChat).toHaveBeenCalledTimes(1);
    expect(JSON.stringify((await chatStore.loadChat('missing-chat'))!.messages)).toContain(
      'checkpoint-only history',
    );
  });

  it.each(['scope mismatch', 'load failure'] as const)(
    'durable resume continues after %s without unsafe ChatStore overwrite',
    async (failure) => {
      const sessionStore = createInMemorySessionStore();
      await sessionStore.save({
        version: 1,
        runId: `unsafe-${failure}`,
        stepId: `unsafe-${failure}#1`,
        stepIndex: 1,
        status: 'suspended',
        messages: [
          { role: 'user', content: 'resume me' },
          {
            role: 'assistant',
            content: [{ type: 'tool_use', id: 'toolu_1', name: 'search', input: { q: 'x' } }],
          },
        ],
        usage: {
          inputTokens: 1,
          outputTokens: 1,
          reasoningTokens: 0,
          cachedReadTokens: 0,
          cacheWriteTokens: 0,
          cacheWrite1hTokens: 0,
          totalTokens: 2,
        },
        createdAt: 1,
      });
      const saveChat = vi.fn();
      const loadChat = vi.fn(() => {
        if (failure === 'load failure') throw new Error('database unavailable');
        return {
          chatId: 'unsafe-chat',
          scope: { userId: 'another-user' },
          messages: [{ role: 'user' as const, content: 'do not overwrite' }],
          updatedAt: 1,
        };
      });
      const { fetch } = mockFetchSequence([() => sseResponse([FINAL])]);
      const logger = makeLogger();
      const result = await resumeFromCheckpoint(sessionStore, `unsafe-${failure}`, {
        model: createAnthropic({ apiKey: 'k', fetch })('claude-opus-4-8'),
        tools: {
          search: { parameters: SCHEMA, execute: async () => 'found', needsApproval: true },
        },
        approvalResponses: [{ approvalId: 'toolu_1', approved: true }],
        chat: {
          store: { saveChat, loadChat },
          chatId: 'unsafe-chat',
          scope: { userId: 'u1' },
        },
        deps: { clock: fixedClock, logger },
      });

      expect(result.text).toBe('Done.');
      expect(loadChat).toHaveBeenCalledTimes(1);
      expect(saveChat).not.toHaveBeenCalled();
      expect(logger.error).toHaveBeenCalled();
    },
  );
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

describe('review fixes (T2-T5 adversarial pass)', () => {
  it('a tag-shaped tool payload with invalid base64 stays plain data (no throw, no loss)', () => {
    const record: ChatRecord = {
      chatId: 'c1',
      scope: { chatId: 'c1' },
      messages: [
        {
          role: 'tool',
          // A tool legitimately returned this exact shape — NOT our encoding.
          content: [{ type: 'tool_result', toolUseId: 't1', result: { $deuzBytes: 'status:ok' } }],
        },
      ],
      updatedAt: 1,
    };
    const back = deserializeChatRecord(serializeChatRecord(record));
    const part = (back.messages[0]!.content as Array<{ result: unknown }>)[0]!;
    expect(part.result).toEqual({ $deuzBytes: 'status:ok' }); // survived verbatim
  });
});

describe('review fixes — reducer placeholder (adversarial pass 2)', () => {
  it('an early tool-state (input-streaming) opens a placeholder that tool-call completes', () => {
    let turn = createAssistantTurn('m1');
    turn = applyUIPart(turn, {
      type: 'tool-state',
      toolCallId: 't1',
      toolName: 'search',
      state: 'input-streaming',
    });
    expect(turn.message.toolCalls).toHaveLength(1);
    expect(turn.message.toolCalls![0]).toMatchObject({
      toolCallId: 't1',
      toolName: 'search',
      runState: 'input-streaming',
    });
    turn = applyUIPart(turn, {
      type: 'tool-call',
      toolCallId: 't1',
      toolName: 'search',
      input: { q: 1 },
    });
    expect(turn.message.toolCalls).toHaveLength(1); // completed in place, no duplicate
    expect(turn.message.toolCalls![0]).toMatchObject({ input: { q: 1 }, state: 'call' });
    // …and the ordered projection references it ONCE, by id (1.9).
    expect(turn.message.parts).toEqual([{ type: 'tool', toolCallId: 't1' }]);
  });
});

// ===================================================================
// 1.9 — the ordered part projection (3.1)
// ===================================================================

type WirePart = Parameters<typeof applyUIPart>[1];

/** A part shape this build's `DeuzUIPart` may not declare yet (see each call site). */
const wire = (part: unknown): WirePart => part as WirePart;

const USAGE = {
  inputTokens: 10,
  outputTokens: 4,
  reasoningTokens: 0,
  cachedReadTokens: 0,
  cacheWriteTokens: 0,
  cacheWrite1hTokens: 0,
  totalTokens: 14,
};

function fold(parts: WirePart[], id = 'tmp'): ReturnType<typeof createAssistantTurn> {
  let turn = createAssistantTurn(id);
  for (const part of parts) turn = applyUIPart(turn, part);
  return turn;
}

describe('ordered parts projection (1.9, 3.1)', () => {
  it('records a multi-step interleave in arrival order, buckets byte-identical to 1.8', () => {
    // The archetypal 1.8 headline run: think → search → "I found 3 papers" →
    // fetch → "here is the summary". The lifecycle parts around the tools
    // (tool-state / tool-result / step-finish) must NOT open elements of their
    // own, and must not split the prose they sit inside.
    const turn = fold([
      { type: 'start', messageId: 'm1' },
      { type: 'step-start', step: 0 },
      { type: 'reasoning-delta', text: 'let me ' },
      { type: 'reasoning-delta', text: 'search', signature: 'sig-1' },
      { type: 'tool-state', toolCallId: 't1', toolName: 'search', state: 'input-streaming' },
      { type: 'tool-call', toolCallId: 't1', toolName: 'search', input: { q: 'papers' } },
      { type: 'tool-state', toolCallId: 't1', toolName: 'search', state: 'executing' },
      { type: 'tool-result', toolCallId: 't1', toolName: 'search', output: '3 hits' },
      { type: 'step-finish', step: 0, finishReason: 'tool_calls', usage: USAGE },
      { type: 'text-delta', text: 'I found 3 papers' },
      { type: 'tool-call', toolCallId: 't2', toolName: 'fetch', input: { id: 1 } },
      { type: 'tool-result', toolCallId: 't2', toolName: 'fetch', output: 'abstract' },
      { type: 'text-delta', text: ' — here is the summary.' },
      { type: 'finish', finishReason: 'stop', usage: USAGE },
    ]);

    // SIX ordered elements: the step boundary the run opened with, then
    // reasoning → tool → text → tool → text exactly as they arrived.
    expect(turn.message.parts).toEqual([
      { type: 'step-start', step: 0 },
      { type: 'reasoning', text: 'let me search', signature: 'sig-1', state: 'done' },
      { type: 'tool', toolCallId: 't1' },
      { type: 'text', text: 'I found 3 papers', state: 'done' },
      { type: 'tool', toolCallId: 't2' },
      // Sealed by the terminal `finish`, not by a following part.
      { type: 'text', text: ' — here is the summary.', state: 'done' },
    ] satisfies UIMessagePart[]);

    // PINNED: the 1.8 buckets are untouched — same concatenations, same array.
    expect(turn.message.content).toBe('I found 3 papers — here is the summary.');
    expect(turn.message.reasoning).toBe('let me search');
    expect(turn.message.toolCalls).toHaveLength(2);
    expect(turn.message.toolCalls![0]).toMatchObject({
      toolCallId: 't1',
      toolName: 'search',
      input: { q: 'papers' },
      state: 'result',
      output: '3 hits',
      runState: 'executing',
    });
    expect(turn.message.toolCalls![1]).toMatchObject({ toolCallId: 't2', state: 'result' });
    // A tool element is a REFERENCE — the card's state lives in exactly one place.
    expect(Object.keys(turn.message.parts![2]!)).toEqual(['type', 'toolCallId']);
    // createAssistantTurn's public shape is unchanged: no `parts` until content.
    expect(createAssistantTurn('m9')).toEqual({
      message: { id: 'm9', role: 'assistant', content: '' },
      approvals: [],
      serverResults: [],
      dataParts: [],
      citations: [],
      activity: [],
    });
  });

  it('a text delta AFTER a tool call opens a NEW text part instead of extending the old one', () => {
    const turn = fold([
      { type: 'text-delta', text: 'Let me check. ' },
      { type: 'tool-call', toolCallId: 't1', toolName: 'search', input: {} },
      { type: 'text-delta', text: 'Found it.' },
      { type: 'text-delta', text: ' Two hits.' },
    ]);
    expect(turn.message.parts).toEqual([
      { type: 'text', text: 'Let me check. ', state: 'done' }, // closed by the tool
      { type: 'tool', toolCallId: 't1' },
      { type: 'text', text: 'Found it. Two hits.', state: 'streaming' }, // one new bubble
    ]);
    // The bucket still sees ONE continuous string (1.8 semantics).
    expect(turn.message.content).toBe('Let me check. Found it. Two hits.');
  });

  it('citations and step boundaries land in order; a citation is the same object as in citations[]', () => {
    const turn = fold([
      { type: 'text-delta', text: 'Per the docs' },
      { type: 'citation', id: 'c1', title: 'Docs', snippet: 'the relevant line' },
      { type: 'step-start', step: 1 },
      { type: 'text-delta', text: ' it is safe.' },
    ]);
    expect(turn.message.parts!.map((p) => p.type)).toEqual([
      'text',
      'citation',
      'step-start',
      'text',
    ]);
    expect(turn.message.parts![1]).toBe(turn.citations[0]); // one object, no drift
    expect(turn.message.parts![3]).toEqual({
      type: 'text',
      text: ' it is safe.',
      state: 'streaming',
    });
  });

  it('seals the tail on the terminal boundary — finish, error, or an explicit seal', () => {
    const streaming = fold([{ type: 'text-delta', text: 'partial' }]);
    // No terminal part yet: still streaming. A truncated turn must LOOK truncated.
    expect(streaming.message.parts![0]).toMatchObject({ state: 'streaming' });

    expect(
      applyUIPart(streaming, { type: 'finish', finishReason: 'stop', usage: USAGE }).message.parts,
    ).toEqual([{ type: 'text', text: 'partial', state: 'done' }]);
    expect(applyUIPart(streaming, { type: 'error', message: 'boom' }).message.parts).toEqual([
      { type: 'text', text: 'partial', state: 'done' },
    ]);

    // The binding's own boundary (user abort, reader gone).
    const sealed = sealAssistantTurn(streaming);
    expect(sealed.message.parts).toEqual([{ type: 'text', text: 'partial', state: 'done' }]);
    expect(streaming.message.parts![0]).toMatchObject({ state: 'streaming' }); // immutable
    // Idempotent AND identity-stable: nothing to seal → the very same object,
    // so a React binding can call it unconditionally without a re-render.
    expect(sealAssistantTurn(sealed)).toBe(sealed);
    expect(sealAssistantTurn(createAssistantTurn('m1'))).toEqual(createAssistantTurn('m1'));
    // A finish on a contentless turn must not invent an empty `parts` key.
    expect(
      'parts' in
        applyUIPart(createAssistantTurn('m1'), {
          type: 'finish',
          finishReason: 'stop',
          usage: USAGE,
        }).message,
    ).toBe(false);
  });

  it('never throws on a malformed part of every new kind (applyUIPart is TOTAL)', () => {
    let turn = createAssistantTurn('m1');
    const hostile: WirePart[] = [
      wire({ type: 'step-start' }), // missing step
      wire({ type: 'step-start', step: 'later' }), // wrong type
      wire({ type: 'step-start', step: Number.NaN }),
      wire({ type: 'text-delta' }), // missing text
      wire({ type: 'reasoning-delta', text: 'x', signature: 42 }),
      wire({ type: 'citation' }), // missing id
      wire({ type: 'data-chart', id: 42, payload: undefined }), // non-string id
      wire({ type: 'data-', payload: 1 }), // empty name
      wire({ type: 'tool-state', toolCallId: 't9', state: 'error', denied: 'yes' }),
      wire({ type: 42 }), // not even a string type
      wire({ type: 'sub-agent', agentPath: ['x'], part: { type: 'text-delta', text: 'inner' } }),
    ];
    for (const part of hostile) {
      expect(() => (turn = applyUIPart(turn, part))).not.toThrow();
    }
    // Malformed step ordinals fall back to arrival position, nothing is dropped.
    expect(turn.message.parts!.filter((p) => p.type === 'step-start')).toEqual([
      { type: 'step-start', step: 0 },
      { type: 'step-start', step: 1 },
      { type: 'step-start', step: 2 },
    ]);
    // A non-string signature is dropped rather than written into a string field.
    expect(turn.message.parts!.find((p) => p.type === 'reasoning')).toEqual({
      type: 'reasoning',
      text: 'x',
      state: 'done',
    });
    // `denied: 'yes'` is not `true` → no denial invented.
    expect(turn.message.toolCalls![0]!.denied).toBeUndefined();
    // A turn rehydrated from JSON can carry ANYTHING in `parts` — still no throw.
    const junk = { ...turn, message: { ...turn.message, parts: 42 as never } };
    expect(() => applyUIPart(junk, { type: 'text-delta', text: 'ok' })).not.toThrow();
    expect(applyUIPart(junk, { type: 'text-delta', text: 'ok' }).message.parts).toEqual([
      { type: 'text', text: 'ok', state: 'streaming' },
    ]);
  });
});

describe('data-part reconciliation by (name, id) (1.9, 3.7a)', () => {
  it('collapses repeated (name, id) writes in place and keeps position + order', () => {
    const first = fold([
      { type: 'data-status', id: 'search', payload: { label: 'searching…' } } as WirePart,
      { type: 'text-delta', text: 'working' },
    ]);
    const turn = applyUIPart(
      first,
      wire({ type: 'data-status', id: 'search', payload: { label: 'found 12' } }),
    );

    // ONE logical entry, latest payload, original position (before the text).
    expect(turn.dataParts).toEqual([
      { name: 'status', id: 'search', payload: { label: 'found 12' } },
    ]);
    expect(turn.message.parts).toEqual([
      { type: 'data', name: 'status', id: 'search', payload: { label: 'found 12' } },
      // A replacement is not an interruption: the prose keeps streaming.
      { type: 'text', text: 'working', state: 'streaming' },
    ]);
    expect(applyUIPart(turn, { type: 'text-delta', text: ' still' }).message.parts).toHaveLength(2);

    // The matched entry was REPLACED, never mutated: the earlier snapshot still
    // reads 'searching…' (React state and prior turns must stay stable).
    expect(first.dataParts).toEqual([
      { name: 'status', id: 'search', payload: { label: 'searching…' } },
    ]);
    expect(first.message.parts![0]).toEqual({
      type: 'data',
      name: 'status',
      id: 'search',
      payload: { label: 'searching…' },
    });
  });

  it('stays append-only without an id, and separates distinct ids / names', () => {
    const turn = fold([
      wire({ type: 'data-chart', payload: { n: 1 } }),
      wire({ type: 'data-chart', payload: { n: 2 } }), // no id → 1.7/1.8 append
      wire({ type: 'data-status', id: 'a', payload: 1 }),
      wire({ type: 'data-status', id: 'b', payload: 2 }), // different id → own entry
      wire({ type: 'data-other', id: 'a', payload: 3 }), // same id, other name
    ]);
    expect(turn.dataParts).toEqual([
      { name: 'chart', payload: { n: 1 } },
      { name: 'chart', payload: { n: 2 } },
      { name: 'status', id: 'a', payload: 1 },
      { name: 'status', id: 'b', payload: 2 },
      { name: 'other', id: 'a', payload: 3 },
    ]);
    // An id-less entry carries no `id` key at all (1.8 shape, byte-for-byte).
    expect(Object.keys(turn.dataParts[0]!)).toEqual(['name', 'payload']);
    expect(turn.message.parts).toHaveLength(5);
  });
});

describe('denied tool calls (1.9, 3.7a)', () => {
  it('renders distinguishably from a thrown tool, without a 4th state literal', () => {
    // NOTE: `denied`/`deniedReason` are pre-seeded on the canonical
    // `ToolStatePart`; the wire's `DeuzUIPart` gains them in this same release
    // (src/ui.ts), so the cast keeps this test compiling against either build.
    const turn = fold([
      { type: 'tool-call', toolCallId: 't1', toolName: 'deleteRepo', input: {} },
      wire({
        type: 'tool-state',
        toolCallId: 't1',
        toolName: 'deleteRepo',
        state: 'error',
        denied: true,
        deniedReason: 'declined by you',
      }),
      {
        type: 'tool-result',
        toolCallId: 't1',
        toolName: 'deleteRepo',
        output: 'denied',
        isError: true,
      },
      { type: 'tool-call', toolCallId: 't2', toolName: 'getWeather', input: {} },
      { type: 'tool-state', toolCallId: 't2', toolName: 'getWeather', state: 'error' },
      {
        type: 'tool-result',
        toolCallId: 't2',
        toolName: 'getWeather',
        output: 'network down',
        isError: true,
      },
    ]);

    const [declined, failed] = turn.message.toolCalls!;
    expect(declined).toMatchObject({
      state: 'result',
      isError: true,
      runState: 'error',
      denied: true,
      deniedReason: 'declined by you',
    });
    // The thrown tool looks exactly as it did in 1.8 — no denial keys invented.
    expect(failed).toMatchObject({ state: 'result', isError: true, runState: 'error' });
    expect(failed!.denied).toBeUndefined();
    expect(failed!.deniedReason).toBeUndefined();
    // The state literal union is untouched (an exhaustive switch keeps working).
    expect([declined!.state, failed!.state]).toEqual(['result', 'result']);
  });

  it('carries denial on a placeholder when the tool-state arrives first', () => {
    const turn = fold([
      wire({
        type: 'tool-state',
        toolCallId: 't1',
        toolName: 'wire',
        state: 'error',
        denied: true,
        deniedReason: 'no',
      }),
    ]);
    expect(turn.message.toolCalls![0]).toMatchObject({ denied: true, deniedReason: 'no' });
    // A non-string reason is dropped: the key is absent, never a number in a
    // field typed `string`.
    const numericReason = fold([
      wire({ type: 'tool-state', toolCallId: 't1', state: 'error', denied: true, deniedReason: 7 }),
    ]).message.toolCalls![0]!;
    expect(numericReason.denied).toBe(true);
    expect('deniedReason' in numericReason).toBe(false);
  });
});

// ===================================================================
// 1.9 — canonicalFromUI, the inverse projection (3.2a)
// ===================================================================

describe('canonicalFromUI (1.9, 3.2a)', () => {
  const ids = (): (() => string) => {
    let n = 0;
    return () => `id-${n++}`;
  };

  const history: Message[] = [
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
  ];

  it('round-trips a text/tool history EXACTLY through the UI view', () => {
    expect(canonicalFromUI(uiFromMessages(history, ids()))).toEqual(history);
    // Twice through is a fixed point (no drift into one-element arrays).
    const once = canonicalFromUI(uiFromMessages(history, ids()));
    expect(canonicalFromUI(uiFromMessages(once, ids()))).toEqual(history);
  });

  it('DROPS system messages — the documented, unavoidable loss', () => {
    const withSystem: Message[] = [{ role: 'system', content: 'you are terse' }, ...history];
    // `uiFromMessages` never renders a system turn, so nothing can bring it
    // back: a caller replacing history must re-prepend its own system prompt.
    expect(canonicalFromUI(uiFromMessages(withSystem, ids()))).toEqual(history);
  });

  it('keeps the interleave, attachments, reasoning flags and tool provider metadata', () => {
    const rich: Message[] = [
      {
        role: 'user',
        content: [
          { type: 'image', image: new Uint8Array([1, 2, 3]), mediaType: 'image/png' },
          { type: 'text', text: 'What is this?' },
        ],
      },
      {
        role: 'assistant',
        content: [
          { type: 'reasoning', text: 'opaque-blob', signature: 'sig', encrypted: true },
          { type: 'text', text: 'A cat, and ' },
          {
            type: 'tool_use',
            id: 't9',
            name: 'zoom',
            input: { x: 1 },
            providerMetadata: { google: { thoughtSignature: 'abc' } },
          },
          { type: 'text', text: 'here is the crop.' },
        ],
      },
    ];
    const ui = uiFromMessages(rich, ids());
    // The attachment is VISIBLE now (pre-1.9 it rendered as an empty bubble).
    expect(ui[0]!.parts).toEqual([
      { type: 'file', mediaType: 'image/png', data: new Uint8Array([1, 2, 3]) },
      { type: 'text', text: 'What is this?', state: 'done' },
    ]);
    expect(ui[0]!.content).toBe('What is this?'); // 1.8 bucket unchanged
    expect(ui[1]!.parts!.map((p) => p.type)).toEqual(['reasoning', 'text', 'tool', 'text']);

    // …and the inverse rebuilds the canonical history byte-for-byte, including
    // the encrypted flag and the Gemini thoughtSignature (dropping either is a
    // 400 on the next request).
    expect(canonicalFromUI(ui)).toEqual(rich);
  });

  it('resolves a media type for an unlabelled attachment and marks renderable srcs', () => {
    const ui = uiFromMessages(
      [
        {
          role: 'user',
          content: [
            { type: 'image', image: new Uint8Array([9]) }, // no mediaType
            { type: 'image', image: 'https://example.com/a.png' },
            { type: 'image', image: 'data:image/webp;base64,AAA' },
            { type: 'image', image: 'iVBORw0KGgo=', mediaType: 'application/pdf' },
          ],
        },
      ],
      ids(),
    );
    expect(ui[0]!.parts).toEqual([
      // internal/image.ts's documented fallback, no bytes re-encoded.
      { type: 'file', mediaType: 'image/jpeg', data: new Uint8Array([9]) },
      {
        type: 'file',
        mediaType: 'image/png',
        data: 'https://example.com/a.png',
        url: 'https://example.com/a.png',
      },
      {
        type: 'file',
        mediaType: 'image/webp',
        data: 'data:image/webp;base64,AAA',
        url: 'data:image/webp;base64,AAA',
      },
      // Bare base64 is not a renderable src → no `url`, the consumer builds one.
      { type: 'file', mediaType: 'application/pdf', data: 'iVBORw0KGgo=' },
    ]);
  });

  it('is LOSSY without `parts`: order flattens and attachments are gone', () => {
    const projected = uiFromMessages(
      [
        {
          role: 'user',
          content: [
            { type: 'image', image: new Uint8Array([1]), mediaType: 'image/png' },
            { type: 'text', text: 'look' },
          ],
        },
      ],
      ids(),
    )[0]!;
    // Simulate a pre-1.9 / hand-built UIMessage: buckets only.
    const flat: UIMessage = { id: projected.id, role: 'user', content: projected.content };
    // `UIMessage.content` is a STRING — the image cannot be recovered. This is
    // the documented lossiness, asserted rather than hand-waved.
    expect(canonicalFromUI([flat])).toEqual([{ role: 'user', content: 'look' }]);

    // An assistant turn without `parts` collapses to bucket order: ONE reasoning
    // block, then ONE text block, then every tool_use — a plausible history, not
    // the original interleave, and the reasoning signature is gone.
    const bucketed: UIMessage = {
      id: 'a1',
      role: 'assistant',
      content: 'first. second.',
      reasoning: 'thought a thought b',
      toolCalls: [
        { toolCallId: 't1', toolName: 'search', input: { q: 1 }, state: 'result', output: 'ok' },
      ],
    };
    expect(canonicalFromUI([bucketed])).toEqual([
      {
        role: 'assistant',
        content: [
          { type: 'reasoning', text: 'thought a thought b' },
          { type: 'text', text: 'first. second.' },
          { type: 'tool_use', id: 't1', name: 'search', input: { q: 1 } },
        ],
      },
      { role: 'tool', content: [{ type: 'tool_result', toolUseId: 't1', result: 'ok' }] },
    ]);
  });

  it('unfolds executed tool calls back into a role:tool message (never a bare tool_use)', () => {
    const ui = uiFromMessages(
      [
        {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'ok', name: 'a', input: {} },
            { type: 'tool_use', id: 'bad', name: 'b', input: {} },
            { type: 'tool_use', id: 'pending', name: 'c', input: {} },
          ],
        },
        {
          role: 'tool',
          content: [
            { type: 'tool_result', toolUseId: 'ok', result: 'fine' },
            { type: 'tool_result', toolUseId: 'bad', result: 'threw', isError: true },
          ],
        },
      ],
      ids(),
    );
    const back = canonicalFromUI(ui);
    expect(back.map((m) => m.role)).toEqual(['assistant', 'tool']);
    expect(back[1]!.content).toEqual([
      { type: 'tool_result', toolUseId: 'ok', result: 'fine' },
      { type: 'tool_result', toolUseId: 'bad', result: 'threw', isError: true },
    ]);
    // A call still awaiting its result stays a bare tool_use — documented, and
    // the reason you resume through the tool flow rather than POSTing this.
    expect((back[0]!.content as Part[]).map((p) => (p as { id: string }).id)).toEqual([
      'ok',
      'bad',
      'pending',
    ]);
  });

  it('rebuilds a streamed turn from the reducer, interleave intact', () => {
    const turn = fold([
      { type: 'reasoning-delta', text: 'plan', signature: 's' },
      { type: 'text-delta', text: 'one. ' },
      { type: 'tool-call', toolCallId: 't1', toolName: 'search', input: { q: 'x' } },
      { type: 'tool-result', toolCallId: 't1', toolName: 'search', output: 'hit' },
      { type: 'text-delta', text: 'two.' },
      { type: 'finish', finishReason: 'stop', usage: USAGE },
    ]);
    expect(canonicalFromUI([turn.message])).toEqual([
      {
        role: 'assistant',
        content: [
          { type: 'reasoning', text: 'plan', signature: 's' },
          { type: 'text', text: 'one. ' },
          { type: 'tool_use', id: 't1', name: 'search', input: { q: 'x' } },
          { type: 'text', text: 'two.' },
        ],
      },
      { role: 'tool', content: [{ type: 'tool_result', toolUseId: 't1', result: 'hit' }] },
    ]);
    // `assistantMessageFromTurn` (the streaming path) is unchanged: buckets,
    // text-then-tools. The two are different projections on purpose.
    expect(assistantMessageFromTurn(turn)).toEqual({
      role: 'assistant',
      content: [
        { type: 'text', text: 'one. two.' },
        { type: 'tool_use', id: 't1', name: 'search', input: { q: 'x' } },
      ],
    });
  });
});

// ===================================================================
// 1.9 — multimodal input primitives (3.3a)
// ===================================================================

describe('input primitives (1.9, 3.3a)', () => {
  it('filesToImageParts converts blobs to ImageParts, in order, via Web APIs only', async () => {
    const png = new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' });
    const pdf = new Blob([new Uint8Array([4, 5])], { type: 'application/pdf' });
    const parts = await filesToImageParts([png, pdf]);
    expect(parts).toEqual([
      { type: 'image', image: new Uint8Array([1, 2, 3]), mediaType: 'image/png' },
      { type: 'image', image: new Uint8Array([4, 5]), mediaType: 'application/pdf' },
    ]);
    // An unlabelled blob carries no mediaType key (resolution happens later).
    const bare = await filesToImageParts([new Blob([new Uint8Array([7])])]);
    expect(bare).toEqual([{ type: 'image', image: new Uint8Array([7]) }]);
    expect(await filesToImageParts([])).toEqual([]);
  });

  it('userMessageFromInput keeps a string turn identical and puts media before the text', () => {
    expect(userMessageFromInput('hello')).toEqual({ role: 'user', content: 'hello' });
    expect(userMessageFromInput({ text: 'hello' })).toEqual({ role: 'user', content: 'hello' });

    const image: Part = { type: 'image', image: new Uint8Array([1]), mediaType: 'image/png' };
    expect(userMessageFromInput({ text: 'what is this?', parts: [image] })).toEqual({
      role: 'user',
      content: [image, { type: 'text', text: 'what is this?' }],
    });
    // No text → no empty text block (Anthropic 400s on one).
    expect(userMessageFromInput({ parts: [image] })).toEqual({ role: 'user', content: [image] });
    expect(userMessageFromInput({ text: '', parts: [image] })).toEqual({
      role: 'user',
      content: [image],
    });
    // Total: junk and emptiness fold instead of throwing.
    expect(userMessageFromInput({})).toEqual({ role: 'user', content: '' });
    expect(userMessageFromInput({ text: 'x', parts: [] })).toEqual({ role: 'user', content: 'x' });
    expect(
      userMessageFromInput({ text: 'x', parts: 'nope' } as unknown as Parameters<
        typeof userMessageFromInput
      >[0]),
    ).toEqual({ role: 'user', content: 'x' });
  });

  it('a picked file survives the whole loop: files → message → UI → canonical', async () => {
    const parts = await filesToImageParts([
      new Blob([new Uint8Array([1, 2])], { type: 'image/png' }),
      new Blob([new Uint8Array([3])], { type: 'image/webp' }),
    ]);
    const message = userMessageFromInput({ text: 'compare these', parts });
    let n = 0;
    const ui = uiFromMessages([message], () => `id-${n++}`);
    // TWO file elements with the right media types, then the question — no
    // longer the empty bubble `textOf` used to produce.
    expect(ui[0]!.parts).toEqual([
      { type: 'file', mediaType: 'image/png', data: new Uint8Array([1, 2]) },
      { type: 'file', mediaType: 'image/webp', data: new Uint8Array([3]) },
      { type: 'text', text: 'compare these', state: 'done' },
    ]);
    expect(ui[0]!.content).toBe('compare these');
    expect(canonicalFromUI(ui)).toEqual([message]);
  });
});
