/**
 * Lane L7b acceptance scenarios (spec §5.1, area chat-stream-react): the
 * durable stream (spec §3.4).
 *
 * - persist-before-publish (fault): producers crash after a commit landed but
 *   before its frames went out, and before a commit landed. A client that
 *   reconnects to the resume endpoint gets every committed frame exactly
 *   once, in order, and never a frame the store lacks. Runs on the memory
 *   store and, where `node:sqlite` exists, on SQLite.
 * - producer-fencing: a producer whose lease lapsed while it was cut off is
 *   fenced by the newer one's token: its next commit is refused, nothing it
 *   did not commit reaches its client, it stops, and the log continues
 *   gapless under the new producer.
 *
 * Every store, clock, lease provider and source is built inside the scenario.
 */
import { expect } from 'vitest';
import {
  connectDeuzStream,
  createInMemoryDurableStreamStateStore,
  resumeDeuzStreamResponse,
  toDeuzStreamResponse,
  type DeuzUIPart,
  type DurableStreamStateStore,
} from '../../src/ui';
import { createInMemoryLeaseProvider } from '../../src/ops';
import { createMemoryObserver } from '../../src/observe';
import { createSqliteDurableStreamStateStore } from '../../src/node/stream-state-sqlite';
import type { Lease, LeaseProvider } from '../../src/types/lease';
import { readAll } from '../fixtures/durable-stream-store-conformance';
import { immediateClock, settleImmediate } from '../fixtures/immediate-clock';
import { bodyReader, manualResult, sseFrames, textPart } from '../fixtures/manual-stream';
import { scenario } from './registry';

let sqliteAvailable = true;
try {
  await import('node:sqlite' as string);
} catch {
  sqliteAvailable = false;
}

/** A timer for the client and the resume poll loop: real turns, never the platform timer resolution. */
const turn = {
  setTimeout(fn: () => void) {
    const id = setImmediate(fn);
    return () => clearImmediate(id);
  },
};

