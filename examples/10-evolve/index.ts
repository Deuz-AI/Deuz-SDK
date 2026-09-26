/**
 * 10 — Evolve: evolutionary program search with a zero-call resume (2.2).
 *
 * `evolve` changes only the code between EVOLVE-BLOCK markers. A model answers
 * with SEARCH/REPLACE diffs, a cascade of evaluators scores each candidate, and
 * the best programs become the next parents. Candidates get deterministic IDs
 * (`g{generation}-i{island}-s{slot}`) and are stored as soon as they are
 * evaluated, so `resumeEvolve` after a crash replays the stored slots without
 * paying for their model calls again.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { evolve, parseEvolveBlocks, resumeEvolve } from '@deuz-sdk/core/evolve';
import type {
  EvolveEvent,
  EvolveOptions,
  EvolveStage,
  PopulationStore,
} from '@deuz-sdk/core/evolve';
import { createSqlitePopulationStore } from '@deuz-sdk/core/evolve/sqlite';
import { createMockModel } from '@deuz-sdk/core/testing';

// Only the marked block may change; the rest is frozen harness.
const initial = `function approxPi() {
  let terms = 1;
  // EVOLVE-BLOCK-START
  return leibniz(terms);
  // EVOLVE-BLOCK-END
}
function leibniz(terms) {
  let sum = 0;
  for (let k = 0; k < terms; k++) sum += (k % 2 ? -4 : 4) / (2 * k + 1);
  return sum;
}
`;

// --- MODEL ------------------------------------------------------------------
// A scripted model that always proposes the same diff, so this runs without an
// API key. REAL PROVIDER: in `models`, pass
//   { model: createAnthropic({ apiKey: process.env.ANTHROPIC_API_KEY })('claude-opus-4-8') }
// from '@deuz-sdk/core/anthropic'; several entries form a UCB1-picked ensemble.
const diff = `<<<<<<< SEARCH
  return leibniz(terms);
=======
  terms *= 10;
  return leibniz(terms);
>>>>>>> REPLACE`;

// The cascade: a cheap check first, so broken candidates never reach the benchmark.
const stages: EvolveStage[] = [
  {
    name: 'shape',
    threshold: 1,
    evaluate: (p) => ({ score: p.includes('leibniz(terms)') ? 1 : 0 }),
  },
  {
    name: 'digits',
    timeoutMs: 5_000,
    evaluate(program) {
      // node:vm bounds the run time but is NOT a security boundary. Run
      // model-written code in a worker, a container or a remote sandbox.
      const value = Number(runInNewContext(`${program}\napproxPi()`, {}, { timeout: 2_000 }));
      const digits = -Math.log10(Math.abs(value - Math.PI)); // correct digits of pi
      return { score: Number(digits.toFixed(2)), metrics: { value } };
    },
  },
];

const dir = mkdtempSync(join(tmpdir(), 'deuz-evolve-'));
const path = join(dir, 'population.sqlite');
const options = (store: PopulationStore): EvolveOptions => ({
  scope: 'tenant-a',
  runId: 'pi',
  initial,
  instructions: 'Make approxPi() return a value closer to Math.PI.',
  stages,
  models: [{ model: createMockModel({ responses: [{ text: diff }] }) }],
  store,
  generations: 2,
  mutationsPerGeneration: 2,
  patch: { diff: 1 }, // SEARCH/REPLACE only; by default full rewrites and crossovers mix in
  budget: { tokens: 100_000 }, // mandatory: every mutation is charged to it
  seed: 'demo',
});
const show = (event: EvolveEvent) => {
  if (event.type !== 'candidate') return;
  const { id, accepted, score, rejection } = event.candidate;
  const verdict = accepted ? `score ${score}` : `rejected (${rejection?.kind})`;
  console.log(`   ${id} ${verdict}${event.replayed ? '  [replayed from the store]' : ''}`);
};

const stores = [createSqlitePopulationStore({ path })];
try {
  console.log('1) evolve on SQLite; the process dies before generation 2 commits');
  // Crash simulation: generation 2's candidates get stored, then this commit
  // never returns, as if the process had been killed at that moment.
  const dying: PopulationStore = {
    ...stores[0]!,
    commitGeneration: (commit) =>
      commit.run.generation === 2 ? new Promise(() => {}) : stores[0]!.commitGeneration(commit),
  };
  let stored = 0;
  for await (const event of evolve(options(dying)).events()) {
    show(event);
    if (event.type === 'candidate' && event.candidate.generation === 2 && ++stored === 2) break;
  }
  console.log('   ... generation 2 is stored but never committed');

  console.log('\n2) a new process resumes the run from the same file');
  stores.push(createSqlitePopulationStore({ path }));
  const handle = resumeEvolve(options(stores[1]!));
  for await (const event of handle.events()) show(event);
  const result = await handle.result;
  console.log(`   ${result.status} (${result.reason}) at generation ${result.generation}`);
  console.log(`   model calls made by the resume: ${result.modelCalls}`);
  console.log(`   best: ${result.best?.id}, score ${result.best?.score}; its evolve block:`);
  const block = parseEvolveBlocks(result.best?.program ?? '').blocks[0]?.content ?? '';
  console.log(block.replace(/^ {2}/gm, '     ').trimEnd());
} finally {
  for (const store of stores) await store.close();
  rmSync(dir, { recursive: true, force: true });
}
