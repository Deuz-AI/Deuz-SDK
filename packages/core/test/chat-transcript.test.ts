/**
 * chat-transcript.test.ts (2.4) — the transcript rules every TranscriptIndex
 * backend shares: which messages are indexed and under which stable id, what
 * text of a message is searchable, how a query becomes terms, and the scope
 * test search and resolveSource apply.
 */
import { describe, expect, it } from 'vitest';
import type { ChatRecord } from '../src/chat';
import type { Message } from '../src/types/message';
import {
  MAX_QUERY_TERMS,
  foldText,
  queryTerms,
  scopeMatches,
  searchText,
  stableMessageIds,
  transcriptEntries,
} from '../src/internal/chat-transcript';

const record = (messages: Message[], messageIds?: string[]): ChatRecord => ({
  chatId: 'c1',
  scope: { userId: 'ada' },
  messages,
  ...(messageIds ? { messageIds } : {}),
  updatedAt: 1,
});

describe('stable message ids', () => {
  it('keeps stored ids and gives a message without one <chatId>:<index>', () => {
    const chat = record(
      [
        { role: 'user', content: 'a' },
        { role: 'assistant', content: 'b' },
        { role: 'user', content: 'c' },
      ],
      ['m-a', ''],
    );
    expect(stableMessageIds(chat)).toEqual(['m-a', 'c1:1', 'c1:2']);
  });

  it('a repeated id keeps its first message; the repeat and a colliding fallback get fresh ones', () => {
    const chat = record(
      [
        { role: 'user', content: 'a' },
        { role: 'assistant', content: 'b' },
        { role: 'user', content: 'c' },
      ],
      // The third message's stored id is what the first fallback would be.
      ['dup', 'dup', 'c1:1'],
    );
    const ids = stableMessageIds(chat);
    expect(ids[0]).toBe('dup');
    expect(ids[2]).toBe('c1:1');
    expect(new Set(ids).size).toBe(3);
    expect(ids[1]).toMatch(/^c1:1:/);
  });
});

describe('transcript entries', () => {
  it('indexes every message but system ones, at its index in the chat, with its text', () => {
    const chat = record(
      [
        { role: 'system', content: 'secret instructions' },
        { role: 'user', content: 'Look up the İzmir trip' },
        {
          role: 'assistant',
          content: [
            { type: 'reasoning', text: 'opaque', encrypted: true },
            { type: 'text', text: 'Checking' },
            { type: 'tool_use', id: 't1', name: 'lookup', input: { q: 'izmir' } },
          ],
        },
        {
          role: 'tool',
          content: [{ type: 'tool_result', toolUseId: 't1', result: 'Booked: Çeşme' }],
        },
      ],
      ['s', 'u', 'a', 't'],
    );
    const entries = transcriptEntries(chat);
    expect(entries.map((entry) => [entry.messageId, entry.index])).toEqual([
      ['u', 1],
      ['a', 2],
      ['t', 3],
    ]);
    expect(entries[0]!.message).toEqual(chat.messages[1]);
    expect(entries.map((entry) => entry.text)).toEqual([
      'look up the izmir trip',
      'checking',
      'booked: cesme',
    ]);
  });
});

describe('searchable text', () => {
  it('folds case and diacritics the way FTS5 unicode61 does', () => {
    expect(foldText('İZMİR Çeşme Ünye straße')).toBe('izmir cesme unye straße');
  });

  it('reads string content, text parts and string tool results only', () => {
    expect(
      searchText({
        role: 'tool',
        content: [
          { type: 'tool_result', toolUseId: 'x', result: { not: 'text' } },
          { type: 'tool_result', toolUseId: 'y', result: 'Plain' },
        ],
      }),
    ).toBe('plain');
    expect(
      searchText({
        role: 'user',
        content: [
          { type: 'text', text: 'One' },
          { type: 'image', image: 'data:image/png;base64,AAAA' },
          { type: 'text', text: 'Two' },
        ],
      }),
    ).toBe('one\ntwo');
  });
});

describe('query terms', () => {
  it('splits on anything but letters and digits, folds and dedupes', () => {
    expect(queryTerms('  Trip to İzmir? izmir, "trip" AND 2024!')).toEqual([
      'trip',
      'to',
      'izmir',
      'and',
      '2024',
    ]);
    expect(queryTerms(' ?! ')).toEqual([]);
  });

  it(`keeps at most ${MAX_QUERY_TERMS} terms`, () => {
    const many = Array.from({ length: 50 }, (_, index) => `w${index}`).join(' ');
    expect(queryTerms(many)).toHaveLength(MAX_QUERY_TERMS);
  });
});

describe('scope matching', () => {
  it('matches when every field the filter sets is the same on the chat', () => {
    const chat = { userId: 'ada', agentId: 'support' };
    expect(scopeMatches(chat, { userId: 'ada' })).toBe(true);
    expect(scopeMatches(chat, { userId: 'ada', agentId: 'support' })).toBe(true);
    expect(scopeMatches(chat, { userId: 'bob' })).toBe(false);
    expect(scopeMatches(chat, { userId: 'ada', chatId: 'c1' })).toBe(false);
    expect(scopeMatches(chat, { userId: 'ada', agentId: undefined })).toBe(true);
  });
});
