/**
 * @internal The native `RunLauncher` (2.4, spec §3.1): V3 runs of a goal
 * through the existing executor, never a loop of its own. The executor is
 * loaded with a lazy `import()`, so `/goal/runtime` never bundles it; so is
 * the budget ledger that reads a run's durable accounting.
 *
 * Per leg: a run its V3 store does not hold is started, a stored one resumed
 * (a repeated launch never starts a run twice); only a `'retry'` of a run
 * whose failure the native layer recorded as transient resumes with
 * `retryFailed`. The inherited working memory goes to a new run only (a
 * stored run keeps its own). Cancel and drain are signals to the native
 * run's lease (`agentRunLeaseKey`): without `lease`, or while no executor
 * holds the run, they answer false and the supervisor keeps the cancel.
 *
 * Edge-safe.
 */
import { agentRunLeaseKey } from '../../internal/agent-run-lease';
import type { AgentResult } from '../../types/agent-run';
import type { AgentRunEnvelopeV3, AgentRunOptionsV3 } from '../../types/agent-run-v3';
import type { BudgetTotals } from '../../types/execution';
import { GoalError } from '../errors';
import type {
  NativeRunLauncherOptions,
  RunLaunchRequest,
  RunLaunchResult,
  RunLauncher,
} from './supervisor';

/** The executor's V3 entry points (lane L3b adds them as overloads of `runAgent` and `resumeAgent`). */
type RunV3 = (options: AgentRunOptionsV3<unknown>) => Promise<AgentResult<unknown>>;

/** A run's after-verdict work, as the supervisor follows it. */
function maintenanceOf(
  envelope: AgentRunEnvelopeV3 | undefined,
): RunLaunchResult['maintenance'] | undefined {
  const status = envelope?.memory?.extraction?.status;
  if (status === undefined) return undefined;
  if (status === 'pending') return 'pending';
  return status === 'completed' ? 'complete' : 'failed';
}

/** The run's durable ledger totals: its checkpoint's ledger, else its result's. */
async function totalsOf(envelope: AgentRunEnvelopeV3): Promise<BudgetTotals | undefined> {
  const execution = envelope.execution;
  if (execution !== undefined) {
    try {
      const { createBudgetLedger } = await import('../../budget-ledger');
      // Read only: persistent admission and a subtree marker matter to a
      // ledger that admits calls, not to one whose totals are read.
      const { admission: _admission, subtree: _subtree, ...snapshot } = execution.ledger;
      return createBudgetLedger({ snapshot }).totals(execution.scopeId);
    } catch {
      // A snapshot this build cannot restore: fall back to the result's accounting.
    }
  }
  return envelope.result?.accounting;
}

export function createNativeRunLauncher(options: NativeRunLauncherOptions): RunLauncher {
  const store = options?.store;
  if (store === null || typeof store !== 'object' || store.checkpointVersion !== 3)
    throw new TypeError('createNativeRunLauncher needs an AgentRunStoreV3 (checkpointVersion 3)');
  if (typeof options.options !== 'function')
    throw new TypeError('createNativeRunLauncher needs an options function');
  const lease = options.lease;
  let executor: Promise<typeof import('../../agent-run')> | undefined;

  async function stored(scope: string, runId: string): Promise<AgentRunEnvelopeV3 | undefined> {
    const envelope = await store.load(runId);
    if (envelope !== undefined && envelope.scope !== scope)
      throw new GoalError('scope_mismatch', `Native run ${runId} belongs to another scope.`);
    return envelope;
  }

  async function leg(request: RunLaunchRequest): Promise<RunLaunchResult> {
    const before = await stored(request.scope, request.runId);
    const base = await options.options(request);
    const retry =
      request.kind === 'retry' && before?.retry !== undefined && before.result?.status === 'failed';
    const runOptions = {
      ...base,
      checkpointVersion: 3,
      session: { store, runId: request.runId, scope: request.scope },
      ...(lease !== undefined ? { lease } : {}),
      ...(before === undefined && request.workingMemory !== undefined
        ? { workingMemory: { ...base.workingMemory, snapshot: request.workingMemory } }
        : {}),
      ...(request.approvalResponses !== undefined
        ? { approvalResponses: request.approvalResponses }
        : {}),
      ...(request.clientToolResults !== undefined
        ? { clientToolResults: request.clientToolResults }
        : {}),
      ...(retry ? { retryFailed: true } : {}),
      ...(request.signal !== undefined ? { signal: request.signal } : {}),
    } as AgentRunOptionsV3<unknown>;
    executor ??= import('../../agent-run');
    const native = await executor;
    const run = (before === undefined ? native.runAgent : native.resumeAgent) as unknown as RunV3;
    const result = await run(runOptions);
    const after = await store.load(request.runId);
    const maintenance = maintenanceOf(after);
    return {
      runId: request.runId,
      result,
      ...(result.status === 'failed' && after?.retry !== undefined ? { retryable: true } : {}),
      ...(after?.workingMemory !== undefined ? { workingMemory: after.workingMemory } : {}),
      ...(maintenance !== undefined ? { maintenance } : {}),
    };
  }

  const signal = async (scope: string, runId: string, kind: 'cancel' | 'drain') =>
    lease === undefined ? false : lease.provider.signal(agentRunLeaseKey({ scope, runId }), kind);

  return {
    launch: leg,
    resume: leg,
    cancel: ({ scope, runId }) => signal(scope, runId, 'cancel'),
    drain: ({ scope, runId }) => signal(scope, runId, 'drain'),
    async accounting({ scope, runId }) {
      const envelope = await store.load(runId);
      if (envelope === undefined || envelope.scope !== scope) return undefined;
      return totalsOf(envelope);
    },
    async maintenance({ scope, runId }) {
      const envelope = await store.load(runId);
      if (envelope === undefined || envelope.scope !== scope) return undefined;
      return maintenanceOf(envelope);
    },
  };
}
