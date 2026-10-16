/**
 * The TranscriptIndex contract (2.4, spec §2.4), run against every backend:
 * in-memory, SQLite (FTS5 and the LIKE fallback) and Postgres (tsvector).
 * Lexical search within a scope, never across one; `index` replaces a chat,
 * `remove` drops it; `limit`, `around`, `chatIds`, `before` and `after`;
 * best hit first with score 1; `resolveSource` under the same scope check.
 *
 * ```ts
 * transcriptIndexContracts('my index', (clock) => ({ index: createMyIndex({ clock }) }));
 * ```
 */
import { describe, expect, it } from 'vitest';
import type { ChatRecord } from '../../src/chat';
import type { TranscriptIndex } from '../../src/types/chat-conditional';
import type { Clock } from '../../src/types/deps';
import type { Message } from '../../src/types/message';
import { indexChat } from '../../src/chat-conditional';

/** A clock the test sets; timers are never used by an index. */
export function settableClock(start = 1_000): Clock & { set(ms: number): void } {
  let now = start;
  return {
    now: () => now,
    setTimeout: () => () => {},
    set(ms) {
      now = ms;
    },
  };
}

export interface TranscriptHarness {
  index: TranscriptIndex;
  close?(): Promise<void>;
}

export interface TranscriptContractOptions {
  /**
   * `'token'` (default): a term matches whole words only (FTS5, tsvector,
   * in-memory). `'substring'`: the LIKE fallback, where a term also matches
   * inside a longer word.
   */
  matching?: 'token' | 'substring';
  /** Per-test timeout in ms (a live server). Default: vitest's. */
  timeout?: number;
}

const user = (content: string): Message => ({ role: 'user', content });
const assistant = (content: string): Message => ({ role: 'assistant', content });

export function chatRecord(
  chatId: string,
  messages: Message[],
  scope: ChatRecord['scope'] = { userId: 'ada' },
  messageIds?: string[],
): ChatRecord {
  return {
    chatId,
    scope,
    messages,
    ...(messageIds ? { messageIds } : {}),
    updatedAt: 1,
  };
}

