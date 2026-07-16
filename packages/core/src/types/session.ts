/**
 * Durable agent execution (1.5 additive): a storage-agnostic `SessionStore`
 * seam plus a serializable `AgentCheckpoint` saved at every STEP BOUNDARY of
 * both agentic loops. No vendor runtime — any KV/SQL/file backend can
 * implement the two-method store. A mid-step crash resumes from the last
 * boundary and re-runs that step (the honest recovery unit is one step).
 */
import type { Message } from './message';
import type { Usage } from './usage';
import type { ToolApprovalRequest } from './tool';

/**
 * Run state at a checkpoint boundary.
 * - `running`   — a step completed; the loop is (or was) still going.
 * - `suspended` — the loop broke on a client-mode approval / client tool;
 *                 resume with `approvalResponses` to settle.
 * - `completed` — the run finished (final text, stop condition, or guard).
 */
export type CheckpointStatus = 'running' | 'suspended' | 'completed';

/**
 * A serializable snapshot of an agentic run at a step boundary. `messages` is
 * the full immutable history — the loop never mutates prior arrays, so a
 * stored reference stays valid; persistent stores serialize it (see
 * `serializeCheckpoint` for the binary-part-safe JSON codec).
 */
export interface AgentCheckpoint {
  /** Checkpoint schema version (forward-compat gate for stores). */
  version: 1;
  /** Identifies the run across suspend/resume legs (stable for the run's life). */
  runId: string;
  /** `${runId}#${stepIndex}` — identifies this exact step boundary. */
  stepId: string;
  /** Checkpoint boundaries saved so far across ALL legs (monotonic; a suspension boundary counts too). */
  stepIndex: number;
  status: CheckpointStatus;
  /** Full message history at the boundary (immutable snapshot). */
  messages: Message[];
  /** CUMULATIVE usage across the whole run (all legs), not just the current call. */
  usage: Usage;
  /** Set when `status` is 'suspended' on a client-mode approval break. */
  pendingApprovals?: ToolApprovalRequest[];
  /** Sub-agent path of the checkpointed loop (absent at the root). */
  agentPath?: string[];
  /** `deps.clock.now()` at save time. */
  createdAt: number;
}

/**
 * The durable-session seam. Implement against any backend (Supabase table,
 * Redis, S3, fs). `save` is called at every step boundary — a throwing store
 * is logged via `deps.logger.error` and the run continues (best-effort
 * durability, never a run-killer). Keys are `runId`s.
 */
export interface SessionStore {
  save(checkpoint: AgentCheckpoint): void | Promise<void>;
  load(runId: string): AgentCheckpoint | undefined | Promise<AgentCheckpoint | undefined>;
  /** Optional: remove a stored run (cleanup tooling — the loops never call it). */
  delete?(runId: string): void | Promise<void>;
  /** Optional: enumerate stored runIds (CLI `runs list`-style tooling). */
  list?(): string[] | Promise<string[]>;
}

/**
 * Opt-in durable execution for an agentic call (additive on
 * `CommonCallOptions`). When present, both loops checkpoint at every step
 * boundary and the result carries `runId` for later `resumeFromCheckpoint`.
 */
export interface DurableSessionOptions {
  store: SessionStore;
  /** Stable run identifier; default `deps.generateId()`. Reuse it to overwrite/continue a run. */
  runId?: string;
}
