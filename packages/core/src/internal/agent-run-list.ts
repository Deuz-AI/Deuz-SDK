/**
 * @internal Native run discovery (2.3), shared by the stores that implement
 * `AgentRunStore.list`: the memory store in `agent-run.ts` and the SQLite and
 * Postgres ops stores under `node/`. One query validation, one order (last
 * save descending, then run ID descending) and one cursor format, so every
 * store pages the same way. Edge-safe.
 */
import type {
  AgentResult,
  AgentRunEnvelope,
  AgentRunListPage,
  AgentRunListQuery,
  AgentRunPhase,
  AgentRunSummary,
} from '../types/agent-run';

const PHASES: readonly AgentRunPhase[] = ['running', 'finalizing', 'terminal'];
const STATUSES: readonly AgentResult['status'][] = ['completed', 'suspended', 'stopped', 'failed'];
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1000;

/** A validated `AgentRunListQuery`, its cursor decoded. */
export interface AgentRunListPlan {
  /** Undefined: every phase. */
  phases?: readonly AgentRunPhase[];
  updatedBefore?: number;
  scope?: string;
  limit: number;
  /** The position the previous page ended at: only runs strictly after it. */
  after?: { updatedAt: number; runId: string };
}

/** Validates a listing query; a malformed one throws a TypeError. */
export function planAgentRunList(query: AgentRunListQuery | undefined): AgentRunListPlan {
  if (query !== undefined && (typeof query !== 'object' || query === null))
    throw new TypeError('An agent run listing query must be an object');
  const { phases, updatedBefore, scope, limit = DEFAULT_LIMIT, cursor } = query ?? {};
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIMIT)
    throw new TypeError(`Agent run listing limit must be an integer from 1 to ${MAX_LIMIT}`);
  if (
    phases !== undefined &&
    (!Array.isArray(phases) || phases.some((phase) => !PHASES.includes(phase)))
  )
    throw new TypeError(`Agent run listing phases must be among ${PHASES.join(', ')}`);
  // Number.isFinite is false for every non-number, with no coercion.
  if (updatedBefore !== undefined && !Number.isFinite(updatedBefore))
    throw new TypeError('updatedBefore must be a finite epoch millisecond value');
  if (scope !== undefined && typeof scope !== 'string')
    throw new TypeError('Agent run listing scope must be a string');
  return {
    ...(phases !== undefined ? { phases: [...new Set(phases)] } : {}),
    ...(updatedBefore !== undefined ? { updatedBefore } : {}),
    ...(scope !== undefined ? { scope } : {}),
    limit,
    ...(cursor !== undefined ? { after: decodeCursor(cursor) } : {}),
  };
}

function decodeCursor(cursor: unknown): { updatedAt: number; runId: string } {
  let position: unknown;
  try {
    position = typeof cursor === 'string' ? JSON.parse(cursor) : undefined;
  } catch {
    position = undefined;
  }
  // The SQL stores' times are whole milliseconds; an injected clock's need not be.
  if (
    !Array.isArray(position) ||
    position.length !== 2 ||
    !Number.isFinite(position[0]) ||
    typeof position[1] !== 'string'
  )
    throw new TypeError('Malformed agent run listing cursor');
  return { updatedAt: position[0] as number, runId: position[1] as string };
}

/** The cursor that resumes a listing after this run. */
function encodeCursor(run: Pick<AgentRunSummary, 'updatedAt' | 'runId'>): string {
  return JSON.stringify([run.updatedAt, run.runId]);
}

/** Newest change first, then run ID descending: the order every listing pages in. */
export function compareAgentRunSummaries(
  left: Pick<AgentRunSummary, 'updatedAt' | 'runId'>,
  right: Pick<AgentRunSummary, 'updatedAt' | 'runId'>,
): number {
  if (left.updatedAt !== right.updatedAt) return right.updatedAt - left.updatedAt;
  return left.runId < right.runId ? 1 : left.runId > right.runId ? -1 : 0;
}

/** Whether a run lies strictly after the cursor's position in that order. */
export function isAfterAgentRunCursor(
  run: Pick<AgentRunSummary, 'updatedAt' | 'runId'>,
  after: AgentRunListPlan['after'],
): boolean {
  return after === undefined || compareAgentRunSummaries(after, run) < 0;
}

/**
 * A run's summary from the fields a store keeps: its envelope's phase and
 * result status (as the envelope records them) and the time of its last save.
 */
export function summarizeAgentRun(row: {
  runId: string;
  scope: string;
  revision: unknown;
  updatedAt: unknown;
  phase: unknown;
  status: unknown;
}): AgentRunSummary {
  const phase = row.phase as AgentRunPhase;
  if (!PHASES.includes(phase))
    throw new Error(`Agent run ${row.runId} has an unknown phase: ${String(row.phase)}`);
  const status = row.status as AgentResult['status'];
  return {
    runId: row.runId,
    scope: row.scope,
    phase,
    revision: Number(row.revision ?? 0),
    updatedAt: Number(row.updatedAt),
    ...(STATUSES.includes(status) ? { status } : {}),
  };
}

/** The summary of a stored envelope, as the memory store keeps it. */
export function summarizeAgentRunEnvelope(
  envelope: AgentRunEnvelope,
  updatedAt: number,
): AgentRunSummary {
  return summarizeAgentRun({
    runId: envelope.runId,
    scope: envelope.scope,
    revision: envelope.revision,
    updatedAt,
    phase: envelope.phase,
    status: envelope.result?.status,
  });
}

/**
 * A page from up to `limit + 1` rows in listing order: the first `limit`, and
 * a cursor when the extra row shows that more follow.
 */
export function agentRunListPage(rows: AgentRunSummary[], limit: number): AgentRunListPage {
  if (rows.length <= limit) return { runs: rows };
  const runs = rows.slice(0, limit);
  return { runs, cursor: encodeCursor(runs.at(-1)!) };
}
