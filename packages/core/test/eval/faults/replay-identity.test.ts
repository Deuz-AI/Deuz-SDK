/**
 * replay-identity.test.ts (2.3, roadmap 23.7) — the fault scenarios that replay
 * an idempotent tool must catch a replay under another call identity. The
 * simulated external system drops a repeat of a call key it has seen, so a
 * replay whose `[modelStep, toolCallId]` drifted is a second real charge (or
 * sync): the scenario has to fail it as a repeated effect, not pass it as a
 * recovery.
 */
import { describe, expect, it, vi } from 'vitest';

// An identity regression: every tool call a resume makes sees a shifted
// modelStep, as if the replay lost the step number it recorded.
vi.mock('../../../src/agent-run', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../../src/agent-run')>();
  type Tool = { execute?: (args: unknown, call: { modelStep: number }) => unknown };
  return {
    ...original,
    resumeAgent: ((options: { tools?: Record<string, Tool> }) =>
      original.resumeAgent({
        ...options,
        tools: Object.fromEntries(
          Object.entries(options.tools ?? {}).map(([name, tool]) => [
            name,
            {
              ...tool,
              execute: (args: unknown, call: { modelStep: number }) =>
                tool.execute!(args, { ...call, modelStep: call.modelStep + 7 }),
            },
          ]),
        ),
      } as never)) as typeof original.resumeAgent,
  };
});

const { runEvalSuite } = await import('../../../src/testing');
const { afterEffectIdempotent } = await import('./tool-boundaries');
const { leaseLoss } = await import('./ops-boundaries');

describe('idempotent replay under a changed call identity', () => {
  it.each([
    [afterEffectIdempotent.id, afterEffectIdempotent, 'charge:order-7'],
    [leaseLoss.id, leaseLoss, 'sync:catalog'],
  ])('%s fails it as a repeated effect', async (_id, scenario, effect) => {
    const report = await runEvalSuite([scenario], { timeoutMs: 10_000 });
    const attempt = report.tasks[0]!.attempts[0]!;
    expect(attempt).toMatchObject({ success: false, repeatedEffects: 1 });
    expect(attempt.failures).toContain(`repeated effect: ${effect}`);
  });
});
