/**
 * real-model-manifests.test.ts (2.3, roadmap 23.7) — the real-model eval tasks
 * are defined and checked here, offline; they never run under `npm test`. Their
 * runner is test/live/eval-real-model.live.test.ts (`npm run test:live`), which
 * skips every task whose key is missing and reports them apart from the offline
 * tasks. The batch twin is defined apart, and no runner runs it.
 */
import { describe, expect, it } from 'vitest';
import { registryMatch } from '../../src/core/registry';
import { createPriceProvider } from '../../src/pricing';
import { runEvalSuite, type EvalTaskManifest } from '../../src/testing';
import {
  BATCH_SKIP_REASON,
  providerModel,
  realModelBatchTasks,
  realModelTasks,
} from './real-model';
import { offlineTasks } from './tasks';

const looked: string[] = [];
const lookup = (name: string) => {
  looked.push(name);
  return undefined;
};
const tasks = realModelTasks(lookup);
const batchTasks = realModelBatchTasks(lookup);

const usage = {
  inputTokens: 1_000,
  outputTokens: 1_000,
  reasoningTokens: 0,
  cachedReadTokens: 0,
  cacheWriteTokens: 0,
  cacheWrite1hTokens: 0,
  totalTokens: 2_000,
};

function expectManifest(task: EvalTaskManifest): void {
  expect(task).toMatchObject({
    tier: 'real-model',
    version: expect.any(Number),
    env: [expect.stringMatching(/_API_KEY$/)],
    model: {
      provider: expect.any(String),
      id: expect.any(String),
      protocol: expect.any(String),
    },
    budget: { usd: expect.any(Number) },
    timeoutMs: expect.any(Number),
  });
  expect(task.id.startsWith('real/')).toBe(true);
  expect(task.acceptance.length).toBeGreaterThan(0);
}

/** The offline task a twin reuses: same start state, same acceptance. */
function expectTwinOfOffline(task: EvalTaskManifest): void {
  const twin = offlineTasks.find((offline) => `real/${offline.id}` === task.id);
  expect(twin, task.id).toBeDefined();
  expect(task.start).toEqual(twin!.start);
  expect(task.acceptance).toBe(twin!.acceptance);
}

describe('real-model eval tasks (defined, never run offline)', () => {
  it('declares a versioned twin, with a model, a key and a budget, for ten offline tasks', () => {
    expect(tasks).toHaveLength(10);
    for (const task of tasks) expectManifest(task);
    expect(new Set(tasks.map((task) => task.id)).size).toBe(tasks.length);
  });

  it('names models the registry pins and the price table prices', () => {
    const prices = createPriceProvider();
    for (const { model } of tasks) {
      // Building a descriptor dials nothing; the key is never used.
      expect(registryMatch(providerModel(model!, 'offline-check')), model!.id).toBe('exact');
      expect(prices.priceUsage(model!.id!, usage)).toBeGreaterThan(0);
    }
  });

  it('reuses the start state and acceptance of an offline task', () => {
    for (const task of tasks) expectTwinOfOffline(task);
  });

  it('skips every task without a key, reports them apart, and never builds a model', async () => {
    const report = await runEvalSuite([...offlineTasks.slice(0, 1), ...tasks], {
      skip: (task) =>
        task.tier === 'real-model' ? 'real-model tasks never run under npm test' : undefined,
    });
    expect(report.aggregate.offline).toMatchObject({ tasks: 1, attempts: 1 });
    expect(report.aggregate['real-model']).toMatchObject({
      tasks: 0,
      skipped: tasks.length,
      attempts: 0,
    });
    expect(report.tasks.filter((task) => task.skipped)).toHaveLength(tasks.length);
    // No key was even looked up: nothing could have reached a provider.
    expect(looked).toEqual([]);
  });

  it('defines the batch twin apart, priced on the batch tier, and skips it with its reason', async () => {
    expect(batchTasks.map((task) => task.id)).toEqual(['real/batch/ticket-triage']);
    expect(tasks.map((task) => task.id)).not.toContain('real/batch/ticket-triage');
    const [batch] = batchTasks;
    expectManifest(batch!);
    expectTwinOfOffline(batch!);
    expect(batch!.timeoutMs).toBeGreaterThanOrEqual(24 * 3_600_000);
    expect(registryMatch(providerModel(batch!.model!, 'offline-check'))).toBe('exact');
    expect(
      createPriceProvider().priceUsage(batch!.model!.id!, usage, { tier: 'batch' }),
    ).toBeGreaterThan(0);
    const report = await runEvalSuite(batchTasks, { skip: () => BATCH_SKIP_REASON });
    expect(report.tasks[0]).toMatchObject({ skipped: BATCH_SKIP_REASON, attempts: [] });
    expect(report.aggregate['real-model']).toMatchObject({ skipped: 1, attempts: 0 });
    expect(looked).toEqual([]);
  });
});
