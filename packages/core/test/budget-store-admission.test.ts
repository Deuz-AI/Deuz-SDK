import { describe, expect, it, vi } from 'vitest';
import { createBudgetLedger } from '../src/budget-ledger';
import { createInMemoryBudgetStore } from '../src/budget-store';
import { createExecutionContext } from '../src/execution-policy';
import { createInMemoryAgentRunStore, resumeAgent, runAgent } from '../src/agent-run';
import { createMockModel } from '../src/testing';
import { createAgent } from '../src/agent';
import { createInMemorySwarmStore, createSwarm } from '../src/swarm';
import type { SwarmStore } from '../src/types/swarm';
import type { BudgetStore, PersistentBudgetScope } from '../src/types/budget-store';
import type { BudgetAdmission, BudgetWarning } from '../src/types/execution';

function manualClock(start = 1_000_000) {
  let now = start;
  return {
    clock: { now: () => now, setTimeout: () => () => {} },
    advance: (ms: number) => {
      now += ms;
    },
  };
}

const user = (
  tokens: number,
  extra: Partial<PersistentBudgetScope> = {},
): PersistentBudgetScope => ({
  key: 'user:1',
  limits: { tokens },
  ...extra,
});

const usage = (totalTokens: number) => ({
  inputTokens: totalTokens,
  outputTokens: 0,
  reasoningTokens: 0,
  cachedReadTokens: 0,
  cacheWriteTokens: 0,
  cacheWrite1hTokens: 0,
  totalTokens,
});

