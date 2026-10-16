/**
 * The in-memory durable stream state store (2.4, preview), published from
 * `@deuz-sdk/core/ui`. The contract is in `types/stream-durable.ts`; the
 * rules every store shares are in `internal/durable-stream.ts`.
 * Edge-safe.
 */
import type { Dependencies } from './types/deps';
import type { DurableStreamStateStore } from './types/stream-durable';
import type { StreamStateRecord } from './ui';
import { resolveDependencies } from './internal/resolve-deps';
import {
  assertFencingToken,
  assertPart,
  assertSeq,
  assertStreamId,
  assertTerminalBefore,
  checkBatch,
  decodePart,
  encodePart,
  isDonePart,
} from './internal/durable-stream';

/** The coalescing defaults of the durable serializer: 20 ms or 16 KiB, whichever first. */
export const DEFAULT_DURABLE_STREAM_BATCH = { maxDelayMs: 20, maxBytes: 16_384 } as const;

/**
 * How long a terminal stream stays replayable by default (spec §4.4): 24
 * hours. Nothing is deleted in the background; the host prunes, e.g. on a
 * durable schedule:
 * `store.prune({ terminalBefore: Date.now() - DEFAULT_DURABLE_STREAM_RETAIN_MS })`
 * (the store clock: the database's for Postgres, the server's for Redis).
 */
export const DEFAULT_DURABLE_STREAM_RETAIN_MS = 24 * 60 * 60 * 1_000;

interface StoredRecord {
  seq: number;
  /** The part as JSON text: a read hands out a fresh copy, as a database would. */
  text: string;
}

interface StoredStream {
  /** The highest fencing token an opener or a commit brought. */
  token: number;
  /** In seq order. */
  records: StoredRecord[];
  /** Store-clock time of the last open, commit or append. */
  touchedAt: number;
}

/**
 * The in-memory `DurableStreamStateStore` (2.4, preview): commits are atomic
 * per batch, fenced by the highest token a producer opened the stream with.
 * For tests and a single process: its streams die with it. `deps.clock`
 * stamps each open, commit and append, which is the time `prune` compares.
 */
export function createInMemoryDurableStreamStateStore(
  options: {
    deps?: Dependencies;
  } = {},
): DurableStreamStateStore {
  const clock = resolveDependencies(options.deps).clock;
  const streams = new Map<string, StoredStream>();
  const stream = (streamId: string): StoredStream => {
    let found = streams.get(streamId);
    if (!found) {
      found = { token: 0, records: [], touchedAt: clock.now() };
      streams.set(streamId, found);
    }
    return found;
  };
  const lastOf = (found: StoredStream | undefined): number => found?.records.at(-1)?.seq ?? -1;

  return {
    durable: true,

    async open(streamId, token) {
      assertStreamId(streamId);
      assertFencingToken(token);
      const found = stream(streamId);
      if (found.token > token) return { status: 'fenced', token: found.token };
      found.token = token;
      found.touchedAt = clock.now();
      return { status: 'opened', lastSeq: lastOf(found) };
    },

    async commit(batch) {
      const checked = checkBatch(batch);
      const found = streams.get(checked.streamId);
      if (found && found.token > checked.token) return { status: 'fenced', token: found.token };
      const last = lastOf(found);
      if (checked.first !== undefined && checked.first !== last + 1)
        return { status: 'conflict', lastSeq: last };
      const target = found ?? stream(checked.streamId);
      target.token = checked.token;
      target.touchedAt = clock.now();
      checked.encoded.forEach((text, index) =>
        target.records.push({ seq: last + 1 + index, text }),
      );
      return { status: 'committed', lastSeq: lastOf(target) };
    },

    async append(streamId, seq, part) {
      assertStreamId(streamId);
      assertSeq(seq);
      assertPart(part);
      const found = stream(streamId);
      const record = { seq, text: encodePart(part) };
      // Replace a record with this seq, else insert it in seq order.
      let index = found.records.length;
      while (index > 0 && found.records[index - 1]!.seq > seq) index--;
      if (index > 0 && found.records[index - 1]!.seq === seq) found.records[index - 1] = record;
      else found.records.splice(index, 0, record);
      found.touchedAt = clock.now();
    },

    async *read(streamId, fromSeq = -1) {
      // A snapshot: what is appended during the iteration belongs to the next read.
      const snapshot = [...(streams.get(streamId)?.records ?? [])];
      for (const record of snapshot)
        if (record.seq > fromSeq)
          yield { seq: record.seq, part: decodePart(record.text) } satisfies StreamStateRecord;
    },

    async lastSeq(streamId) {
      return streams.get(streamId)?.records.at(-1)?.seq;
    },

    async delete(streamId) {
      streams.delete(streamId);
    },

    async prune(pruneOptions) {
      const terminalBefore = assertTerminalBefore(pruneOptions);
      let removed = 0;
      for (const [streamId, found] of streams) {
        const tail = found.records.at(-1);
        if (!tail || found.touchedAt >= terminalBefore) continue;
        if (!isDonePart(decodePart(tail.text))) continue;
        streams.delete(streamId);
        removed++;
      }
      return removed;
    },
  };
}
