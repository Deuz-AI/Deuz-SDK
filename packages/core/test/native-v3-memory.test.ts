/**
 * native-v3-memory.test.ts (2.4, spec §4.1 "Memory/run arasındaki kayıt
 * protokolü") — a V3 run's versioned-memory writes follow durable intent →
 * prepared plan → atomic memory commit with its receipt → native
 * acknowledgment. There is no transaction across the two stores: a lost
 * acknowledgment is settled by reading the receipt (the session replays the
 * operation id), a model call repeated after a crash never applies a memory
 * change again, and a V3 extraction that wrote part of its plan is `partial`.
 */
import { describe, expect, it, vi } from 'vitest';
import { reconcileAgentRun, resumeAgent, runAgent, streamAgent } from '../src/agent-run';
import { createInMemoryAgentRunStoreV3 } from '../src/agent-run-v3-store';
import { createInMemoryMemoryStore, type MemorySeams, type MemoryStore } from '../src/memory';
import { createInMemoryVersionedMemoryStore, createMemorySession } from '../src/memory/versioned';
import type {
  AgentEventV3,
  AgentRunMemoryIntentV3,
  AgentRunOptionsV3,
  AgentRunStoreV3,
} from '../src/types/agent-run-v3';
import { interceptedStore } from './fixtures/versioned-memory-session';
import { recordingStoreV3, scriptedModel, type ScriptedCall } from './fixtures/native-v3';

const scope = { userId: 'ada' };

function versioned() {
  const store = interceptedStore(createInMemoryVersionedMemoryStore());
  const session = createMemorySession({ store, scope });
  return { store, session };
}

function memoryRun(
  script: ScriptedCall[],
  memory: ReturnType<typeof versioned>,
  extra: Partial<AgentRunOptionsV3> = {},
) {
  const scripted = scriptedModel(script);
  const options = (store: AgentRunStoreV3): AgentRunOptionsV3 => ({
    model: scripted.model,
    prompt: 'I prefer tea',
    checkpointVersion: 3,
    session: { store, runId: 'run-mem', scope: 'tenant' },
    versionedMemory: { session: memory.session, tools: true },
    ...extra,
  });
  return { ...scripted, options };
}

const remember = (id: string, text: string): ScriptedCall => ({
  toolCalls: [{ toolName: 'memory_remember', id, args: { text } }],
});

describe('versioned memory writes of a V3 run', () => {
  it('records each tool write as an intent with the session operation id, then acknowledges it', async () => {
    const memory = versioned();
    const store = recordingStoreV3();
    const run = memoryRun([remember('m1', 'Ada prefers tea'), { text: 'noted' }], memory);
    const stream = streamAgent(run.options(store));
    const events: AgentEventV3[] = [];
    for await (const event of stream.eventsV3) events.push(event);
    expect((await stream.result).status).toBe('completed');

    const stored = (await store.load('run-mem'))!;
    expect(stored.memoryIntents).toHaveLength(1);
    const intent = stored.memoryIntents![0]!;
    expect(intent).toMatchObject({ status: 'acknowledged', toolCallId: 'm1', modelStep: 1 });
    // The intent names the operation the memory store committed.
    const receipt = await memory.store.receipt(intent.operationId);
    expect(receipt?.entries).toHaveLength(1);
    expect(memory.store.commits).toHaveLength(1);
    expect(
      events.flatMap((event) => (event.type === 'memory-intent' ? [event.status] : [])),
    ).toEqual(['intended', 'committed', 'acknowledged']);
    // Durable intent: the call's executing receipt is saved with it, before the commit.
    const statusAt = (stage: string) =>
      store.saves.find((save) =>
        Object.values(save.toolResults ?? {}).some(
          (entry) => entry.toolCallId === 'm1' && entry.stage === stage,
        ),
      )?.memoryIntents?.[0]?.status;
    expect(statusAt('executing')).toBe('intended');
    expect(statusAt('executed')).toBe('committed');
    expect(statusAt('completed')).toBe('acknowledged');
  });

  it('settles a lost acknowledgment from the receipt: the write is replayed, never applied again', async () => {
    const memory = versioned();
    const inner = createInMemoryAgentRunStoreV3();
    const first = recordingStoreV3(inner);
    const run = memoryRun([remember('m1', 'Ada prefers tea'), { text: 'noted' }], memory);
    // The process dies after the intent was saved: the commit lands, its acknowledgment does not.
    first.failAfter((envelope) => envelope.memoryIntents?.[0]?.status === 'intended');
    expect((await runAgent(run.options(first))).status).toBe('failed');
    expect(memory.store.commits).toHaveLength(1);

    const second = recordingStoreV3(inner);
    const resumed = await resumeAgent(run.options(second));
    expect(resumed.status).toBe('completed');
    expect(memory.store.commits).toHaveLength(1);
    const hits = await memory.session.recall({ text: 'tea' });
    expect(hits).toHaveLength(1);
    const stored = (await second.load('run-mem'))!;
    expect(stored.memoryIntents?.map((intent) => intent.status)).toEqual(['acknowledged']);
  });

  it('a model call repeated after a crash never applies the memory change again', async () => {
    const memory = versioned();
    const inner = createInMemoryAgentRunStoreV3();
    const first = recordingStoreV3(inner);
    const run = memoryRun(
      [remember('m1', 'Ada prefers tea'), { text: 'noted' }, { text: 'noted' }],
      memory,
    );
    // The process dies once the second model call was sent (its answer never saved).
    const fetch = run.fetch.getMockImplementation()!;
    let calls = 0;
    run.fetch.mockImplementation(async (input, init) => {
      if (++calls === 2) first.failFromSave(1);
      return fetch(input, init);
    });
    expect((await runAgent(run.options(first))).status).toBe('failed');
    const resumed = await resumeAgent(run.options(recordingStoreV3(inner)));
    expect(resumed.status).toBe('completed');
    expect(run.fetch).toHaveBeenCalledTimes(3);
    expect(memory.store.commits).toHaveLength(1);
    expect(await memory.session.recall({ text: 'tea' })).toHaveLength(1);
  });
});

