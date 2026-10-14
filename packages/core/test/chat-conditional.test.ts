/**
 * chat-conditional.test.ts (2.4) — the in-memory conditional chat store and
 * transcript index from `@deuz-sdk/core/chat`, on the shared contracts, plus
 * `indexChat` and `updateConditionalChat`.
 */
import { describe, expect, it, vi } from 'vitest';
import { createInMemoryChatStore } from '../src/chat';
import {
  createInMemoryConditionalChatStore,
  createInMemoryTranscriptIndex,
  indexChat,
  isConditionalChatStore,
  updateConditionalChat,
} from '../src/chat-conditional';
import { RevisionConflictError } from '../src/errors';
import type { ConditionalChatMerge, ConditionalChatStore } from '../src/types/chat-conditional';
import { chat, conditionalChatStoreContracts } from './fixtures/conditional-chat-store-conformance';
import { chatRecord, transcriptIndexContracts } from './fixtures/transcript-index-conformance';

transcriptIndexContracts('in-memory transcript index', (clock) => ({
  index: createInMemoryTranscriptIndex({ deps: { clock } }),
}));

conditionalChatStoreContracts('in-memory conditional chat store', (clock) => {
  const transcript = createInMemoryTranscriptIndex({ deps: { clock } });
  return { store: createInMemoryConditionalChatStore({ transcript, deps: { clock } }), transcript };
});

describe('in-memory conditional chat store', () => {
  it('commits nothing when its transcript index fails', async () => {
    const transcript = createInMemoryTranscriptIndex();
    const store = createInMemoryConditionalChatStore({
      transcript: {
        ...transcript,
        index: () => Promise.reject(new Error('index down')),
      },
    });
    await expect(store.writeChat(chat('c', ['x']), { expectedRevision: 0 })).rejects.toThrow(
      'index down',
    );
    expect(await store.readChat('c')).toEqual({ status: 'missing' });
  });

  it('works without a transcript index', async () => {
    const store = createInMemoryConditionalChatStore();
    await store.saveChat(chat('c', ['x']));
    expect((await store.loadChat('c'))!.revision).toBe(1);
  });

  it('is told apart from a legacy ChatStore', () => {
    expect(isConditionalChatStore(createInMemoryConditionalChatStore())).toBe(true);
    expect(isConditionalChatStore(createInMemoryChatStore())).toBe(false);
  });
});

describe('updateConditionalChat', () => {
  const append = (text: string) =>
    vi.fn<ConditionalChatMerge>((current) => {
      const messages = current.status === 'found' ? current.record.messages : [];
      return chat('c', [...messages.map((message) => message.content as string), text]);
    });

  it('creates a missing chat and merges onto a stored one', async () => {
    const store = createInMemoryConditionalChatStore();
    expect(await updateConditionalChat(store, 'c', append('one'))).toMatchObject({ revision: 1 });
    const merged = await updateConditionalChat(store, 'c', append('two'));
    expect(merged).toMatchObject({ revision: 2 });
    expect(merged!.messages.map((message) => message.content)).toEqual(['one', 'two']);
  });

  it('writes nothing when the merge declines', async () => {
    const store = createInMemoryConditionalChatStore();
    expect(await updateConditionalChat(store, 'c', () => undefined)).toBeUndefined();
    expect(await store.readChat('c')).toEqual({ status: 'missing' });
  });

  it('re-reads and merges again when another writer got there first', async () => {
    const inner = createInMemoryConditionalChatStore();
    let interleave = true;
    const store: ConditionalChatStore = {
      ...inner,
      async writeChat(record, options) {
        if (interleave) {
          interleave = false;
          await inner.saveChat(chat('c', ['concurrent']));
        }
        return inner.writeChat(record, options);
      },
    };
    const merge = append('mine');
    const result = await updateConditionalChat(store, 'c', merge);
    expect(merge).toHaveBeenCalledTimes(2);
    expect(merge.mock.calls.map((call) => call[1])).toEqual([1, 2]);
    expect(result!.messages.map((message) => message.content)).toEqual(['concurrent', 'mine']);
    expect(result!.revision).toBe(2);
  });

  it('gives up with RevisionConflictError after three attempts', async () => {
    const inner = createInMemoryConditionalChatStore();
    const store: ConditionalChatStore = {
      ...inner,
      async writeChat(record, options) {
        await inner.saveChat(chat('c', ['someone else']));
        return inner.writeChat(record, options);
      },
    };
    const merge = append('mine');
    const error = await updateConditionalChat(store, 'c', merge).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(RevisionConflictError);
    expect(error).toMatchObject({ subsystem: 'chat', key: 'c', attempts: 3 });
    expect(merge).toHaveBeenCalledTimes(3);
    const once = append('mine');
    await expect(updateConditionalChat(store, 'c', once, { attempts: 1 })).rejects.toMatchObject({
      attempts: 1,
    });
    expect(once).toHaveBeenCalledTimes(1);
  });

  it('never writes over a tombstone', async () => {
    const store = createInMemoryConditionalChatStore();
    await store.saveChat(chat('c', ['x']));
    await store.deleteChat('c');
    const merge = append('late');
    await expect(updateConditionalChat(store, 'c', merge)).rejects.toMatchObject({
      code: 'revision_conflict',
      actualRevision: 2,
      attempts: 1,
    });
    expect(merge.mock.calls[0]![0]).toMatchObject({ status: 'deleted' });
    expect(await updateConditionalChat(store, 'c', () => undefined)).toBeUndefined();
  });

  it('refuses a merge that returns another chat', async () => {
    const store = createInMemoryConditionalChatStore();
    await expect(updateConditionalChat(store, 'c', () => chat('other', ['x']))).rejects.toThrow(
      /other/,
    );
    await expect(
      updateConditionalChat(store, 'c', () => undefined, { attempts: 0 }),
    ).rejects.toThrow(/attempts/);
  });
});

describe('indexChat', () => {
  it('backfills a chat saved through a legacy ChatStore', async () => {
    const legacy = createInMemoryChatStore();
    legacy.saveChat(
      chatRecord('old', [
        { role: 'user', content: 'where is my parcel' },
        { role: 'assistant', content: 'it ships monday' },
      ]),
    );
    const index = createInMemoryTranscriptIndex();
    await indexChat(index, (await legacy.loadChat('old'))!);
    const [hit] = await index.search({ userId: 'ada' }, 'parcel');
    expect(hit).toMatchObject({ chatId: 'old', messageId: 'old:0', index: 0 });
  });

  it('hands the index the record with every message id filled in', async () => {
    const seen: (string[] | undefined)[] = [];
    const index = createInMemoryTranscriptIndex();
    await indexChat(
      {
        ...index,
        index: async (record) => {
          seen.push(record.messageIds);
          await index.index(record);
        },
      },
      chatRecord(
        'ids',
        [
          { role: 'user', content: 'a' },
          { role: 'user', content: 'b' },
        ],
        {
          userId: 'ada',
        },
        ['kept'],
      ),
    );
    expect(seen).toEqual([['kept', 'ids:1']]);
  });
});
