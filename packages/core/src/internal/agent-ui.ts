/**
 * The client half of the native UI bridge (2.3, roadmap 23.5): reading
 * `data-agent` frames back into a `DeuzAgentState`, plus the wire coercions
 * the chat reducer shares with it.
 *
 * Lives apart from `ui.ts` so `./chat` (whose `applyUIPart` folds agent frames
 * into `AssistantTurnState.agent`) does not pull the serializers into its
 * bundle. Edge-safe and pure: no clock, no randomness, no Node import.
 *
 * Every value here crossed a network boundary from a server that may be older,
 * newer or hostile, so a frame is applied only when it is well formed, and a
 * field typed `string` or `number` never ends up holding anything else.
 */
import type { StopDetails } from '../types/methods';
import type { ToolApprovalRequest } from '../types/tool';
import type { Usage } from '../types/usage';
import type {
  DeuzAgentClientCall,
  DeuzAgentFrame,
  DeuzAgentResultFrame,
  DeuzAgentState,
  DeuzUIPart,
} from '../ui';

/**
 * Coerce a wire `usage` payload into a real `Usage` (1.9). `applyUIPart` is
 * TOTAL by contract, and this payload crosses a network boundary from a server
 * that may be older, newer, or hostile: `null`, a string, or a partial object
 * (`{ totalTokens: 1 }`) must fold without throwing AND without leaving a field
 * typed `number` holding something else. Non-finite/missing counts read as 0;
 * `totalTokens` falls back to input+output so a token badge always renders.
 */
export function usageFromWire(value: unknown): Usage {
  const raw = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
  const optional = (key: string): number | undefined => {
    const n = raw[key];
    return typeof n === 'number' && Number.isFinite(n) ? n : undefined;
  };
  const count = (key: string): number => optional(key) ?? 0;
  const inputTokens = count('inputTokens');
  const outputTokens = count('outputTokens');
  const audioTokens = optional('audioTokens');
  const serverToolUses = optional('serverToolUses');
  return {
    inputTokens,
    outputTokens,
    reasoningTokens: count('reasoningTokens'),
    cachedReadTokens: count('cachedReadTokens'),
    cacheWriteTokens: count('cacheWriteTokens'),
    cacheWrite1hTokens: count('cacheWrite1hTokens'),
    ...(audioTokens !== undefined ? { audioTokens } : {}),
    ...(serverToolUses !== undefined ? { serverToolUses } : {}),
    totalTokens: optional('totalTokens') ?? inputTokens + outputTokens,
  };
}

/**
 * A wire `stopDetails` (2.3), kept only when it has a string `type`. Same
 * shape rules as `stopDetailsFrom` on the server: `category` and
 * `explanation` are a string or `null` when present.
 */