describe('ledger admission through a BudgetStore', () => {
  it('admits locally, then in the store, and records the hold in both', async () => {
    const store = createInMemoryBudgetStore();
    const ledger = createBudgetLedger({ admission: { store, scopes: [user(100)] } });
    await ledger.reserve({ requestId: 'a', modelId: 'm', tokens: 60 });
    expect(ledger.get('a')?.state).toBe('reserved');
    expect(await store.usage('user:1')).toEqual({ tokens: 60, usd: 0 });
  });

  it('refuses a request the store denies and keeps no local record', async () => {
    const store = createInMemoryBudgetStore();
    const ledger = createBudgetLedger({ admission: { store, scopes: [user(100)] } });
    await ledger.reserve({ requestId: 'a', modelId: 'm', tokens: 60 });
    await expect(
      ledger.reserve({ requestId: 'b', modelId: 'm', tokens: 60 }),
    ).rejects.toMatchObject({
      name: 'BudgetLedgerError',
      code: 'budget_exceeded',
      message: expect.stringContaining('user:1'),
    });
    expect(ledger.get('b')).toBeUndefined();
    expect(ledger.snapshot().revision).toBe(1);
    expect(await store.usage('user:1')).toEqual({ tokens: 60, usd: 0 });
  });

  it('does not reach the store when local admission fails', async () => {
    const inner = createInMemoryBudgetStore();
    const reserve = vi.fn(inner.reserve);
    const store: BudgetStore = { ...inner, reserve };
    const ledger = createBudgetLedger({
      budget: { tokens: 10 },
      admission: { store, scopes: [user(100)] },
    });
    await expect(
      ledger.reserve({ requestId: 'a', modelId: 'm', tokens: 50 }),
    ).rejects.toMatchObject({ code: 'budget_exceeded' });
    expect(reserve).not.toHaveBeenCalled();
  });

  it('requires an estimate for every dimension a persistent scope bounds', async () => {
    const store = createInMemoryBudgetStore();
    const ledger = createBudgetLedger({
      admission: { store, scopes: [{ key: 'user:1', limits: { usd: 1 } }] },
    });
    await expect(ledger.reserve({ requestId: 'a', modelId: 'm', tokens: 5 })).rejects.toMatchObject(
      { code: 'missing_reservation' },
    );
    expect(await store.usage('user:1')).toEqual({ tokens: 0, usd: 0 });
  });

  it('fails closed when the store is unavailable', async () => {
    const store: BudgetStore = {
      ...createInMemoryBudgetStore(),
      reserve: () => Promise.reject(new Error('connection refused')),
    };
    const ledger = createBudgetLedger({ admission: { store, scopes: [user(100)] } });
    await expect(ledger.reserve({ requestId: 'a', modelId: 'm', tokens: 5 })).rejects.toMatchObject(
      {
        code: 'admission_failed',
        cause: expect.objectContaining({ message: 'connection refused' }),
      },
    );
    expect(ledger.get('a')).toBeUndefined();
    // The ledger is not poisoned: the next attempt may succeed.
    expect(ledger.snapshot().revision).toBe(0);
  });

  it('mirrors settlement, release and unknown usage to the store', async () => {
    const store = createInMemoryBudgetStore();
    const ledger = createBudgetLedger({ admission: { store, scopes: [user(1_000)] } });
    await ledger.reserve({ requestId: 'settled', modelId: 'm', tokens: 100, usd: 1 });
    await ledger.settle({ requestId: 'settled', tokens: 10, usd: 0.5 });
    expect(await store.usage('user:1')).toEqual({ tokens: 10, usd: 0.5 });

    await ledger.reserve({ requestId: 'priced', modelId: 'm', tokens: 100, usd: 1 });
    await ledger.settleUsage('priced', usage(20), { priceUsage: () => 0.25 });
    expect(await store.usage('user:1')).toEqual({ tokens: 30, usd: 0.75 });

    // Unpriced usage stays unknown locally, so the store keeps the full hold.
    await ledger.reserve({ requestId: 'unpriced', modelId: 'm', tokens: 100, usd: 1 });
    await ledger.settleUsage('unpriced', usage(20));
    expect(ledger.get('unpriced')?.state).toBe('unknown');
    await ledger.reserve({ requestId: 'unknown', modelId: 'm', tokens: 100, usd: 1 });
    await ledger.markUnknown('unknown');
    expect(await store.usage('user:1')).toEqual({ tokens: 230, usd: 2.75 });

    await ledger.reserve({ requestId: 'released', modelId: 'm', tokens: 100, usd: 1 });
    await ledger.release('released');
    expect(await store.usage('user:1')).toEqual({ tokens: 230, usd: 2.75 });
  });

  it('leaves the local record untouched when mirroring fails, so the call can be retried', async () => {
    const inner = createInMemoryBudgetStore();
    let failing = true;
    const store: BudgetStore = {
      ...inner,
      settle: (id, actual) =>
        failing ? Promise.reject(new Error('timeout')) : inner.settle(id, actual),
    };
    const ledger = createBudgetLedger({ admission: { store, scopes: [user(1_000)] } });
    await ledger.reserve({ requestId: 'a', modelId: 'm', tokens: 100, usd: 1 });
    await expect(ledger.settle({ requestId: 'a', tokens: 10, usd: 0 })).rejects.toMatchObject({
      code: 'admission_failed',
    });
    expect(ledger.get('a')?.state).toBe('reserved');
    failing = false;
    await ledger.settle({ requestId: 'a', tokens: 10, usd: 0 });
    expect(await inner.usage('user:1')).toEqual({ tokens: 10, usd: 0 });
  });

  it('warns once per crossing per scope and dimension', async () => {
    const { clock, advance } = manualClock();
    const store = createInMemoryBudgetStore({ clock });
    const warnings: BudgetWarning[] = [];
    const ledger = createBudgetLedger({
      admission: {
        store,
        scopes: [
          user(100, { window: { ms: 1_000, buckets: 10 } }),
          { key: 'org:1', limits: { tokens: 1_000 }, warnAtPercent: 5 },
        ],
        warnAtPercent: 80,
        onWarning: (warning) => {
          warnings.push(warning);
          throw new Error('a broken callback never breaks admission');
        },
      },
    });
    await ledger.reserve({ requestId: 'a', modelId: 'm', tokens: 50 });
    expect(warnings).toEqual([
      {
        key: 'org:1',
        dimension: 'tokens',
        committed: 50,
        limit: 1_000,
        percent: 5,
        warnAtPercent: 5,
        requestId: 'a',
      },
    ]);
    await ledger.reserve({ requestId: 'b', modelId: 'm', tokens: 35 });
    await ledger.reserve({ requestId: 'c', modelId: 'm', tokens: 5 });
    expect(warnings.map((warning) => [warning.key, warning.requestId])).toEqual([
      ['org:1', 'a'],
      ['user:1', 'b'],
    ]);
    // The window empties, usage drops below the threshold, then crosses again.
    advance(1_000);
    await ledger.reserve({ requestId: 'd', modelId: 'm', tokens: 10 });
    await ledger.reserve({ requestId: 'e', modelId: 'm', tokens: 80 });
    expect(warnings.map((warning) => [warning.key, warning.requestId])).toEqual([
      ['org:1', 'a'],
      ['user:1', 'b'],
      ['user:1', 'e'],
    ]);
  });

  it('records persistent scopes in a version 2 snapshot that needs the store to restore', async () => {
    const store = createInMemoryBudgetStore();
    const ledger = createBudgetLedger({ admission: { store, scopes: [user(100)] } });
    await ledger.reserve({ requestId: 'a', modelId: 'm', tokens: 60 });
    const saved = ledger.snapshot();
    expect(saved).toMatchObject({ version: 2, admission: [user(100)] });
    expect(() => createBudgetLedger({ snapshot: saved })).toThrow(/persistent/i);

    const restored = createBudgetLedger({ snapshot: saved, admission: { store } });
    expect(restored.snapshot().admission).toEqual([user(100)]);
    await expect(
      restored.reserve({ requestId: 'b', modelId: 'm', tokens: 60 }),
    ).rejects.toMatchObject({ code: 'budget_exceeded' });
    await restored.settle({ requestId: 'a', tokens: 10, usd: 0 });
    expect(await store.usage('user:1')).toEqual({ tokens: 10, usd: 0 });
  });

  it('only tightens persistent scopes on restore', async () => {
    const store = createInMemoryBudgetStore();
    const saved = createBudgetLedger({ admission: { store, scopes: [user(100)] } }).snapshot();
    const tightened = createBudgetLedger({
      snapshot: saved,
      admission: {
        store,
        scopes: [user(500), { key: 'org:1', limits: { usd: 3 } }],
      },
    });
    expect(tightened.snapshot().admission).toEqual([
      { key: 'user:1', limits: { tokens: 100 } },
      { key: 'org:1', limits: { usd: 3 } },
    ]);
    expect(() =>
      createBudgetLedger({
        snapshot: saved,
        admission: { store, scopes: [user(50, { window: { ms: 1_000 } })] },
      }),
    ).toThrow(/window/i);
  });

  it('rejects malformed admission', () => {
    const store = createInMemoryBudgetStore();
    expect(() => createBudgetLedger({ admission: { store, scopes: [] } })).toThrow(/scope/i);
    expect(() => createBudgetLedger({ admission: { store, scopes: [user(1), user(2)] } })).toThrow(
      /duplicate/i,
    );
    expect(() =>
      createBudgetLedger({ admission: { store, scopes: [user(1)], warnAtPercent: 0 } }),
    ).toThrow(/warnAtPercent/);
    expect(() => createBudgetLedger({ admission: { scopes: [user(1)] } as never })).toThrow(
      /store/i,
    );
  });
});

