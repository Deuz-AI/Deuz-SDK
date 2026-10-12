/**
 * fault-suite.test.ts (2.3, roadmap 23.7) — the fault-injection scenarios
 * under `npm test`. Each one injects a single fault at one boundary and must
 * show no repeated effect, no billed call missing from the accounting, and
 * the recovery the documentation promises. The aggregate is the 2.3 fault
 * baseline: which faults the SDK recovers from by itself, and which it contains
 * (a documented stop or failure that repeats and loses nothing).
 *
 * Opt in to the JSON report with `DEUZ_FAULT_REPORT=<path>`.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { runEvalSuite, type EvalSuiteReport } from '../../../src/testing';
import { faultScenarios } from './index';

/** Roadmap 23.7's fault boundaries, with the native memory and fail-over ones of 23.4. */
const BOUNDARIES = [
  'memory-scope',
  'provider-fallback',
  'fallback-budget-settlement',
  'compaction-boundary',
  'chat-projection',
  'memory-write',
  'ui-disconnect-replay',
  'before-dispatch',
  'after-approval',
  'after-effect-before-receipt',
  'after-receipt-before-checkpoint',
  'mid-model-stream',
  'verifier-abort',
  'verifier-deadline',
  'child-initialization',
  'swarm-cancel-commit',
  'lease-loss',
  'lease-renew-failure',
  'admission-store-failure',
  'settle-failure',
  'spawn-commit-failure',
  'mcp-hot-refresh',
  'refusal-mid-tool-call',
  'max-tokens-mid-tool-call',
];

function steppingClock(): () => number {
  let now = 0;
  return () => (now += 1);
}

let report: EvalSuiteReport;

beforeAll(async () => {
  report = await runEvalSuite(faultScenarios, {
    name: 'deuz-2.3-faults',
    clock: steppingClock(),
    timeoutMs: 10_000,
    ...(process.env.DEUZ_FAULT_REPORT ? { report: process.env.DEUZ_FAULT_REPORT } : {}),
  });
}, 60_000);

describe('fault injection (2.3)', () => {
  it.each(faultScenarios.map((scenario) => [scenario.id, scenario.fault!.recovery]))(
    '%s: nothing repeated, nothing lost, recovery %s',
    (id, recovery) => {
      const task = report.tasks.find((entry) => entry.id === id)!;
      for (const attempt of task.attempts)
        expect({ id, ...attempt }).toMatchObject({
          id,
          success: true,
          failures: [],
          repeatedEffects: 0,
          recoveryPath: recovery,
          interruptions: [expect.any(String)],
        });
    },
  );

  it('covers every boundary', () => {
    const covered = new Set(faultScenarios.map((scenario) => scenario.fault!.boundary));
    expect([...covered].sort()).toEqual([...BOUNDARIES].sort());
  });

  it('records the fault baseline: what is recovered, what is contained', () => {
    const classes = Object.fromEntries(
      report.tasks.map((task) => [task.id, task.attempts[0]!.recovery]),
    );
    expect(classes).toEqual({
      'fault/before-dispatch': 'recovered',
      'fault/after-approval': 'recovered',
      'fault/after-effect-before-receipt': 'contained',
      'fault/after-effect-before-receipt-idempotent': 'recovered',
      'fault/after-effect-before-receipt-reconciled': 'recovered',
      'fault/after-receipt-before-checkpoint': 'recovered',
      'fault/after-receipt-approved': 'recovered',
      'fault/mid-model-stream': 'contained',
      'fault/mid-model-stream-retried': 'recovered',
      'fault/verifier-abort': 'contained',
      'fault/verifier-deadline': 'contained',
      'fault/child-initialization': 'recovered',
      'fault/swarm-cancel-commit': 'recovered',
      'fault/lease-loss': 'recovered',
      'fault/lease-renew-failure': 'recovered',
      'fault/admission-store-failure': 'contained',
      'fault/admission-store-failure-retried': 'recovered',
      'fault/settle-failure': 'recovered',
      'fault/spawn-commit-failure': 'recovered',
      'fault/mcp-refresh-list-failure': 'recovered',
      'fault/mcp-refresh-record-failure': 'contained',
      'fault/mcp-refresh-record-failure-accepted': 'recovered',
      'fault/refusal-mid-tool-call': 'contained',
      'fault/max-tokens-mid-tool-call': 'contained',
      'fault/memory-scope-widened': 'contained',
      'fault/memory-scope-shared-context': 'contained',
      'fault/provider-fallback': 'recovered',
      'fault/fallback-budget-settlement': 'recovered',
      'fault/compaction-preserved-thinking': 'recovered',
      'fault/chat-projection-repair': 'recovered',
      'fault/chat-projection-superseded': 'contained',
      'fault/memory-write-checkpoint-failure': 'recovered',
      'fault/ui-disconnect-replay': 'recovered',
    });
    expect(report.aggregate.offline).toMatchObject({
      tasks: faultScenarios.length,
      successes: faultScenarios.length,
      falseCompleted: 0,
      repeatedEffects: 0,
      // A person checked the payment system after the unknown charge.
      humanRescues: 1,
      requiredApprovals: 2,
      recovery: { 'not-needed': 0, recovered: 22, rescued: 0, contained: 11, failed: 0 },
    });
  });
});
