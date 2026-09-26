import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInMemoryPopulationStore } from '../src/evolve/store';
import { evolve, resumeEvolve } from '../src/evolve/controller';
import { createMockModel } from '../src/testing';
import { attachConfig, readConfig } from '../src/internal/config-symbol';
import type { EvolveOptions } from '../src/evolve/types';
import { createSqlitePopulationStore } from '../src/node/evolve-sqlite';
import type { SqliteDatabaseLike } from '../src/node/store-sqlite';
import {
  candidateRecord,
  populationStoreContracts,
  runRecord,
} from './fixtures/population-store-conformance';

let DatabaseSync: (new (path: string) => SqliteDatabaseLike) | undefined;
try {
  DatabaseSync = ((await import('node:sqlite' as string)) as { DatabaseSync: typeof DatabaseSync })
    .DatabaseSync;
} catch {
  /* optional runtime */
}
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

populationStoreContracts('memory population store', createInMemoryPopulationStore);

describe.skipIf(!DatabaseSync)('SQLite population store', () => {
  populationStoreContracts('SQLite population store', () => {
    const store = createSqlitePopulationStore({ path: ':memory:' });
    cleanup.push(() => store.close());
    return store;
  });

  it('reopens a file with its runs and candidates intact', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'deuz-evolve-'));
    cleanup.push(() =>
      rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 }),
    );
    const path = join(directory, 'evolve.sqlite');
    const first = createSqlitePopulationStore({ path });
    await first.createRun(runRecord());
    await first.putCandidate(candidateRecord());
    await first.close();
    const second = createSqlitePopulationStore({ path });
    cleanup.push(() => second.close());
    expect(await second.loadRun(runRecord())).toEqual(runRecord());
    expect(await second.listCandidates(runRecord())).toEqual([candidateRecord()]);
  });

  it('keeps its own schema table and refuses an unknown schema version', async () => {
    const db = new DatabaseSync!(':memory:');
    db.exec('CREATE TABLE deuz_evolve_schema (singleton INTEGER PRIMARY KEY, version INTEGER)');
    db.exec('INSERT INTO deuz_evolve_schema VALUES (1, 99)');
    const store = createSqlitePopulationStore({ path: ':memory:', database: db });
    await expect(store.loadRun(runRecord())).rejects.toThrow(/schema version/i);
  });

  it('drives an evolve run to a file and resumes it from a fresh connection with zero calls', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'deuz-evolve-run-'));
    cleanup.push(() =>
      rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 }),
    );
    const path = join(directory, 'evolve.sqlite');
    const grow =
      '<<<<<<< SEARCH\n    return x\n=======\n    x = x + 1\n    return x\n>>>>>>> REPLACE';
    let calls = 0;
    const base = createMockModel({ responses: [{ text: grow }] });
    const config = readConfig(base)!;
    const model = attachConfig(
      { ...base },
      {
        ...config,
        fetch: ((input: RequestInfo | URL, init?: RequestInit) => {
          calls++;
          return config.fetch!(input, init);
        }) as typeof fetch,
      },
    );
    const options = (store: EvolveOptions['store'], generations: number): EvolveOptions => ({
      scope: 'tenant',
      runId: 'file-run',
      initial: 'def f(x):\n    # EVOLVE-BLOCK-START\n    return x\n    # EVOLVE-BLOCK-END\n',
      stages: [{ evaluate: (program) => ({ score: program.split('x = x + 1').length - 1 }) }],
      models: [{ model }],
      store,
      generations,
      mutationsPerGeneration: 2,
      budget: { tokens: 1_000_000 },
      seed: 'file',
    });
    const first = createSqlitePopulationStore({ path });
    const done = await evolve(options(first, 2)).result;
    await first.close();
    expect(done).toMatchObject({ status: 'completed', generation: 2 });
    expect(calls).toBe(4);

    const second = createSqlitePopulationStore({ path });
    cleanup.push(() => second.close());
    const again = await resumeEvolve(options(second, 2)).result;
    expect(calls).toBe(4);
    expect(again.best?.program).toBe(done.best?.program);
    const more = await resumeEvolve(options(second, 3)).result;
    expect(calls).toBe(6);
    expect(more.generation).toBe(3);
    expect(more.run.executionState?.ledger.reservations).toEqual([]);
  });

  it('rejects use after close', async () => {
    const store = createSqlitePopulationStore({ path: ':memory:' });
    await store.close();
    await expect(store.loadRun(runRecord())).rejects.toThrow(/closed/i);
  });
});
