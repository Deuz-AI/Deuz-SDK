/**
 * stable-prefix.test.ts (2.3, F22): the transcript prefix Claude 5.x binds its
 * thinking to stays byte-identical across requests.
 *
 * Fable 5.1, Opus 5.5, Sonnet 5.5 and Haiku 5.5 bind each thinking block's
 * signature to the top-level `system`, the `tools` array and every earlier
 * message. Every scenario below runs on such a model through the real
 * Anthropic adapter and asserts with the prefix-diff check
 * (`test/helpers/stable-prefix.ts`): request N's system + tools + messages,
 * serialized, are a byte prefix of request N+1's. Shapes follow
 * `@anthropic-ai/sdk` 0.133.0; the API behaviour is not live-verified.
 */
import { describe, expect, it, vi } from 'vitest';
import { generateText, streamChat } from '../src/index';
import { resumeFromCheckpoint } from '../src/durable';
import { createInMemorySessionStore } from '../src/durable';
import { createInMemoryChatStore } from '../src/chat';
import { createInMemoryMemoryStore, type MemorySeams } from '../src/memory';
import type { CommonCallOptions } from '../src/types/config';
import type { Message } from '../src/types/message';
import type { JSONSchema } from '../src/types/schema';
import type { GenerateTextResult } from '../src/types/methods';
import {
  prefixBreak,
  prefixBreaks,
  replaysThinking,
  scriptedClaude,
  thinkThenAnswer,
  thinkThenCall,
  type ClaudeRequest,
} from './helpers/stable-prefix';

const OBJ: JSONSchema = { type: 'object', properties: {} };
const clock = { now: () => 1_700_000_000_000, setTimeout: () => () => {} };

/**
 * Run one call through either loop. The streaming result has no response delta
 * (`response.messages` is the buffered call's), so it comes back only there.
 */
async function run(
  loop: 'buffered' | 'streaming',
  options: CommonCallOptions,
): Promise<Pick<GenerateTextResult, 'response'> | undefined> {
  if (loop === 'buffered') return generateText(options);
  const result = streamChat(options);
  for await (const part of result.fullStream) {
    if (part.type === 'error') throw part.error;
  }
  return undefined;
}

const LOOPS = ['buffered', 'streaming'] as const;

describe('the prefix-diff check', () => {
  const base: ClaudeRequest = {
    system: 'S',
    tools: [{ name: 'a', input_schema: OBJ }],
    messages: [{ role: 'user', content: [{ type: 'text', text: 'q' }] }],
    max_tokens: 100,
  };

  it('accepts appended messages, a role:system one included', () => {
    const next: ClaudeRequest = {
      ...base,
      messages: [...base.messages, { role: 'system', content: [{ type: 'text', text: 'B' }] }],
    };
    expect(prefixBreak(base, next)).toBeUndefined();
  });

  it('accepts a change outside system, tools and messages (max_tokens, effort, tool_choice)', () => {
    const next: ClaudeRequest = {
      ...base,
      max_tokens: 9,
      output_config: { effort: 'low' },
      tool_choice: { type: 'none' },
    };
    expect(prefixBreak(base, next)).toBeUndefined();
  });

  it('reports a changed system, a changed tools array and an edited message', () => {
    expect(prefixBreak(base, { ...base, system: 'S2' })).toMatch(/^system changed/);
    expect(prefixBreak(base, { ...base, tools: [] })).toMatch(/^tools changed/);
    expect(
      prefixBreak(base, {
        ...base,
        messages: [{ role: 'user', content: [{ type: 'text', text: 'q!' }] }],
      }),
    ).toMatch(/^messages\[0\] changed/);
  });
});

// --- memory recall -----------------------------------------------------------

function memorySeams(): MemorySeams & { search: ReturnType<typeof vi.fn> } {
  const store = createInMemoryMemoryStore();
  const search = vi.fn(store.search.bind(store));
  let id = 0;
  return {
    store: { ...store, search },
    // Extraction is off in these runs; recall never calls the LLM.
    llm: async () => '{"facts": []}',
    clock,
    generateId: () => `mem-${id++}`,
    hashFn: async (t: string) => `h:${t}`,
    search,
  };
}

