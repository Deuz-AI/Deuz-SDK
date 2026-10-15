/**
 * The durable journal of a UI stream response (2.4, preview, spec §3.4):
 * persist before publish. `ui.ts` loads it with `import()` only when a
 * response sets `durable`, so the `/ui` entry pays nothing for it otherwise.
 *
 * - The producer takes the lease `stream:<streamId>`, opens the stream with
 *   the lease token (its fencing token), renews the lease every `ttlMs / 3`
 *   and gives it back at the end. When a lease prune restarted the key's
 *   tokens below the stream's stored one, the lease's holder (a renewal
 *   proves it) fences the stream one past the stored token instead.
 * - Frames are queued and committed in batches: when the queue reaches
 *   `maxBytes` (encoded), or `maxDelayMs` after its first frame, whichever
 *   comes first. One commit is in flight at a time; what arrives meanwhile
 *   waits for the next batch. A batch reaches the wire only after its commit
 *   answered `committed`, in queue order, so the client never holds a frame
 *   the store lacks.
 * - A transient frame (never journaled) rides the queue in order; with
 *   nothing queued or in flight it goes out at once.
 * - It fails closed: a fenced or conflicting commit, a lost lease or a store
 *   error halts it. The queue is dropped (nothing uncommitted is sent), the
 *   host closes the response with an error frame, and the producer stops.
 *
 * Spans (spec §3.6): `deuz.stream.batch` per commit (frames, bytes, commit
 * milliseconds) and `deuz.stream.fenced` per refusal (the fencing token).
 * Edge-safe.
 */
import type { StreamStateRecord } from '../ui';
import type { Lease } from '../types/lease';
import type { DurableStreamOptions } from '../types/stream-durable';
import { resolveDependencies } from './resolve-deps';
import { DEUZ_ATTR, DEUZ_SPAN, observeSpan, recordSpan } from './telemetry';

/** One frame of the response: journaled when it has a record, in any case these bytes on the wire. */
export interface DurableFrame {
  record?: StreamStateRecord;
  bytes: Uint8Array;
}

export interface DurableJournal {
  /** Queues a frame; dropped once the journal halted. */
  push(frame: DurableFrame): void;
  /**
   * Commits everything queued, gives the lease back, then publishes what it
   * committed: a client that starts the next leg as soon as it reads
   * `[DONE]` finds the lease free.
   */
  end(): Promise<void>;
  /** True once the journal failed closed. */
  readonly halted: boolean;
}

export interface DurableJournalHost {
  streamId: string;
  options: DurableStreamOptions;
  /** Writes bytes to the response (a no-op once the client left). */
  enqueue(bytes: Uint8Array): void;
  /** The journal failed closed with this (redacted) message: end the response. */
  onHalt(message: string): void;
  /** A thrown store or lease error, for `onStoreError`. */
  onStoreError(error: unknown): void;
}

export type DurableJournalOpen =
  | { status: 'opened'; lastSeq: number; journal: DurableJournal }
  | { status: 'refused'; message: string };

/** What a client is told when its producer fails closed: never a store's own words. */
export const DURABLE_STREAM_MESSAGES = {
  held: 'Durable stream: another producer holds this stream.',
  fenced: 'Durable stream: a newer producer took over this stream.',
  conflict: 'Durable stream: the stored stream moved past this producer.',
  leaseLost: 'Durable stream: this producer lost its lease.',
  storeFailed: 'Durable stream: the stream store failed.',
} as const;

/** The lease TTL when `lease.ttlMs` is unset, as for native runs. */
export const DEFAULT_DURABLE_LEASE_TTL_MS = 30_000;

const DEFAULT_MAX_DELAY_MS = 20;
const DEFAULT_MAX_BYTES = 16_384;

/**
 * Takes the lease and opens the stream. Refused when another producer holds
 * the lease or a newer one fenced the stream, or when the lease provider or
 * the store throws (reported to `onStoreError`).
 */
