/**
 * Lane E2's 2.4 acceptance scenarios (new.txt §5.1, area `retention`; spec
 * §4.4 "Saklama, temizlik ve forget").
 *
 * prune-boundaries: every 2.4 store's cleanup is an explicit call with an
 * exclusive cutoff that touches only what it names — past revisions of
 * retracted records, settled inbox payloads (with the 7-day default), old
 * occurrence records, terminal streams (with the 24-hour default), terminal
 * process operations, terminal V3 runs, chat tombstones — and keeps what
 * guards dedupe and forgetting: receipts, inbox ids, forgotten ids, forget
 * tombstones. Time alone deletes nothing.
 *
 * forget-redacts-v3-context (fault): a host runs two V3 runs on SQLite files
 * (one completes, one crashes mid-run), restarts, and forgets a memory record
 * through the session. Every package blob holding the record is redacted and
 * the manifests say so; neither run keeps a copy of the record's retrieval
 * block, the completed run's `result.messages` included. The crashed run
 * resumes: the reopened step is compiled again, the next request carries no
 * forgotten text, and after another restart the records still hold none.
 */
import { expect, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resumeAgent, runAgent } from '../../src/agent-run';
import { createInMemoryAgentRunStoreV3 } from '../../src/agent-run-v3-store';
import { createInMemoryConditionalChatStore } from '../../src/chat-conditional';
import { createInMemoryProcessOperationStore } from '../../src/compute/docker';
import { createMemoryContextSource } from '../../src/context/sources';
import {
  DEFAULT_GOAL_RUNTIME_POLICY,
  createInMemoryGoalRuntimeStore,
} from '../../src/goal/runtime/store';
import {
  createInMemoryVersionedMemoryStore,
  createMemorySession,
} from '../../src/memory/versioned';
import { createSqliteAgentRunStoreV3 } from '../../src/node/runs-v3-sqlite';
import { createSqliteVersionedMemoryStore } from '../../src/node/vmem-sqlite';
import {
  createInMemoryDurableStreamStateStore,
  DEFAULT_DURABLE_STREAM_RETAIN_MS,
} from '../../src/stream-durable';
import type { AgentRunOptionsV3, AgentRunStoreV3 } from '../../src/types/agent-run-v3';
import type { StreamStateRecord } from '../../src/ui';
import { chat } from '../fixtures/conditional-chat-store-conformance';
import { envelopeV3 } from '../fixtures/agent-run-v3';
import {
  delivery,
  occurrence,
  runtimeGoal,
  scheduleInput,
  T0,
} from '../fixtures/goal-runtime-store-conformance';
import { manualClock } from '../fixtures/manual-clock';
import { recordingStoreV3, scriptedModel, wireText } from '../fixtures/native-v3';
import { newRecord } from '../fixtures/process-ops-store-conformance';
import {
  checkForgetOutlivesPrune,
  checkMemoryRetention,
  loggerWith,
} from '../fixtures/retention-2-4';
import { SLOW_TEST_TIMEOUT_MS } from '../fixtures/timeouts';
import { scenario } from './registry';

const DAY = 86_400_000;
const MINUTE = 60_000;

