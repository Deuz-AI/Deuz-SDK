/**
 * native-memory-partial.test.ts (2.4, H5) — an interrupted native extraction is
 * settled by what it planned, not by finding some of its records: the planned
 * mutation count is saved before the first memory write, and a pass that wrote
 * only part of it is never reported completed (`'failed'`, with a
 * `memory-extraction-partial` warning). Deletions, which leave no record to
 * find, are applied and counted first.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  createInMemoryAgentRunStore,
  reconcileAgentRun,
  runAgent,
  streamAgent,
} from '../src/agent-run';
import {
  applyMutations,
  createInMemoryMemoryStore,
  remember,
  type MemoryRecord,
  type MemorySeams,
  type MemoryStore,
} from '../src/memory';
import { createMockModel } from '../src/testing';
import type {
  AgentEvent,
  AgentRunEnvelope,
  AgentRunMemoryExtraction,
  AgentRunOptions,
  AgentRunSession,
  AgentRunStore,
} from '../src/types/agent-run';

type Resumable = AgentRunOptions & { session: AgentRunSession };
const scope = { userId: 'ada' };
const clock = { now: () => 5_000, setTimeout: (fn: () => void) => (fn(), () => {}) };

function seeded(id: string, text: string, metadata?: Record<string, unknown>): MemoryRecord {
  return {
    id,
    text,
    hash: `h:${text}`,
    kind: 'semantic',
    scope,
    createdAt: 1,
    updatedAt: 1,
    ...(metadata ? { metadata } : {}),
  };
}

/**
 * Memory seams whose LLM extracts `facts` and decides `decision` (by default,
 * ADD every fact), over a store whose upserts can be cut short: `cut(n)` makes
 * the next upsert write only its first `n` records and then throw, as a
 * connection lost in the middle of a batch.
 */
function memory(facts: string[], decision?: object[], seed: MemoryRecord[] = []) {
  const inner = createInMemoryMemoryStore();
  void inner.upsert(seed);
  let keep: number | undefined;
  const writes: string[] = [];
  const onWrite = vi.fn();
  const store: MemoryStore = {
    ...inner,
    upsert: async (records) => {
      onWrite();
      const n = keep ?? records.length;
      keep = undefined;
      await inner.upsert(records.slice(0, n));
      writes.push(...records.slice(0, n).map((record) => `upsert:${record.text}`));
      if (n < records.length) throw new Error('connection lost');
    },
    delete: async (ids) => {
      onWrite();
      await inner.delete(ids);
      writes.push(...ids.map((id) => `delete:${id}`));
    },
  };
  const llm = vi.fn<MemorySeams['llm']>(async ({ system }) =>
    system.includes('extract')
      ? JSON.stringify({ facts })
      : JSON.stringify({ memory: decision ?? facts.map((text) => ({ event: 'ADD', text })) }),
  );
  let n = 0;
  const seams: MemorySeams = {
    store,
    llm,
    clock,
    generateId: () => `mem-${n++}`,
    hashFn: async (text) => `h:${text}`,
  };
  return {
    seams,
    store: inner,
    llm,
    writes,
    onWrite,
    cut: (records: number) => {
      keep = records;
    },
  };
}

/**
 * A run store that records every save; `died` drops the saves of an
 * extraction's outcome, as if the process ended before it could write them.
 */
function runs() {
  const inner = createInMemoryAgentRunStore();
  const saves: AgentRunEnvelope[] = [];
  const state = { died: false, refuseProgress: false };
  const store: AgentRunStore = {
    load: inner.load,
    save: async (envelope) => {
      const extraction = envelope.memory?.extraction;
      if (state.died && extraction && extraction.status !== 'pending')
        throw new Error('process ended');
      if (state.refuseProgress && extraction?.planned !== undefined) throw new Error('disk full');
      await inner.save(envelope);
      saves.push(structuredClone(envelope));
    },
  };
  return { store, inner, saves, state };
}

function options(
  seams: MemorySeams,
  store: AgentRunStore,
  runId: string,
): Resumable & { memory: { seams: MemorySeams; scope: typeof scope } } {
  return {
    model: createMockModel({ responses: [{ text: 'noted' }] }),
    prompt: 'I prefer tea and I live in Oslo',
    memory: { seams, scope, recall: false },
    session: { store, runId, scope: 'tenant' },
  };
}

async function extractionOf(
  store: AgentRunStore,
  runId: string,
): Promise<AgentRunMemoryExtraction | undefined> {
  return (await store.load(runId))?.memory?.extraction;
}

