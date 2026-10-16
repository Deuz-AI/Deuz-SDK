/**
 * What the SQLite and PostgreSQL conditional chat stores share (2.4): the
 * schema name and version, the scope columns, the binary-safe record and
 * message codec, and the row shapes they decode. Node-only.
 *
 * Both stores keep one row per chat in `deuz_chat_conditional`: a live chat
 * (`record` set, `deleted_at` NULL) or its tombstone (`record` NULL,
 * `deleted_at` set), with the revision either way. The transcript lives in
 * `deuz_chat_transcript`, one row per indexed message with its scope copied
 * from the chat, its folded search text (`body`) and the message itself.
 */
import type { ChatRecord } from '../chat';
import { deserializeChatRecord, serializeChatRecord } from '../chat';
import type { MemoryScope } from '../memory';
import type {
  ChatTombstone,
  ConditionalChatRead,
  ConditionalChatRecord,
  TranscriptMessage,
} from '../types/chat-conditional';
import type { Message } from '../types/message';
import type { Clock } from '../types/deps';
import { resolveDependencies } from '../internal/resolve-deps';

/** The schema-meta name: the version lives in `deuz_chat_conditional_schema`. */
export const CHAT_CONDITIONAL_SCHEMA_NAME = 'deuz_chat_conditional';
export const CHAT_CONDITIONAL_SCHEMA_VERSION = 1;

/** Rows the LIKE fallback reads before ranking them here. */
export const LIKE_SCAN_LIMIT = 1000;

/** The host clock, for a store given none. */
export const hostClock = (): Pick<Clock, 'now'> => resolveDependencies().clock;

/** The scope fields as columns, in a fixed order (statement texts stay stable). */
export const SCOPE_COLUMNS: ReadonlyArray<readonly [keyof MemoryScope, string]> = [
  ['userId', 'user_id'],
  ['agentId', 'agent_id'],
  ['runId', 'run_id'],
  ['actorId', 'actor_id'],
  ['chatId', 'scope_chat_id'],
];

/** The five scope column values of `scope`, NULL for an unset field. */
export function scopeValues(scope: MemoryScope): (string | null)[] {
  return SCOPE_COLUMNS.map(([key]) => scope[key] ?? null);
}

/** The scope a row's columns hold. */
export function scopeOfRow(row: Record<string, unknown>): MemoryScope {
  const scope: MemoryScope = {};
  for (const [key, column] of SCOPE_COLUMNS) {
    const value = row[column];
    if (typeof value === 'string') scope[key] = value;
  }
  return scope;
}

/** The record as stored: the binary-safe codec, without the revision (a column of its own). */
export function encodeRecord(record: ChatRecord): string {
  const { revision: _revision, ...rest } = record as ChatRecord & { revision?: unknown };
  return serializeChatRecord(rest);
}

/** One message through the same binary-safe codec as a record. */
export function encodeMessage(message: Message): string {
  return JSON.stringify(
    JSON.parse(serializeChatRecord({ chatId: '', scope: {}, messages: [message], updatedAt: 0 }))
      .messages[0],
  );
}

export function decodeMessage(json: string): Message {
  return deserializeChatRecord(`{"messages":[${json}]}`).messages[0]!;
}

/** A chat row as `ConditionalChatRead`; `undefined` (missing) when there is none. */
export function readOfRow(
  row: Record<string, unknown> | undefined,
  chatId: string,
): ConditionalChatRead {
  if (!row) return { status: 'missing' };
  const revision = Number(row.revision);
  if (row.deleted_at !== null && row.deleted_at !== undefined) {
    const tombstone: ChatTombstone = {
      chatId,
      scope: scopeOfRow(row),
      revision,
      deletedAt: Number(row.deleted_at),
    };
    return { status: 'deleted', tombstone };
  }
  const record: ConditionalChatRecord = {
    ...deserializeChatRecord(String(row.record)),
    revision,
  };
  return { status: 'found', record };
}

/** The stored revision of a chat row; 0 when there is none. */
export function revisionOfRow(row: Record<string, unknown> | undefined): number {
  return row ? Number(row.revision) : 0;
}

/** A transcript row as a `TranscriptMessage`. */
export function messageOfRow(row: Record<string, unknown>): TranscriptMessage {
  return {
    chatId: String(row.chat_id),
    messageId: String(row.message_id),
    index: Number(row.position),
    message: decodeMessage(String(row.message)),
  };
}

/** `%`, `_` and the escape character itself, for a LIKE pattern. */
export function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, (c) => `\\${c}`);
}
