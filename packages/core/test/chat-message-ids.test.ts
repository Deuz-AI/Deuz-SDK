/**
 * chat-message-ids.test.ts (2.4) — `uiFromMessages` keeps the ids a stored chat
 * gave its messages (`ChatRecord.messageIds`, aligned with the canonical
 * messages); a fresh id is only the fallback. The two-argument call is the 2.3
 * projection, unchanged.
 */
import { describe, expect, it, vi } from 'vitest';
import { canonicalFromUI, createInMemoryChatStore, uiFromMessages } from '../src/chat';
import { createInMemoryAgentRunStore, runAgent } from '../src/agent-run';
import { createMockModel } from '../src/testing';
import type { Message } from '../src/types/message';

const history: Message[] = [
  { role: 'system', content: 'be brief' },
  { role: 'user', content: 'look it up' },
  {
    role: 'assistant',
    content: [
      { type: 'text', text: 'checking' },
      { type: 'tool_use', id: 't1', name: 'lookup', input: { q: 'x' } },
    ],
  },
  { role: 'tool', content: [{ type: 'tool_result', toolUseId: 't1', result: 'found' }] },
  { role: 'assistant', content: 'it is found' },
  { role: 'user', content: 'thanks' },
];
const storedIds = ['s-0', 'u-1', 'run:2', 'run:3', 'run:4', 'u-5'];

function fresh() {
  let n = 0;
  return vi.fn(() => `fresh-${n++}`);
}

describe('uiFromMessages: stored message ids (2.4)', () => {
  it('gives each UI message the id stored for its canonical message', () => {
    const generateId = fresh();
    const ui = uiFromMessages(history, generateId, { messageIds: storedIds });
    // The system turn is not rendered and the tool turn folds into its call:
    // their ids are skipped, never shifted onto the next message.
    expect(ui.map((message) => [message.role, message.id])).toEqual([
      ['user', 'u-1'],
      ['assistant', 'run:2'],
      ['assistant', 'run:4'],
      ['user', 'u-5'],
    ]);
    expect(ui[1]!.toolCalls).toEqual([
      { toolCallId: 't1', toolName: 'lookup', input: { q: 'x' }, state: 'result', output: 'found' },
    ]);
    // A stored id never burns a fresh one.
    expect(generateId).not.toHaveBeenCalled();
  });

  it('projects the same messages as the two-argument call, ids aside', () => {
    const withIds = uiFromMessages(history, fresh(), { messageIds: storedIds });
    const plain = uiFromMessages(history, fresh());
    expect(withIds.map(({ id: _id, ...rest }) => rest)).toEqual(
      plain.map(({ id: _id, ...rest }) => rest),
    );
    expect(canonicalFromUI(withIds)).toEqual(history.slice(1));
  });

  it('the two-argument call and an options object without ids mint fresh ids in order', () => {
    for (const ui of [
      uiFromMessages(history, fresh()),
      uiFromMessages(history, fresh(), {}),
      uiFromMessages(history, fresh(), { messageIds: undefined }),
    ])
      expect(ui.map((message) => message.id)).toEqual(['fresh-0', 'fresh-1', 'fresh-2', 'fresh-3']);
  });

  it('falls back to a fresh id where the stored list has none', () => {
    const generateId = fresh();
    // Shorter than the history (a store that kept ids for an older prefix),
    // with an empty entry.
    const ui = uiFromMessages(history, generateId, { messageIds: ['s-0', '', 'run:2'] });
    expect(ui.map((message) => message.id)).toEqual(['fresh-0', 'run:2', 'fresh-1', 'fresh-2']);
    expect(generateId).toHaveBeenCalledTimes(3);
  });

  it('never gives two UI messages the same id', () => {
    const ui = uiFromMessages(history, fresh(), {
      messageIds: ['s-0', 'dup', 'dup', 'run:3', 'dup', 'u-5'],
    });
    expect(ui.map((message) => message.id)).toEqual(['dup', 'fresh-0', 'fresh-1', 'u-5']);
  });

  it('keeps the ids of a chat a native run projected', async () => {
    const chats = createInMemoryChatStore();
    const result = await runAgent({
      model: createMockModel({
        responses: [{ toolCalls: [{ toolName: 'lookup', id: 'c1', args: {} }] }, { text: 'found' }],
      }),
      prompt: 'look it up',
      chat: { store: chats, chatId: 'chat-ids', scope: { userId: 'ada' } },
      session: { store: createInMemoryAgentRunStore(), runId: 'projected', scope: 'tenant' },
      tools: {
        lookup: { parameters: { type: 'object', properties: {} }, execute: () => 'the answer' },
      },
    });
    expect(result.status).toBe('completed');
    const record = (await chats.loadChat('chat-ids'))!;
    const ui = uiFromMessages(record.messages, fresh(), { messageIds: record.messageIds });
    expect(ui.map((message) => message.id)).toEqual(['projected:0', 'projected:1', 'projected:3']);
  });
});
