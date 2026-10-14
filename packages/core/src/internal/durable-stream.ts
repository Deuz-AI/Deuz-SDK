/**
 * The rules every `DurableStreamStateStore` shares (2.4, spec §3.4): input
 * validation, the fencing and continuation checks, the terminal test and the
 * part encoding. The memory, SQLite, Postgres and Redis stores apply them the
 * same way, so they answer the same contract.
 *
 * - Fencing: a stream keeps the highest token any producer opened it (or
 *   committed to it) with; an `open` or `commit` with a lower token is refused
 *   as `fenced`, an equal one goes through, a higher one becomes the fence.
 * - Continuation: a batch's seqs are consecutive integers (else a TypeError: a
 *   programming error, not a race) and the first is the stored last seq plus
 *   one (else `conflict`, nothing stored). An empty batch stores nothing.
 * - Terminal: the record with the highest seq is the `done` sentinel. A
 *   continued run appends past an earlier leg's sentinel, which then no longer
 *   counts.
 * - A part is stored as its JSON text and read back with `JSON.parse`, so a
 *   replay serializes byte for byte what the live response sent (a Postgres
 *   `jsonb` column would reorder the keys).
 *
 * Edge-safe.
 */
import type { StreamStateRecord } from '../ui';
import type { DurableStreamBatch } from '../types/stream-durable';

/** Throws a TypeError unless `streamId` is a nonempty string. */
export function assertStreamId(streamId: unknown): asserts streamId is string {
  if (typeof streamId !== 'string' || streamId.length === 0)
    throw new TypeError('A durable stream id must be a nonempty string.');
}

/** Throws a TypeError unless `token` is a non-negative safe integer. */
export function assertFencingToken(token: unknown): asserts token is number {
  if (!Number.isSafeInteger(token) || (token as number) < 0)
    throw new TypeError(
      `A fencing token must be a non-negative safe integer, got ${String(token)}.`,
    );
}

/** Throws a TypeError unless `seq` is a non-negative safe integer. */
export function assertSeq(seq: unknown): asserts seq is number {
  if (!Number.isSafeInteger(seq) || (seq as number) < 0)
    throw new TypeError(`A stream seq must be a non-negative safe integer, got ${String(seq)}.`);
}

/** Throws a TypeError unless `part` is an object with a string `type`. */
export function assertPart(part: unknown): asserts part is StreamStateRecord['part'] {
  if (
    typeof part !== 'object' ||
    part === null ||
    typeof (part as { type?: unknown }).type !== 'string'
  )
    throw new TypeError('A stream record part must be an object with a string `type`.');
}

/** What a valid batch holds: its first seq and whether it ends the stream. */
export interface CheckedBatch {
  streamId: string;
  token: number;
  /** The first seq; `undefined` for an empty batch. */
  first: number | undefined;
  /** The records' parts as JSON text, in seq order. */
  encoded: string[];
  /** The batch ends with the `done` sentinel. */
  done: boolean;
}

/** Validates a batch (see the module note) and encodes its parts. */
export function checkBatch(batch: DurableStreamBatch): CheckedBatch {
  if (typeof batch !== 'object' || batch === null)
    throw new TypeError('A durable stream batch must be an object.');
  assertStreamId(batch.streamId);
  assertFencingToken(batch.token);
  if (!Array.isArray(batch.records))
    throw new TypeError('A durable stream batch needs a `records` array.');
  const encoded: string[] = [];
  let first: number | undefined;
  for (const [index, record] of batch.records.entries()) {
    assertSeq(record?.seq);
    assertPart(record.part);
    if (first === undefined) first = record.seq;
    else if (record.seq !== first + index)
      throw new TypeError(
        `A durable stream batch holds consecutive seqs; seq ${record.seq} follows ${first + index - 1}.`,
      );
    encoded.push(encodePart(record.part));
  }
  const last = batch.records.at(-1);
  return {
    streamId: batch.streamId,
    token: batch.token,
    first,
    encoded,
    done: last !== undefined && isDonePart(last.part),
  };
}

/** Throws a TypeError unless `terminalBefore` is a finite number. */
export function assertTerminalBefore(options: { terminalBefore: number }): number {
  const value = (options as { terminalBefore?: unknown } | undefined)?.terminalBefore;
  if (typeof value !== 'number' || !Number.isFinite(value))
    throw new TypeError('prune needs a finite `terminalBefore` (epoch milliseconds).');
  return value;
}

/** True for the leg-end sentinel. */
export function isDonePart(part: StreamStateRecord['part']): boolean {
  return part.type === 'done';
}

/** A part as the text a store keeps. */
export function encodePart(part: StreamStateRecord['part']): string {
  return JSON.stringify(part);
}

/** A stored part. */
export function decodePart(text: string): StreamStateRecord['part'] {
  return JSON.parse(text) as StreamStateRecord['part'];
}

/** How many records one `read` page fetches from a database or Redis. */
export const READ_PAGE = 500;

/** How many streams one prune batch removes. */
export const PRUNE_PAGE = 500;
