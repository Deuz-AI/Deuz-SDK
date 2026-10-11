/**
 * The headless report and its exit-code contract (2.3 preview, 23.8), read from
 * stored native runs: `inspectRun` makes no model call, so every terminal state
 * can be set up as an envelope. Real runs are covered in headless.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { createInMemoryAgentRunStore } from '../src/agent-run';
import { EMPTY_USAGE } from '../src/core/metering';
import { HEADLESS_EXIT_CODES, exitCodeFor, inspectRun } from '../src/node/headless';
import type { HeadlessReport } from '../src/node/headless';
import type { AgentResult, AgentRunEnvelope, AgentToolReceipt } from '../src/types/agent-run';

const usage = { ...EMPTY_USAGE, inputTokens: 12, outputTokens: 8, totalTokens: 20 };

function envelope(runId: string, extra: Partial<AgentRunEnvelope>): AgentRunEnvelope {
  return {
    kind: 'deuz-agent-run',
    version: 1,
    runId,
    revision: 1,
    scope: 'ci',
    phase: 'terminal',
    messages: [
      { role: 'user', content: 'Fix the build.' },
      { role: 'assistant', content: 'Done.' },
    ],
    usage,
    modelSteps: 2,
    finalizationAttempts: 0,
    verificationAttempts: 0,
    checkpoints: {},
    ...extra,
  };
}

function base(runId: string) {
  return { runId, text: 'Done.', messages: [], usage, modelSteps: 2 };
}

/** Store `result` as a run's outcome and inspect it. */
async function inspectResult(result: AgentResult<unknown>): Promise<HeadlessReport> {
  const store = createInMemoryAgentRunStore();
  await store.save(
    envelope(result.runId, {
      phase: result.status === 'suspended' ? 'running' : 'terminal',
      result,
    }),
  );
  return inspectRun(store, result.runId);
}

const stopped = (runId: string, reason: string, extra: object = {}): AgentResult<unknown> => ({
  ...base(runId),
  status: 'stopped',
  reason,
  ...extra,
});
const failed = (runId: string, code: string): AgentResult<unknown> => ({
  ...base(runId),
  status: 'failed',
  error: { name: 'Error', message: `failed: ${code}`, code },
});

