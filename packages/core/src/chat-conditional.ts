/**
 * In-memory conditional chat store and transcript index (2.4), published from
 * `@deuz-sdk/core/chat`. The contracts are in `types/chat-conditional.ts`; the
 * transcript rules every backend shares are in `internal/chat-transcript.ts`.
 * Edge-safe.
 */
import type { ChatRecord, ChatStore } from './chat';
import type { MemoryScope } from './memory';
import type { Dependencies } from './types/deps';
import type {
  ChatTombstone,
  ConditionalChatMerge,
  ConditionalChatRead,
  ConditionalChatRecord,
  ConditionalChatStore,
  ConditionalChatWriteResult,
  TranscriptHit,
  TranscriptIndex,
  TranscriptMessage,
  UpdateConditionalChatOptions,
} from './types/chat-conditional';
import { InvalidRequestError, RevisionConflictError } from './errors';
import { resolveDependencies } from './internal/resolve-deps';
import {
  CHAT_WRITE_ATTEMPTS,
  assertExpectedRevision,
  compareRanked,
  deletedChatError,
  normalizeScore,
  queryTerms,
  resolveSearchOptions,
  scopeMatches,
  stableMessageIds,
  textTerms,
  transcriptEntries,
  type RankedMessage,
} from './internal/chat-transcript';

/** Options of `createInMemoryConditionalChatStore`. */
export interface InMemoryConditionalChatStoreOptions {
  /** An index kept in step with every write and tombstone. */
  transcript?: TranscriptIndex;
  /** The clock for `deletedAt` and tombstone pruning. */
  deps?: Dependencies;
}

type StoredChat =
  | { status: 'found'; record: ConditionalChatRecord }
  | { status: 'deleted'; tombstone: ChatTombstone };

/** The stored revision, 0 for a chat that does not exist. */
const revisionOf = (stored: StoredChat | ConditionalChatRead | undefined): number =>
  stored?.status === 'found'
    ? stored.record.revision
    : stored?.status === 'deleted'
      ? stored.tombstone.revision
      : 0;

/** A record as the store keeps it: its own copy, at `revision`. */
function atRevision(record: ChatRecord, revision: number): ConditionalChatRecord {
  const { revision: _caller, ...rest } = record as ChatRecord & { revision?: unknown };
  return { ...structuredClone(rest), revision };
}

/**
 * The in-memory `ConditionalChatStore` (2.4): copies in and out, revisions
 * and tombstones as the contract says, and `transcript` updated with every
 * committed write. Writes run one at a time; one whose index update fails
 * commits nothing.
 */