describe('versioned memory extraction of a V3 run', () => {
  it('records the intent in the terminal commit, prepares the plan, commits and acknowledges', async () => {
    const memory = versioned();
    const store = recordingStoreV3();
    const run = memoryRun([{ text: 'noted' }], memory, {
      versionedMemory: { session: memory.session, extract: { infer: false } },
    });
    expect((await runAgent(run.options(store))).status).toBe('completed');
    const terminal = store.saves.find((save) => save.phase === 'terminal')!;
    expect(terminal.memoryIntents).toEqual([
      { operationId: expect.any(String), status: 'intended', extraction: { infer: false } },
    ]);
    const statuses = store.saves.flatMap((save) =>
      save.memoryIntents?.length ? [save.memoryIntents[0]!.status] : [],
    );
    expect(statuses).toEqual(['intended', 'planned', 'acknowledged']);
    const intent = (await store.load('run-mem'))!.memoryIntents![0]!;
    const receipt = (await memory.store.receipt(intent.operationId))!;
    expect(intent).toMatchObject({
      status: 'acknowledged',
      planned: 1,
      requestDigest: receipt.requestDigest,
      receipt: { scopeRevision: receipt.scopeRevision, committedAt: receipt.committedAt },
    });
    const hits = await memory.session.recall({ text: 'tea' });
    expect(hits.map((hit) => hit.record.text)).toEqual(['I prefer tea']);
  });

  it('settles a lost extraction acknowledgment from the receipt in reconcileAgentRun', async () => {
    const memory = versioned();
    const inner = createInMemoryAgentRunStoreV3();
    const first = recordingStoreV3(inner);
    const run = memoryRun([{ text: 'noted' }], memory, {
      versionedMemory: { session: memory.session, extract: { infer: false } },
    });
    first.failAfter((envelope) => envelope.memoryIntents?.[0]?.status === 'planned');
    expect((await runAgent(run.options(first))).status).toBe('completed');
    expect(memory.store.commits).toHaveLength(1);
    const operationId = (await inner.load('run-mem'))!.memoryIntents![0]!.operationId;
    expect((await inner.load('run-mem'))!.memoryIntents![0]!.status).toBe('planned');

    const outcome = await reconcileAgentRun({
      checkpointVersion: 3,
      session: { store: inner, runId: 'run-mem', scope: 'tenant' },
      versionedMemory: { session: memory.session },
    });
    expect(outcome.memoryIntents).toEqual([operationId]);
    // Read from the receipt: no second commit.
    expect(memory.store.commits).toHaveLength(1);
    const intent: AgentRunMemoryIntentV3 = (await inner.load('run-mem'))!.memoryIntents![0]!;
    expect(intent.status).toBe('acknowledged');
    expect(intent.receipt).toBeDefined();
  });
});

describe('legacy memory extraction in a V3 run', () => {
  it("is 'partial' when the pass wrote only part of its plan", async () => {
    const inner = createInMemoryMemoryStore();
    let cut = true;
    const legacy: MemoryStore = {
      ...inner,
      upsert: async (records) => {
        const n = cut ? 1 : records.length;
        cut = false;
        await inner.upsert(records.slice(0, n));
        if (n < records.length) throw new Error('connection lost');
      },
    };
    let n = 0;
    const seams: MemorySeams = {
      store: legacy,
      llm: vi.fn<MemorySeams['llm']>(async ({ system }) =>
        system.includes('extract')
          ? JSON.stringify({ facts: ['prefers tea', 'lives in Oslo'] })
          : JSON.stringify({
              memory: [
                { event: 'ADD', text: 'prefers tea' },
                { event: 'ADD', text: 'lives in Oslo' },
              ],
            }),
      ),
      clock: { now: () => 5_000, setTimeout: () => () => {} },
      generateId: () => `mem-${n++}`,
      hashFn: async (text) => `h:${text}`,
    };
    const store = recordingStoreV3();
    const { model } = scriptedModel([{ text: 'noted' }]);
    const stream = streamAgent({
      model,
      prompt: 'I prefer tea and I live in Oslo',
      checkpointVersion: 3,
      session: { store, runId: 'run-partial', scope: 'tenant' },
      memory: { seams, scope, recall: false },
    });
    const warnings: string[] = [];
    for await (const event of stream.events)
      if (event.type === 'part' && event.part.type === 'warning')
        warnings.push(event.part.warning.type);
    expect((await stream.result).status).toBe('completed');
    expect((await store.load('run-partial'))!.memory?.extraction).toMatchObject({
      status: 'partial',
      planned: 2,
      mutations: 1,
    });
    expect(warnings).toContain('memory-extraction-partial');
    const outcome = await reconcileAgentRun({
      checkpointVersion: 3,
      session: { store, runId: 'run-partial', scope: 'tenant' },
      memory: { seams, scope, recall: false },
    });
    // The 2.3 answer shape; the V3 record keeps 'partial'.
    expect(outcome.memory).toBe('failed');
    expect(outcome.warnings?.[0]?.type).toBe('memory-extraction-partial');
    expect((await store.load('run-partial'))!.memory?.extraction?.status).toBe('partial');
  });
});
