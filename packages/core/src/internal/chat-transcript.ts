/**
 * The transcript rules every `TranscriptIndex` backend shares (2.4, spec
 * §2.4): which messages of a chat are indexed and under which stable id, what
 * text of a message is searchable, how a query becomes terms, the scope test
 * of search and `resolveSource`, and the search defaults. Lexical only: no
 * embeddings. Edge-safe.
 *
 * Text is folded before it is stored or matched (NFKD, combining marks
 * dropped, lower case), the way SQLite FTS5's default `unicode61` tokenizer
 * folds, so `İzmir`, `IZMIR` and `izmir` are one term in every backend. A
 * message's stored text is capped at `MAX_INDEXED_TEXT_BYTES` and U+0000
 * becomes a space, so every backend can store every message and holds the
 * same terms of it.
 */
import type { ChatRecord } from '../chat';
import type { MemoryScope } from '../memory';
import type { TranscriptSearchOptions } from '../types/chat-conditional';
import type { Message } from '../types/message';
import { InvalidRequestError, RevisionConflictError } from '../errors';
import { scopeWithin } from './native-scope';

/** Hits a search returns when `limit` is not set. */
export const DEFAULT_TRANSCRIPT_LIMIT = 10;

/** Terms a query keeps at most: the rest is ignored. */
export const MAX_QUERY_TERMS = 32;

/**
 * The most of a message's folded text an index holds, in UTF-8 bytes: 256 KiB,
 * cut before the term the limit falls in. A larger message (a log dump, a
 * file read whole) is searchable by the terms of its first 256 KiB in every
 * backend, and its Postgres `tsvector` stays well under the 1 MB a
 * `tsvector` may take, past which the whole chat write would fail.
 */
export const MAX_INDEXED_TEXT_BYTES = 262_144;

/** Attempts of a conditional chat write against concurrent writers, the first included. */
export const CHAT_WRITE_ATTEMPTS = 3;

/** One indexed message: its stable id, position, the message and its folded text. */
export interface TranscriptEntry {
  messageId: string;
  index: number;
  message: Message;
  /** The folded searchable text; empty for a message with none (it is kept for `around`). */
  text: string;
}

/**
 * A stable id per message of `record`: its `messageIds[i]` when that is a
 * non-empty string no earlier message took, otherwise `<chatId>:<i>`
 * (suffixed `:<n>` in the rare case a stored id already is that).
 */
export function stableMessageIds(record: ChatRecord): string[] {
  const stored = record.messageIds ?? [];
  const first = new Map<string, number>();
  stored.forEach((id, index) => {
    if (index < record.messages.length && typeof id === 'string' && id !== '' && !first.has(id))
      first.set(id, index);
  });
  const taken = new Set(first.keys());
  return record.messages.map((_message, index) => {
    const id = stored[index];
    if (typeof id === 'string' && first.get(id) === index) return id;
    let fallback = `${record.chatId}:${index}`;
    for (let n = 1; taken.has(fallback); n++) fallback = `${record.chatId}:${index}:${n}`;
    taken.add(fallback);
    return fallback;
  });
}

/** Folds case and diacritics: NFKD, combining marks dropped, lower case. */
export function foldText(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase();
}

/**
 * A message's searchable text, folded: its string content, its `text` parts
 * and its string tool results, one per line. Reasoning, tool inputs, images
 * and structured tool results are not searched. U+0000 becomes a space
 * (Postgres refuses it in text, SQLite's LIKE stops at it), and the text is
 * capped at `MAX_INDEXED_TEXT_BYTES`.
 */
export function searchText(message: Message): string {
  if (typeof message.content === 'string') return indexedText(message.content);
  const pieces: string[] = [];
  for (const part of message.content) {
    if (part.type === 'text') pieces.push(part.text);
    else if (part.type === 'tool_result' && typeof part.result === 'string')
      pieces.push(part.result);
  }
  return indexedText(pieces.join('\n'));
}

const TERM_CHAR = /^[\p{L}\p{N}]$/u;

/** Whether the code point starting at `index` is a term character (letter or digit). */
const termCharAt = (text: string, index: number): boolean =>
  TERM_CHAR.test(String.fromCodePoint(text.codePointAt(index)!));

