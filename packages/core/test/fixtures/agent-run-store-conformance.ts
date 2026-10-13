import { describe, expect, it } from 'vitest';
import type {
  AgentResult,
  AgentRunEnvelope,
  AgentRunListPage,
  AgentRunListQuery,
  AgentRunStore,
} from '../../src/types/agent-run';

/** A minimal native envelope at the given revision (undefined: a 2.1 envelope). */
export function envelope(
  runId: string,
  revision: number | undefined,
  extra: Partial<AgentRunEnvelope> = {},
): AgentRunEnvelope {
  return {
    kind: 'deuz-agent-run',
    version: 1,
    runId,
    scope: 'tenant',
    phase: 'running',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
    usage: {
      inputTokens: 1,
      outputTokens: 2,
      reasoningTokens: 0,
      cachedReadTokens: 0,
      cacheWriteTokens: 0,
      cacheWrite1hTokens: 0,
      totalTokens: 3,
    },
    modelSteps: 0,
    finalizationAttempts: 0,
    verificationAttempts: 0,
    checkpoints: {},
    ...(revision === undefined ? {} : { revision }),
    ...extra,
  };
}

/**
 * The durable native run store contract (2.2). Every save carries the next
 * revision; a store rejects any other, so an executor that lost its run (a
 * zombie) cannot overwrite the new executor's progress.
 */
export function agentRunStoreContracts(
  name: string,
  make: () => AgentRunStore | Promise<AgentRunStore>,
): void {
  describe(name, () => {
    it('roundtrips envelopes as copies and returns undefined for an unknown run', async () => {
      const store = await make();
      expect(await store.load('missing')).toBeUndefined();
      const first = envelope('run', 1);
      await store.save(first);
      first.modelSteps = 99;
      const loaded = await store.load('run');
      expect(loaded).toEqual(envelope('run', 1));
      loaded!.messages.length = 0;
      expect((await store.load('run'))?.messages).toHaveLength(1);
      await store.save(envelope('run', 2, { phase: 'terminal', modelSteps: 3 }));
      expect(await store.load('run')).toMatchObject({ revision: 2, phase: 'terminal' });
    });

    it('rejects a stale or skipped revision without writing it', async () => {
      const store = await make();
      await store.save(envelope('run', 1));
      await store.save(envelope('run', 2, { modelSteps: 1 }));
      // A zombie executor still believes revision 1 is current.
      await expect(
        Promise.resolve().then(() => store.save(envelope('run', 2, { modelSteps: 7 }))),
      ).rejects.toThrow(/revision/i);
      await expect(
        Promise.resolve().then(() => store.save(envelope('run', 4, { modelSteps: 7 }))),
      ).rejects.toThrow(/revision/i);
      await expect(Promise.resolve().then(() => store.save(envelope('other', 2)))).rejects.toThrow(
        /revision/i,
      );
      expect(await store.load('run')).toMatchObject({ revision: 2, modelSteps: 1 });
      expect(await store.load('other')).toBeUndefined();
    });

    it('counts a stored 2.1 envelope without a revision as revision 0', async () => {
      const store = await make();
      await store.save(envelope('legacy', undefined));
      expect((await store.load('legacy'))?.revision).toBeUndefined();
      await store.save(envelope('legacy', 1, { modelSteps: 2 }));
      expect(await store.load('legacy')).toMatchObject({ revision: 1, modelSteps: 2 });
      // Once fenced, a revision-less writer is stale too.
      await expect(
        Promise.resolve().then(() => store.save(envelope('legacy', undefined))),
      ).rejects.toThrow(/revision/i);
    });
  });
}

/**
 * Agent run retention (2.3), shared by the SQLite and Postgres ops stores:
 * `prune` deletes the terminal runs last saved before a time. `advance` moves
 * the store's time forward and `now` reads it.
 */
export function agentRunPruneContracts(
  name: string,
  make: () => Promise<{
    store: AgentRunStore & { prune(before: number): Promise<number> };
    advance(ms: number): Promise<void>;
    now(): number;
  }>,
): void {
  describe(name, () => {
    it('prunes terminal runs last saved before a time, and nothing a run may still need', async () => {
      const { store, advance, now } = await make();
      // A NUL, a lone surrogate or an escape spelled out in a message must not
      // trip the prune's reading of the phase.
      const nul = {
        messages: [
          {
            role: 'user' as const,
            content: [{ type: 'text' as const, text: 'a\u0000b \ud800 \\u0000 \\\u0000' }],
          },
        ],
      };
      await store.save(envelope('done', 1, { phase: 'terminal', ...nul }));
      await store.save(envelope('running', 1, nul));
      await store.save(envelope('finalizing', 1, { phase: 'finalizing' }));
      // A suspended native run keeps phase 'running' until it settles.
      await store.save(envelope('suspended', 1));
      await store.save(envelope('legacy', undefined, { phase: 'terminal' }));
      await advance(50);
      const cut = now();
      await advance(50);
      await store.save(envelope('recent', 1, { phase: 'terminal' }));

      expect(await store.prune(cut)).toBe(2);
      expect(await store.load('done')).toBeUndefined();
      expect(await store.load('legacy')).toBeUndefined();
      for (const runId of ['running', 'finalizing', 'suspended', 'recent'])
        expect(await store.load(runId), runId).toBeDefined();
      expect(await store.prune(cut)).toBe(0);
      // A pruned run's ID is free again.
      await store.save(envelope('done', 1));
      expect(await store.load('done')).toMatchObject({ revision: 1, phase: 'running' });
      await expect(Promise.resolve().then(() => store.prune(Number.NaN))).rejects.toThrow(
        TypeError,
      );
    });
  });
}

