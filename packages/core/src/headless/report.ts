/**
 * The headless report (2.3 preview, 23.8): what one native run leg, or a stored
 * run, comes to, as plain JSON for automation, and the exit code each outcome
 * maps to. Pure and edge-safe; the Node entry (`@deuz-sdk/core/headless`) runs
 * the agent, reads the store and fills in what only it knows.
 */
import type {
  AgentResult,
  AgentRunEnvelope,
  AgentRunPhase,
  AgentRunRetry,
  AgentVerification,
} from '../types/agent-run';
import type { BudgetTotals } from '../types/execution';
import type { CallWarning, StopDetails } from '../types/methods';
import type { Message } from '../types/message';
import type { Usage } from '../types/usage';
import type { DoctorReport } from './doctor';
import { createExecutionContext } from '../execution-policy';

/**
 * How a run leg ended, for automation (2.3 preview). Each has its own exit code
 * ({@link HEADLESS_EXIT_CODES}):
 *
 * - `'completed'` — the run finished with an accepted output.
 * - `'failed'` — an error ended it (a provider error, a store failure, a lost lease).
 * - `'pending'` — the run is not over and waits for you: approvals, client tool
 *   results, a decision on calls whose effect is unknown, or (a stored run with
 *   no result yet) a resume.
 * - `'refused'` — the model refused (a `'refusal'` stop, F16).
 * - `'cancelled'` — the run was aborted or cancelled.
 * - `'limit'` — a limit you set stopped it: the USD or token budget, `maxSteps`,
 *   the execution deadline, a timeout, or a strict budget refusing an unpriced model.
 * - `'stopped'` — it stopped short for another reason: a guardrail, a verifier
 *   that never accepted, a cut-off output, a changed MCP catalog.
 *
 * A failure whose cause was transient (`'failed'`, or `'limit'` for a
 * transport timeout) also carries the report's `retry`.
 */
export type HeadlessOutcome =
  | 'completed'
  | 'failed'
  | 'pending'
  | 'refused'
  | 'cancelled'
  | 'limit'
  | 'stopped';

/**
 * The exit-code contract of the headless preview (2.3). A run that did not
 * complete never exits 0. `usage` is for a command line that could not parse
 * its arguments; `doctor` for a configuration `doctor` found errors in.
 *
 * | Code | Meaning |
 * | --- | --- |
 * | 0 | completed (or a doctor report without errors) |
 * | 1 | failed |
 * | 2 | usage: invalid arguments |
 * | 3 | pending: waiting for approvals, client results, reconciliation or a resume |
 * | 4 | refused by the model |
 * | 5 | cancelled |
 * | 6 | a budget, step, deadline or timeout limit stopped it |
 * | 7 | stopped short for another reason |
 * | 8 | doctor found errors |
 */