describe('execution contexts with persistent admission', () => {
  it('shares admission with child contexts and records it in a version 2 snapshot', async () => {
    const store = createInMemoryBudgetStore();
    const root = createExecutionContext({
      scopeId: 'run',
      admission: { store, scopes: [user(100)] },
    });
    const child = root.child({ scopeId: 'tool-1' });
    await child.reserve({ requestId: 'c', modelId: 'm', tokens: 70 });
    await expect(root.reserve({ requestId: 'r', modelId: 'm', tokens: 40 })).rejects.toMatchObject({
      code: 'budget_exceeded',
    });
    const saved = child.snapshot();
    expect(saved.version).toBe(2);
    expect(saved.ledger.admission).toEqual([user(100)]);
    expect(() => createExecutionContext({ snapshot: saved })).toThrow(/persistent/i);

    const restored = createExecutionContext({ snapshot: saved, admission: { store } });
    await expect(
      restored.reserve({ requestId: 'again', modelId: 'm', tokens: 40 }),
    ).rejects.toMatchObject({ code: 'budget_exceeded' });
    await restored.reserve({ requestId: 'fits', modelId: 'm', tokens: 30 });
    expect(await store.usage('user:1')).toEqual({ tokens: 100, usd: 0 });
  });

  it('keeps version 1 snapshots for contexts without persistent scopes', () => {
    expect(createExecutionContext({}).snapshot().version).toBe(1);
  });

  it('refuses a context snapshot whose version disagrees with its persistent scopes', () => {
    const store = createInMemoryBudgetStore();
    const saved = createExecutionContext({ admission: { store, scopes: [user(100)] } }).snapshot();
    const { admission: _dropped, ...ledger } = saved.ledger;
    expect(() =>
      createExecutionContext({ snapshot: { ...saved, version: 1 }, admission: { store } }),
    ).toThrow(/malformed/i);
    expect(() =>
      createExecutionContext({ snapshot: { ...saved, ledger }, admission: { store } }),
    ).toThrow(/malformed/i);
  });

  it('denies a second native run once a shared user scope is exhausted', async () => {
    const store = createInMemoryBudgetStore();
    const admission = { store, scopes: [user(110)] };
    const run = (scopeId: string) =>
      runAgent({
        model: createMockModel({
          responses: [{ text: 'done', usage: { inputTokens: 10, outputTokens: 5 } }],
        }),
        prompt: 'hi',
        execution: createExecutionContext({ scopeId, admission }),
        executionEstimate: { tokens: 100, usd: 0.1 },
        deps: { priceProvider: { priceUsage: () => 0.01 } },
      });
    const first = await run('run-a');
    expect(first.status).toBe('completed');
    // The first run settled to its actual 15 tokens; 15 + 100 no longer fits in 110.
    expect(await store.usage('user:1')).toEqual({ tokens: 15, usd: 0.01 });
    const second = await run('run-b');
    expect(second).toMatchObject({
      status: 'failed',
      error: { message: expect.stringMatching(/budget exceeded in persistent scope user:1/) },
    });
    expect(await store.usage('user:1')).toEqual({ tokens: 15, usd: 0.01 });
  });

  it('resumes a suspended native run with its persistent admission, and never without it', async () => {
    const store = createInMemoryBudgetStore();
    const runs = createInMemoryAgentRunStore();
    const start = (runId: string) => {
      const options = {
        model: createMockModel({
          responses: [{ toolCalls: [{ toolName: 'work', id: 'w', args: {} }] }, { text: 'done' }],
        }),
        prompt: 'x',
        session: { store: runs, runId, scope: 'tenant' },
        tools: {
          work: {
            parameters: { type: 'object', properties: {} },
            execute: () => 'ok',
            needsApproval: true,
          },
        },
        executionEstimate: { tokens: 100, usd: 0.1 },
        deps: { priceProvider: { priceUsage: () => 0.01 } },
      };
      const execution = createExecutionContext({
        scopeId: runId,
        admission: { store, scopes: [user(1_000)] },
      });
      return { options, first: runAgent({ ...options, execution }) };
    };
    const approved = [{ approvalId: 'w', approved: true }];

    const durable = start('durable');
    expect((await durable.first).status).toBe('suspended');
    const saved = (await runs.load('durable'))!.execution!;
    expect(saved).toMatchObject({ version: 2, ledger: { admission: [user(1_000)] } });
    const resumed = await resumeAgent({
      ...durable.options,
      execution: createExecutionContext({ snapshot: saved, admission: { store } }),
      approvalResponses: approved,
    });
    expect(resumed.status).toBe('completed');
    // Both model calls were admitted and settled in the shared store.
    expect(await store.usage('user:1')).toMatchObject({ tokens: 30 });

    const blind = start('blind');
    expect((await blind.first).status).toBe('suspended');
    expect(await resumeAgent({ ...blind.options, approvalResponses: approved })).toMatchObject({
      status: 'failed',
      error: { message: expect.stringMatching(/persistent/) },
    });
  });
});