describe('native memory extraction: interrupted writes (H5)', () => {
  for (const died of [true, false]) {
    it(`a pass that wrote only part of its plan is never reported completed (${died ? 'the process died' : 'the write failed'})`, async () => {
      const mem = memory(['prefers tea', 'lives in Oslo']);
      const run = runs();
      const opts = options(mem.seams, run.store, 'partial');
      mem.cut(1);
      run.state.died = died;
      const result = await runAgent(opts);
      expect(result.status).toBe('completed');
      expect(await mem.store.list(scope)).toHaveLength(1);
      expect(await extractionOf(run.inner, 'partial')).toMatchObject({
        status: died ? 'pending' : 'failed',
        planned: 2,
      });

      run.state.died = false;
      const calls = mem.llm.mock.calls.length;
      const reconciled = await reconcileAgentRun({ session: opts.session, memory: opts.memory });
      expect(reconciled.memory).toBe('failed');
      expect(reconciled.warnings).toEqual([
        {
          type: 'memory-extraction-partial',
          setting: 'memory',
          message: expect.stringContaining('1 of the 2'),
        },
      ]);
      expect(await extractionOf(run.inner, 'partial')).toMatchObject({
        status: 'failed',
        planned: 2,
        mutations: 1,
        error: { code: 'memory-extraction-partial' },
      });
      // No second pass: the missing fact is reported, never guessed at again.
      expect(mem.llm).toHaveBeenCalledTimes(calls);
      expect(await mem.store.list(scope)).toHaveLength(1);
      // And it stays that way.
      expect((await reconcileAgentRun({ session: opts.session, memory: opts.memory })).memory).toBe(
        'failed',
      );
    });
  }

  it('saves the planned count before the first memory write', async () => {
    const mem = memory(['prefers tea', 'lives in Oslo']);
    const run = runs();
    let atFirstWrite: AgentRunEnvelope | undefined;
    mem.onWrite.mockImplementation(() => {
      atFirstWrite ??= run.saves.at(-1);
    });
    await runAgent(options(mem.seams, run.store, 'planned'));
    expect(atFirstWrite?.memory?.extraction).toMatchObject({ status: 'pending', planned: 2 });
    expect(atFirstWrite?.memory?.extraction?.mutations).toBeUndefined();
    expect(await extractionOf(run.inner, 'planned')).toMatchObject({
      status: 'completed',
      planned: 2,
      mutations: 2,
    });
  });

  it('applies and counts deletions first: a lost write after them is still partial', async () => {
    const mem = memory(
      ['prefers tea'],
      [
        { event: 'DELETE', id: '0' },
        { event: 'ADD', text: 'prefers tea' },
      ],
      [seeded('coffee', 'prefers coffee')],
    );
    const run = runs();
    const opts = options(mem.seams, run.store, 'deleted');
    mem.cut(0);
    run.state.died = true;
    await runAgent(opts);
    expect(mem.writes).toEqual(['delete:coffee']);
    expect(await extractionOf(run.inner, 'deleted')).toMatchObject({
      status: 'pending',
      planned: 2,
      mutations: 1,
    });
    run.state.died = false;
    const reconciled = await reconcileAgentRun({ session: opts.session, memory: opts.memory });
    expect(reconciled.memory).toBe('failed');
    expect(reconciled.warnings?.[0]?.type).toBe('memory-extraction-partial');
    expect(await extractionOf(run.inner, 'deleted')).toMatchObject({ planned: 2, mutations: 1 });
  });

  it('a pass that deleted and wrote everything settles completed without the LLM', async () => {
    const mem = memory(
      ['prefers tea'],
      [
        { event: 'DELETE', id: '0' },
        { event: 'ADD', text: 'prefers tea' },
      ],
      [seeded('coffee', 'prefers coffee')],
    );
    const run = runs();
    const opts = options(mem.seams, run.store, 'whole');
    run.state.died = true;
    await runAgent(opts);
    expect(mem.writes).toEqual(['delete:coffee', 'upsert:prefers tea']);
    run.state.died = false;
    const calls = mem.llm.mock.calls.length;
    const reconciled = await reconcileAgentRun({ session: opts.session, memory: opts.memory });
    expect(reconciled).toEqual({ runId: 'whole', memory: 'completed' });
    expect(await extractionOf(run.inner, 'whole')).toMatchObject({
      status: 'completed',
      planned: 2,
      mutations: 2,
    });
    expect(mem.llm).toHaveBeenCalledTimes(calls);
  });

  it('an updated record carries the operation that wrote it, so the update is found', async () => {
    const mem = memory(
      ['likes green tea'],
      [{ event: 'UPDATE', id: '0', text: 'likes green tea', old_memory: 'likes tea' }],
      [seeded('tea', 'likes tea', { deuz: { runId: 'older', operationId: 'op-older' } })],
    );
    const run = runs();
    const opts = options(mem.seams, run.store, 'updated');
    run.state.died = true;
    await runAgent(opts);
    const { operationId } = (await extractionOf(run.inner, 'updated'))!;
    expect(await mem.store.get('tea')).toMatchObject({
      text: 'likes green tea',
      metadata: { deuz: { runId: 'updated', operationId }, prevText: 'likes tea' },
    });
    run.state.died = false;
    const reconciled = await reconcileAgentRun({ session: opts.session, memory: opts.memory });
    expect(reconciled).toEqual({ runId: 'updated', memory: 'completed' });
  });

  it('a pass that planned nothing settles completed without the LLM', async () => {
    const mem = memory([]);
    const run = runs();
    const opts = options(mem.seams, run.store, 'nothing');
    run.state.died = true;
    await runAgent(opts);
    expect(await extractionOf(run.inner, 'nothing')).toMatchObject({
      status: 'pending',
      planned: 0,
    });
    run.state.died = false;
    const calls = mem.llm.mock.calls.length;
    expect(await reconcileAgentRun({ session: opts.session, memory: opts.memory })).toEqual({
      runId: 'nothing',
      memory: 'completed',
    });
    expect(await extractionOf(run.inner, 'nothing')).toMatchObject({
      status: 'completed',
      planned: 0,
      mutations: 0,
    });
    expect(mem.llm).toHaveBeenCalledTimes(calls);
  });

  it('writes nothing when the planned count cannot be saved, and reconciles by running again', async () => {
    const mem = memory(['prefers tea', 'lives in Oslo']);
    const run = runs();
    const opts = options(mem.seams, run.store, 'unsaved');
    run.state.refuseProgress = true;
    const events: AgentEvent[] = [];
    const stream = streamAgent(opts);
    const consumed = (async () => {
      for await (const event of stream.events) events.push(event);
    })();
    expect((await stream.result).status).toBe('completed');
    await consumed;
    expect(mem.onWrite).not.toHaveBeenCalled();
    expect(
      events.some(
        (event) =>
          event.type === 'part' &&
          event.part.type === 'warning' &&
          event.part.warning.setting === 'memory',
      ),
    ).toBe(true);
    run.state.refuseProgress = false;
    const reconciled = await reconcileAgentRun({ session: opts.session, memory: opts.memory });
    expect(reconciled.memory).toBe('completed');
    expect((await mem.store.list(scope)).map((record) => record.text).sort()).toEqual([
      'lives in Oslo',
      'prefers tea',
    ]);
  });

  it('settles an extraction a 2.3 process left pending as 2.3 did', async () => {
    const mem = memory(['prefers tea', 'lives in Oslo']);
    const run = runs();
    const opts = options(mem.seams, run.store, 'older');
    mem.cut(1);
    run.state.died = true;
    await runAgent(opts);
    run.state.died = false;
    // A 2.3 executor saved no planned count.
    const envelope = (await run.inner.load('older'))!;
    delete envelope.memory!.extraction!.planned;
    envelope.revision = (envelope.revision ?? 0) + 1;
    await run.inner.save(envelope);
    const reconciled = await reconcileAgentRun({ session: opts.session, memory: opts.memory });
    expect(reconciled).toEqual({ runId: 'older', memory: 'completed' });
    expect(await extractionOf(run.inner, 'older')).toMatchObject({ mutations: 1 });
  });
});

describe('memory: plan, then apply (2.4 exports)', () => {
  it('remember({ apply: false }) writes nothing and applyMutations applies the plan', async () => {
    const mem = memory(['prefers tea']);
    const plan = await remember([{ role: 'user', content: 'I prefer tea' }], scope, mem.seams, {
      apply: false,
    });
    expect(plan).toMatchObject([{ op: 'upsert', event: 'ADD', record: { text: 'prefers tea' } }]);
    expect(await mem.store.list(scope)).toEqual([]);
    await applyMutations(mem.seams.store, plan);
    expect((await mem.store.list(scope)).map((record) => record.text)).toEqual(['prefers tea']);
  });
});