async function seededSeams(): Promise<ReturnType<typeof memorySeams>> {
  const seams = memorySeams();
  await seams.store.upsert([
    {
      id: 'm-0',
      text: 'User prefers dark roast coffee',
      hash: 'h:coffee',
      kind: 'semantic',
      scope: { userId: 'u1' },
      createdAt: 1,
      updatedAt: 1,
      validAt: 1,
    },
  ]);
  return seams;
}

const RECALL = {
  role: 'system',
  content: [{ type: 'text', text: 'Relevant memories:\n- User prefers dark roast coffee' }],
};

describe.each(LOOPS)('memory recall on Claude 5.x (%s loop)', (loop) => {
  const memory = (seams: MemorySeams) =>
    ({ seams, scope: { userId: 'u1' }, extract: false }) as const;

  it('rides as one appended system message; the top-level system stays the caller’s', async () => {
    const seams = await seededSeams();
    const claude = scriptedClaude([
      thinkThenCall('S0', 'tu_0', 'lookup'),
      thinkThenAnswer('S1', 'Dark roast it is.'),
    ]);
    const result = await run(loop, {
      model: claude.model,
      messages: [
        { role: 'system', content: 'You are a barista.' },
        { role: 'user', content: 'Order me a coffee.' },
      ],
      tools: { lookup: { parameters: OBJ, execute: async () => 'menu' } },
      maxSteps: 3,
      memory: memory(seams),
      deps: { clock },
    });

    expect(claude.requests).toHaveLength(2);
    expect(claude.requests[0]!.system).toBe('You are a barista.');
    expect(claude.requests[0]!.messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'Order me a coffee.' }] },
      RECALL,
    ]);
    expect(replaysThinking(claude.requests[1]!)).toBe(true);
    expect(prefixBreaks(claude.requests)).toEqual([]);
    // Conversation content of this turn: the response delta carries it first.
    if (result) {
      expect(result.response.messages[0]).toMatchObject({
        role: 'system',
        content: 'Relevant memories:\n- User prefers dark roast coffee',
      });
    }
    expect(seams.search).toHaveBeenCalledTimes(1);
  });

  it.runIf(loop === 'buffered')(
    'the next turn, built from response.messages, replays the same prefix',
    async () => {
      const seams = await seededSeams();
      const claude = scriptedClaude([
        thinkThenAnswer('S0', 'Dark roast it is.'),
        thinkThenAnswer('S1', 'Tea too.'),
      ]);
      const history: Message[] = [
        { role: 'system', content: 'You are a barista.' },
        { role: 'user', content: 'Order me a coffee.' },
      ];
      const first = await run(loop, {
        model: claude.model,
        messages: history,
        memory: memory(seams),
        deps: { clock },
      });
      await run(loop, {
        model: claude.model,
        messages: [
          ...history,
          ...first!.response.messages,
          { role: 'user', content: 'And a tea?' },
        ],
        memory: memory(seams),
        deps: { clock },
      });

      expect(claude.requests).toHaveLength(2);
      expect(prefixBreaks(claude.requests)).toEqual([]);
      expect(replaysThinking(claude.requests[1]!)).toBe(true);
      // The second turn recalls for its own question, appended after it.
      expect(claude.requests[1]!.messages.at(-2)).toEqual({
        role: 'user',
        content: [{ type: 'text', text: 'And a tea?' }],
      });
      expect(claude.requests[1]!.messages.at(-1)!.role).toBe('system');
    },
  );

  it('a chat store keeps the recall message, so the next turn from the store replays it', async () => {
    const seams = await seededSeams();
    const chatStore = createInMemoryChatStore();
    const chat = { store: chatStore, chatId: 'c1', scope: { userId: 'u1', chatId: 'c1' } };
    const claude = scriptedClaude([
      thinkThenAnswer('S0', 'Dark roast it is.'),
      thinkThenAnswer('S1', 'Tea too.'),
    ]);
    await run(loop, {
      model: claude.model,
      messages: [{ role: 'user', content: 'Order me a coffee.' }],
      memory: memory(seams),
      chat,
      deps: { clock },
    });
    const saved = (await chatStore.loadChat('c1'))!;
    expect(saved.messages.map((m) => m.role)).toEqual(['user', 'system', 'assistant']);
    await run(loop, {
      model: claude.model,
      messages: [...saved.messages, { role: 'user', content: 'And a tea?' }],
      memory: memory(seams),
      chat,
      deps: { clock },
    });
    expect(prefixBreaks(claude.requests)).toEqual([]);
  });

  it('a turn whose question is already followed by its recall message does not recall again', async () => {
    const seams = await seededSeams();
    const claude = scriptedClaude([thinkThenAnswer('S0', 'ok')]);
    await run(loop, {
      model: claude.model,
      messages: [
        { role: 'user', content: 'Order me a coffee.' },
        {
          role: 'system',
          content: 'Relevant memories:\n- User prefers dark roast coffee',
          providerMetadata: { deuz: { memoryRecall: true } },
        },
      ],
      memory: memory(seams),
      deps: { clock },
    });
    expect(seams.search).not.toHaveBeenCalled();
    expect(claude.requests[0]!.messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'Order me a coffee.' }] },
      RECALL,
    ]);
  });

  it('extraction never writes the recall message back as a memory', async () => {
    const seams = await seededSeams();
    const claude = scriptedClaude([thinkThenAnswer('S0', 'Dark roast it is.')]);
    const result =
      loop === 'buffered'
        ? await generateText({
            model: claude.model,
            messages: [{ role: 'user', content: 'Order me a coffee.' }],
            memory: { seams, scope: { userId: 'u1' }, extract: { infer: false } },
            deps: { clock },
          })
        : streamChat({
            model: claude.model,
            messages: [{ role: 'user', content: 'Order me a coffee.' }],
            memory: { seams, scope: { userId: 'u1' }, extract: { infer: false } },
            deps: { clock },
          });
    if ('fullStream' in result) for await (const _ of result.fullStream) void _;
    // `infer: false` stores every turn it is handed verbatim.
    const written = (await result.memory!).map((m) => (m.op === 'upsert' ? m.record.text : ''));
    expect(written).toEqual(['Order me a coffee.', 'Dark roast it is.']);
  });
});