export function stopDetailsFromWire(value: unknown): StopDetails | undefined {
  if (!isRecord(value) || typeof value.type !== 'string') return undefined;
  const { type, category, explanation } = value;
  return {
    type,
    ...(typeof category === 'string' || category === null ? { category } : {}),
    ...(typeof explanation === 'string' || explanation === null ? { explanation } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

const isCount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0;

const isText = (value: unknown): value is string => typeof value === 'string' && value !== '';

const VERIFICATIONS: ReadonlySet<unknown> = new Set(['verified', 'rejected', 'inconclusive']);

function approvalFromWire(value: unknown): ToolApprovalRequest | undefined {
  if (!isRecord(value)) return undefined;
  const { approvalId, toolCallId, toolName, input, token, agentPath } = value;
  if (!isText(approvalId) || !isText(toolCallId) || typeof toolName !== 'string') return undefined;
  if (token !== undefined && typeof token !== 'string') return undefined;
  if (
    agentPath !== undefined &&
    !(Array.isArray(agentPath) && agentPath.every((segment) => typeof segment === 'string'))
  )
    return undefined;
  return {
    approvalId,
    toolCallId,
    toolName,
    input,
    ...(token !== undefined ? { token } : {}),
    ...(agentPath !== undefined ? { agentPath: [...(agentPath as string[])] } : {}),
  };
}

function clientCallFromWire(value: unknown): DeuzAgentClientCall | undefined {
  if (!isRecord(value) || !isText(value.toolCallId) || typeof value.toolName !== 'string')
    return undefined;
  return { toolCallId: value.toolCallId, toolName: value.toolName, input: value.input };
}

/** Every entry well formed, or `undefined`: a half-read pending set would resume the run wrongly. */
function listFromWire<T>(value: unknown, read: (entry: unknown) => T | undefined): T[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: T[] = [];
  for (const entry of value) {
    const item = read(entry);
    if (item === undefined) return undefined;
    out.push(item);
  }
  return out;
}

function resultFrameFromWire(
  raw: Record<string, unknown>,
  seq: number,
): DeuzAgentFrame | undefined {
  if (typeof raw.runId !== 'string') return undefined;
  const stopDetails = stopDetailsFromWire(raw.stopDetails);
  const common = {
    kind: 'result' as const,
    seq,
    runId: raw.runId,
    ...(raw.usage !== undefined ? { usage: usageFromWire(raw.usage) } : {}),
    ...(isCount(raw.modelSteps) ? { modelSteps: raw.modelSteps } : {}),
    ...(VERIFICATIONS.has(raw.verification)
      ? { verification: raw.verification as DeuzAgentResultFrame['verification'] }
      : {}),
    ...(stopDetails ? { stopDetails } : {}),
  };
  switch (raw.status) {
    case 'completed':
      return { ...common, status: 'completed', output: raw.output };
    case 'suspended': {
      const pendingApprovals = listFromWire(raw.pendingApprovals, approvalFromWire);
      const pendingClientCalls = listFromWire(raw.pendingClientCalls, clientCallFromWire);
      if (!pendingApprovals || !pendingClientCalls) return undefined;
      return { ...common, status: 'suspended', pendingApprovals, pendingClientCalls };
    }
    case 'stopped': {
      if (typeof raw.reason !== 'string') return undefined;
      const unknownEffects =
        raw.unknownEffects === undefined
          ? undefined
          : listFromWire(raw.unknownEffects, (entry) =>
              isRecord(entry) && isText(entry.toolCallId) && typeof entry.toolName === 'string'
                ? {
                    toolCallId: entry.toolCallId,
                    toolName: entry.toolName,
                    ...(isCount(entry.modelStep) ? { modelStep: entry.modelStep } : {}),
                  }
                : undefined,
            );
      if (raw.unknownEffects !== undefined && !unknownEffects) return undefined;
      return {
        ...common,
        status: 'stopped',
        reason: raw.reason,
        ...(unknownEffects ? { unknownEffects } : {}),
      };
    }
    case 'failed': {
      const error = raw.error;
      if (!isRecord(error) || typeof error.name !== 'string' || typeof error.message !== 'string')
        return undefined;
      return {
        ...common,
        status: 'failed',
        error: {
          name: error.name,
          message: error.message,
          ...(typeof error.code === 'string' ? { code: error.code } : {}),
        },
      };
    }
    default:
      return undefined;
  }
}

/**
 * The agent frame a `data-agent` part carries (2.3), or `undefined` when the
 * part is anything else — another part type, or an app's own `data-agent`
 * payload, which stays an ordinary data part.
 */
export function agentFrameOf(part: DeuzUIPart): DeuzAgentFrame | undefined {
  if (part.type !== 'data-agent') return undefined;
  const raw: unknown = (part as { payload?: unknown }).payload;
  if (!isRecord(raw) || !isCount(raw.seq)) return undefined;
  const { seq } = raw;
  if (raw.runId !== undefined && typeof raw.runId !== 'string') return undefined;
  const runId = typeof raw.runId === 'string' ? { runId: raw.runId } : {};
  switch (raw.kind) {
    case 'run':
      return raw.status === 'running'
        ? { kind: 'run', seq, ...runId, status: 'running' }
        : undefined;
    case 'phase':
      return raw.phase === 'running' || raw.phase === 'finalizing'
        ? { kind: 'phase', seq, phase: raw.phase }
        : undefined;
    case 'partial':
      return isCount(raw.attempt) && 'value' in raw
        ? { kind: 'partial', seq, attempt: raw.attempt, value: raw.value }
        : undefined;
    case 'element':
      return isCount(raw.attempt) && isCount(raw.index) && 'value' in raw
        ? { kind: 'element', seq, attempt: raw.attempt, index: raw.index, value: raw.value }
        : undefined;
    case 'result':
      return resultFrameFromWire(raw, seq);
    default:
      return undefined;
  }
}

/** The state before any frame. A new object each time: states are never shared mutable values. */
export function idleAgentState<T>(): DeuzAgentState<T> {
  return { status: 'idle', seq: -1 };
}

/**
 * Apply one frame. A frame at or below `state.seq` was applied already (a
 * replay overlapping what the client holds) or is older than what it holds
 * (out of order): either way it returns `state` itself, so the state never
 * moves backwards and no frame applies twice. A frame of another run, later
 * in the sequence, starts that run's state.
 */
export function applyAgentFrame<T>(
  state: DeuzAgentState<T>,
  frame: DeuzAgentFrame,
): DeuzAgentState<T> {
  if (frame.seq <= state.seq) return state;
  const frameRun = 'runId' in frame ? frame.runId : undefined;
  const base: DeuzAgentState<T> =
    frameRun !== undefined && state.runId !== undefined && frameRun !== state.runId
      ? idleAgentState<T>()
      : state;
  const runId = frameRun ?? base.runId;
  const identity = { seq: frame.seq, ...(runId !== undefined ? { runId } : {}) };
  // A leg in progress keeps what the leg has said so far; a new leg after a
  // terminal frame (one whose `run` frame this reader missed) starts clean.
  const live =
    base.status === 'running'
      ? {
          ...(base.phase !== undefined ? { phase: base.phase } : {}),
          ...(base.partial !== undefined ? { partial: base.partial } : {}),
          ...(base.elements !== undefined ? { elements: base.elements } : {}),
        }
      : {};
  switch (frame.kind) {
    case 'run':
      // Every leg opens with one: what an earlier leg left (a suspension, its
      // drafts) is over.
      return { status: 'running', ...identity };
    case 'phase':
      return { status: 'running', ...identity, ...live, phase: frame.phase };
    case 'partial':
      return {
        status: 'running',
        ...identity,
        ...live,
        partial: { attempt: frame.attempt, value: frame.value },
      };
    case 'element': {
      const current =
        live.elements !== undefined && live.elements.attempt === frame.attempt
          ? live.elements.values
          : [];
      const values = [...current];
      values[frame.index] = frame.value;
      return {
        status: 'running',
        ...identity,
        ...live,
        elements: { attempt: frame.attempt, values },
      };
    }
    case 'result': {
      // Drafts end with the run: only `completed` carries an output, and it is
      // the one the server validated, never the last draft.
      const terminal = {
        ...identity,
        runId: frame.runId,
        ...(live.phase !== undefined ? { phase: live.phase } : {}),
        ...(frame.usage !== undefined ? { usage: frame.usage } : {}),
        ...(frame.modelSteps !== undefined ? { modelSteps: frame.modelSteps } : {}),
        ...(frame.verification !== undefined ? { verification: frame.verification } : {}),
        ...(frame.stopDetails !== undefined ? { stopDetails: frame.stopDetails } : {}),
      };
      switch (frame.status) {
        case 'completed':
          return { ...terminal, status: 'completed', output: frame.output as T };
        case 'suspended':
          return {
            ...terminal,
            status: 'suspended',
            pendingApprovals: frame.pendingApprovals,
            pendingClientCalls: frame.pendingClientCalls,
          };
        case 'stopped':
          return {
            ...terminal,
            status: 'stopped',
            reason: frame.reason,
            ...(frame.unknownEffects !== undefined ? { unknownEffects: frame.unknownEffects } : {}),
          };
        case 'failed':
          return { ...terminal, status: 'failed', error: frame.error };
      }
    }
  }
}