describe('swarms with persistent admission', () => {
  // Priced, so settlement replaces each hold with the actual usage.
  const deps = { priceProvider: { priceUsage: () => 0.01 } };
  const worker = () =>
    createAgent({
      model: createMockModel({
        responses: [{ text: 'done', usage: { inputTokens: 10, outputTokens: 5 } }],
      }),
    });

  it("admits every task's model calls against the swarm's persistent scopes", async () => {
    const store = createInMemoryBudgetStore();
    const swarm = createSwarm({
      store: createInMemorySwarmStore(),
      agents: { worker: worker() },
      deps,
      admission: { store, scopes: [user(100_000)] },
    });
    const outcome = await (
      await swarm.run({ scope: 'tenant', tasks: [{ id: 'a', agent: 'worker', prompt: 'x' }] })
    ).result;
    expect(outcome.run.status).toBe('completed');
    expect(await store.usage('user:1')).toMatchObject({ tokens: 15 });
    expect(outcome.run.executionState).toMatchObject({
      version: 2,
      ledger: { admission: [user(100_000)] },
    });
  });

  it('fails a task the shared scope cannot admit', async () => {
    const store = createInMemoryBudgetStore();
    const swarm = createSwarm({
      store: createInMemorySwarmStore(),
      agents: { worker: worker() },
      deps,
      admission: { store, scopes: [user(100)] },
    });
    const outcome = await (
      await swarm.run({ scope: 'tenant', tasks: [{ id: 'a', agent: 'worker', prompt: 'x' }] })
    ).result;
    expect(outcome.tasks[0]).toMatchObject({
      status: 'failed',
      error: { message: expect.stringMatching(/persistent scope user:1/) },
    });
    expect(await store.usage('user:1')).toMatchObject({ tokens: 0 });
  });

  it('resumes an interrupted swarm with its persistent admission, and never without it', async () => {
    const store = createInMemoryBudgetStore();
    const inner = createInMemorySwarmStore();
    let crash = true;
    const swarms: SwarmStore = {
      ...inner,
      async commit(change) {
        if (crash && change.events?.some((event) => event.type === 'task.completed')) {
          crash = false;
          throw new Error('crash before the task completes');
        }
        return inner.commit(change);
      },
    };
    const options = (admission?: BudgetAdmission) => ({
      store: swarms,
      agents: { worker: worker() },
      deps,
      ...(admission ? { admission } : {}),
    });
    const handle = await createSwarm(options({ store, scopes: [user(100_000)] })).run({
      scope: 'tenant',
      runId: 'interrupted',
      tasks: [{ id: 'a', agent: 'worker', prompt: 'x', replay: 'safe' }],
    });
    await expect(handle.result).rejects.toThrow('crash before the task completes');
    await expect(
      (async () => (await createSwarm(options()).resume(handle)).result)(),
    ).rejects.toThrow(/persistent budget scopes/);
    const resumed = await (await createSwarm(options({ store, scopes: [] })).resume(handle)).result;
    expect(resumed.run.status).toBe('completed');
    // The finished native run is recovered, not repeated: one admitted, settled call.
    expect(await store.usage('user:1')).toMatchObject({ tokens: 15 });
  });
});
