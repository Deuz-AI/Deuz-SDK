/**
 * A scripted `RunLauncher` (2.4) for supervisor tests: it records every call,
 * answers each leg from a script (or holds it until the test finishes it),
 * stops a held leg on `cancel` (reason `'cancelled'`) or `drain` (reason
 * `'drained'`), and reports per-run ledger totals and maintenance the test
 * sets. Nothing here runs a model.
 */
import type {
  RunLaunchRequest,
  RunLaunchResult,
  RunLauncher,
} from '../../src/goal/runtime/supervisor';
import type { AgentResult } from '../../src/types/agent-run';
import type { BudgetTotals } from '../../src/types/execution';
import type { ToolApprovalRequest } from '../../src/types/tool';

const USAGE = {
  inputTokens: 1,
  outputTokens: 1,
  reasoningTokens: 0,
  cachedReadTokens: 0,
  cacheWriteTokens: 0,
  cacheWrite1hTokens: 0,
  totalTokens: 2,
};

const base = (runId: string) => ({ runId, text: '', messages: [], usage: USAGE, modelSteps: 1 });

export const results = {
  completed: (runId: string): AgentResult<unknown> => ({
    ...base(runId),
    status: 'completed',
    output: 'done',
  }),
  suspended: (runId: string, approvalIds: readonly string[] = ['ap-1']): AgentResult<unknown> => ({
    ...base(runId),
    status: 'suspended',
    pendingApprovals: approvalIds.map(
      (approvalId): ToolApprovalRequest => ({
        approvalId,
        toolCallId: `call-${approvalId}`,
        toolName: 'deploy',
        input: {},
      }),
    ),
    pendingClientCalls: [],
  }),
  stopped: (runId: string, reason: string): AgentResult<unknown> => ({
    ...base(runId),
    status: 'stopped',
    reason,
  }),
  failed: (runId: string, code = 'boom'): AgentResult<unknown> => ({
    ...base(runId),
    status: 'failed',
    error: { name: 'Error', message: 'model call failed', code },
  }),
};

/** Ledger totals with `spent` and `reserved` amounts. */
export function totals(
  spent: { tokens: number; usd: number },
  reserved: { tokens: number; usd: number } = { tokens: 0, usd: 0 },
): BudgetTotals {
  return {
    spent,
    reserved,
    committed: { tokens: spent.tokens + reserved.tokens, usd: spent.usd + reserved.usd },
    unknownTokens: 0,
    unknownUsd: 0,
  };
}

export type LegKind = 'launch' | 'resume';

/** What the script answers for a leg: a result now, or `'hold'` until the test finishes it. */
export type LegScript = (
  request: RunLaunchRequest,
  kind: LegKind,
) => RunLaunchResult | 'hold' | Promise<RunLaunchResult | 'hold'>;

export interface HeldLeg {
  kind: LegKind;
  request: RunLaunchRequest;
  finish(result: RunLaunchResult): void;
  fail(error: unknown): void;
}

export interface FakeRunLauncher extends RunLauncher {
  calls: { kind: LegKind; request: RunLaunchRequest }[];
  cancels: { scope: string; runId: string; reason?: string }[];
  drains: { scope: string; runId: string }[];
  held: HeldLeg[];
  /** Per-run ledger totals `accounting` reports. */
  ledger: Map<string, BudgetTotals>;
  /** Per-run maintenance `maintenance` reports. */
  upkeep: Map<string, 'pending' | 'complete' | 'failed'>;
  script: LegScript;
  /** Resolves once `count` legs are held. */
  whenHeld(count?: number): Promise<HeldLeg>;
}

export function fakeRunLauncher(script?: LegScript): FakeRunLauncher {
  const waiters: { count: number; resolve: (leg: HeldLeg) => void }[] = [];
  const launcher: FakeRunLauncher = {
    calls: [],
    cancels: [],
    drains: [],
    held: [],
    ledger: new Map(),
    upkeep: new Map(),
    script:
      script ?? ((request) => ({ runId: request.runId, result: results.completed(request.runId) })),
    whenHeld(count = 1) {
      const ready = launcher.held.length >= count;
      if (ready) return Promise.resolve(launcher.held[count - 1]!);
      return new Promise((resolve) => waiters.push({ count, resolve }));
    },
    launch: (request) => leg('launch', request),
    resume: (request) => leg('resume', request),
    async cancel(request) {
      launcher.cancels.push(request);
      const running = launcher.held.find((held) => held.request.runId === request.runId);
      if (!running) return false;
      running.finish({ runId: request.runId, result: results.stopped(request.runId, 'cancelled') });
      return true;
    },
    async drain(request) {
      launcher.drains.push(request);
      const running = launcher.held.find((held) => held.request.runId === request.runId);
      if (!running) return false;
      running.finish({ runId: request.runId, result: results.stopped(request.runId, 'drained') });
      return true;
    },
    async accounting(request) {
      return launcher.ledger.get(request.runId);
    },
    async maintenance(request) {
      return launcher.upkeep.get(request.runId);
    },
  };

  async function leg(kind: LegKind, request: RunLaunchRequest): Promise<RunLaunchResult> {
    launcher.calls.push({ kind, request });
    const answer = await launcher.script(request, kind);
    if (answer !== 'hold') return answer;
    return new Promise<RunLaunchResult>((resolve, reject) => {
      const held: HeldLeg = {
        kind,
        request,
        finish(result) {
          launcher.held.splice(launcher.held.indexOf(held), 1);
          resolve(result);
        },
        fail(error) {
          launcher.held.splice(launcher.held.indexOf(held), 1);
          reject(error);
        },
      };
      launcher.held.push(held);
      for (const waiter of [...waiters])
        if (launcher.held.length >= waiter.count) {
          waiters.splice(waiters.indexOf(waiter), 1);
          waiter.resolve(launcher.held[waiter.count - 1]!);
        }
    });
  }

  return launcher;
}