export const HEADLESS_EXIT_CODES: Readonly<Record<HeadlessOutcome | 'usage' | 'doctor', number>> =
  Object.freeze({
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

/**
 * One thing a pending run waits for, and the resume option that answers it
 * (`resumeWith`; either of two for an unknown effect). `'resume'` is a stored
 * run with no result yet: its executor stopped (or still drives it
 * elsewhere), and a resume continues it.
 */
export type HeadlessPendingAction =
  | {
      kind: 'approval';
      approvalId: string;
      toolCallId: string;
      toolName: string;
      input: unknown;
      /** Set when the call waits inside a sub-agent. */
      agentPath?: string[];
      /** A signed approval's token: echo it back on the verdict. */
      token?: string;
      resumeWith: 'approvalResponses';
    }
  | {
      kind: 'client-tool';
      toolCallId: string;
      toolName: string;
      input: unknown;
      resumeWith: 'clientToolResults';
    }
  | {
      /**
       * A call that started and whose outcome was never recorded. Check the
       * effect in the system it touched, then answer with either option: list
       * the call in `retryToolCallIds` to run it again, or give the result that
       * landed in `reconciledToolResults` (`isError` for an error) so it never
       * runs again. Every unknown effect of the run needs an answer in the
       * same resume.
       */
      kind: 'unknown-effect';
      toolCallId: string;
      toolName: string;
      input: unknown;
      modelStep?: number;
      resumeWith: ['retryToolCallIds', 'reconciledToolResults'];
    }
  | { kind: 'resume'; phase: Exclude<AgentRunPhase, 'terminal'> };

/**
 * A failed run a resume can re-enter (2.3 preview): its failure was transient,
 * and the stored run records why (`AgentRunEnvelope.retry`). Resume with
 * `retryFailed: true` to go on from the run's last checkpoint.
 */
export interface HeadlessRetry {
  /**
   * `'model-call'`: a model call failed in transit (a network or provider
   * error, a transport timeout, an open circuit breaker, a stream that broke
   * off). `'admission'`: the persistent budget store refused a call with a
   * serialization conflict.
   */
  cause: AgentRunRetry['cause'];
  /** The phase the run failed in, where the retry re-enters it. */
  phase: AgentRunRetry['phase'];
  resumeWith: 'retryFailed';
}

/** What a run's model calls cost (2.3 preview), from its budget ledger. */
export interface HeadlessCost {
  /** Known USD spend of the run's model calls, its sub-agents' included. */
  usd: number;
  /** Every call was priced and settled, so `usd` is the whole cost; otherwise a lower bound. */
  complete: boolean;
  /** Calls whose model has no price (an unpriced model adds nothing to `usd`). */
  unpricedCalls: number;
  /** Calls whose cost is unknown for another reason, such as an interrupted call. */
  unknownCalls: number;
}

/**
 * One native run leg (`runHeadless`, `resumeHeadless`) or a stored run
 * (`inspectRun`), as plain JSON (2.3 preview).
 */
export interface HeadlessReport {
  kind: 'deuz-headless-report';
  version: 1;
  runId: string;
  scope: string;
  /** The run's result status; `'in-progress'` for a stored run with no result yet. */
  status: AgentResult['status'] | 'in-progress';
  outcome: HeadlessOutcome;
  /**
   * Where the stored run stands; absent when nothing was stored, or when it
   * could not be read back after the leg (a warning says so).
   */
  phase?: AgentRunPhase;
  /** A stopped run's reason, e.g. `'refusal'` or `'budget.usd'`. */
  reason?: string;
  error?: { name: string; message: string; code?: string };
  /**
   * The stored run failed in transit, and a resume with `retryFailed: true`
   * re-enters it. Set on the report of that failure (its outcome `'failed'`,
   * or `'limit'` for a transport timeout), and of a later leg that ended
   * before its first write (a retried resume that stopped again for an
   * unknown effect: answer it and pass `retryFailed: true` once more). Absent
   * for any other failure, including a resume refused before it wrote.
   */
  retry?: HeadlessRetry;
  stopDetails?: StopDetails;
  /** What the run waits for; empty unless the outcome is `'pending'`. */
  pending: HeadlessPendingAction[];
  usage: Usage;
  modelSteps: number;
  /** Absent when the run has no budget ledger to read it from. */
  cost?: HeadlessCost;
  /** The verifier's last verdict, when the run has a `verify` that ran. */
  verification?: AgentVerification['status'];
  /** The warnings this leg reported (`inspectRun` reports none: no call was made). */
  warnings: CallWarning[];
  /** A completed run's accepted output. */
  output?: unknown;
  /** The final text: the answer, or what was produced before the run stopped. */
  text: string;
}

const LIMIT_REASONS = new Set([
  'budget.usd',
  'budget.tokens',
  'max-steps',
  'stepCountIs',
  'totalTokensExceed',
  'costExceeds',
  'durationExceeds',
]);
const LIMIT_CODES = new Set(['budget_exceeded', 'deadline_exceeded', 'timeout', 'unpriced_model']);

/** The outcome a native result maps to. */
export function outcomeOf(result: AgentResult<unknown>): HeadlessOutcome {
  switch (result.status) {
    case 'completed':
      return 'completed';
    case 'suspended':
      return 'pending';
    case 'stopped':
      if (result.reason === 'refusal') return 'refused';
      if (result.reason === 'aborted' || result.reason === 'cancelled') return 'cancelled';
      if (result.reason === 'tool-reconciliation-required') return 'pending';
      return LIMIT_REASONS.has(result.reason) ? 'limit' : 'stopped';
    case 'failed': {
      const code = result.error.code;
      if (code === 'aborted') return 'cancelled';
      return code !== undefined && LIMIT_CODES.has(code) ? 'limit' : 'failed';
    }
  }
}

/** The exit code of a run report or a doctor report (2.3 preview). */
export function exitCodeFor(report: HeadlessReport | DoctorReport): number {
  if (report.kind === 'deuz-headless-doctor')
    return report.ok ? HEADLESS_EXIT_CODES.completed : HEADLESS_EXIT_CODES.doctor;
  return HEADLESS_EXIT_CODES[report.outcome] ?? HEADLESS_EXIT_CODES.failed;
}

/** The cost the ledger's totals record. */
export function costOf(totals: BudgetTotals | undefined): HeadlessCost | undefined {
  if (!totals) return undefined;
  const unpricedCalls = totals.unpriced ?? 0;
  return {
    usd: totals.spent.usd,
    complete: totals.unknownUsd === 0 && totals.reserved.usd === 0,
    unpricedCalls,
    unknownCalls: totals.unknownUsd - unpricedCalls,
  };
}

function pendingOf(result: AgentResult<unknown>): HeadlessPendingAction[] {
  if (result.status === 'suspended') {
    return [
      ...result.pendingApprovals.map(
        (request): HeadlessPendingAction => ({
          kind: 'approval',
          approvalId: request.approvalId,
          toolCallId: request.toolCallId,
          toolName: request.toolName,
          input: request.input,
          ...(request.agentPath ? { agentPath: [...request.agentPath] } : {}),
          ...(request.token !== undefined ? { token: request.token } : {}),
          resumeWith: 'approvalResponses',
        }),
      ),
      ...result.pendingClientCalls.map(
        (call): HeadlessPendingAction => ({
          kind: 'client-tool',
          toolCallId: call.toolCallId,
          toolName: call.toolName,
          input: call.args,
          resumeWith: 'clientToolResults',
        }),
      ),
    ];
  }
  if (result.status === 'stopped') return (result.unknownEffects ?? []).map(unknownEffect);
  return [];
}

function unknownEffect(receipt: {
  toolCallId: string;
  toolName: string;
  input: unknown;
  modelStep?: number;
}): HeadlessPendingAction {
  return {
    kind: 'unknown-effect',
    toolCallId: receipt.toolCallId,
    toolName: receipt.toolName,
    input: receipt.input,
    ...(receipt.modelStep !== undefined ? { modelStep: receipt.modelStep } : {}),
    resumeWith: ['retryToolCallIds', 'reconciledToolResults'],
  };
}

type ResultError = { name: string; message: string; code?: string };

function sameError(a: ResultError, b: ResultError): boolean {
  return a.name === b.name && a.message === b.message && a.code === b.code;
}

/**
 * The retry a resume can make of the stored run (`retryFailed`): the run's
 * record of a transient failure, when the resume would take it (its result
 * failed, in a phase it can re-enter). A leg that failed on its own, such as
 * a resume refused before it wrote or a fresh run under a taken ID, is not
 * that failure and gets none.
 */
function retryOf(
  result: AgentResult<unknown>,
  stored: AgentRunEnvelope | undefined,
): HeadlessRetry | undefined {
  const record = stored?.retry;
  const failure = stored?.phase === 'terminal' ? stored.result : undefined;
  if (!record || failure?.status !== 'failed') return undefined;
  if (record.phase !== 'running' && record.phase !== 'finalizing') return undefined;
  if (result.status === 'failed' && !sameError(result.error, failure.error)) return undefined;
  return { cause: record.cause, phase: record.phase, resumeWith: 'retryFailed' };
}

/** Round-trip through JSON: the report holds plain data only. */
function plain<T>(value: T): T {
  return value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T);
}

/**
 * The report of a native result. `stored` is the stored run as the leg left it,
 * when it could be read: its phase, and the retry its failure allows.
 */
export function reportFromResult(
  result: AgentResult<unknown>,
  context: { scope: string; stored?: AgentRunEnvelope; warnings?: readonly CallWarning[] },
): HeadlessReport {
  const phase = context.stored?.phase;
  const retry = retryOf(result, context.stored);
  const report: HeadlessReport = {
    kind: 'deuz-headless-report',
    version: 1,
    runId: result.runId,
    scope: context.scope,
    status: result.status,
    outcome: outcomeOf(result),
    ...(phase !== undefined ? { phase } : {}),
    ...(result.status === 'stopped' ? { reason: result.reason } : {}),
    ...(result.status === 'failed' ? { error: { ...result.error } } : {}),
    ...(retry ? { retry } : {}),
    ...(result.stopDetails ? { stopDetails: { ...result.stopDetails } } : {}),
    pending: pendingOf(result),
    usage: { ...result.usage },
    modelSteps: result.modelSteps,
    ...(result.accounting ? { cost: costOf(result.accounting) } : {}),
    ...(result.verification ? { verification: result.verification } : {}),
    warnings: (context.warnings ?? []).map((warning) => ({ ...warning })),
    ...(result.status === 'completed' ? { output: result.output } : {}),
    text: result.text,
  };
  return plain(report);
}

function lastAssistantText(messages: readonly Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!;
    if (message.role !== 'assistant') continue;
    return typeof message.content === 'string'
      ? message.content
      : message.content.map((part) => (part.type === 'text' ? part.text : '')).join('');
  }
  return '';
}

