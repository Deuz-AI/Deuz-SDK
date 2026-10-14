/**
 * Lane L7A's acceptance scenarios (new.txt §5.1): conditional chat writes
 * that never lose an update between two writers sharing one database, a
 * deletion tombstone that a projection interrupted by a host crash cannot
 * write past after the restart, and a transcript search that never crosses a
 * scope and forgets a tombstoned chat. Every run builds its own stores.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect } from 'vitest';
import { createInMemoryAgentRunStore, reconcileAgentRun, runAgent } from '../../src/agent-run';
import type { ChatRecord } from '../../src/chat';
import {
  createInMemoryConditionalChatStore,
  createInMemoryTranscriptIndex,
  updateConditionalChat,
} from '../../src/chat-conditional';
import { RevisionConflictError } from '../../src/errors';
import { createSqliteConditionalChatStore } from '../../src/node/chat-conditional-sqlite';
import { createMockModel } from '../../src/testing';
import type {
  ConditionalChatRead,
  ConditionalChatStore,
  TranscriptIndex,
} from '../../src/types/chat-conditional';
import type { Message } from '../../src/types/message';
import { SLOW_TEST_TIMEOUT_MS } from '../fixtures/timeouts';
import { scenario } from './registry';

const ADA = { userId: 'ada' };
const BOB = { userId: 'bob' };

const user = (content: string): Message => ({ role: 'user', content });

/** A temporary directory removed after `fn`, whatever happens. */
async function inTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'deuz-l7a-'));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const textsOf = (read: ConditionalChatRead): string[] =>
  read.status === 'found' ? read.record.messages.map((message) => String(message.content)) : [];

scenario(
  'chat-stream-react',
  'conditional-write-cas',
  () =>
    inTempDir(async (dir) => {
      // Two writers (two hosts) on one database file, both starting from revision 1.
      const path = join(dir, 'chats.db');
      const a = createSqliteConditionalChatStore({ path });
      const b = createSqliteConditionalChatStore({ path });
      try {
        const base: ChatRecord = {
          chatId: 'shared',
          scope: ADA,
          messages: [user('plan the trip')],
          updatedAt: 1,
        };
        expect((await a.writeChat(base, { expectedRevision: 0 })).status).toBe('committed');
        const seenByB = await b.readChat('shared');
        expect(seenByB).toMatchObject({ status: 'found', record: { revision: 1 } });

        // A commits first. B's write at the revision it read is refused, whole.
        const fromA = { ...base, messages: [...base.messages, user('book the ferry')] };
        expect((await a.writeChat(fromA, { expectedRevision: 1 })).status).toBe('committed');
        const stale = { ...base, messages: [...base.messages, user('book the hotel')] };
        const refused = await b.writeChat(stale, { expectedRevision: 1 });
        expect(refused).toMatchObject({ status: 'conflict', current: { record: { revision: 2 } } });

        // B re-reads and merges onto what A stored: nothing is lost.
        const merged = await updateConditionalChat(b, 'shared', (current) =>
          current.status === 'found'
            ? { ...current.record, messages: [...current.record.messages, user('book the hotel')] }
            : undefined,
        );
        expect(merged).toMatchObject({ revision: 3 });
        expect(textsOf(await a.readChat('shared'))).toEqual([
          'plan the trip',
          'book the ferry',
          'book the hotel',
        ]);
        // The index moved with the committed writes only.
        const hits = await a.transcript.search(ADA, 'ferry hotel');
        expect(hits.map((hit) => hit.index).sort()).toEqual([1, 2]);

        // Writers that never stop colliding give up loudly, never silently.
        const busy: ConditionalChatStore = {
          ...b,
          async writeChat(record, options) {
            await a.saveChat({ ...base, messages: [user('someone else')] });
            return b.writeChat(record, options);
          },
        };
        await expect(
          updateConditionalChat(busy, 'shared', (current) =>
            current.status === 'found' ? current.record : undefined,
          ),
        ).rejects.toBeInstanceOf(RevisionConflictError);
      } finally {
        await a.close();
        await b.close();
      }
    }),
  { timeout: SLOW_TEST_TIMEOUT_MS },
);

