/**
 * The real-model eval tasks (2.3, roadmap 23.7), against real providers.
 *
 * Runs only through `npm run test:live`, and only the tasks whose key is set
 * (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GOOGLE_API_KEY` in `.env.smoke` or
 * the environment); the others are listed as skipped. Each task runs three
 * attempts under its USD budget. The report keeps these numbers apart from the
 * offline suite's; set `DEUZ_EVAL_REPORT=<path>` to write it as JSON.
 *
 * It asserts that the tasks ran and were measured, not that a model passed
 * them: a model's success rate is the result, not a test condition.
 */
import { describe, expect, it } from 'vitest';
import { runEvalSuite } from '../../src/testing';
import { realModelTasks } from '../eval/real-model';
import { fingerprint, key } from './env';

const tasks = realModelTasks(key);
const missing = (env: readonly string[] = []) => env.filter((name) => !key(name));
const runnable = tasks.filter((task) => missing(task.env).length === 0);

describe.skipIf(runnable.length === 0)('real-model eval tasks — live', () => {
  it(
    'runs every task a key was supplied for and reports it apart from the offline tasks',
    async () => {
      for (const task of runnable)
        console.log(
          `[live] ${task.id} on ${task.model?.id} with ${fingerprint(key(task.env![0]!)!)}`,
        );
      const report = await runEvalSuite(tasks, {
        name: 'deuz-2.3-real-model',
        skip: (task) => {
          const absent = missing(task.env);
          return absent.length > 0 ? `no ${absent.join(', ')}` : undefined;
        },
        ...(process.env.DEUZ_EVAL_REPORT ? { report: process.env.DEUZ_EVAL_REPORT } : {}),
      });
      for (const task of report.tasks)
        console.log(
          `[live] ${task.id}: ${task.skipped ?? `${task.metrics.successes}/${task.metrics.attempts} succeeded, $${task.metrics.costUsd}`}`,
        );
      expect(report.aggregate.offline).toBeUndefined();
      expect(report.aggregate['real-model']!.attempts).toBe(runnable.length * 3);
    },
    30 * 60_000,
  );
});
