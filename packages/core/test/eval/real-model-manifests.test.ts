/**
 * real-model-manifests.test.ts (2.3, roadmap 23.7) — the real-model eval tasks
 * are defined and checked here, offline; they never run under `npm test`. Their
 * runner is test/live/eval-real-model.live.test.ts (`npm run test:live`), which
 * skips every task whose key is missing and reports them apart from the offline
 * tasks.
 */
import { describe, expect, it } from 'vitest';
import { registryMatch } from '../../src/core/registry';
import { createPriceProvider } from '../../src/pricing';
import { runEvalSuite } from '../../src/testing';
import { providerModel, realModelTasks } from './real-model';
import { offlineTasks } from './tasks';

const looked: string[] = [];
const tasks = realModelTasks((name) => {
  looked.push(name);
  return undefined;
});

describe('real-model eval tasks (defined, never run offline)', () => {
  it('declares three to five versioned real-model tasks with a model, a key and a budget', () => {
    expect(tasks.length).toBeGreaterThanOrEqual(3);
    expect(tasks.length).toBeLessThanOrEqual(5);
    for (const task of tasks) {
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
    expect(new Set(tasks.map((task) => task.id)).size).toBe(tasks.length);
  });

  it('names models the registry pins and the price table prices', () => {
    const prices = createPriceProvider();
    const usage = {
      inputTokens: 1_000,
      outputTokens: 1_000,
      reasoningTokens: 0,
      cachedReadTokens: 0,
      cacheWriteTokens: 0,
      cacheWrite1hTokens: 0,
      totalTokens: 2_000,
    };
    for (const { model } of tasks) {
      // Building a descriptor dials nothing; the key is never used.
      expect(registryMatch(providerModel(model!, 'offline-check')), model!.id).toBe('exact');
      expect(prices.priceUsage(model!.id!, usage)).toBeGreaterThan(0);
    }
  });

  it('reuses the start state and acceptance of an offline task', () => {
    for (const task of tasks) {
      const twin = offlineTasks.find((offline) => `real/${offline.id}` === task.id);
      expect(twin, task.id).toBeDefined();
      expect(task.start).toEqual(twin!.start);
      expect(task.acceptance).toBe(twin!.acceptance);
    }
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
});