/** A stored result of the given status, as a native run records it. */
function outcome(runId: string, status: AgentResult<unknown>['status']): AgentResult<unknown> {
  const base = {
    runId,
    text: '',
    messages: [],
    usage: envelope(runId, 1).usage,
    modelSteps: 1,
  };
  if (status === 'completed') return { ...base, status, output: 'done' };
  if (status === 'suspended')
    return { ...base, status, pendingApprovals: [], pendingClientCalls: [] };
  if (status === 'stopped') return { ...base, status, reason: 'aborted' };
  return { ...base, status, error: { name: 'Error', message: 'boom' } };
}

type ListingStore = AgentRunStore & {
  list(query?: AgentRunListQuery): Promise<AgentRunListPage>;
};

/**
 * Native run discovery (2.3): `list` pages through a store's runs, newest
 * change first, with a summary of each. `advance` moves the store's time
 * forward and `now` reads it, to within `slack` ms. `frozen` says that time
 * stands still between advances (an injected clock), so two saves can share
 * a time.
 */
export function agentRunListContracts(
  name: string,
  make: () => Promise<{
    store: ListingStore;
    advance(ms: number): Promise<void>;
    now(): number;
    slack?: number;
    frozen?: boolean;
  }>,
): void {
  /** Every run a full traversal visits, page by page. */
  const traverse = async (store: ListingStore, query: AgentRunListQuery = {}) => {
    const pages: string[][] = [];
    let cursor: string | undefined;
    do {
      const page = await store.list({ ...query, ...(cursor ? { cursor } : {}) });
      pages.push(page.runs.map((run) => run.runId));
      cursor = page.cursor;
    } while (cursor && pages.length < 50);
    return pages;
  };

  describe(name, () => {
    it('lists nothing in an empty store', async () => {
      const { store } = await make();
      expect(await store.list()).toEqual({ runs: [] });
      expect(await store.list({ phases: ['running'], limit: 1 })).toEqual({ runs: [] });
    });

    it('summarises each run, newest change first, with the time of its last save', async () => {
      const { store, advance, now, slack = 0 } = await make();
      const times: Record<string, [number, number]> = {};
      const save = async (value: AgentRunEnvelope) => {
        const before = now();
        await store.save(value);
        times[value.runId] = [before, now()];
        await advance(5);
      };
      await save(envelope('a', 1));
      await save(envelope('b', 1, { phase: 'finalizing', scope: 'other' }));
      // A NUL or a lone surrogate in a message must not trip the reading of the summary.
      const odd = {
        role: 'user' as const,
        content: [{ type: 'text' as const, text: 'a\u0000b \ud800 \\u0000' }],
      };
      await save(
        envelope('c', 1, {
          phase: 'terminal',
          messages: [odd],
          result: { ...outcome('c', 'completed'), messages: [odd] },
        }),
      );
      await save(envelope('s', 1, { result: outcome('s', 'suspended') }));
      await save(
        envelope('legacy', undefined, { phase: 'terminal', result: outcome('legacy', 'failed') }),
      );
      // A new save moves a run to the front.
      await save(envelope('a', 2, { modelSteps: 3 }));

      const { runs, cursor } = await store.list();
      expect(cursor).toBeUndefined();
      expect(runs.map((run) => run.runId)).toEqual(['a', 'legacy', 's', 'c', 'b']);
      const at = expect.any(Number) as unknown as number;
      expect(runs).toEqual([
        { runId: 'a', scope: 'tenant', phase: 'running', revision: 2, updatedAt: at },
        // A 2.1 envelope has no revision and counts as 0.
        {
          runId: 'legacy',
          scope: 'tenant',
          phase: 'terminal',
          revision: 0,
          status: 'failed',
          updatedAt: at,
        },
        // A suspended run keeps phase 'running'; its stored result says why.
        {
          runId: 's',
          scope: 'tenant',
          phase: 'running',
          revision: 1,
          status: 'suspended',
          updatedAt: at,
        },
        {
          runId: 'c',
          scope: 'tenant',
          phase: 'terminal',
          revision: 1,
          status: 'completed',
          updatedAt: at,
        },
        { runId: 'b', scope: 'other', phase: 'finalizing', revision: 1, updatedAt: at },
      ]);
      for (const run of runs) {
        const [from, to] = times[run.runId]!;
        expect(run.updatedAt, run.runId).toBeGreaterThanOrEqual(from - slack);
        expect(run.updatedAt, run.runId).toBeLessThanOrEqual(to + slack);
      }
      for (let index = 1; index < runs.length; index++)
        expect(runs[index - 1]!.updatedAt).toBeGreaterThan(runs[index]!.updatedAt);
    });

    it('filters by phase, scope and last save', async () => {
      const { store, advance, now } = await make();
      await store.save(envelope('old-running', 1));
      await store.save(envelope('old-terminal', 1, { phase: 'terminal' }));
      await store.save(envelope('old-other', 1, { scope: 'other' }));
      await advance(50);
      const cut = now();
      await advance(50);
      await store.save(envelope('new-running', 1));
      await store.save(envelope('new-finalizing', 1, { phase: 'finalizing' }));

      const ids = async (query: AgentRunListQuery) =>
        (await store.list(query)).runs.map((run) => run.runId).sort();
      expect(await ids({ phases: ['terminal'] })).toEqual(['old-terminal']);
      expect(await ids({ phases: ['running', 'finalizing'] })).toEqual([
        'new-finalizing',
        'new-running',
        'old-other',
        'old-running',
      ]);
      expect(await ids({ scope: 'other' })).toEqual(['old-other']);
      expect(await ids({ updatedBefore: cut })).toEqual([
        'old-other',
        'old-running',
        'old-terminal',
      ]);
      expect(
        await ids({ updatedBefore: cut, phases: ['running', 'finalizing'], scope: 'tenant' }),
      ).toEqual(['old-running']);
      // No phase at all: nothing.
      expect(await ids({ phases: [] })).toEqual([]);
    });

    it('pages with a cursor, which it returns only while more runs follow', async () => {
      const { store, advance } = await make();
      for (const runId of ['r1', 'r2', 'r3', 'r4', 'r5']) {
        await store.save(envelope(runId, 1));
        await advance(3);
      }
      expect(await traverse(store, { limit: 2 })).toEqual([['r5', 'r4'], ['r3', 'r2'], ['r1']]);
      // A last page that is exactly full carries no cursor.
      expect(await traverse(store, { limit: 5 })).toEqual([['r5', 'r4', 'r3', 'r2', 'r1']]);
      expect(await traverse(store, { limit: 1, phases: ['running'], updatedBefore: 1e15 })).toEqual(
        [['r5'], ['r4'], ['r3'], ['r2'], ['r1']],
      );
    });

    it('never repeats a run that is saved again while a traversal pages', async () => {
      const { store, advance } = await make();
      for (const runId of ['r1', 'r2', 'r3']) {
        await store.save(envelope(runId, 1));
        await advance(3);
      }
      const first = await store.list({ limit: 1 });
      expect(first.runs.map((run) => run.runId)).toEqual(['r3']);
      // r3 moves further ahead, and r1, not listed yet, overtakes the cursor.
      await store.save(envelope('r3', 2));
      await advance(3);
      await store.save(envelope('r1', 2));
      const rest = await traverse(store, { limit: 1, cursor: first.cursor });
      expect(rest.flat()).toEqual(['r2']);
    });

    it('orders runs saved at the same time by run ID, descending', async () => {
      const { store, frozen } = await make();
      if (!frozen) return;
      for (const runId of ['x', 'z', 'y']) await store.save(envelope(runId, 1));
      expect(await traverse(store, { limit: 1 })).toEqual([['z'], ['y'], ['x']]);
      expect(await traverse(store, { limit: 2 })).toEqual([['z', 'y'], ['x']]);
    });

    it('rejects a malformed query', async () => {
      const { store } = await make();
      await store.save(envelope('r', 1));
      for (const query of [
        { limit: 0 },
        { limit: 1001 },
        { limit: 1.5 },
        { limit: Number.NaN },
        { cursor: 'not-a-cursor' },
        { cursor: '' },
        { cursor: '[1]' },
        { phases: ['done'] },
        { phases: 'running' },
        { updatedBefore: Number.NaN },
        { updatedBefore: Number.POSITIVE_INFINITY },
        { scope: 7 },
      ] as unknown as AgentRunListQuery[])
        await expect(
          Promise.resolve().then(() => store.list(query)),
          JSON.stringify(query),
        ).rejects.toThrow(TypeError);
      expect((await store.list({ limit: 1000 })).runs).toHaveLength(1);
    });
  });
}
