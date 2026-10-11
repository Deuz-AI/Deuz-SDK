/**
 * `@deuz-sdk/core/headless` (2.3, a PREVIEW, not a stable API): run, resume and
 * inspect native agent runs from a script or CI job, and check a provider /
 * model / configuration before running it. Node-only: it reads project
 * instruction files and skill folders from disk and the environment. There is
 * no `bin` and no CLI package; `examples/headless` shows a command line built
 * on it.
 *
 * Every function returns plain JSON — a {@link HeadlessReport} or a
 * {@link DoctorReport} — and {@link exitCodeFor} maps it to a documented exit
 * code, so a run that did not complete never exits 0.
 */
import type {
  AgentEvent,
  AgentResult,
  AgentRunOptions,
  AgentRunSession,
  AgentRunStore,
  AgentStream,
} from '../types/agent-run';
import type { Dependencies } from '../types/deps';
import { resumeStreamAgent, streamAgent } from '../agent-run';
import { createPriceProvider } from '../pricing';
import { resolveDependencies } from '../internal/resolve-deps';
import { createWarningSink } from '../internal/warnings';
import { reportFromEnvelope, reportFromResult, type HeadlessReport } from '../headless/report';

export {
  HEADLESS_EXIT_CODES,
  exitCodeFor,
  type HeadlessCost,
  type HeadlessOutcome,
  type HeadlessPendingAction,
  type HeadlessReport,
} from '../headless/report';
export type { DoctorFinding, DoctorReport, DoctorSeverity } from '../headless/doctor';

/** Where a headless run is stored, and how its leg is observed (2.3 preview). */
export interface HeadlessSessionOptions {
  /**
   * A durable native run store. `createSqliteOpsStore({ path }).agentRuns` from
   * `@deuz-sdk/core/ops/sqlite` is the default choice for one machine; any
   * `AgentRunStore` works (Postgres, Redis, or the in-memory store in tests).
   */
  store: AgentRunStore;
  /** Application-selected tenant / workflow scope, checked on every resume. Default `'headless'`. */
  scope?: string;
  /**
   * Every event of the leg as it happens (text deltas, tool states, warnings,
   * the result), for progress output. It must not throw: an error it throws
   * rejects the call once the run has settled.
   */
  onEvent?: (event: AgentEvent<unknown>) => void;
}

/**
 * `runHeadless` options (2.3 preview): `runAgent`'s, with the session made from
 * `store`, `runId` and `scope`.
 */
export type HeadlessRunOptions<T = string> = AgentRunOptions<T> &
  HeadlessSessionOptions & {
    /** The run's ID. Default: a generated one (`deps.generateId`). */
    runId?: string;
    session?: never;
  };

/**
 * `resumeHeadless` options (2.3 preview): `resumeAgent`'s, with the session
 * made from `store`, `runId` and `scope`. Pass the same model, tools and output
 * as the first leg: the run's binding rejects a change.
 */
export type HeadlessResumeOptions<T = string> = AgentRunOptions<T> &
  HeadlessSessionOptions & {
    runId: string;
    session?: never;
    prompt?: never;
    messages?: never;
    instructions?: never;
  };

/** Price model calls with the bundled table unless the caller brought a price provider. */
function pricedDeps(deps: Dependencies | undefined): Dependencies {
  return deps?.priceProvider ? deps : { ...deps, priceProvider: createPriceProvider() };
}

/** Drain one leg's events, then report its result with the stored run's phase. */
async function report(
  stream: AgentStream<unknown>,
  session: AgentRunSession,
  onEvent: HeadlessSessionOptions['onEvent'],
): Promise<HeadlessReport> {
  const warnings = createWarningSink();
  let callbackError: { error: unknown } | undefined;
  for await (const event of stream.events) {
    if (event.type === 'part' && event.part.type === 'warning')
      warnings.add(event.part.warning, { mirror: false });
    if (onEvent && !callbackError) {
      try {
        onEvent(event);
      } catch (error) {
        callbackError = { error };
      }
    }
  }
  const result: AgentResult<unknown> = await stream.result;
  if (callbackError) throw callbackError.error;
  let phase: HeadlessReport['phase'];
  try {
    phase = (await session.store.load(session.runId))?.phase;
  } catch (error) {
    warnings.add(
      {
        type: 'other',
        message: `The stored run could not be read back: ${error instanceof Error ? error.message : String(error)}`,
      },
      { mirror: false },
    );
  }
  return reportFromResult(result, {
    scope: session.scope,
    ...(phase !== undefined ? { phase } : {}),
    warnings: warnings.list(),
  });
}

function split<O extends HeadlessSessionOptions & { runId?: string; deps?: Dependencies }>(
  options: O,
): {
  session: AgentRunSession;
  onEvent: HeadlessSessionOptions['onEvent'];
  rest: Omit<O, 'store' | 'runId' | 'scope' | 'onEvent'>;
} {
  const { store, runId, scope, onEvent, ...rest } = options;
  return {
    session: {
      store,
      runId: runId ?? resolveDependencies(options.deps).generateId(),
      scope: scope ?? 'headless',
    },
    onEvent,
    rest,
  };
}

/**
 * Start a native run (2.3 preview): `streamAgent` with a durable session, its
 * events drained, and a {@link HeadlessReport} of the result. Calls are priced
 * with the bundled table unless `deps.priceProvider` is given. Whatever happens
 * to the run is in the report; it rejects only when `onEvent` threw.
 */
export async function runHeadless<T = string>(
  options: HeadlessRunOptions<T>,
): Promise<HeadlessReport> {
  const { session, onEvent, rest } = split(options);
  const stream = streamAgent({
    ...(rest as AgentRunOptions<T>),
    deps: pricedDeps(rest.deps),
    session,
  });
  return report(stream as AgentStream<unknown>, session, onEvent);
}

/**
 * Continue a stored native run (2.3 preview): `resumeStreamAgent` with the
 * verdicts, client results or `retryToolCallIds` the previous report's
 * `pending` asked for, reported like {@link runHeadless}.
 */
export async function resumeHeadless<T = string>(
  options: HeadlessResumeOptions<T>,
): Promise<HeadlessReport> {
  const { session, onEvent, rest } = split(options);
  const stream = resumeStreamAgent({
    ...(rest as AgentRunOptions<T>),
    deps: pricedDeps(rest.deps),
    session,
  });
  return report(stream as AgentStream<unknown>, session, onEvent);
}

/**
 * The report of a stored run (2.3 preview), read from `store` with no model
 * call: its outcome, what it waits for, usage and cost. A run with no result
 * yet reports `status: 'in-progress'` and a pending `'resume'`, with any call
 * whose effect is unknown; that is accurate only when no executor still drives
 * it. Rejects an unknown run ID with a TypeError.
 */
export async function inspectRun(store: AgentRunStore, runId: string): Promise<HeadlessReport> {
  const envelope = await store.load(runId);
  if (!envelope) throw new TypeError(`Unknown native run: ${runId}`);
  if (envelope.kind !== 'deuz-agent-run' || envelope.runId !== runId)
    throw new TypeError(`Not a native run record: ${runId}`);
  return reportFromEnvelope(envelope);
}