scenario(
  'chat-stream-react',
  'tombstone-blocks-late-projection',
  () =>
    inTempDir(async (dir) => {
      const path = join(dir, 'chats.db');
      const runs = createInMemoryAgentRunStore();
      const session = { store: runs, runId: 'crashed', scope: 'tenant' };
      const before = createSqliteConditionalChatStore({ path });
      // The host dies between the run's checkpoint and its chat projection:
      // the projection's write never lands.
      const crashing: ConditionalChatStore = {
        ...before,
        writeChat: () => Promise.reject(new Error('host crashed')),
      };
      const result = await runAgent({
        model: createMockModel({ responses: [{ text: 'your card ends in 4242' }] }),
        prompt: 'which card did I use?',
        chat: { store: crashing, chatId: 'private', scope: ADA },
        session,
      });
      expect(result.status).toBe('completed');
      expect((await runs.load('crashed'))!.chat?.status).toBe('failed');
      await before.close();

      // Meanwhile the user deletes the conversation.
      const ui = createSqliteConditionalChatStore({ path });
      await ui.deleteChat('private');
      await ui.close();

      // After the restart, the repair finds the tombstone and writes nothing.
      const after = createSqliteConditionalChatStore({ path });
      try {
        expect(
          await reconcileAgentRun({
            session,
            chat: { store: after, chatId: 'private', scope: ADA },
          }),
        ).toEqual({ runId: 'crashed', chat: 'superseded' });
        expect(await after.readChat('private')).toMatchObject({
          status: 'deleted',
          tombstone: { revision: 1 },
        });
        expect(await after.transcript.search(ADA, 'card 4242')).toEqual([]);
        // No later writer, conditional or legacy, brings it back either.
        expect(
          (
            await after.writeChat(
              { chatId: 'private', scope: ADA, messages: [user('late')], updatedAt: 9 },
              { expectedRevision: 1 },
            )
          ).status,
        ).toBe('conflict');
        await expect(
          after.saveChat({ chatId: 'private', scope: ADA, messages: [user('late')], updatedAt: 9 }),
        ).rejects.toBeInstanceOf(RevisionConflictError);
        expect(await after.listChats(ADA)).toEqual([]);
        // Settled: the run records why it wrote nothing, and stops retrying.
        expect((await runs.load('crashed'))!.chat?.status).toBe('superseded');
        expect(
          await reconcileAgentRun({
            session,
            chat: { store: after, chatId: 'private', scope: ADA },
          }),
        ).toEqual({ runId: 'crashed', chat: 'current' });
      } finally {
        await after.close();
      }
    }),
  { fault: true, timeout: SLOW_TEST_TIMEOUT_MS },
);

scenario('transcript', 'scope-filter-and-tombstone', async () => {
  const sqlite = createSqliteConditionalChatStore({ path: ':memory:' });
  const memoryIndex = createInMemoryTranscriptIndex();
  const backends: [ConditionalChatStore, TranscriptIndex][] = [
    [sqlite, sqlite.transcript],
    [createInMemoryConditionalChatStore({ transcript: memoryIndex }), memoryIndex],
  ];
  try {
    for (const [store, index] of backends) {
      await store.writeChat(
        {
          chatId: 'ada-trip',
          scope: ADA,
          messages: [user('my passport number is X123'), user('the ferry to Bodrum')],
          messageIds: ['a0', 'a1'],
          updatedAt: 1,
        },
        { expectedRevision: 0 },
      );
      await store.writeChat(
        {
          chatId: 'bob-trip',
          scope: BOB,
          messages: [user('my passport number is Y999')],
          messageIds: ['b0'],
          updatedAt: 1,
        },
        { expectedRevision: 0 },
      );

      // Each user finds only their own messages, for the same words.
      const ada = await index.search(ADA, 'passport number');
      expect(ada.map((hit) => [hit.chatId, hit.messageId])).toEqual([['ada-trip', 'a0']]);
      expect((await index.search(BOB, 'passport')).map((hit) => hit.messageId)).toEqual(['b0']);
      expect(await index.search({ userId: 'mallory' }, 'passport')).toEqual([]);
      // A memory source reference resolves only under its own scope.
      const bobRef = {
        kind: 'user' as const,
        chatId: 'bob-trip',
        messageId: 'b0',
        digest: 'sha256:00' as const,
      };
      expect(await index.resolveSource(BOB, bobRef)).toMatchObject({ messageId: 'b0', index: 0 });
      expect(await index.resolveSource(ADA, bobRef)).toBeUndefined();

      // A tombstoned chat leaves search and source resolution at once.
      await store.tombstoneChat('ada-trip', { expectedRevision: 1 });
      expect(await index.search(ADA, 'passport ferry')).toEqual([]);
      expect(
        await index.resolveSource(ADA, { ...bobRef, chatId: 'ada-trip', messageId: 'a0' }),
      ).toBeUndefined();
      expect((await index.search(BOB, 'passport')).map((hit) => hit.messageId)).toEqual(['b0']);
    }
    // The SQL store also refuses to re-index a tombstoned chat from a backfill.
    await sqlite.transcript.index({
      chatId: 'ada-trip',
      scope: ADA,
      messages: [user('my passport number is X123')],
      updatedAt: 2,
    });
    expect(await sqlite.transcript.search(ADA, 'passport')).toEqual([]);
  } finally {
    await sqlite.close();
  }
});
