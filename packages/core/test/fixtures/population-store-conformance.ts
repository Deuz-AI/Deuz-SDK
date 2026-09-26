import { describe, expect, it } from 'vitest';
import type { EvolveCandidate, EvolveRunRecord, PopulationStore } from '../../src/evolve/types';

export function runRecord(overrides: Partial<EvolveRunRecord> = {}): EvolveRunRecord {
  return {
    kind: 'deuz-evolve',
    version: 1,
    scope: 'tenant',
    runId: 'run',
    seed: 'seed',
    status: 'running',
    generation: -1,
    islandCount: 1,
    mutationsPerGeneration: 2,
    modelCount: 1,
    islands: [{ members: [] }],
    archive: [],
    bandit: { pulls: [0], rewards: [0] },
    stale: 0,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

export function candidateRecord(overrides: Partial<EvolveCandidate> = {}): EvolveCandidate {
  const generation = overrides.generation ?? 1;
  const island = overrides.island ?? 0;
  const slot = overrides.slot ?? 0;
  return {
    scope: 'tenant',
    runId: 'run',
    id: `g${generation}-i${island}-s${slot}`,
    generation,
    island,
    slot,
    program: 'x = 1',
    patchType: 'diff',
    parentId: 'g0-i0-s0',
    inspirationIds: [],
    model: 0,
    accepted: true,
    score: 1,
    metrics: { speed: 2 },
    artifacts: { stderr: 'ok' },
    stages: [{ name: 'stage-0', score: 1, passed: true }],
    createdAt: 1,
    ...overrides,
  };
}

/** The shared PopulationStore contract; every backend runs it. */
export function populationStoreContracts(name: string, create: () => PopulationStore): void {
  describe(`${name}: PopulationStore contract`, () => {
    it('creates, loads and isolates runs by scope', async () => {
      const store = create();
      await store.createRun(runRecord());
      await store.createRun(runRecord({ scope: 'other', seed: 'b' }));
      expect(await store.loadRun({ scope: 'tenant', runId: 'run' })).toEqual(runRecord());
      expect((await store.loadRun({ scope: 'other', runId: 'run' }))?.seed).toBe('b');
      expect(await store.loadRun({ scope: 'tenant', runId: 'missing' })).toBeUndefined();
    });

    it('rejects a duplicate run with a conflict error', async () => {
      const store = create();
      await store.createRun(runRecord());
      await expect(store.createRun(runRecord())).rejects.toMatchObject({
        name: 'EvolveConflictError',
      });
    });

    it('returns copies, never live state', async () => {
      const store = create();
      const run = runRecord();
      await store.createRun(run);
      const loaded = (await store.loadRun(run)) as unknown as { islands: unknown[] };
      loaded.islands.push('mutated');
      expect((await store.loadRun(run))?.islands).toEqual([{ members: [] }]);
      await store.putCandidate(candidateRecord());
      const [listed] = (await store.listCandidates(run)) as unknown as {
        inspirationIds: string[];
      }[];
      listed!.inspirationIds.push('mutated');
      expect((await store.listCandidates(run))[0]?.inspirationIds).toEqual([]);
    });

    it('puts candidates idempotently by ID', async () => {
      const store = create();
      await store.createRun(runRecord());
      expect(await store.putCandidate(candidateRecord())).toBe(true);
      expect(await store.putCandidate(candidateRecord())).toBe(false);
      // Key order does not make a repeat conflicting.
      const reordered = Object.fromEntries(
        Object.entries(candidateRecord()).reverse(),
      ) as unknown as EvolveCandidate;
      expect(await store.putCandidate(reordered)).toBe(false);
      await expect(store.putCandidate(candidateRecord({ program: 'x = 2' }))).rejects.toMatchObject(
        { name: 'EvolveConflictError' },
      );
      expect(await store.listCandidates(runRecord())).toEqual([candidateRecord()]);
    });

    it('refuses candidates of a missing run and malformed candidates', async () => {
      const store = create();
      await expect(store.putCandidate(candidateRecord())).rejects.toThrow(/not found/i);
      await store.createRun(runRecord());
      await expect(store.putCandidate(candidateRecord({ id: 'wrong' }))).rejects.toThrow(
        /g\{generation\}/,
      );
      await expect(store.putCandidate(candidateRecord({ score: Number.NaN }))).rejects.toThrow(
        /finite/i,
      );
    });

    it('lists candidates ordered by generation, island and slot, with filters', async () => {
      const store = create();
      await store.createRun(
        runRecord({ islandCount: 2, islands: [{ members: [] }, { members: [] }] }),
      );
      const ids = [
        { generation: 2, island: 0, slot: 0 },
        { generation: 1, island: 1, slot: 0 },
        { generation: 1, island: 0, slot: 10 },
        { generation: 1, island: 0, slot: 2 },
      ];
      for (const at of ids) await store.putCandidate(candidateRecord(at));
      await store.putCandidate(candidateRecord({ runId: 'elsewhere' })).catch(() => {});
      const key = { scope: 'tenant', runId: 'run' };
      expect((await store.listCandidates(key)).map((item) => item.id)).toEqual([
        'g1-i0-s2',
        'g1-i0-s10',
        'g1-i1-s0',
        'g2-i0-s0',
      ]);
      expect((await store.listCandidates(key, { generation: 1 })).map((item) => item.id)).toEqual([
        'g1-i0-s2',
        'g1-i0-s10',
        'g1-i1-s0',
      ]);
      expect(
        (await store.listCandidates(key, { ids: ['g2-i0-s0', 'g1-i0-s2', 'nope'] })).map(
          (item) => item.id,
        ),
      ).toEqual(['g1-i0-s2', 'g2-i0-s0']);
      expect(await store.listCandidates(key, { ids: [] })).toEqual([]);
    });

    it('commits generations with a compare-and-set on the generation number', async () => {
      const store = create();
      await store.createRun(runRecord());
      const key = { scope: 'tenant', runId: 'run' };
      await store.commitGeneration({
        ...key,
        expectedGeneration: -1,
        run: runRecord({ generation: 0, bestScore: 1 }),
      });
      expect((await store.loadRun(key))?.bestScore).toBe(1);
      await expect(
        store.commitGeneration({
          ...key,
          expectedGeneration: -1,
          run: runRecord({ generation: 0 }),
        }),
      ).rejects.toMatchObject({ name: 'EvolveConflictError' });
      await expect(
        store.commitGeneration({
          ...key,
          expectedGeneration: 0,
          run: runRecord({ generation: 2 }),
        }),
      ).rejects.toThrow(/expectedGeneration \+ 1/);
      await expect(
        store.commitGeneration({
          scope: 'tenant',
          runId: 'missing',
          expectedGeneration: 0,
          run: runRecord({ runId: 'missing', generation: 1 }),
        }),
      ).rejects.toThrow(/not found/i);
      await store.commitGeneration({
        ...key,
        expectedGeneration: 0,
        run: runRecord({ generation: 1 }),
      });
      expect((await store.loadRun(key))?.generation).toBe(1);
    });

    it('saves run state only within the stored generation', async () => {
      const store = create();
      await store.createRun(runRecord());
      await store.saveRun(runRecord({ status: 'stopped', reason: 'budget' }));
      expect(await store.loadRun(runRecord())).toMatchObject({
        status: 'stopped',
        reason: 'budget',
      });
      await expect(store.saveRun(runRecord({ generation: 3 }))).rejects.toMatchObject({
        name: 'EvolveConflictError',
      });
      await expect(store.saveRun(runRecord({ runId: 'missing' }))).rejects.toThrow(/not found/i);
    });

    it('rejects run records that JSON would silently change', async () => {
      const store = create();
      await expect(store.createRun(runRecord({ stale: Number.POSITIVE_INFINITY }))).rejects.toThrow(
        /finite/i,
      );
      await expect(
        store.createRun({ ...runRecord(), kind: 'other' } as unknown as EvolveRunRecord),
      ).rejects.toThrow(/run record/i);
    });
  });
}
