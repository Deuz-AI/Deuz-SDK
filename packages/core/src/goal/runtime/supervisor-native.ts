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
 * stored run keeps its own). A leg that another executor of the run
 * refused (its lease held or lost, or an executor in this process) reports
 * `heldElsewhere`: the supervisor resumes the run later. Cancel and drain are
 * signals to the native run's lease (`agentRunLeaseKey`); a launcher created
 * without `lease` takes the lease provider of the first supervisor it is
 * given to. Without one, or while no executor holds the run, they answer
 * false and the supervisor keeps the cancel.
 *
 * Edge-safe.
 */
import { agentRunLeaseKey } from '../../internal/agent-run-lease';
import type { AgentResult, AgentRunLeaseOptions } from '../../types/agent-run';
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

/** Native launchers created without `lease`, and how a supervisor gives them one. */
const unleased = new WeakMap<RunLauncher, (lease: AgentRunLeaseOptions) => void>();

/**
 * Gives a native launcher created without `lease` the supervisor's (spec
 * §3.1: the native run keeps its own lease), so a drain, a cancel and a
 * takeover reach its runs. A launcher with a lease of its own, or of another
 * kind, is left as it is. The first supervisor's lease stays.
 */
export function adoptRunLease(launcher: RunLauncher, lease: AgentRunLeaseOptions): void {
  unleased.get(launcher)?.(lease);
}

/** What the executor answers a second executor of a run in the same process. */
const ACTIVE_EXECUTOR = 'This native run already has an active executor.';

/**
 * Whether another executor holds the run: its lease refused this leg
 * (`lease_held`), took the run from it (`lease_lost`), or an executor of the
 * run in this process is still driving it.
 */
function heldElsewhere(result: AgentResult<unknown>): boolean {
  if (result.status !== 'failed') return false;
  const { name, code, message } = result.error;
  if (name === 'AgentRunLeaseError') return code === 'lease_held' || code === 'lease_lost';
  return name === 'TypeError' && message === ACTIVE_EXECUTOR;
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
  let lease = options.lease;
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
    // Nothing of the run happened here: the supervisor resumes it at a later claim.
    if (heldElsewhere(result)) return { runId: request.runId, result, heldElsewhere: true };
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

  const launcher: RunLauncher = {
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
  if (lease === undefined)
    unleased.set(launcher, (given) => {
      lease = given;
      unleased.delete(launcher);
    });
  return launcher;
}
