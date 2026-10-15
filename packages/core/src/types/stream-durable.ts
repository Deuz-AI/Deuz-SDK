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
import type { Dependencies } from './deps';
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
 *
 * The rules every store follows:
 * - A stream keeps the highest token it was opened (or committed to) with.
 *   `open` and `commit` with a lower token are refused (`fenced`); an equal
 *   one goes through, so a producer may open again; a higher one becomes the
 *   fence, even on a commit without an `open`.
 * - A batch holds consecutive seqs (else a TypeError) starting at the stored
 *   last seq plus one (else `conflict`); an empty batch stores nothing.
 *   Ids, tokens and seqs are validated: a malformed call rejects with a
 *   TypeError.
 * - `append` replaces a record with the same seq; `lastSeq` is the highest.
 * - A part is kept as its JSON text, so a replay sends the live bytes.
 * - A stream is terminal while its highest record is the `done` sentinel; a
 *   continued run appends past it. `prune` counts the last `open`, `commit`
 *   or `append` as the stream's activity, so a stream opened again for a new
 *   leg is not pruned under it. A pruned (or deleted) stream forgets its
 *   fence: prune only streams no producer will continue.
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
   * policy: `DEFAULT_DURABLE_STREAM_RETAIN_MS` (24 hours). The cutoff is
   * exclusive. Answers how many it deleted. The store
   * clock is the injected one (memory, SQLite), the database's (Postgres) or
   * the server's `TIME` (Redis). Nothing is deleted in the background.
   */
  prune(options: { terminalBefore: number }): Promise<number>;
}

/** How the durable serializer coalesces frames. Defaults: 20 ms or 16 KiB, whichever first. */
export interface DurableStreamBatchOptions {
  /** How long the first frame of a batch waits for company, in ms (default 20; 0 or more). */
  maxDelayMs?: number;
  /** The encoded size that commits a batch at once, in bytes (default 16 384; positive). */
  maxBytes?: number;
}

/**
 * The durable mode of a UI stream response (`ToDeuzStreamOptions.durable`,
 * 2.4, preview). The response takes the producer lease, opens the stream with
 * its token, then commits every batch before it sends it. It fails closed:
 * when the lease is held by another producer or lost, when a newer producer
 * fenced it off, when the stored log moved past it, or when the store fails,
 * it sends nothing it did not commit, ends with a redacted `error` frame (no
 * event id) and no `[DONE]`, stops reading its source and hands a thrown
 * store error to `onStoreError`. A client that reconnects to the resume
 * endpoint gets every committed frame once, in order.
 */
export interface DurableStreamOptions {
  store: DurableStreamStateStore;
  /**
   * The producer lease: key `stream:<streamId>`, its token the fencing token.
   * `owner` defaults to a random id, `ttlMs` (an integer of at least 3) to
   * 30 000; the lease is renewed every `ttlMs / 3` and released at the end.
   * When the provider's `prune` removed the released key since the stream's
   * last leg, its tokens start again at 1, below the stream's fence: the
   * lease's holder (a renewal proves it still holds it) then fences the
   * stream one past the stored token, and a producer whose lease changed
   * hands is refused as before. A producer cut off past the prune cutoff
   * can hold the same token as the next holder: keep the lease retention
   * longer than any producer pause.
   */
  lease: { provider: LeaseProvider; owner?: string; ttlMs?: number };
  batch?: DurableStreamBatchOptions;
  /**
   * The seams the durable serializer uses (2.4 refinement): `clock` times the
   * coalescing window, the lease renewals and the commit latency; `observer`
   * (or `tracer`) receives the `deuz.stream.batch` and `deuz.stream.fenced`
   * spans, whose attributes are counts, bytes, milliseconds and tokens, never
   * content; `generateId` names the default lease owner. Default: the host
   * clock, no observation, a random owner.
   */
  deps?: Dependencies;
}
