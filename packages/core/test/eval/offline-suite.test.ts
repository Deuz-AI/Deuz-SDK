/**
 * offline-suite.test.ts (2.3, roadmap 23.7) — the offline eval tasks under
 * `npm test`. Every task must succeed on every attempt, and the suite's
 * aggregate is the 2.3 baseline: no false completion, no repeated effect, no
 * human rescue, the required approvals counted apart.
 *
 * Opt in to the JSON report with `DEUZ_EVAL_REPORT=<path>`; nothing is written
 * otherwise.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { runEvalSuite, type EvalSuiteReport } from '../../src/testing';
import { offlineTasks } from './tasks';

/** Durations from a fixed clock, so two runs of the suite report the same numbers. */
function steppingClock(): () => number {
  let now = 0;
  return () => (now += 1);
}

const suite = () =>
  runEvalSuite(offlineTasks, {
    name: 'deuz-2.3-offline',
    clock: steppingClock(),
    timeoutMs: 10_000,
    ...(process.env.DEUZ_EVAL_REPORT ? { report: process.env.DEUZ_EVAL_REPORT } : {}),
  });

let report: EvalSuiteReport;

beforeAll(async () => {
  // Warm the optional MCP peer's module graph once (see mcp-http.test.ts).
  await import('@modelcontextprotocol/sdk/client/index.js');
  await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
  await import('@modelcontextprotocol/sdk/server/index.js');
  await import('@modelcontextprotocol/sdk/server/streamableHttp.js');
  // And the v2 lines the MCP server task runs on.
  await import('@modelcontextprotocol/client');
  await import('@modelcontextprotocol/server');
  report = await suite();
}, 120_000);

describe('offline eval tasks (2.3)', () => {
  it.each(offlineTasks.map((task) => task.id))('%s succeeds', (id) => {
    const task = report.tasks.find((entry) => entry.id === id)!;
    expect(task.attempts.length).toBeGreaterThan(0);
    for (const attempt of task.attempts)
      expect({ id, ...attempt }).toMatchObject({
        id,
        success: true,
        failures: [],
        repeatedEffects: 0,
        humanRescues: 0,
      });
  });

  it('has distinct, versioned ids', () => {
    const ids = offlineTasks.map((task) => task.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(offlineTasks.every((task) => Number.isInteger(task.version) && task.version >= 1)).toBe(
      true,
    );
  });

  it('records the baseline aggregate', () => {
    expect(report.aggregate['real-model']).toBeUndefined();
    expect(report.aggregate.offline).toMatchObject({
      tasks: offlineTasks.length,
      skipped: 0,
      attempts: offlineTasks.length,
      successes: offlineTasks.length,
      successRate: 1,
      falseCompleted: 0,
      humanRescues: 0,
      // deploy-approved, deploy-denied, the sub-agent payment and the UI approval.
      requiredApprovals: 4,
      repeatedEffects: 0,
      // The interrupted run and the overloaded primary recover by themselves.
      recovery: {
        'not-needed': offlineTasks.length - 2,
        recovered: 2,
        rescued: 0,
        contained: 0,
        failed: 0,
      },
    });
    expect(report.aggregate.offline!.costUsd).toBeGreaterThan(0);
    expect(report.aggregate.offline!.tokens).toBeGreaterThan(0);
  });

  it('reports the same numbers on a second run', async () => {
    const again = await suite();
    expect(again).toEqual(report);
  }, 60_000);
});
