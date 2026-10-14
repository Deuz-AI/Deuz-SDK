/**
 * chat-message-ids-stores.test.ts (2.4, H7 server side) — the ids a native run
 * gives its chat messages (`ChatRecord.messageIds`) survive every conditional
 * chat store and reach the UI through `uiFromMessages(..., { messageIds })`,
 * and a transcript hit names the same message id the UI renders, so a memory
 * source reference, a search hit and a rendered bubble agree on one id.
 */
import { PGlite } from '@electric-sql/pglite';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { createInMemoryAgentRunStore, runAgent } from '../src/agent-run';
import { uiFromMessages } from '../src/chat';
import {
  createInMemoryConditionalChatStore,
  createInMemoryTranscriptIndex,
} from '../src/chat-conditional';
import { createPostgresConditionalChatStore } from '../src/node/chat-conditional-postgres';
import { createSqliteConditionalChatStore } from '../src/node/chat-conditional-sqlite';
import { createMockModel } from '../src/testing';
import type { ConditionalChatStore, TranscriptIndex } from '../src/types/chat-conditional';
import { pglitePool } from './fixtures/pg-pool';

const lite = new PGlite();
const litePool = pglitePool(lite);
afterAll(async () => {
  await lite.close();
});

const backends: [string, () => Promise<{ store: ConditionalChatStore; index: TranscriptIndex }>][] =
  [
    [
      'in-memory',
      async () => {
        const index = createInMemoryTranscriptIndex();
        return { store: createInMemoryConditionalChatStore({ transcript: index }), index };
      },
    ],
    [
      'SQLite',
      async () => {
        const store = createSqliteConditionalChatStore({ path: ':memory:' });
        return { store, index: store.transcript };
      },
    ],
    [
      'PostgreSQL (PGlite)',
      async () => {
        await litePool.query('CREATE SCHEMA IF NOT EXISTS h7');
        const store = createPostgresConditionalChatStore({ pool: litePool, schema: 'h7' });
        return { store, index: store.transcript };
      },
    ],
  ];

describe.each(backends)('H7: stored message ids reach the UI (%s)', (_name, make) => {
  it('keeps the ids a native run projected, for the UI and for search', async () => {
    const { store, index } = await make();
    const chatId = `h7-${_name.length}`;
    const result = await runAgent({
      model: createMockModel({
        responses: [
          { toolCalls: [{ toolName: 'lookup', id: 'c1', args: {} }] },
          { text: 'the parcel ships monday' },
        ],
      }),
      prompt: 'where is my parcel',
      chat: { store, chatId, scope: { userId: 'ada' } },
      session: { store: createInMemoryAgentRunStore(), runId: 'h7', scope: 'tenant' },
      tools: {
        lookup: {
          parameters: { type: 'object', properties: {} },
          execute: () => 'in transit',
        },
      },
    });
    expect(result.status).toBe('completed');
    const record = (await store.loadChat(chatId))!;
    expect(record.messageIds).toEqual(['h7:0', 'h7:1', 'h7:2', 'h7:3']);

    const generateId = vi.fn(() => 'fresh');
    const ui = uiFromMessages(record.messages, generateId, { messageIds: record.messageIds });
    expect(ui.map((message) => message.id)).toEqual(['h7:0', 'h7:1', 'h7:3']);
    expect(generateId).not.toHaveBeenCalled();

    const [hit] = await index.search({ userId: 'ada' }, 'ships monday');
    expect(hit!.messageId).toBe('h7:3');
    expect(ui.map((message) => message.id)).toContain(hit!.messageId);
  });
});