export async function openDurableJournal(host: DurableJournalHost): Promise<DurableJournalOpen> {
  const { streamId, options } = host;
  const { store } = options;
  const provider = options.lease.provider;
  const deps = resolveDependencies(options.deps);
  const clock = deps.clock;
  const ttlMs = options.lease.ttlMs ?? DEFAULT_DURABLE_LEASE_TTL_MS;
  const maxDelayMs = options.batch?.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
  const maxBytes = options.batch?.maxBytes ?? DEFAULT_MAX_BYTES;
  const fencedSpan = (token: number) =>
    recordSpan(deps, DEUZ_SPAN.streamFenced, { [DEUZ_ATTR.streamFencingToken]: token });
  const releaseLease = async (held: Lease) => {
    try {
      await provider.release(held);
    } catch {
      /* the lease expires on its own */
    }
  };

  let lease: Lease;
  let lastSeq: number;
  // The token this producer opens and commits with: its lease token, unless
  // the stream already holds a higher one while the lease is still this
  // producer's (see below).
  let fence: number;
  try {
    const acquired = await provider.acquire({
      key: `stream:${streamId}`,
      owner: options.lease.owner ?? deps.generateId(),
      ttlMs,
    });
    if (!acquired) return { status: 'refused', message: DURABLE_STREAM_MESSAGES.held };
    lease = acquired;
  } catch (error) {
    host.onStoreError(error);
    return { status: 'refused', message: DURABLE_STREAM_MESSAGES.storeFailed };
  }
  try {
    fence = lease.token;
    let opened = await store.open(streamId, fence);
    if (opened.status === 'fenced') {
      // The stream holds a higher token than this lease. Either the lease
      // changed hands after this producer took it (a newer producer owns the
      // stream: refused), or the provider pruned the released key since the
      // stream's last leg and its tokens started again at 1 (types/lease.ts).
      // A renewal tells them apart: only the lease's current holder renews.
      // The holder then fences the stream one past the stored token, so a
      // producer from before the prune is refused all the same.
      const renewal = await provider.renew(lease, ttlMs);
      if (renewal.held) {
        lease = renewal.lease;
        fence = opened.token + 1;
        opened = await store.open(streamId, fence);
      }
    }
    if (opened.status === 'fenced') {
      fencedSpan(opened.token);
      await releaseLease(lease);
      return { status: 'refused', message: DURABLE_STREAM_MESSAGES.fenced };
    }
    lastSeq = opened.lastSeq;
  } catch (error) {
    host.onStoreError(error);
    await releaseLease(lease);
    return { status: 'refused', message: DURABLE_STREAM_MESSAGES.storeFailed };
  }

  let halted = false;
  let ended = false;
  let queue: DurableFrame[] = [];
  let queuedBytes = 0;
  let cancelWindow: (() => void) | undefined;
  let cancelRenewal: (() => void) | undefined;
  let inFlight: Promise<void> | undefined;
  let flushAgain = false;
  // Once `end` began: the bytes of the batches committed since, sent after
  // the lease went back (or before the error frame of a halt).
  let ending = false;
  let tail: Uint8Array[] = [];

  const sendTail = (): void => {
    for (const bytes of tail) host.enqueue(bytes);
    tail = [];
  };

  const stopTimers = (): void => {
    cancelWindow?.();
    cancelWindow = undefined;
    cancelRenewal?.();
    cancelRenewal = undefined;
  };

  const halt = (message: string, error?: unknown): void => {
    if (halted) return;
    halted = true;
    stopTimers();
    queue = [];
    queuedBytes = 0;
    if (error !== undefined) host.onStoreError(error);
    // Committed while ending: these frames precede the error.
    sendTail();
    host.onHalt(message);
    void releaseLease(lease);
  };

  const publish = async (batch: DurableFrame[]): Promise<void> => {
    const records: StreamStateRecord[] = [];
    let bytes = 0;
    for (const frame of batch)
      if (frame.record) {
        records.push(frame.record);
        bytes += frame.bytes.byteLength;
      }
    if (records.length > 0) {
      let result;
      try {
        const startedAt = clock.now();
        result = await observeSpan(
          deps,
          DEUZ_SPAN.streamBatch,
          {
            [DEUZ_ATTR.streamBatchFrames]: records.length,
            [DEUZ_ATTR.streamBatchBytes]: bytes,
          },
          async (annotate) => {
            const committed = await store.commit({ streamId, token: fence, records });
            annotate({ [DEUZ_ATTR.streamCommitMs]: clock.now() - startedAt });
            return committed;
          },
        );
      } catch (error) {
        halt(DURABLE_STREAM_MESSAGES.storeFailed, error);
        return;
      }
      if (result.status === 'fenced') {
        fencedSpan(result.token);
        halt(DURABLE_STREAM_MESSAGES.fenced);
        return;
      }
      if (result.status === 'conflict') {
        halt(DURABLE_STREAM_MESSAGES.conflict);
        return;
      }
    }
    // Committed, but the response may have failed closed meanwhile (a lost lease).
    if (halted) return;
    for (const frame of batch)
      if (ending) tail.push(frame.bytes);
      else host.enqueue(frame.bytes);
  };

  const flush = (): void => {
    cancelWindow?.();
    cancelWindow = undefined;
    if (halted || queue.length === 0) return;
    if (inFlight) {
      flushAgain = true;
      return;
    }
    const batch = queue;
    queue = [];
    queuedBytes = 0;
    const current = publish(batch).finally(() => {
      if (inFlight === current) inFlight = undefined;
      if (halted) return;
      if (flushAgain || queuedBytes >= maxBytes) {
        flushAgain = false;
        flush();
      }
    });
    inFlight = current;
  };

  const renew = (): void => {
    cancelRenewal = clock.setTimeout(
      () => {
        cancelRenewal = undefined;
        void (async () => {
          if (halted || ended) return;
          try {
            const renewal = await provider.renew(lease, ttlMs);
            if (!renewal.held) {
              halt(DURABLE_STREAM_MESSAGES.leaseLost);
              return;
            }
            lease = renewal.lease;
          } catch {
            /* a provider hiccup: try again next time; the store fence still holds */
          }
          if (!halted && !ended) renew();
        })();
      },
      Math.max(1, Math.floor(ttlMs / 3)),
    );
  };
  renew();

  const journal: DurableJournal = {
    push(frame) {
      if (halted || ended) return;
      if (!frame.record && queue.length === 0 && !inFlight) {
        host.enqueue(frame.bytes);
        return;
      }
      queue.push(frame);
      queuedBytes += frame.bytes.byteLength;
      if (queuedBytes >= maxBytes) flush();
      else if (!cancelWindow) {
        cancelWindow = clock.setTimeout(() => {
          cancelWindow = undefined;
          flush();
        }, maxDelayMs);
      }
    },
    async end() {
      ending = true;
      while (!halted && (queue.length > 0 || inFlight)) {
        if (inFlight) await inFlight;
        else flush();
      }
      ended = true;
      stopTimers();
      if (halted) return;
      // Every frame is committed (and fenced): the lease goes back before the
      // last frames, [DONE] among them, reach the client.
      await releaseLease(lease);
      sendTail();
    },
    get halted() {
      return halted;
    },
  };
  return { status: 'opened', lastSeq, journal };
}