scenario('retention', 'prune-boundaries', async () => {
  // --- Versioned memory: history, receipts, forgotten ids. -------------
  {
    const { clock, advance } = manualClock(T0);
    const warn = vi.fn();
    const store = createInMemoryVersionedMemoryStore({ deps: { clock, logger: loggerWith(warn) } });
    await checkMemoryRetention({ store, clock, advance, warn });
  }

  // --- Goal runtime: inbox payloads (7-day default) and occurrences. ----
  {
    const { clock, advance } = manualClock(T0);
    const store = createInMemoryGoalRuntimeStore({ deps: { clock } });
    const goal = runtimeGoal('g');
    await store.save(goal);
    await store.schedules.put(scheduleInput(goal, 's1'), {
      expectedRevision: 0,
      effectiveFrom: T0,
    });
    const ids: Record<string, string> = {};
    for (const id of ['old', 'edge', 'pending'])
      ids[id] = (await store.inbox.enqueue(delivery(goal, id))).entry.id;
    const settle = (id: string) =>
      store.inbox.apply({ scope: 'tenant', goalId: 'g', entryId: ids[id]!, disposition: 'stale' });
    await settle('old');
    await advance(DAY);
    await settle('edge');
    await store.schedules.advance({
      scope: 'tenant',
      scheduleId: 's1',
      expectedRevision: 1,
      fromCursor: T0,
      toCursor: T0 + MINUTE,
      occurrences: [occurrence(goal, 's1', T0 + MINUTE, 'catch-up-none')],
    });
    await advance(DEFAULT_GOAL_RUNTIME_POLICY.retainPayloadMs);
    // Time alone dropped nothing.
    expect((await store.inbox.get('tenant', ids.old!))?.payload).toBeDefined();
    const before = clock.now() - DEFAULT_GOAL_RUNTIME_POLICY.retainPayloadMs;
    expect(before).toBe(T0 + DAY);
    expect(await store.prunePayloads({ before })).toBe(1);
    const tombstone = await store.inbox.get('tenant', ids.old!);
    expect(tombstone).toMatchObject({ id: ids.old, payloadPruned: true });
    expect(tombstone?.payload).toBeUndefined();
    // The id still dedupes; the entry settled exactly at the cutoff and the
    // pending one keep their payloads.
    expect((await store.inbox.enqueue(delivery(goal, 'old'))).status).toBe('duplicate');
    expect((await store.inbox.get('tenant', ids.edge!))?.payload).toBeDefined();
    expect((await store.inbox.get('tenant', ids.pending!))?.payload).toBeDefined();
    // The occurrence was recorded exactly at the cutoff: it stays, then goes.
    expect(await store.pruneOccurrences({ before })).toBe(0);
    expect(await store.pruneOccurrences({ before: before + 1 })).toBe(1);
    expect(await store.schedules.get('tenant', 's1')).toBeDefined();
  }

  // --- Durable streams: terminal only, 24-hour default. -----------------
  {
    const { clock, advance } = manualClock(T0);
    const store = createInMemoryDurableStreamStateStore({ deps: { clock } });
    const part = (type: string) => ({ type, messageId: 'm' }) as StreamStateRecord['part'];
    const done = { type: 'done' } as StreamStateRecord['part'];
    await store.commit({ streamId: 'old', token: 1, records: [{ seq: 0, part: done }] });
    await store.commit({ streamId: 'live', token: 1, records: [{ seq: 0, part: part('start') }] });
    await advance(DAY);
    await store.commit({ streamId: 'edge', token: 1, records: [{ seq: 0, part: done }] });
    await advance(DEFAULT_DURABLE_STREAM_RETAIN_MS);
    expect(
      await store.prune({ terminalBefore: clock.now() - DEFAULT_DURABLE_STREAM_RETAIN_MS }),
    ).toBe(1);
    expect(await store.lastSeq('old')).toBeUndefined();
    expect(await store.lastSeq('edge')).toBe(0);
    expect(await store.lastSeq('live')).toBe(0);
  }

  // --- Process operations: terminal only; containers are not touched. ---
  {
    const { clock, advance } = manualClock(T0);
    const store = createInMemoryProcessOperationStore({ deps: { clock } });
    await store.create(newRecord({ operationId: 'exited', state: 'exited' }));
    await store.create(newRecord({ operationId: 'running', state: 'running' }));
    await advance(DAY);
    const cut = clock.now();
    await store.create(newRecord({ operationId: 'edge', state: 'disposed' }));
    await advance(30 * DAY);
    expect(await store.prune({ terminalBefore: cut })).toBe(1);
    expect(await store.get('tenant-a', 'exited')).toBeUndefined();
    expect(await store.get('tenant-a', 'edge')).toBeDefined();
    expect(await store.prune({ terminalBefore: clock.now() })).toBe(1);
    expect(await store.get('tenant-a', 'running')).toBeDefined();
  }

  // --- V3 runs: terminal only; forget tombstones outlive the prune. -----
  {
    const { clock, advance } = manualClock(T0);
    const store = createInMemoryAgentRunStoreV3({ deps: { clock } });
    await store.save(envelopeV3('old', 1, { phase: 'terminal' }));
    await store.save(envelopeV3('running', 1));
    await advance(DAY);
    const cut = clock.now();
    await store.save(envelopeV3('edge', 1, { phase: 'terminal' }));
    await advance(30 * DAY);
    expect(await store.prune({ terminalBefore: cut })).toBe(1);
    expect(await store.load('old')).toBeUndefined();
    expect(await store.load('edge')).toBeDefined();
    expect(await store.load('running')).toBeDefined();
    expect(await store.prune({ terminalBefore: clock.now() })).toBe(1);
    await checkForgetOutlivesPrune(store, () => clock.now() + 1);
    expect(await store.load('running')).toBeDefined();
  }

  // --- Conditional chats: tombstones only; a pruned id is free again. ---
  {
    const { clock, advance } = manualClock(T0);
    const store = createInMemoryConditionalChatStore({ deps: { clock } });
    await store.writeChat(chat('live', ['hi']), { expectedRevision: 0 });
    await store.deleteChat('old');
    await advance(DAY);
    const cut = clock.now();
    await store.deleteChat('edge');
    await advance(30 * DAY);
    expect((await store.readChat('old')).status).toBe('deleted');
    expect(await store.pruneTombstones(cut)).toBe(1);
    expect((await store.readChat('old')).status).toBe('missing');
    expect((await store.readChat('edge')).status).toBe('deleted');
    expect((await store.readChat('live')).status).toBe('found');
    expect((await store.writeChat(chat('old', ['again']), { expectedRevision: 0 })).status).toBe(
      'committed',
    );
  }
});

const FORGOTTEN = 'The deploy key is under the mat.';
const KEPT = 'Deploy target is eu-west.';
const parameters = { type: 'object', properties: { q: { type: 'string' } } };