/** Waits (in real turns) until `condition` holds. */
async function until(condition: () => boolean, what: string): Promise<void> {
  const deadline = performance.now() + 5_000;
  while (!condition()) {
    if (performance.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await settleImmediate(1);
  }
}

/** A lease provider whose holders never give a lease back: they crash instead. */
function crashingHolders(inner: LeaseProvider): LeaseProvider {
  return {
    ...inner,
    acquire: (request) => inner.acquire(request),
    renew: (lease, ttlMs, options) => inner.renew(lease, ttlMs, options),
    release: async () => {},
    signal: (key, signal) => inner.signal(key, signal),
  };
}

/**
 * The store as one producer process sees it: `crashAfterCommit` makes the
 * process die right after its next commit landed (the commit is stored, the
 * call never returns to it); `crashBeforeCommit` makes it die before its next
 * commit reaches the store.
 */
function processView(store: DurableStreamStateStore, crash?: 'after' | 'before') {
  let armed = false;
  const view: DurableStreamStateStore = {
    durable: true,
    open: (streamId, token) => store.open(streamId, token),
    async commit(batch) {
      if (armed && crash === 'before') throw new Error('process died before its commit');
      const result = await store.commit(batch);
      if (armed && crash === 'after') throw new Error('process died after its commit');
      return result;
    },
    append: (streamId, seq, part) => store.append(streamId, seq, part),
    read: (streamId, fromSeq) => store.read(streamId, fromSeq),
    lastSeq: (streamId) => store.lastSeq(streamId),
    delete: (streamId) => store.delete(streamId),
    prune: (options) => store.prune(options),
  };
  return {
    store: view,
    arm() {
      armed = true;
    },
  };
}

const text = (part: DeuzUIPart): string | undefined =>
  part.type === 'text-delta' ? part.text : undefined;

async function persistBeforePublish(store: DurableStreamStateStore): Promise<void> {
  const time = immediateClock(1_700_000_000_000);
  const leases = crashingHolders(createInMemoryLeaseProvider({ clock: time.clock }));
  const ttlMs = 300;
  const durable = (view: DurableStreamStateStore, owner: string) => ({
    store: view,
    lease: { provider: leases, owner, ttlMs },
    deps: { clock: time.clock },
  });

  // Leg A: two batches; the process dies right after the second one committed.
  const a = processView(store, 'after');
  const sourceA = manualResult();
  const legA = toDeuzStreamResponse(sourceA.result, {
    durable: durable(a.store, 'a'),
    streamId: 'run-1',
    messageId: 'm',
  });

  // The client: the live response first, then the resume endpoint on every drop.
  const parts: DeuzUIPart[] = [];
  const cursors: string[] = [];
  let connections = 0;
  const client = (async () => {
    for await (const part of connectDeuzStream(
      ({ lastEventId }) => {
        connections++;
        if (connections === 1) return legA;
        return resumeDeuzStreamResponse(store, 'run-1', {
          lastEventId: lastEventId ?? null,
          clock: turn,
          pollIntervalMs: 1,
          idleTimeoutMs: 1_000_000,
        });
      },
      { clock: turn, maxReconnects: 20, onCursor: (id) => cursors.push(id) },
    ))
      parts.push(part);
  })();

  await until(() => time.pending() > 0, 'leg A to open');
  sourceA.push(textPart('a1'));
  sourceA.push(textPart('a2'));
  await time.advance(20);
  await until(() => parts.some((part) => text(part) === 'a2'), 'a2 on the client');
  a.arm();
  sourceA.push(textPart('a3'));
  sourceA.push(textPart('a4'));
  await time.advance(20);
  // a3 and a4 are stored, never published by A; the client reconnects and gets them.
  await until(() => parts.some((part) => text(part) === 'a4'), 'a4 through the resume endpoint');
  expect((await readAll(store, 'run-1')).map((record) => record.seq)).toEqual([0, 1, 2, 3, 4]);

  // Leg B, once A's lease lapsed: the process dies before its first commit.
  await time.advance(ttlMs + 1);
  const b = processView(store, 'before');
  b.arm();
  const sourceB = manualResult();
  const legB = bodyReader(
    toDeuzStreamResponse(sourceB.result, {
      durable: durable(b.store, 'b'),
      streamId: 'run-1',
      messageId: 'm',
    }),
  );
  await until(() => time.pending() > 0, 'leg B to open');
  sourceB.push(textPart('lost-1'));
  sourceB.push(textPart('lost-2'));
  await time.advance(20);
  const rawB = await legB.rest();
  expect(rawB).not.toContain('lost-');
  expect(rawB).not.toContain('[DONE]');
  expect(await store.lastSeq('run-1')).toBe(4);

  // Leg C, once B's lease lapsed: it finishes the run.
  await time.advance(ttlMs + 1);
  const c = processView(store);
  const sourceC = manualResult();
  const legC = bodyReader(
    toDeuzStreamResponse(sourceC.result, {
      durable: durable(c.store, 'c'),
      streamId: 'run-1',
      messageId: 'm',
    }),
  );
  await until(() => time.pending() > 0, 'leg C to open');
  sourceC.push(textPart('c1'));
  sourceC.push(textPart('c2'));
  sourceC.end();
  await time.advance(20);
  const framesC = sseFrames(await legC.rest());
  expect(framesC.map((frame) => frame.id)).toEqual(['5', '6', '7']);
  await client;

  // Every committed frame reached the client once, in order; nothing else did.
  const journal = await readAll(store, 'run-1');
  expect(journal.map((record) => record.seq)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  expect(journal.at(-1)!.part).toEqual({ type: 'done' });
  const delivered = parts.filter((part) => part.type !== 'error');
  expect(delivered).toEqual(journal.slice(0, -1).map((record) => record.part));
  expect(delivered.map(text).filter(Boolean)).toEqual(['a1', 'a2', 'a3', 'a4', 'c1', 'c2']);
  // The cursor only moves forward (an id-less frame re-reports the one it had: SSE ids are sticky).
  expect([...new Set(cursors)]).toEqual(['0', '1', '2', '3', '4', '5', '6']);
  expect(
    cursors.every((id, index) => index === 0 || Number(id) >= Number(cursors[index - 1])),
  ).toBe(true);
  // A's failure reached the client as one error frame, before the replayed tail.
  const errorAt = parts.findIndex((part) => part.type === 'error');
  expect(parts.filter((part) => part.type === 'error')).toHaveLength(1);
  expect(errorAt).toBe(parts.findIndex((part) => text(part) === 'a3') - 1);
}

scenario(
  'chat-stream-react',
  'persist-before-publish',
  async () => {
    await persistBeforePublish(createInMemoryDurableStreamStateStore());
    if (sqliteAvailable) {
      const sqlite = createSqliteDurableStreamStateStore({ path: ':memory:' });
      try {
        await persistBeforePublish(sqlite);
      } finally {
        await sqlite.close();
      }
    }
  },
  { fault: true, timeout: 30_000 },
);

scenario('chat-stream-react', 'producer-fencing', async () => {
  const time = immediateClock(1_700_000_000_000);
  const inner = createInMemoryLeaseProvider({ clock: time.clock });
  const store = createInMemoryDurableStreamStateStore({ deps: { clock: time.clock } });
  const observer = createMemoryObserver();
  const ttlMs = 300;
  // Producer A is cut off from the lease provider: its renewals never come back.
  const partitioned: LeaseProvider = {
    ...inner,
    acquire: (request) => inner.acquire(request),
    renew: () => new Promise<never>(() => {}),
    release: async (_lease: Lease) => {},
    signal: (key, signal) => inner.signal(key, signal),
  };
  const sourceA = manualResult();
  const legA = bodyReader(
    toDeuzStreamResponse(sourceA.result, {
      durable: {
        store,
        lease: { provider: partitioned, owner: 'a', ttlMs },
        deps: { clock: time.clock, observer },
      },
      streamId: 'chat-1',
      messageId: 'm',
    }),
  );
  await until(() => time.pending() > 0, 'producer A to open');
  sourceA.push(textPart('a1'));
  await time.advance(20);
  await legA.until('"a1"');

  // A's lease lapses; B takes it with a higher token and opens the stream.
  await time.advance(ttlMs + 1);
  const sourceB = manualResult();
  const legB = bodyReader(
    toDeuzStreamResponse(sourceB.result, {
      durable: {
        store,
        lease: { provider: inner, owner: 'b', ttlMs },
        deps: { clock: time.clock, observer },
      },
      streamId: 'chat-1',
      messageId: 'm',
    }),
  );
  // A's renewal hangs, so it holds no timer: the first one on the clock is B's.
  await until(() => time.pending() > 0, 'producer B to open');
  expect(await store.open('chat-1', 1)).toEqual({ status: 'fenced', token: 2 });

  // A, still running, produces on: its commit is refused and it stops.
  sourceA.push(textPart('stale'));
  await time.advance(20);
  const rawA = await legA.rest();
  expect(rawA).not.toContain('stale');
  expect(rawA).not.toContain('[DONE]');
  expect(sseFrames(rawA).at(-1)!.data).toContain('a newer producer took over this stream');
  sourceA.push(textPart('more'));
  await settleImmediate();
  expect(sourceA.returned()).toBe(true);
  const fenced = observer
    .events()
    .filter(
      (event) => event.type === 'operation.completed' && event.operation === 'deuz.stream.fenced',
    );
  expect(fenced).toHaveLength(1);
  expect(fenced[0]).toMatchObject({ attributes: { 'deuz.stream.fencing_token': 2 } });

  // B continues the log right after A's last committed frame.
  sourceB.push(textPart('b1'));
  sourceB.end();
  await time.advance(20);
  const framesB = sseFrames(await legB.rest());
  expect(framesB.map((frame) => frame.id)).toEqual(['2', '3']);
  const journal = await readAll(store, 'chat-1');
  expect(journal.map((record) => record.seq)).toEqual([0, 1, 2, 3]);
  expect(
    journal.map((record) =>
      record.part.type === 'text-delta' ? record.part.text : record.part.type,
    ),
  ).toEqual(['start', 'a1', 'b1', 'done']);
  // A replay from the start reads both producers once, in order.
  const replay = sseFrames(await resumeDeuzStreamResponse(store, 'chat-1').text());
  expect(replay.map((frame) => frame.id)).toEqual(['0', '1', '2', '3']);
});