export function createInMemoryConditionalChatStore(
  options?: InMemoryConditionalChatStoreOptions,
): ConditionalChatStore {
  const chats = new Map<string, StoredChat>();
  const transcript = options?.transcript;
  const { clock } = resolveDependencies(options?.deps);
  let tail: Promise<unknown> = Promise.resolve();
  const serialize = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = tail.then(fn, fn);
    tail = next.catch(() => undefined);
    return next;
  };
  const read = (chatId: string): ConditionalChatRead => {
    const stored = chats.get(chatId);
    if (!stored) return { status: 'missing' };
    return stored.status === 'found'
      ? { status: 'found', record: structuredClone(stored.record) }
      : { status: 'deleted', tombstone: structuredClone(stored.tombstone) };
  };
  const commit = async (record: ChatRecord, revision: number): Promise<ConditionalChatRecord> => {
    const next = atRevision(record, revision);
    await transcript?.index(structuredClone(next));
    chats.set(next.chatId, { status: 'found', record: next });
    return structuredClone(next);
  };
  const bury = async (chatId: string, revision: number): Promise<ChatTombstone> => {
    const stored = chats.get(chatId);
    const tombstone: ChatTombstone = {
      chatId,
      scope: stored?.status === 'found' ? { ...stored.record.scope } : {},
      revision,
      deletedAt: clock.now(),
    };
    await transcript?.remove(chatId);
    chats.set(chatId, { status: 'deleted', tombstone });
    return structuredClone(tombstone);
  };

  return {
    conditional: true,

    async readChat(chatId) {
      return read(chatId);
    },

    async writeChat(record, { expectedRevision }) {
      assertExpectedRevision('writeChat', expectedRevision);
      return serialize(async (): Promise<ConditionalChatWriteResult> => {
        const stored = chats.get(record.chatId);
        if (stored?.status === 'deleted' || revisionOf(stored) !== expectedRevision)
          return { status: 'conflict', current: read(record.chatId) };
        return { status: 'committed', record: await commit(record, expectedRevision + 1) };
      });
    },

    async tombstoneChat(chatId, { expectedRevision }) {
      assertExpectedRevision('tombstoneChat', expectedRevision);
      return serialize(async (): Promise<ConditionalChatWriteResult> => {
        const stored = chats.get(chatId);
        if (stored?.status === 'deleted' || revisionOf(stored) !== expectedRevision)
          return { status: 'conflict', current: read(chatId) };
        return { status: 'deleted', tombstone: await bury(chatId, expectedRevision + 1) };
      });
    },

    saveChat(record) {
      return serialize(async () => {
        const stored = chats.get(record.chatId);
        if (stored?.status === 'deleted')
          throw deletedChatError(record.chatId, stored.tombstone.revision);
        await commit(record, revisionOf(stored) + 1);
      });
    },

    async loadChat(chatId) {
      const stored = chats.get(chatId);
      return stored?.status === 'found' ? structuredClone(stored.record) : undefined;
    },

    deleteChat(chatId) {
      return serialize(async () => {
        const stored = chats.get(chatId);
        if (stored?.status !== 'deleted') await bury(chatId, revisionOf(stored) + 1);
      });
    },

    async listChats(scope) {
      const live: ConditionalChatRecord[] = [];
      for (const stored of chats.values())
        if (stored.status === 'found' && (!scope || scopeMatches(stored.record.scope, scope)))
          live.push(stored.record);
      return live
        .sort(
          (a, b) =>
            b.updatedAt - a.updatedAt || (a.chatId < b.chatId ? -1 : a.chatId > b.chatId ? 1 : 0),
        )
        .map((record) => record.chatId);
    },

    async pruneTombstones(before) {
      assertTombstoneCutoff(before);
      return serialize(async () => {
        let pruned = 0;
        for (const [chatId, stored] of chats)
          if (stored.status === 'deleted' && stored.tombstone.deletedAt < before) {
            chats.delete(chatId);
            pruned++;
          }
        return pruned;
      });
    },
  };
}

/**
 * `pruneTombstones`' cutoff, checked before anything is deleted: a finite
 * epoch-ms time on the store clock, else `InvalidRequestError`, as the
 * conditional chat stores refuse other malformed arguments.
 */
export function assertTombstoneCutoff(before: unknown): asserts before is number {
  if (typeof before !== 'number' || !Number.isFinite(before))
    throw new InvalidRequestError({
      message: `ConditionalChatStore.pruneTombstones: before must be a finite epoch-ms time, got ${String(before)}.`,
    });
}

/** True for a store with the conditional surface (`conditional: true`, `readChat`, `writeChat`). */
export function isConditionalChatStore(
  store: ChatStore | ConditionalChatStore,
): store is ConditionalChatStore {
  const candidate = store as Partial<ConditionalChatStore>;
  return (
    candidate.conditional === true &&
    typeof candidate.readChat === 'function' &&
    typeof candidate.writeChat === 'function'
  );
}

/**
 * Read, merge, compare-and-set (2.4): reads the chat, asks `merge` for the
 * record to write, and writes it at the revision it read. On a conflict it
 * reads again and merges onto what the other writer stored, three attempts in
 * all (`options.attempts`), then throws `RevisionConflictError`. A tombstone
 * is final: when `merge` still returns a record for a deleted chat, it throws
 * at once. Returns the committed record, or `undefined` when `merge` declined.
 */
export async function updateConditionalChat(
  store: ConditionalChatStore,
  chatId: string,
  merge: ConditionalChatMerge,
  options: UpdateConditionalChatOptions = {},
): Promise<ConditionalChatRecord | undefined> {
  const attempts = options.attempts ?? CHAT_WRITE_ATTEMPTS;
  if (!Number.isInteger(attempts) || attempts < 1)
    throw new InvalidRequestError({
      message: `updateConditionalChat: attempts must be an integer from 1, got ${String(attempts)}.`,
    });
  let expectedRevision = 0;
  let current: ConditionalChatRead = { status: 'missing' };
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const read = await store.readChat(chatId);
    const next = await merge(read, attempt);
    if (next === undefined) return undefined;
    if (next.chatId !== chatId)
      throw new InvalidRequestError({
        message: `updateConditionalChat: the merge for chat '${chatId}' returned chat '${next.chatId}'.`,
      });
    if (read.status === 'deleted') throw deletedChatError(chatId, read.tombstone.revision, attempt);
    expectedRevision = revisionOf(read);
    const result = await store.writeChat(next, { expectedRevision });
    if (result.status === 'committed') return result.record;
    if (result.status === 'conflict') current = result.current;
  }
  throw new RevisionConflictError({
    subsystem: 'chat',
    key: chatId,
    expectedRevision,
    ...(current.status !== 'missing' ? { actualRevision: revisionOf(current) } : {}),
    attempts,
  });
}