/** The ledger totals a run without a recorded result last saved, if they can be read. */
function savedTotals(envelope: AgentRunEnvelope): BudgetTotals | undefined {
  const saved = envelope.execution;
  if (!saved) return undefined;
  try {
    return createExecutionContext({ snapshot: saved }).ledger.totals(saved.scopeId);
  } catch {
    // A snapshot this reader cannot restore (e.g. persistent admission) has no cost here.
    return undefined;
  }
}

/** The report of a stored run (`inspectRun`): no model call, no warnings. */
export function reportFromEnvelope(envelope: AgentRunEnvelope): HeadlessReport {
  if (envelope.result) {
    return reportFromResult(envelope.result, { scope: envelope.scope, stored: envelope });
  }
  // No result: the run is in progress, or its executor stopped before it ended.
  // An interrupted call that is not idempotent needs a decision before resume.
  const unknown = Object.values(envelope.toolResults ?? {}).filter(
    (receipt) => receipt.stage === 'executing' && receipt.idempotent !== true,
  );
  const phase = envelope.phase === 'terminal' ? 'running' : envelope.phase;
  const cost = costOf(savedTotals(envelope));
  const report: HeadlessReport = {
    kind: 'deuz-headless-report',
    version: 1,
    runId: envelope.runId,
    scope: envelope.scope,
    status: 'in-progress',
    outcome: 'pending',
    phase: envelope.phase,
    pending: [...unknown.map(unknownEffect), { kind: 'resume', phase }],
    usage: { ...envelope.usage },
    modelSteps: envelope.modelSteps,
    ...(cost ? { cost } : {}),
    ...(envelope.verification ? { verification: envelope.verification } : {}),
    warnings: [],
    text: envelope.candidateText ?? lastAssistantText(envelope.messages),
  };
  return plain(report);
}
