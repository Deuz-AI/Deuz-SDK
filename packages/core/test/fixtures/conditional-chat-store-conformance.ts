/**
 * The ConditionalChatStore contract (2.4, spec §3.4), run against every
 * backend: in-memory, SQLite and Postgres. Writes are compare-and-set on a
 * revision (1 for a new chat, plus one per committed write); a delete leaves
 * a tombstone no write goes over until it is pruned; the legacy `ChatStore`
 * methods keep working on top; and the store's transcript index moves with
 * every committed write and tombstone.
 *
 * ```ts
 * conditionalChatStoreContracts('my store', (clock) => ({ store, transcript }));
 * ```
 */
import { describe, expect, it } from 'vitest';
import type { ChatRecord } from '../../src/chat';
import { RevisionConflictError } from '../../src/errors';
import type {
  ConditionalChatStore,
  ConditionalChatWriteResult,
  TranscriptIndex,
} from '../../src/types/chat-conditional';
import type { Clock } from '../../src/types/deps';
import type { Message } from '../../src/types/message';
import { settableClock } from './transcript-index-conformance';

export interface ConditionalChatHarness {
  store: ConditionalChatStore;
  /** The index the store keeps in step with its writes. */
  transcript: TranscriptIndex;
  close?(): Promise<void>;
}

const SCOPE = { userId: 'ada', agentId: 'support' };

export function chat(chatId: string, texts: string[], extra: Partial<ChatRecord> = {}): ChatRecord {
  const messages: Message[] = texts.map((content, index) => ({
    role: index % 2 === 0 ? 'user' : 'assistant',
    content,
  }));
  return { chatId, scope: SCOPE, messages, updatedAt: 1, ...extra };
}

function committed(result: ConditionalChatWriteResult) {
  if (result.status !== 'committed') throw new Error(`expected a commit, got ${result.status}`);
  return result.record;
}

