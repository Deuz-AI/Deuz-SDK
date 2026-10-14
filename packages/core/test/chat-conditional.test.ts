/**
 * chat-conditional.test.ts (2.4) — the in-memory conditional chat store and
 * transcript index from `@deuz-sdk/core/chat`, on the shared contracts, plus
 * `indexChat` and `updateConditionalChat`.
 */
import { describe, expect, it } from 'vitest';
import { createInMemoryChatStore } from '../src/chat';
import { createInMemoryTranscriptIndex, indexChat } from '../src/chat-conditional';
import { chatRecord, transcriptIndexContracts } from './fixtures/transcript-index-conformance';

transcriptIndexContracts('in-memory transcript index', (clock) => ({
  index: createInMemoryTranscriptIndex({ deps: { clock } }),
}));

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
