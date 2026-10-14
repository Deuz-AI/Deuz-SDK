/**
 * L4A acceptance scenarios (new.txt §3.1, §5.1 "Goal supervisor"): the goal
 * store contract kept by a durable store across restarts, and a stale writer
 * fenced out by revision compare-and-set after it lost its claim. Each
 * scenario builds its own database files and stores.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect } from 'vitest';
import { createGoal, createInMemoryGoalStore, transitionGoal } from '../../src/goal';
import type { GoalCommand, GoalRecord, GoalStore } from '../../src/goal';
import { DEFAULT_GOAL_RUNTIME_POLICY, goalInboxKey } from '../../src/goal/runtime';
import type { GoalRuntimeState } from '../../src/goal/runtime';
import { createSqliteGoalRuntimeStore } from '../../src/node/goal-runtime-sqlite';
import { openSqliteDatabase } from '../../src/node/sqlite-handle';
import type { SqliteDatabaseLike } from '../../src/node/store-sqlite';
import { SLOW_TEST_TIMEOUT_MS } from '../fixtures/timeouts';
import { scenario } from './registry';

const T0 = Date.parse('2026-10-14T09:00:00Z');
const SCOPE = 'tenant-a';
const DIGEST = `sha256:${'c'.repeat(64)}` as const;

async function databaseFile(): Promise<{ path: string; remove(): Promise<void> }> {
  const directory = await mkdtemp(join(tmpdir(), 'deuz-l4a-'));
  return {
    path: join(directory, 'goals.sqlite'),
    remove: () => rm(directory, { recursive: true, force: true }),
  };
}

/** A host's loop: load, transition, save; returns the saved record. */
async function step(
  store: GoalStore,
  goalId: string,
  command: GoalCommand,
  now: number,
): Promise<GoalRecord> {
  const current = await store.load(goalId);
  if (!current) throw new Error(`Unknown goal ${goalId}`);
  const next = transitionGoal(current, command, { now });
  if (next.changed) await store.save(next.record);
  return next.record;
}

function runtimeState(revision: number, patch: Partial<GoalRuntimeState> = {}): GoalRuntimeState {
  return {
    goalId: 'g',
    scope: SCOPE,
    revision,
    policy: {
      ...DEFAULT_GOAL_RUNTIME_POLICY,
      retryDelaysMs: [...DEFAULT_GOAL_RUNTIME_POLICY.retryDelaysMs],
    },
    phase: 'idle',
    runs: 0,
    retries: 0,
    createdAt: T0,
    updatedAt: T0 + revision,
    ...patch,
  };
}

/** A handle whose statements starting with `prefix` throw while `crash.on` is set. */
function crashing(
  inner: SqliteDatabaseLike,
  prefix: string,
): SqliteDatabaseLike & { crash: { on: boolean } } {
  const crash = { on: false };
  return {
    crash,
    exec: (sql) => inner.exec(sql),
    close: () => inner.close(),
    prepare(sql) {
      const statement = inner.prepare(sql);
      if (!sql.trimStart().startsWith(prefix)) return statement;
      return {
        run: (...params) => {
          if (crash.on) throw new Error('process died mid-write');
          return statement.run(...params);
        },
        get: (...params) => statement.get(...params),
        all: (...params) => statement.all(...params),
      };
    },
  };
}

