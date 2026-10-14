/**
 * Conditional chat persistence and transcript search (2.4, spec §3.4 and
 * §2.4). A `ConditionalChatStore` is a `ChatStore` whose writes are
 * compare-and-set on a revision and whose deletes leave a tombstone, so a late
 * projection can never bring a deleted chat back. A `TranscriptIndex` searches
 * past messages lexically within a scope and resolves a memory source
 * reference to its message. The legacy `ChatStore`s (memory, file, SQLite,
 * Postgres, Redis) are unchanged; the SQLite and Postgres conditional stores
 * use new tables with their own schema version and update their index in the
 * same transaction.
 */
import type { ChatRecord } from '../chat';
import type { MemoryScope } from '../memory';
import type { MemorySourceRef } from '../memory/versioned/types';
import type { Message } from './message';

/** A chat record with its revision (2.4). */
export interface ConditionalChatRecord extends ChatRecord {
  /** 1 for a new chat, plus one on every committed write. */
  revision: number;
}

/** What a deleted chat leaves behind: enough to refuse a late write, no messages. */
export interface ChatTombstone {
  chatId: string;
  scope: MemoryScope;
  /** The revision the delete wrote. */
  revision: number;
  deletedAt: number;
}

/** A revisioned read. */
export type ConditionalChatRead =
  | { status: 'found'; record: ConditionalChatRecord }
  | { status: 'missing' }
  | { status: 'deleted'; tombstone: ChatTombstone };

/** What a conditional write or delete did. */
export type ConditionalChatWriteResult =
  | { status: 'committed'; record: ConditionalChatRecord }
  | { status: 'deleted'; tombstone: ChatTombstone }
  /** The stored revision is not the expected one (or the chat is a tombstone): nothing written. */
  | { status: 'conflict'; current: ConditionalChatRead };

/**
 * A `ChatStore` with compare-and-set writes and tombstone deletes (2.4):
 * in-memory in `/chat`, SQLite and Postgres in `/stores/sqlite` and
 * `/stores/postgres`. Pass it wherever a `ChatStore` goes; the native chat
 * projection uses `writeChat` when the store has it (its legacy fingerprint
 * repair path stays for every other store). The legacy `saveChat` writes at
 * the stored revision plus one but never over a tombstone (it throws
 * `RevisionConflictError` then), and `deleteChat` tombstones.
 */
export interface ConditionalChatStore {
  /** Marks the store as conditional, so callers can tell it from a legacy one. */
  readonly conditional: true;
  /** The chat with its revision, or why there is none. */
  readChat(chatId: string): Promise<ConditionalChatRead>;
  /**
   * Writes `record` only when the stored revision is `expectedRevision` (0:
   * the chat must not exist, nor its tombstone), as revision
   * `expectedRevision + 1`; the store's transcript index is updated in the
   * same transaction. A writer re-reads and merges on `'conflict'`, three
   * attempts in all, then throws `RevisionConflictError`.
   */
  writeChat(
    record: ChatRecord,
    options: { expectedRevision: number },
  ): Promise<ConditionalChatWriteResult>;
  /**
   * Replaces the chat by a tombstone at `expectedRevision + 1` and drops it
   * from the transcript index; `'conflict'` when the revision moved.
   */
  tombstoneChat(
    chatId: string,
    options: { expectedRevision: number },
  ): Promise<ConditionalChatWriteResult>;
  /** The legacy write: last writer wins, revision plus one, never over a tombstone. */
  saveChat(record: ChatRecord): Promise<void>;
  /** The legacy read: the record (with its `revision`), absent for a missing or deleted chat. */
  loadChat(chatId: string): Promise<ConditionalChatRecord | undefined>;
  /** Tombstones the chat at whatever revision is stored. */
  deleteChat(chatId: string): Promise<void>;
  listChats(scope?: MemoryScope): Promise<string[]>;
  /** Retention: deletes tombstones older than `before` (epoch ms); a pruned id can be reused. */
  pruneTombstones(before: number): Promise<number>;
}

/** Options of `TranscriptIndex.search`. */
export interface TranscriptSearchOptions {
  /** Hits at most. Default 10. */
  limit?: number;
  /** Surrounding messages to return on each side of a hit. Default 0. */
  around?: number;
  /** Only these chats. */
  chatIds?: readonly string[];
  /** Only messages indexed before / after this time (epoch ms, the store's clock). */
  before?: number;
  after?: number;
  signal?: AbortSignal;
}

/** One message of a chat, with its stable id and position. */
export interface TranscriptMessage {
  chatId: string;
  messageId: string;
  /** Its index in the chat's messages. */
  index: number;
  message: Message;
}

/** One search hit: the message, its score, and the messages around it when asked. */
export interface TranscriptHit extends TranscriptMessage {
  score: number;
  /** The `around` messages before and after it, in order, the hit excluded. */
  around?: TranscriptMessage[];
}

/**
 * Lexical search over past messages (2.4): FTS5 in SQLite (LIKE where FTS5 is
 * missing), `tsvector` with a GIN index in Postgres, simple matching in
 * memory. No embeddings in 2.4.
 */
export interface TranscriptIndex {
  /** Indexes a chat: replaces whatever was indexed for it before. */
  index(record: ChatRecord): Promise<void>;
  /** Drops a chat (a tombstone or a delete drops it too). */
  remove(chatId: string): Promise<void>;
  /**
   * Messages matching `query` in chats whose scope matches every field set in
   * `scope` (as `listChats(scope)` does), best first. Never crosses scopes.
   */
  search(
    scope: MemoryScope,
    query: string,
    options?: TranscriptSearchOptions,
  ): Promise<TranscriptHit[]>;
  /**
   * Resolves a memory source reference (`chatId` + `messageId`) to its
   * message, under the same scope check; undefined when the chat is gone, the
   * message is unknown or the chat is outside `scope`.
   */
  resolveSource(scope: MemoryScope, ref: MemorySourceRef): Promise<TranscriptMessage | undefined>;
}