scenario(
  'retention',
  'forget-redacts-v3-context',
  async () => {
    const dir = await mkdtemp(join(tmpdir(), 'deuz-e2-forget-'));
    const runsPath = join(dir, 'runs.db');
    const memoryPath = join(dir, 'memory.db');
    /** One host process: its stores and a memory session whose forgets reach the runs. */
    const host = () => {
      const runs = createSqliteAgentRunStoreV3({ path: runsPath });
      const memory = createSqliteVersionedMemoryStore({ path: memoryPath });
      const session = createMemorySession({
        store: memory,
        scope: { userId: 'u-1' },
        onForget: async (event) => {
          await runs.redactForgotten(event);
        },
      });
      return {
        runs,
        session,
        source: createMemoryContextSource({ session }),
        close: async () => {
          await runs.close();
          await memory.close();
        },
      };
    };
    const script = [
      { toolCalls: [{ toolName: 'lookup', id: 'l1', args: { q: 'x' } }] },
      { text: 'done' },
    ];
    const doneModel = scriptedModel(script);
    const crashModel = scriptedModel(script);
    const options = (
      store: AgentRunStoreV3,
      runId: string,
      source: ReturnType<typeof createMemoryContextSource>,
      model: AgentRunOptionsV3['model'],
    ): AgentRunOptionsV3 => ({
      model,
      prompt: 'Deploy the service',
      checkpointVersion: 3,
      session: { store, runId, scope: 'tenant' },
      tools: { lookup: { description: 'Look things up.', parameters, execute: () => 'found' } },
      context: { sources: [source] },
      capabilities: { contextWindow: 100_000, maxOutput: 4_000 },
    });
    const sent = (requests: ReturnType<typeof crashModel.requests>, index: number) =>
      requests[index]!.messages.map((message) => wireText(message)).join('\n');

    try {
      // --- First process: one run completes, the other crashes mid-run. ---
      const first = host();
      const forgotten = (await first.session.remember({ text: FORGOTTEN })).records[0]!;
      await first.session.remember({ text: KEPT });
      const done = await runAgent(options(first.runs, 'run-done', first.source, doneModel.model));
      expect(done).toMatchObject({ status: 'completed', output: 'done' });
      const crashing = recordingStoreV3(first.runs);
      const fetch = crashModel.fetch.getMockImplementation()!;
      let calls = 0;
      crashModel.fetch.mockImplementation(async (input, init) => {
        calls += 1;
        // The second call: step 0's block is in the stored history, the
        // answer is never saved (the process dies).
        if (calls === 2) crashing.failFromSave(1);
        return fetch(input, init);
      });
      await runAgent(options(crashing, 'run-crash', first.source, crashModel.model));
      expect(sent(crashModel.requests(), 1)).toContain(FORGOTTEN);
      const before = await first.runs.load('run-done');
      expect(JSON.stringify(before?.result?.messages)).toContain(FORGOTTEN);
      await first.close();

      // --- The host restarts and forgets the record. ---------------------
      const second = host();
      const forgot = await second.session.forget(forgotten.id);
      expect(forgot).toMatchObject({ redaction: 'complete', revisions: [forgotten.revision] });
      for (const runId of ['run-done', 'run-crash']) {
        const stored = (await second.runs.load(runId))!;
        expect(JSON.stringify(stored), runId).not.toContain(FORGOTTEN);
        const redacted = stored.context!.steps.filter((step) => step.manifest.redacted === true);
        expect(redacted.length, runId).toBeGreaterThan(0);
        for (const step of redacted)
          expect(await second.runs.getBlob(step.blob.digest)).toEqual({ status: 'redacted' });
      }
      const terminal = (await second.runs.load('run-done'))!;
      expect(terminal.revision).toBe(before!.revision);
      expect(terminal.result?.messages).toHaveLength(before!.result!.messages.length);

      // --- The crashed run resumes. --------------------------------------
      const resumed = await resumeAgent(
        options(second.runs, 'run-crash', second.source, crashModel.model),
      );
      expect(resumed).toMatchObject({ status: 'completed', output: 'done' });
      const requests = crashModel.requests();
      expect(requests).toHaveLength(3);
      expect(sent(requests, 2)).not.toContain(FORGOTTEN);
      expect(sent(requests, 2)).toContain(KEPT);
      await second.close();

      // --- After another restart nothing forgotten is back. --------------
      const third = host();
      for (const runId of ['run-done', 'run-crash'])
        expect(JSON.stringify(await third.runs.load(runId)), runId).not.toContain(FORGOTTEN);
      const crash = (await third.runs.load('run-crash'))!;
      expect(crash.phase).toBe('terminal');
      expect(crash.context!.steps.at(-1)!.manifest).toMatchObject({
        refresh: 'redacted',
        redacted: true,
        cachePrefixChanged: true,
      });
      // The memory itself no longer answers with it; the kept fact still comes back.
      const hits = (await third.session.recall({ text: 'deploy key' })).map((hit) => hit.record);
      expect(hits.map((record) => record.id)).not.toContain(forgotten.id);
      expect(hits.map((record) => record.text)).toContain(KEPT);
      await third.close();
    } finally {
      await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
    }
  },
  { fault: true, timeout: SLOW_TEST_TIMEOUT_MS },
);