scenario(
  'supervisor',
  'goal-store-conformance-durable',
  async () => {
    // The same host loop on the 2.3 reference store and on a SQLite file that
    // is closed and reopened between every step ends with the same goal: the
    // goal runtime store is a GoalStore, now durable.
    const file = await databaseFile();
    try {
      const reference = createInMemoryGoalStore();
      const created = createGoal(
        {
          goalId: 'g',
          scope: SCOPE,
          objective: 'Ship the nightly report.',
          criteria: [{ id: 'tests', description: 'The suite passes' }],
        },
        { now: T0 },
      );
      await reference.save(created);
      const first = createSqliteGoalRuntimeStore({ path: file.path });
      await first.save(created);
      await first.close();
      const commands: GoalCommand[] = [
        { type: 'link-run', runId: 'run-1' },
        { type: 'wait', wait: { reason: 'event', source: { type: 'signal', id: 'ci' } } },
        { type: 'resume' },
        {
          type: 'evaluate',
          results: [
            { criterionId: 'tests', verdict: 'passed', source: 'test', evidence: ['junit'] },
          ],
          evidence: [{ id: 'junit', source: 'test', ref: 'reports/junit.xml', digest: DIGEST }],
        },
        { type: 'charge', tokens: 1_200, usd: 0.02, key: 'run-1' },
        { type: 'complete' },
      ];
      let expected = created;
      for (const [index, command] of commands.entries()) {
        const now = T0 + (index + 1) * 1_000;
        expected = await step(reference, 'g', command, now);
        const durable = createSqliteGoalRuntimeStore({ path: file.path });
        try {
          expect(await step(durable, 'g', command, now)).toEqual(expected);
        } finally {
          await durable.close();
        }
      }
      expect(expected.status).toBe('completed');
      const reopened = createSqliteGoalRuntimeStore({ path: file.path });
      try {
        expect(await reopened.load('g')).toEqual(await reference.load('g'));
        expect(await reopened.load('g', { scope: 'tenant-b' })).toBeUndefined();
        expect((await reopened.list({ scope: SCOPE })).goals).toEqual(
          (await reference.list({ scope: SCOPE })).goals,
        );
        // A writer holding an older copy is refused, and nothing it held lands.
        const stale = transitionGoal(created, { type: 'cancel' }, { now: T0 + 9_000 }).record;
        await expect(reopened.save(stale)).rejects.toMatchObject({ code: 'revision_conflict' });
        expect((await reopened.load('g'))?.status).toBe('completed');
      } finally {
        await reopened.close();
      }
    } finally {
      await file.remove();
    }
  },
  { timeout: SLOW_TEST_TIMEOUT_MS },
);