/** Folded, U+0000 as a space, and at most `MAX_INDEXED_TEXT_BYTES` of UTF-8. */
function indexedText(text: string): string {
  const folded = foldText(text).replaceAll('\u0000', ' ');
  // A UTF-16 unit is at most three UTF-8 bytes: a short text needs no count.
  if (folded.length * 3 <= MAX_INDEXED_TEXT_BYTES) return folded;
  let bytes = 0;
  let end = 0;
  for (const char of folded) {
    const code = char.codePointAt(0)!;
    const size = code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
    if (bytes + size > MAX_INDEXED_TEXT_BYTES) break;
    bytes += size;
    end += char.length;
  }
  if (end === folded.length || !termCharAt(folded, end)) return folded.slice(0, end);
  // The head of a term the limit cuts through is no term of the message:
  // step back over it, a code point at a time (a low surrogate with its pair).
  while (end > 0) {
    const low = folded.charCodeAt(end - 1);
    const high = end >= 2 ? folded.charCodeAt(end - 2) : 0;
    const width = low >= 0xdc00 && low <= 0xdfff && high >= 0xd800 && high <= 0xdbff ? 2 : 1;
    if (!termCharAt(folded, end - width)) break;
    end -= width;
  }
  return folded.slice(0, end);
}

/** The messages of `record` an index holds: all but system ones, each with its stable id. */
export function transcriptEntries(record: ChatRecord): TranscriptEntry[] {
  const ids = stableMessageIds(record);
  const entries: TranscriptEntry[] = [];
  record.messages.forEach((message, index) => {
    if (message.role === 'system') return;
    entries.push({ messageId: ids[index]!, index, message, text: searchText(message) });
  });
  return entries;
}

const TERM = /[\p{L}\p{N}]+/gu;

/** The folded terms of a text, in order, repeats included. */
export function textTerms(text: string): string[] {
  return foldText(text).match(TERM) ?? [];
}

/**
 * The distinct folded terms of a query, at most `MAX_QUERY_TERMS`. Any
 * character but a letter or digit separates terms, so a query is never parsed
 * as a backend's query syntax.
 */
export function queryTerms(query: string): string[] {
  return [...new Set(textTerms(query))].slice(0, MAX_QUERY_TERMS);
}

/** Every field `filter` sets is the same on the chat's scope (as `listChats(scope)` matches). */
export function scopeMatches(chat: MemoryScope, filter: MemoryScope): boolean {
  return scopeWithin(chat, filter);
}

/** `search` options with their defaults applied. */
export interface ResolvedSearchOptions {
  limit: number;
  around: number;
  chatIds?: ReadonlySet<string>;
  before?: number;
  after?: number;
}

function count(name: string, value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value < 0)
    throw new InvalidRequestError({
      message: `TranscriptIndex.search: ${name} must be a non-negative number.`,
    });
  return Math.floor(value);
}

/** Applies the defaults (`limit` 10, `around` 0); a negative or non-finite count throws. */
export function resolveSearchOptions(options: TranscriptSearchOptions = {}): ResolvedSearchOptions {
  options.signal?.throwIfAborted();
  return {
    limit: count('limit', options.limit, DEFAULT_TRANSCRIPT_LIMIT),
    around: count('around', options.around, 0),
    ...(options.chatIds !== undefined ? { chatIds: new Set(options.chatIds) } : {}),
    ...(options.before !== undefined ? { before: options.before } : {}),
    ...(options.after !== undefined ? { after: options.after } : {}),
  };
}

/** A ranked candidate before its score is normalized. */
export interface RankedMessage {
  chatId: string;
  index: number;
  indexedAt: number;
  raw: number;
}

/** Best first: higher raw score, then the newer message, then chat id and position. */
export function compareRanked(a: RankedMessage, b: RankedMessage): number {
  return (
    b.raw - a.raw ||
    b.indexedAt - a.indexedAt ||
    (a.chatId < b.chatId ? -1 : a.chatId > b.chatId ? 1 : 0) ||
    a.index - b.index
  );
}

/** A raw score as a fraction of the best one, so the top hit scores 1. */
export function normalizeScore(raw: number, best: number): number {
  return best > 0 ? raw / best : 1;
}

/** Throws unless `value` is a revision a conditional write can expect: an integer from 0. */
export function assertExpectedRevision(method: string, value: number): void {
  if (!Number.isInteger(value) || value < 0)
    throw new InvalidRequestError({
      message: `ConditionalChatStore.${method}: expectedRevision must be an integer from 0, got ${String(value)}.`,
    });
}

/** What a write over a tombstone throws: the chat was deleted and stays so until pruned. */
export function deletedChatError(chatId: string, revision: number, attempts?: number): Error {
  return new RevisionConflictError({
    subsystem: 'chat',
    key: chatId,
    actualRevision: revision,
    ...(attempts !== undefined ? { attempts } : {}),
    message: `Chat '${chatId}' was deleted (tombstone at revision ${revision}); a write cannot bring it back.`,
  });
}
