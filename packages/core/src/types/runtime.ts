/**
 * Background run bookkeeping (1.8 additive) — a `RunStore` records the METADATA
 * of long-running autonomous runs (status, goal, plan snapshot, timestamps) on
 * top of the durable `SessionStore` (which holds the resumable checkpoints).
 * Together they make "the agent keeps working while your device is off" real:
 * a run is registered here, driven with `session`, and — if the process dies —
 * a worker lists stale runs and continues each from its last checkpoint with
 * `resumeFromCheckpoint` / `resumeDeuzChatResponse`.
 *
 * This is a metadata seam, not an executor: it never drives the model itself.
 */
import type { PlanTaskSnapshot } from './stream';

/** Lifecycle of a background run. */
export type RunStatus = 'queued' | 'running' | 'suspended' | 'completed' | 'failed';

/** Metadata for one background run (keyed by `runId`, aligned with `SessionStore`). */
export interface RunRecord {
  /** Same id used for the durable `SessionStore` checkpoints. */
  runId: string;
  status: RunStatus;
  /** The goal/prompt that started the run (for dashboards). */
  goal?: string;
  /** Last durable checkpoint step index, when known. */
  stepIndex?: number;
  /** Latest plan snapshot, when the run tracks a `TaskList`. */
  plan?: { goal?: string; tasks: PlanTaskSnapshot[] };
  /** Redacted error message when `status` is `failed`. */
  error?: string;
  /** Arbitrary correlation metadata (chatId, userId, tenant, …). */
  meta?: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
}

/**
 * Persistence seam for run metadata (the `SessionStore` pattern). Back it with
 * any KV/SQL/file store; `@deuz-sdk/core/runtime` ships an in-memory reference
 * and `@deuz-sdk/core/runtime/node` a JSONL one.
 */
export interface RunStore {
  create(record: RunRecord): void | Promise<void>;
  update(runId: string, patch: Partial<Omit<RunRecord, 'runId'>>): void | Promise<void>;
  get(runId: string): RunRecord | undefined | Promise<RunRecord | undefined>;
  list(filter?: { status?: RunStatus }): RunRecord[] | Promise<RunRecord[]>;
  delete?(runId: string): void | Promise<void>;
}