describe('memory recall resume rule (Claude 5.x)', () => {
  it('the checkpoint keeps the recall message and the resume leg does not recall again', async () => {
    const seams = await seededSeams();
    const store = createInMemorySessionStore();
    const tools = {
      brew: { parameters: OBJ, execute: async () => 'brewed', needsApproval: true },
    };
    const claude = scriptedClaude([
      thinkThenCall('S0', 'tu_0', 'brew'),
      thinkThenAnswer('S1', 'Brewed.'),
    ]);
    const first = await generateText({
      model: claude.model,
      messages: [{ role: 'user', content: 'Brew me a coffee.' }],
      tools,
      maxSteps: 3,
      memory: { seams, scope: { userId: 'u1' }, extract: false },
      session: { store, runId: 'run-1' },
      deps: { clock },
    });
    expect(first.pendingApprovals).toHaveLength(1);
    const checkpoint = await store.load('run-1');
    expect(checkpoint!.messages[1]).toMatchObject({ role: 'system' });

    await resumeFromCheckpoint(store, 'run-1', {
      model: claude.model,
      tools,
      maxSteps: 3,
      memory: { seams, scope: { userId: 'u1' }, extract: false },
      approvalResponses: [{ approvalId: first.pendingApprovals![0]!.approvalId, approved: true }],
      deps: { clock },
    });
    expect(seams.search).toHaveBeenCalledTimes(1);
    expect(claude.requests).toHaveLength(2);
    expect(prefixBreaks(claude.requests)).toEqual([]);
  });
});