interface IndexedMessage extends TranscriptMessage {
  /** Folded term counts of the message's searchable text. */
  terms: Map<string, number>;
  /** When this message id was first indexed (the store clock). */
  indexedAt: number;
}

interface IndexedChat {
  scope: MemoryScope;
  messages: IndexedMessage[];
}

const transcriptMessage = (message: IndexedMessage): TranscriptMessage => ({
  chatId: message.chatId,
  messageId: message.messageId,
  index: message.index,
  message: structuredClone(message.message),
});

/**
 * The in-memory `TranscriptIndex` (2.4): case- and diacritic-insensitive
 * whole-term matching, scope-checked. A hit's raw score is how many distinct
 * query terms its message holds; ties go to the newer message.
 */
export function createInMemoryTranscriptIndex(options?: { deps?: Dependencies }): TranscriptIndex {
  const chats = new Map<string, IndexedChat>();
  const { clock } = resolveDependencies(options?.deps);
  return {
    async index(record) {
      const at = clock.now();
      const firstIndexed = new Map(
        (chats.get(record.chatId)?.messages ?? []).map((message) => [
          message.messageId,
          message.indexedAt,
        ]),
      );
      const messages = transcriptEntries(structuredClone(record)).map((entry) => {
        const terms = new Map<string, number>();
        for (const term of textTerms(entry.text)) terms.set(term, (terms.get(term) ?? 0) + 1);
        return {
          chatId: record.chatId,
          messageId: entry.messageId,
          index: entry.index,
          message: entry.message,
          terms,
          indexedAt: firstIndexed.get(entry.messageId) ?? at,
        };
      });
      chats.set(record.chatId, { scope: { ...record.scope }, messages });
    },

    async remove(chatId) {
      chats.delete(chatId);
    },

    async search(scope, query, searchOptions) {
      const resolved = resolveSearchOptions(searchOptions);
      const terms = queryTerms(query);
      if (terms.length === 0 || resolved.limit === 0) return [];
      const ranked: (RankedMessage & { chat: IndexedChat; position: number })[] = [];
      for (const [chatId, chat] of chats) {
        if (resolved.chatIds && !resolved.chatIds.has(chatId)) continue;
        if (!scopeMatches(chat.scope, scope)) continue;
        chat.messages.forEach((message, position) => {
          if (resolved.before !== undefined && !(message.indexedAt < resolved.before)) return;
          if (resolved.after !== undefined && !(message.indexedAt > resolved.after)) return;
          const raw = terms.filter((term) => message.terms.has(term)).length;
          if (raw > 0)
            ranked.push({
              chatId,
              index: message.index,
              indexedAt: message.indexedAt,
              raw,
              chat,
              position,
            });
        });
      }
      ranked.sort(compareRanked);
      const best = ranked[0]?.raw ?? 0;
      return ranked.slice(0, resolved.limit).map((entry): TranscriptHit => {
        const hit: TranscriptHit = {
          ...transcriptMessage(entry.chat.messages[entry.position]!),
          score: normalizeScore(entry.raw, best),
        };
        if (resolved.around > 0) {
          const { messages } = entry.chat;
          hit.around = [
            ...messages.slice(Math.max(0, entry.position - resolved.around), entry.position),
            ...messages.slice(entry.position + 1, entry.position + 1 + resolved.around),
          ].map(transcriptMessage);
        }
        return hit;
      });
    },

    async resolveSource(scope, ref) {
      if (ref.chatId === undefined || ref.messageId === undefined) return undefined;
      const chat = chats.get(ref.chatId);
      if (!chat || !scopeMatches(chat.scope, scope)) return undefined;
      const message = chat.messages.find((candidate) => candidate.messageId === ref.messageId);
      return message ? transcriptMessage(message) : undefined;
    },
  };
}

/**
 * Indexes a chat saved through a legacy `ChatStore` (2.4): the backfill and
 * the explicit sync step for stores that do not index in their own write
 * transaction. Messages without stable ids get `<chatId>:<index>`.
 */
export async function indexChat(index: TranscriptIndex, record: ChatRecord): Promise<void> {
  await index.index({ ...record, messageIds: stableMessageIds(record) });
}