export function transcriptIndexContracts(
  name: string,
  make: (clock: Clock) => TranscriptHarness | Promise<TranscriptHarness>,
  options: TranscriptContractOptions = {},
): void {
  const setup = async (start = 1_000) => {
    const clock = settableClock(start);
    const harness = await make(clock);
    return { clock, ...harness, done: async () => harness.close?.() };
  };

  describe(name, { ...(options.timeout !== undefined ? { timeout: options.timeout } : {}) }, () => {
    it('finds an indexed message with its id, position and content, best score 1', async () => {
      const { index, done } = await setup();
      const record = chatRecord(
        'trip',
        [
          { role: 'system', content: 'never searched: izmir' },
          user('Book me a trip to İzmir'),
          assistant('Done, the Izmir hotel is booked'),
        ],
        { userId: 'ada' },
        ['s', 'm-user', 'm-assistant'],
      );
      await index.index(record);
      const hits = await index.search({ userId: 'ada' }, 'IZMIR hotel');
      expect(hits.map((hit) => hit.messageId)).toEqual(['m-assistant', 'm-user']);
      expect(hits[0]).toEqual({
        chatId: 'trip',
        messageId: 'm-assistant',
        index: 2,
        message: record.messages[2],
        score: 1,
      });
      expect(hits[1]!.score).toBeGreaterThan(0);
      expect(hits[1]!.score).toBeLessThan(1);
      // System messages are never indexed.
      expect(await index.search({ userId: 'ada' }, 'never searched')).toEqual([]);
      await done();
    });

    it('replaces a chat on every index, and forgets it on remove', async () => {
      const { index, done } = await setup();
      await index.index(chatRecord('c', [user('the old plan: lisbon')]));
      await index.index(chatRecord('c', [user('the new plan: porto')]));
      expect(await index.search({ userId: 'ada' }, 'lisbon')).toEqual([]);
      expect((await index.search({ userId: 'ada' }, 'porto')).map((hit) => hit.chatId)).toEqual([
        'c',
      ]);
      await index.remove('c');
      expect(await index.search({ userId: 'ada' }, 'porto')).toEqual([]);
      await index.remove('never-indexed');
      await done();
    });

    it('never crosses scopes', async () => {
      const { index, done } = await setup();
      await index.index(chatRecord('ada-1', [user('budget for berlin')], { userId: 'ada' }));
      await index.index(
        chatRecord('ada-2', [user('budget for berlin')], { userId: 'ada', agentId: 'travel' }),
      );
      await index.index(chatRecord('bob-1', [user('budget for berlin')], { userId: 'bob' }));
      const ids = async (scope: ChatRecord['scope']) =>
        (await index.search(scope, 'berlin budget')).map((hit) => hit.chatId).sort();
      expect(await ids({ userId: 'ada' })).toEqual(['ada-1', 'ada-2']);
      expect(await ids({ userId: 'ada', agentId: 'travel' })).toEqual(['ada-2']);
      expect(await ids({ userId: 'bob' })).toEqual(['bob-1']);
      expect(await ids({ userId: 'carol' })).toEqual([]);
      expect(await ids({ agentId: 'travel' })).toEqual(['ada-2']);
      await done();
    });

    it('keeps to the chats named in chatIds', async () => {
      const { index, done } = await setup();
      for (const chatId of ['a', 'b', 'c'])
        await index.index(chatRecord(chatId, [user('weekly sync notes')]));
      const hits = await index.search({ userId: 'ada' }, 'sync', { chatIds: ['a', 'c', 'zz'] });
      expect(hits.map((hit) => hit.chatId).sort()).toEqual(['a', 'c']);
      expect(await index.search({ userId: 'ada' }, 'sync', { chatIds: [] })).toEqual([]);
      await done();
    });

    it('filters by when a message was first indexed', async () => {
      const { index, clock, done } = await setup(1_000);
      await index.index(chatRecord('early', [user('invoice one')], { userId: 'ada' }, ['e0']));
      clock.set(2_000);
      await index.index(chatRecord('late', [user('invoice two')], { userId: 'ada' }, ['l0']));
      const ids = async (filter: { before?: number; after?: number }) =>
        (await index.search({ userId: 'ada' }, 'invoice', filter))
          .map((hit) => hit.messageId)
          .sort();
      expect(await ids({ after: 1_500 })).toEqual(['l0']);
      expect(await ids({ before: 1_500 })).toEqual(['e0']);
      expect(await ids({ after: 1_000, before: 2_000 })).toEqual([]);
      // Re-indexing a chat keeps the time its messages were first indexed.
      clock.set(3_000);
      await index.index(
        chatRecord('early', [user('invoice one'), assistant('invoice three')], { userId: 'ada' }, [
          'e0',
          'e1',
        ]),
      );
      expect(await ids({ after: 2_500 })).toEqual(['e1']);
      expect(await ids({ before: 1_500 })).toEqual(['e0']);
      await done();
    });

    it('returns 10 hits by default, and at most limit', async () => {
      const { index, done } = await setup();
      await index.index(
        chatRecord(
          'many',
          Array.from({ length: 15 }, (_, n) => user(`status report ${n}`)),
        ),
      );
      expect(await index.search({ userId: 'ada' }, 'report')).toHaveLength(10);
      expect(await index.search({ userId: 'ada' }, 'report', { limit: 3 })).toHaveLength(3);
      expect(await index.search({ userId: 'ada' }, 'report', { limit: 0 })).toEqual([]);
      await done();
    });

    it('returns the messages around a hit, in order, the hit and system messages excluded', async () => {
      const { index, done } = await setup();
      const record = chatRecord(
        'ctx',
        [
          user('first'),
          { role: 'system', content: 'host note' },
          assistant('second'),
          user('the needle'),
          assistant('third'),
          user('fourth'),
        ],
        { userId: 'ada' },
        ['m0', 's', 'm2', 'm3', 'm4', 'm5'],
      );
      await index.index(record);
      const [hit] = await index.search({ userId: 'ada' }, 'needle', { around: 2 });
      expect(hit!.messageId).toBe('m3');
      expect(
        hit!.around!.map((message) => [message.messageId, message.index, message.message]),
      ).toEqual([
        ['m0', 0, record.messages[0]],
        ['m2', 2, record.messages[2]],
        ['m4', 4, record.messages[4]],
        ['m5', 5, record.messages[5]],
      ]);
      const [edge] = await index.search({ userId: 'ada' }, 'first', { around: 1 });
      expect(edge!.around!.map((message) => message.messageId)).toEqual(['m2']);
      await done();
    });

    it('ranks a message matching more of the query first', async () => {
      const { index, done } = await setup();
      await index.index(
        chatRecord(
          'rank',
          [user('ferry times'), user('ferry times to bodrum'), user('bodrum')],
          { userId: 'ada' },
          ['one', 'both', 'other'],
        ),
      );
      const hits = await index.search({ userId: 'ada' }, 'bodrum ferry');
      expect(hits[0]!.messageId).toBe('both');
      expect(hits[0]!.score).toBe(1);
      expect(hits.map((hit) => hit.messageId).sort()).toEqual(['both', 'one', 'other']);
      for (const hit of hits.slice(1)) expect(hit.score).toBeLessThan(1);
      await done();
    });

    it('finds the terms inside hosts, emails, versions and paths', async () => {
      const { index, done } = await setup();
      await index.index(
        chatRecord('urls', [
          user('Deploy to api.example.com and mail ops@acme.io about v2.4.1 at /srv/app'),
          assistant('Edited src/index.ts, see https://docs.deuz.dev/guide?tab=api'),
        ]),
      );
      const hits = async (term: string) =>
        (await index.search({ userId: 'ada' }, term)).map((hit) => hit.messageId);
      for (const term of ['deploy', 'example', 'acme', 'ops', 'v2', 'srv', 'app'])
        expect({ term, hits: await hits(term) }).toEqual({ term, hits: ['urls:0'] });
      for (const term of ['index', 'ts', 'docs', 'deuz', 'guide', 'tab'])
        expect({ term, hits: await hits(term) }).toEqual({ term, hits: ['urls:1'] });
      await done();
    });

    it('indexes a message holding U+0000, and finds its terms', async () => {
      const { index, done } = await setup();
      await index.index(chatRecord('nul', [user('binary \u0000 tail\u0000end')]));
      const hits = async (term: string) =>
        (await index.search({ userId: 'ada' }, term)).map((hit) => hit.messageId);
      expect(await hits('binary')).toEqual(['nul:0']);
      expect(await hits('tail')).toEqual(['nul:0']);
      expect(await hits('end')).toEqual(['nul:0']);
      await done();
    });

    it('indexes a huge message with many distinct terms, its first terms searchable', async () => {
      const { index, done } = await setup();
      const lines: string[] = [];
      // ~1.6 MB: as a tsvector, past Postgres's 1 MB limit.
      for (let i = 0; i < 80_000; i++) lines.push(`req id${i}x${(i * 7919) % 100_003} ok`);
      await index.index(chatRecord('big', [user(`log dump\n${lines.join('\n')}`), user('small')]));
      expect((await index.search({ userId: 'ada' }, 'dump')).map((hit) => hit.messageId)).toEqual([
        'big:0',
      ]);
      expect((await index.search({ userId: 'ada' }, 'id7x55433')).map((hit) => hit.chatId)).toEqual(
        ['big'],
      );
      expect((await index.search({ userId: 'ada' }, 'small')).map((hit) => hit.messageId)).toEqual([
        'big:1',
      ]);
      await done();
    });

    it('answers an empty or punctuation-only query with nothing', async () => {
      const { index, done } = await setup();
      await index.index(chatRecord('c', [user('anything at all')]));
      expect(await index.search({ userId: 'ada' }, '')).toEqual([]);
      expect(await index.search({ userId: 'ada' }, ' "*?:( ')).toEqual([]);
      // Query syntax of a backend is never interpreted.
      expect(await index.search({ userId: 'ada' }, 'anything OR NOT "at" *')).not.toEqual([]);
      await done();
    });

    it('resolves a memory source reference under the scope check', async () => {
      const { index, done } = await setup();
      const record = chatRecord(
        'src',
        [user('my order is A-17'), assistant('noted')],
        {
          userId: 'ada',
        },
        ['m-order', 'm-noted'],
      );
      await index.index(record);
      const ref = {
        kind: 'user' as const,
        chatId: 'src',
        messageId: 'm-order',
        digest: 'sha256:00' as const,
      };
      expect(await index.resolveSource({ userId: 'ada' }, ref)).toEqual({
        chatId: 'src',
        messageId: 'm-order',
        index: 0,
        message: record.messages[0],
      });
      expect(await index.resolveSource({ userId: 'bob' }, ref)).toBeUndefined();
      expect(
        await index.resolveSource({ userId: 'ada' }, { ...ref, messageId: 'unknown' }),
      ).toBeUndefined();
      expect(
        await index.resolveSource({ userId: 'ada' }, { ...ref, chatId: undefined }),
      ).toBeUndefined();
      await index.remove('src');
      expect(await index.resolveSource({ userId: 'ada' }, ref)).toBeUndefined();
      await done();
    });

    it('gives messages without a stable id <chatId>:<index> through indexChat', async () => {
      const { index, done } = await setup();
      await indexChat(index, chatRecord('legacy', [user('alpha'), assistant('beta')]));
      expect((await index.search({ userId: 'ada' }, 'beta')).map((hit) => hit.messageId)).toEqual([
        'legacy:1',
      ]);
      expect(
        await index.resolveSource(
          { userId: 'ada' },
          { kind: 'assistant', chatId: 'legacy', messageId: 'legacy:0', digest: 'sha256:00' },
        ),
      ).toMatchObject({ index: 0 });
      await done();
    });

    it('keeps its own copies', async () => {
      const { index, done } = await setup();
      const record = chatRecord('copy', [user('original words')]);
      await index.index(record);
      (record.messages[0] as { content: string }).content = 'mutated after indexing';
      const [hit] = await index.search({ userId: 'ada' }, 'original');
      expect(hit!.message).toEqual(user('original words'));
      (hit!.message as { content: string }).content = 'mutated hit';
      expect((await index.search({ userId: 'ada' }, 'original'))[0]!.message).toEqual(
        user('original words'),
      );
      await done();
    });

    it('refuses an aborted search and a negative limit', async () => {
      const { index, done } = await setup();
      const controller = new AbortController();
      controller.abort();
      await expect(
        index.search({ userId: 'ada' }, 'x', { signal: controller.signal }),
      ).rejects.toThrow();
      await expect(index.search({ userId: 'ada' }, 'x', { limit: -1 })).rejects.toThrow(/limit/);
      await done();
    });

    if ((options.matching ?? 'token') === 'token')
      it('matches whole words only', async () => {
        const { index, done } = await setup();
        await index.index(
          chatRecord('w', [user('a tripod'), user('the trip')], { userId: 'ada' }, [
            'tripod',
            'trip',
          ]),
        );
        expect((await index.search({ userId: 'ada' }, 'trip')).map((hit) => hit.messageId)).toEqual(
          ['trip'],
        );
        await done();
      });
  });
}