scenario(
  'supervisor',
  'stale-writer-fenced',
  async () => {
    // Supervisor A dies half way through applying a webhook event (its
    // transaction rolls back); supervisor B, which took the goal over with a
    // higher lease token, applies it and finishes the run. A comes back with
    // its old view and tries every write it had in flight: each is fenced by
    // the revision compare-and-set, and nothing B wrote is lost.
    const file = await databaseFile();
    const handle = crashing(
      await openSqliteDatabase(file.path),
      'INSERT INTO deuz_goal_runtime_intents',
    );
    const a = createSqliteGoalRuntimeStore({ database: handle });
    const b = createSqliteGoalRuntimeStore({ path: file.path });
    try {
      const goal = createGoal(
        { goalId: 'g', scope: SCOPE, objective: 'Triage the alert.' },
        { now: T0 },
      );
      expect(await a.runtime.save(runtimeState(1), goal)).toEqual({ status: 'committed' });
      const { entry } = await a.inbox.enqueue({
        scope: SCOPE,
        goalId: 'g',
        namespace: 'webhook:pagerduty',
        deliveryId: 'alert-1',
        event: {
          kind: 'deuz-goal-event',
          version: 1,
          id: 'alert-1',
          key: 'alert-1',
          source: { type: 'signal', id: 'pagerduty' },
          scope: SCOPE,
          goalId: 'g',
          at: T0 + 10,
        },
        payload: { body: '{"alert":1}', mediaType: 'application/json' },
        digest: DIGEST,
      });

      // A's view: goal and state at revision 1. Its apply dies mid-write.
      const aGoal = transitionGoal(
        goal,
        { type: 'link-run', runId: 'run-a' },
        { now: T0 + 20 },
      ).record;
      const aApply = {
        scope: SCOPE,
        goalId: 'g',
        entryId: entry.id,
        disposition: 'applied' as const,
        goal: aGoal,
        runtime: runtimeState(2, { phase: 'dispatching' }),
        intent: {
          intentId: 'g#2-a',
          scope: SCOPE,
          goalId: 'g',
          kind: 'start' as const,
          runId: 'run-a',
          attempt: 1,
        },
      };
      handle.crash.on = true;
      await expect(a.inbox.apply(aApply)).rejects.toThrow('process died mid-write');
      handle.crash.on = false;
      expect((await b.inbox.get(SCOPE, entry.id))?.disposition).toBe('pending');
      expect((await b.load('g'))?.revision).toBe(1);

      // B takes over: applies the event, claims under token 2, launches and completes.
      const bGoal = transitionGoal(
        goal,
        { type: 'link-run', runId: 'run-b' },
        { now: T0 + 30 },
      ).record;
      expect(
        await b.inbox.apply({
          ...aApply,
          goal: bGoal,
          runtime: runtimeState(2, { phase: 'dispatching' }),
          intent: { ...aApply.intent, intentId: 'g#2-b', runId: 'run-b' },
        }),
      ).toEqual({ status: 'committed' });
      expect(
        await b.intents.claim(SCOPE, 'g#2-b', { owner: 'b', token: 2, expectedRevision: 1 }),
      ).toMatchObject({ status: 'committed' });
      expect(await b.intents.launched(SCOPE, 'g#2-b', { token: 2, expectedRevision: 2 })).toEqual({
        status: 'committed',
      });
      const bDone = transitionGoal(
        bGoal,
        { type: 'charge', tokens: 300, key: 'run-b' },
        { now: T0 + 40 },
      ).record;
      expect(
        await b.intents.complete(SCOPE, 'g#2-b', {
          token: 2,
          expectedRevision: 3,
          status: 'completed',
          outcome: { status: 'completed' },
          runtime: runtimeState(3, { phase: 'idle', runs: 1 }),
          goal: bDone,
        }),
      ).toEqual({ status: 'committed' });

      // A returns with its old view: every write is fenced.
      expect(await a.inbox.apply(aApply)).toEqual({ status: 'conflict', reason: 'entry-settled' });
      expect(await a.runtime.save(runtimeState(2, { phase: 'running' }), aGoal)).toEqual({
        status: 'conflict',
        reason: 'runtime-revision',
      });
      await expect(a.save(aGoal)).rejects.toMatchObject({ code: 'revision_conflict' });
      expect(
        await a.intents.record(
          { ...aApply.intent, intentId: 'g#retry-a', kind: 'retry' },
          { runtime: runtimeState(2, { phase: 'retrying', retries: 1 }) },
        ),
      ).toEqual({ status: 'conflict', reason: 'runtime-revision' });
      expect(
        await a.intents.claim(SCOPE, 'g#2-b', { owner: 'a', token: 1, expectedRevision: 4 }),
      ).toEqual({ status: 'conflict' });
      expect(
        await a.intents.complete(SCOPE, 'g#2-b', {
          token: 1,
          expectedRevision: 4,
          status: 'failed',
          runtime: runtimeState(3, { phase: 'retrying' }),
          goal: aGoal,
        }),
      ).toEqual({ status: 'conflict', reason: 'intent-revision' });
      expect(
        await a.watermarks.advance({
          scope: SCOPE,
          goalId: 'g',
          runId: 'run-a',
          expectedRevision: 0,
          next: { tokens: 900, usd: 0, reservedTokens: 0, reservedUsd: 0 },
          goal: transitionGoal(
            aGoal,
            { type: 'charge', tokens: 900, key: 'run-a' },
            { now: T0 + 50 },
          ).record,
        }),
      ).toEqual({ status: 'conflict', reason: 'goal-revision' });

      // Nothing B wrote was lost or overwritten.
      expect(await b.load('g')).toEqual(bDone);
      expect(await b.runtime.get(SCOPE, 'g')).toEqual(runtimeState(3, { phase: 'idle', runs: 1 }));
      expect(await b.intents.get(SCOPE, 'g#2-b')).toMatchObject({
        status: 'completed',
        claim: { owner: 'b', token: 2 },
        outcome: { status: 'completed' },
      });
      expect(await b.inbox.get(SCOPE, entry.id)).toMatchObject({
        disposition: 'applied',
        goalRevision: 2,
        intentId: 'g#2-b',
      });
      expect(await b.watermarks.get(SCOPE, 'g', 'run-a')).toBeUndefined();
      expect(
        (
          await b.intents.list({
            scope: SCOPE,
            statuses: ['pending', 'claimed', 'launched', 'completed'],
          })
        ).intents.map((intent) => intent.intentId),
      ).toEqual(['g#2-b']);
      expect(
        await b.inbox.get(SCOPE, goalInboxKey(SCOPE, 'webhook:pagerduty', 'alert-1')),
      ).toBeDefined();
    } finally {
      await a.close();
      await b.close();
      handle.close();
      await file.remove();
    }
  },
  { fault: true, timeout: SLOW_TEST_TIMEOUT_MS },
);