describe('inspectRun (headless preview)', () => {
  it('reports a completed run as plain JSON with its output, usage and steps', async () => {
    const report = await inspectResult({
      ...base('r-done'),
      status: 'completed',
      output: { fixed: true },
      verification: 'verified',
    });
    expect(report).toMatchObject({
      kind: 'deuz-headless-report',
      version: 1,
      runId: 'r-done',
      scope: 'ci',
      status: 'completed',
      outcome: 'completed',
      phase: 'terminal',
      pending: [],
      usage,
      modelSteps: 2,
      verification: 'verified',
      output: { fixed: true },
      text: 'Done.',
      warnings: [],
    });
    expect(JSON.parse(JSON.stringify(report))).toEqual(report);
    expect(exitCodeFor(report)).toBe(0);
  });

  it('lists each pending approval and client call with what resumes it', async () => {
    const report = await inspectResult({
      ...base('r-wait'),
      status: 'suspended',
      pendingApprovals: [
        {
          approvalId: 'appr-1',
          toolCallId: 'call_1',
          toolName: 'deploy',
          input: { env: 'prod' },
          token: 'signed',
        },
      ],
      pendingClientCalls: [{ toolCallId: 'call_2', toolName: 'pick_file', args: { glob: '*.ts' } }],
    });
    expect(report.status).toBe('suspended');
    expect(report.outcome).toBe('pending');
    expect(report.phase).toBe('running');
    expect(report.pending).toEqual([
      {
        kind: 'approval',
        approvalId: 'appr-1',
        toolCallId: 'call_1',
        toolName: 'deploy',
        input: { env: 'prod' },
        token: 'signed',
        resumeWith: 'approvalResponses',
      },
      {
        kind: 'client-tool',
        toolCallId: 'call_2',
        toolName: 'pick_file',
        input: { glob: '*.ts' },
        resumeWith: 'clientToolResults',
      },
    ]);
    expect(report.output).toBeUndefined();
    expect(exitCodeFor(report)).toBe(HEADLESS_EXIT_CODES.pending);
    expect(exitCodeFor(report)).not.toBe(0);
  });

  it('reports a refusal with its stop details, never as a success', async () => {
    const report = await inspectResult(
      stopped('r-refused', 'refusal', {
        stopDetails: { type: 'refusal', category: 'cyber', explanation: 'Not allowed.' },
      }),
    );
    expect(report).toMatchObject({
      status: 'stopped',
      outcome: 'refused',
      reason: 'refusal',
      stopDetails: { type: 'refusal', category: 'cyber', explanation: 'Not allowed.' },
    });
    expect(exitCodeFor(report)).toBe(HEADLESS_EXIT_CODES.refused);
    expect(exitCodeFor(report)).not.toBe(0);
  });

  it('reports a failure with the error name, message and code', async () => {
    const report = await inspectResult(failed('r-failed', 'authentication'));
    expect(report).toMatchObject({
      status: 'failed',
      outcome: 'failed',
      error: { name: 'Error', message: 'failed: authentication', code: 'authentication' },
    });
    expect(exitCodeFor(report)).toBe(HEADLESS_EXIT_CODES.failed);
  });

  it('classifies every way a run ends into the documented outcomes', async () => {
    const cases: [AgentResult<unknown>, HeadlessReport['outcome']][] = [
      [stopped('s1', 'aborted'), 'cancelled'],
      [stopped('s2', 'cancelled'), 'cancelled'],
      [failed('s3', 'aborted'), 'cancelled'],
      [stopped('s4', 'budget.usd'), 'limit'],
      [stopped('s5', 'budget.tokens'), 'limit'],
      [stopped('s6', 'max-steps'), 'limit'],
      [stopped('s7', 'durationExceeds'), 'limit'],
      [failed('s8', 'deadline_exceeded'), 'limit'],
      [failed('s9', 'budget_exceeded'), 'limit'],
      [failed('s10', 'timeout'), 'limit'],
      [failed('s11', 'unpriced_model'), 'limit'],
      [stopped('s12', 'guardrail:output'), 'stopped'],
      [stopped('s13', 'verification-inconclusive'), 'stopped'],
      [stopped('s14', 'length'), 'stopped'],
      [stopped('s15', 'mcp-catalog-changed'), 'stopped'],
      [failed('s16', 'lease_held'), 'failed'],
    ];
    for (const [result, outcome] of cases) {
      const report = await inspectResult(result);
      expect(report.outcome, `${result.runId}`).toBe(outcome);
      expect(exitCodeFor(report), `${result.runId}`).toBe(HEADLESS_EXIT_CODES[outcome]);
    }
  });

  it('reports a run without a result as pending a resume, with its unknown effects', async () => {
    const store = createInMemoryAgentRunStore();
    const receipt = (toolCallId: string, extra: Partial<AgentToolReceipt>): AgentToolReceipt => ({
      modelStep: 1,
      toolCallId,
      toolName: 'charge',
      input: { usd: 5 },
      stage: 'executing',
      ...extra,
    });
    await store.save(
      envelope('r-crashed', {
        phase: 'running',
        toolResults: {
          '[1,"call_1"]': receipt('call_1', {}),
          // Runs again by itself on resume: nothing to decide.
          '[1,"call_2"]': receipt('call_2', { idempotent: true }),
          '[1,"call_3"]': receipt('call_3', { stage: 'completed', rawResult: { ok: true } }),
        },
      }),
    );
    const report = await inspectRun(store, 'r-crashed');
    expect(report.status).toBe('in-progress');
    expect(report.outcome).toBe('pending');
    expect(report.phase).toBe('running');
    expect(report.text).toBe('Done.');
    expect(report.pending).toEqual([
      {
        kind: 'unknown-effect',
        toolCallId: 'call_1',
        toolName: 'charge',
        input: { usd: 5 },
        modelStep: 1,
        resumeWith: 'retryToolCallIds',
      },
      { kind: 'resume', phase: 'running' },
    ]);
    expect(exitCodeFor(report)).toBe(HEADLESS_EXIT_CODES.pending);
  });

  it('rejects an unknown run', async () => {
    await expect(inspectRun(createInMemoryAgentRunStore(), 'nope')).rejects.toThrow(
      'Unknown native run: nope',
    );
  });

  it('keeps the documented exit codes, one per outcome', () => {
    expect(HEADLESS_EXIT_CODES).toEqual({
      completed: 0,
      failed: 1,
      usage: 2,
      pending: 3,
      refused: 4,
      cancelled: 5,
      limit: 6,
      stopped: 7,
      doctor: 8,
    });
    const codes = Object.values(HEADLESS_EXIT_CODES);
    expect(new Set(codes).size).toBe(codes.length);
  });
});
