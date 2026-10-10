import { describe, expect, it } from 'vitest';
import type { AgentRunEnvelope, AgentRunStore } from '../../src/types/agent-run';

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