export function conditionalChatStoreContracts(
  name: string,
  make: (clock: Clock) => ConditionalChatHarness | Promise<ConditionalChatHarness>,
  options: {
    /** Per-test timeout in ms (a live server). Default: vitest's. */ timeout?: number;
  } = {},
): void {
  const setup = async (start = 1_000) => {
    const clock = settableClock(start);
    const harness = await make(clock);
    return { clock, ...harness, done: async () => harness.close?.() };
  };

  describe(name, { ...(options.timeout !== undefined ? { timeout: options.timeout } : {}) }, () => {
    it('is marked conditional and starts empty', async () => {
      const { store, done } = await setup();
      expect(store.conditional).toBe(true);
      expect(await store.readChat('none')).toEqual({ status: 'missing' });
      expect(await store.loadChat('none')).toBeUndefined();
      expect(await store.listChats()).toEqual([]);
      await done();
    });

    it('creates a chat at revision 1 and moves one revision per committed write', async () => {
      const { store, done } = await setup();
      const first = chat('c1', ['hi'], {
        messageIds: ['m0'],
        parentId: 'root',
        updatedAt: 5,
      });
      const created = committed(await store.writeChat(first, { expectedRevision: 0 }));
      expect(created).toEqual({ ...first, revision: 1 });
      expect(await store.readChat('c1')).toEqual({ status: 'found', record: created });
      expect(await store.loadChat('c1')).toEqual(created);
      const second = chat('c1', ['hi', 'hello'], { messageIds: ['m0', 'm1'], updatedAt: 6 });
      expect(committed(await store.writeChat(second, { expectedRevision: 1 }))).toEqual({
        ...second,
        revision: 2,
      });
      // A revision carried on the input is the caller's stale copy: the store assigns its own.
      const third = { ...chat('c1', ['hi', 'hello', 'again']), revision: 99 };
      expect(committed(await store.writeChat(third, { expectedRevision: 2 })).revision).toBe(3);
      await done();
    });

    it('refuses a write whose expected revision is not the stored one, writing nothing', async () => {
      const { store, done } = await setup();
      committed(await store.writeChat(chat('c1', ['one']), { expectedRevision: 0 }));
      committed(await store.writeChat(chat('c1', ['one', 'two']), { expectedRevision: 1 }));
      const stored = await store.readChat('c1');
      expect(await store.writeChat(chat('c1', ['stale']), { expectedRevision: 1 })).toEqual({
        status: 'conflict',
        current: stored,
      });
      expect(await store.writeChat(chat('c1', ['fresh?']), { expectedRevision: 0 })).toEqual({
        status: 'conflict',
        current: stored,
      });
      expect(await store.writeChat(chat('c2', ['ahead']), { expectedRevision: 3 })).toEqual({
        status: 'conflict',
        current: { status: 'missing' },
      });
      expect(await store.readChat('c1')).toEqual(stored);
      expect(await store.readChat('c2')).toEqual({ status: 'missing' });
      await done();
    });

    it('lets exactly one of several concurrent creators commit', async () => {
      const { store, done } = await setup();
      const results = await Promise.all(
        Array.from({ length: 5 }, (_, n) =>
          store.writeChat(chat('race', [`writer ${n}`]), { expectedRevision: 0 }),
        ),
      );
      expect(results.filter((result) => result.status === 'committed')).toHaveLength(1);
      expect(results.filter((result) => result.status === 'conflict')).toHaveLength(4);
      const read = await store.readChat('race');
      expect(read).toMatchObject({ status: 'found', record: { revision: 1 } });
      await done();
    });

    it('keeps its own copies', async () => {
      const { store, done } = await setup();
      const record = chat('c1', ['original']);
      await store.writeChat(record, { expectedRevision: 0 });
      (record.messages[0] as { content: string }).content = 'mutated input';
      const loaded = (await store.loadChat('c1'))!;
      expect(loaded.messages[0]!.content).toBe('original');
      (loaded.messages[0] as { content: string }).content = 'mutated output';
      expect((await store.loadChat('c1'))!.messages[0]!.content).toBe('original');
      await done();
    });

    it('tombstones a chat: no message stays, and no write goes over it', async () => {
      const { store, clock, done } = await setup();
      committed(await store.writeChat(chat('c1', ['secret']), { expectedRevision: 0 }));
      clock.set(2_000);
      expect(await store.tombstoneChat('c1', { expectedRevision: 0 })).toEqual({
        status: 'conflict',
        current: await store.readChat('c1'),
      });
      const tombstone = { chatId: 'c1', scope: SCOPE, revision: 2, deletedAt: 2_000 };
      expect(await store.tombstoneChat('c1', { expectedRevision: 1 })).toEqual({
        status: 'deleted',
        tombstone,
      });
      const deleted = { status: 'deleted', tombstone };
      expect(await store.readChat('c1')).toEqual(deleted);
      expect(await store.loadChat('c1')).toBeUndefined();
      expect(await store.listChats()).toEqual([]);
      // A late projection, at any revision, finds the tombstone.
      for (const expectedRevision of [0, 1, 2])
        expect(await store.writeChat(chat('c1', ['late']), { expectedRevision })).toEqual({
          status: 'conflict',
          current: deleted,
        });
      await expect(store.saveChat(chat('c1', ['late legacy']))).rejects.toBeInstanceOf(
        RevisionConflictError,
      );
      expect(await store.tombstoneChat('c1', { expectedRevision: 2 })).toEqual({
        status: 'conflict',
        current: deleted,
      });
      expect(await store.readChat('c1')).toEqual(deleted);
      await done();
    });

    it('tombstones a chat that was never written, so a late first write cannot create it', async () => {
      const { store, done } = await setup();
      expect(await store.tombstoneChat('ghost', { expectedRevision: 0 })).toEqual({
        status: 'deleted',
        tombstone: { chatId: 'ghost', scope: {}, revision: 1, deletedAt: 1_000 },
      });
      expect((await store.writeChat(chat('ghost', ['late']), { expectedRevision: 0 })).status).toBe(
        'conflict',
      );
      await done();
    });

    it('keeps the legacy ChatStore methods: saveChat moves the revision, deleteChat tombstones', async () => {
      const { store, clock, done } = await setup();
      await store.saveChat(chat('legacy', ['one']));
      expect((await store.loadChat('legacy'))!.revision).toBe(1);
      await store.saveChat(chat('legacy', ['one', 'two']));
      expect(await store.loadChat('legacy')).toEqual({
        ...chat('legacy', ['one', 'two']),
        revision: 2,
      });
      clock.set(3_000);
      await store.deleteChat('legacy');
      expect(await store.readChat('legacy')).toEqual({
        status: 'deleted',
        tombstone: { chatId: 'legacy', scope: SCOPE, revision: 3, deletedAt: 3_000 },
      });
      // Deleting again changes nothing; deleting an unknown chat leaves a tombstone.
      clock.set(4_000);
      await store.deleteChat('legacy');
      expect(await store.readChat('legacy')).toMatchObject({ tombstone: { revision: 3 } });
      await store.deleteChat('unknown');
      expect(await store.readChat('unknown')).toMatchObject({
        status: 'deleted',
        tombstone: { revision: 1, deletedAt: 4_000 },
      });
      await done();
    });

    it('lists live chats by scope, the most recently updated first', async () => {
      const { store, done } = await setup();
      await store.saveChat(chat('a', ['x'], { updatedAt: 10 }));
      await store.saveChat(chat('b', ['x'], { updatedAt: 30 }));
      await store.saveChat(chat('c', ['x'], { updatedAt: 30 }));
      await store.saveChat(chat('bob', ['x'], { scope: { userId: 'bob' }, updatedAt: 40 }));
      await store.saveChat(chat('gone', ['x'], { updatedAt: 50 }));
      await store.deleteChat('gone');
      expect(await store.listChats()).toEqual(['bob', 'b', 'c', 'a']);
      expect(await store.listChats({ userId: 'ada' })).toEqual(['b', 'c', 'a']);
      expect(await store.listChats({ userId: 'ada', agentId: 'other' })).toEqual([]);
      await done();
    });

    it('prunes tombstones older than a time, after which the id can be reused', async () => {
      const { store, clock, done } = await setup();
      await store.saveChat(chat('live', ['stays']));
      clock.set(1_000);
      await store.deleteChat('old');
      clock.set(5_000);
      await store.deleteChat('recent');
      expect(await store.pruneTombstones(5_000)).toBe(1);
      expect(await store.readChat('old')).toEqual({ status: 'missing' });
      expect(await store.readChat('recent')).toMatchObject({ status: 'deleted' });
      expect(await store.readChat('live')).toMatchObject({ status: 'found' });
      expect(await store.pruneTombstones(5_000)).toBe(0);
      expect(
        committed(await store.writeChat(chat('old', ['again']), { expectedRevision: 0 })),
      ).toMatchObject({ revision: 1 });
      await done();
    });

    it('prunes on a finite fractional cutoff as on any other: strictly older tombstones', async () => {
      const { store, clock, done } = await setup();
      clock.set(1_000);
      await store.deleteChat('old');
      // 1000 is not before 999.5; it is before 1000.5.
      expect(await store.pruneTombstones(999.5)).toBe(0);
      expect(await store.readChat('old')).toMatchObject({ status: 'deleted' });
      expect(await store.pruneTombstones(1_000.5)).toBe(1);
      expect(await store.readChat('old')).toEqual({ status: 'missing' });
      await done();
    });

    it('moves its transcript index with every committed write and tombstone', async () => {
      const { store, transcript, done } = await setup();
      const scope = { userId: 'ada' };
      await store.writeChat(chat('t', ['the ferry leaves at nine'], { messageIds: ['f'] }), {
        expectedRevision: 0,
      });
      expect((await transcript.search(scope, 'ferry')).map((hit) => hit.messageId)).toEqual(['f']);
      // A refused write leaves the index as it was.
      await store.writeChat(chat('t', ['the bus instead']), { expectedRevision: 0 });
      expect(await transcript.search(scope, 'bus')).toEqual([]);
      await store.writeChat(chat('t', ['the bus instead'], { messageIds: ['b'] }), {
        expectedRevision: 1,
      });
      expect(await transcript.search(scope, 'ferry')).toEqual([]);
      expect((await transcript.search(scope, 'bus')).map((hit) => hit.messageId)).toEqual(['b']);
      await store.tombstoneChat('t', { expectedRevision: 2 });
      expect(await transcript.search(scope, 'bus')).toEqual([]);
      expect(
        await transcript.resolveSource(scope, {
          kind: 'user',
          chatId: 't',
          messageId: 'b',
          digest: 'sha256:00',
        }),
      ).toBeUndefined();
      await store.saveChat(chat('legacy', ['parcel tracking']));
      expect((await transcript.search(scope, 'parcel')).map((hit) => hit.messageId)).toEqual([
        'legacy:0',
      ]);
      await store.deleteChat('legacy');
      expect(await transcript.search(scope, 'parcel')).toEqual([]);
      await done();
    });

    it('writes a chat holding U+0000 or a huge tool result, as every backend does', async () => {
      const { store, transcript, done } = await setup();
      const nul = chat('nul', ['binary \u0000 tail']);
      expect(committed(await store.writeChat(nul, { expectedRevision: 0 }))).toEqual({
        ...nul,
        revision: 1,
      });
      expect(await store.loadChat('nul')).toEqual({ ...nul, revision: 1 });
      const lines: string[] = [];
      for (let i = 0; i < 80_000; i++) lines.push(`req id${i}x${(i * 7919) % 100_003} ok`);
      const big: ChatRecord = {
        ...chat('big', ['show me the log']),
        messages: [
          { role: 'user', content: 'show me the log' },
          {
            role: 'tool',
            content: [{ type: 'tool_result', toolUseId: 't1', result: lines.join('\n') }],
          },
        ],
      };
      expect(committed(await store.writeChat(big, { expectedRevision: 0 })).revision).toBe(1);
      await store.saveChat(big);
      expect(await store.readChat('big')).toMatchObject({
        status: 'found',
        record: { revision: 2 },
      });
      const scope = { userId: 'ada' };
      expect((await transcript.search(scope, 'tail')).map((hit) => hit.chatId)).toEqual(['nul']);
      expect((await transcript.search(scope, 'id3x23757')).map((hit) => hit.chatId)).toEqual([
        'big',
      ]);
      await done();
    });

    it('refuses an expected revision that is not a non-negative integer', async () => {
      const { store, done } = await setup();
      for (const expectedRevision of [-1, 1.5, Number.NaN]) {
        await expect(store.writeChat(chat('c', ['x']), { expectedRevision })).rejects.toThrow(
          /expectedRevision/,
        );
        await expect(store.tombstoneChat('c', { expectedRevision })).rejects.toThrow(
          /expectedRevision/,
        );
      }
      await done();
    });
  });
}
