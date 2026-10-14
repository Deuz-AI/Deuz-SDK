/**
 * Durable stream state (2.4, preview, spec §3.4): persist before publish. A
 * frame reaches a client only after it is committed, frames are coalesced so
 * a token is not a database round trip (20 ms or 16 KiB by default), and one
 * producer per stream is fenced by its `LeaseProvider` token written into the
 * log: a stale producer's commit is refused. A `DurableStreamStateStore` is a
 * `StreamStateStore`, so replay (`resumeDeuzStreamResponse`, Last-Event-ID)
 * reads it unchanged. In-memory in `/ui`; SQLite, Postgres and Redis in the
 * `/stores/*` entries.
 */
import type { StreamStateRecord } from '../ui';
import type { LeaseProvider } from './lease';

/** A batch of frames, committed together before any of them is sent. */
export interface DurableStreamBatch {
  streamId: string;
  /** The producer's fencing token: its lease token for the stream. */
  token: number;
  /** Consecutive `seq`s, the first one past the stream's stored last `seq`. */
  records: StreamStateRecord[];
}

/** What opening a stream for a producer did. */
export type DurableStreamOpenResult =
  /** The token is now the stream's highest; `lastSeq` is where to continue (-1 when empty). */
  | { status: 'opened'; lastSeq: number }
  /** A producer with a higher token owns the stream. */
  | { status: 'fenced'; token: number };

/** What a commit did. Nothing of a refused batch is stored. */
export type DurableStreamCommitResult =
  | { status: 'committed'; lastSeq: number }
  /** A newer producer (higher token) opened the stream: stop producing. */
  | { status: 'fenced'; token: number }
  /** The batch does not continue the stored `lastSeq`. */
  | { status: 'conflict'; lastSeq: number };

/**
 * A stream state store that commits before publish (2.4, preview). It also
 * answers the legacy `StreamStateStore` methods: `read` and `lastSeq` serve
 * replay; `append` (the legacy best-effort path) commits one record without
 * fencing and is never called by the durable serializer.
 */
export interface DurableStreamStateStore {
  /** Marks the store as durable. */
  readonly durable: true;
  /** Records `token` as the stream's highest, unless a higher one exists. */
  open(streamId: string, token: number): Promise<DurableStreamOpenResult>;
  /** Commits a batch atomically, fenced by its token. */
  commit(batch: DurableStreamBatch): Promise<DurableStreamCommitResult>;
  append(streamId: string, seq: number, part: StreamStateRecord['part']): Promise<void>;
  read(streamId: string, fromSeq?: number): AsyncIterable<StreamStateRecord>;
  lastSeq(streamId: string): Promise<number | undefined>;
  delete(streamId: string): Promise<void>;
  /**
   * Retention: deletes terminal streams (with a `done` record) whose last
   * commit is older than `terminalBefore` (epoch ms, store clock). Default
   * policy in the docs: 24 hours.
   */
  prune(options: { terminalBefore: number }): Promise<number>;
}

/** How the durable serializer coalesces frames. Defaults: 20 ms or 16 KiB, whichever first. */
export interface DurableStreamBatchOptions {
  maxDelayMs?: number;
  maxBytes?: number;
}

/** The durable mode of a UI stream response (wired into the stream options by the stream lane). */
export interface DurableStreamOptions {
  store: DurableStreamStateStore;
  /** The producer lease: key `stream:<streamId>`, its token the fencing token. */
  lease: { provider: LeaseProvider; owner?: string; ttlMs?: number };
  batch?: DurableStreamBatchOptions;
}
