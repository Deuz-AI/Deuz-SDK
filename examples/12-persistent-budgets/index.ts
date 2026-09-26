/**
 * 12 — Persistent budgets: one per-user budget, shared by every run and process (2.2).
 *
 * An execution context's ledger bounds one run. A `BudgetStore` bounds usage
 * that outlives the run, such as a user's daily tokens. After local admission,
 * every model call is admitted all-or-nothing against the persistent scopes
 * (`reserve` an estimate, then `settle` the real usage), whether it comes from
 * a native `runAgent` or from a swarm task (`SwarmOptions.admission`).
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAgent, createExecutionContext, runAgent } from '@deuz-sdk/core/agent';
import type { BudgetAdmission, BudgetStore } from '@deuz-sdk/core/agent';
import { createSqliteBudgetStore } from '@deuz-sdk/core/ops/sqlite';
import { createInMemorySwarmStore, createSwarm } from '@deuz-sdk/core/swarm';
import { createMockModel } from '@deuz-sdk/core/testing';

// --- MODEL ------------------------------------------------------------------
// Scripted, so this runs without an API key; every call reports 10 input and
// 5 output tokens. REAL PROVIDER: replace it with
//   import { createAnthropic } from '@deuz-sdk/core/anthropic';
//   const model = createAnthropic({ apiKey: process.env.ANTHROPIC_API_KEY })('claude-opus-4-8');
const model = createMockModel({ responses: [{ text: 'Done.' }] });
const ESTIMATE = { tokens: 20 }; // reserved before each call, replaced by the real usage after
const DAILY_TOKENS = 75;

const dir = mkdtempSync(join(tmpdir(), 'deuz-budget-'));
const path = join(dir, 'budgets.sqlite');
// Two processes, each with its own connection to the same budget file.
const storeA = createSqliteBudgetStore({ path });
const storeB = createSqliteBudgetStore({ path });

// A per-user budget over a rolling 24-hour window. Every request naming the key shares it.
const admission = (store: BudgetStore, user: string): BudgetAdmission => ({
  store,
  scopes: [{ key: `user:${user}`, limits: { tokens: DAILY_TOKENS }, window: { ms: 86_400_000 } }],
  warnAtPercent: 70,
  onWarning: (w) =>
    console.log(`   [warning] ${w.key} at ${Math.round(w.percent)}% of its ${w.dimension}`),
});

/** Process A: one native agent run for a user. */
async function ask(user: string, runId: string) {
  const result = await runAgent({
    model,
    prompt: 'Summarise the ticket.',
    execution: createExecutionContext({ scopeId: runId, admission: admission(storeA, user) }),
    executionEstimate: ESTIMATE,
  });
  const why = result.status === 'failed' ? ` (${result.error.code}: ${result.error.message})` : '';
  console.log(
    `   ${runId} for user:${user} -> ${result.status}, ${result.usage.totalTokens} tokens${why}`,
  );
}
const used = async (user: string) => {
  // Settled usage plus holds still in flight, over the key's history.
  const usage = await storeA.usage(`user:${user}`);
  console.log(`   user:${user}: ${usage.tokens} tokens used, limit ${DAILY_TOKENS} per 24 h`);
};

try {
  console.log('1) process A: a native run for user 42');
  await ask('42', 'run-1');
  await used('42');

  console.log('\n2) process B: a swarm for the same user, admitted against the same scope');
  const swarm = createSwarm({
    store: createInMemorySwarmStore(),
    agents: { worker: createAgent({ model, executionEstimate: ESTIMATE }) },
    admission: admission(storeB, '42'), // every task's model calls go through it
  });
  const handle = await swarm.run({
    scope: 'user-42',
    tasks: ['a', 'b', 'c'].map((id) => ({ id, agent: 'worker', prompt: `Handle part ${id}.` })),
  });
  const outcome = await handle.result;
  const tasks = outcome.tasks.map((t) => `${t.task.id}=${t.status}`).join(' ');
  console.log(`   swarm: ${outcome.run.status} (${tasks})`);
  await used('42');

  console.log('\n3) process A again: the next estimate no longer fits, so the call is never sent');
  await ask('42', 'run-2');
  await ask('7', 'run-3'); // another user's scope is untouched
  await used('42');
  await used('7');
} finally {
  await storeA.close();
  await storeB.close();
  rmSync(dir, { recursive: true, force: true });
}
