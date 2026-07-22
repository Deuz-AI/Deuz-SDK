/**
 * `@deuz-sdk/core/runtime` (1.8) — the edge-safe background-run layer:
 *
 * - `RunStore` bookkeeping (`createInMemoryRunStore`, `createRunManager`) that
 *   tracks a long-running autonomous run's status/plan alongside the durable
 *   `SessionStore` checkpoints, so a dashboard can list runs and a worker can
 *   find the ones that need continuing after a crash.
 * - Live-view emitters (`emitPlanUpdate`, `emitActivity`) a tool calls through
 *   `ctx.emitPart` to feed a UI's to-do panel and "Computer" activity feed.
 * - `createSteeringController` — inject a user message into a running loop at
 *   the next step boundary (read it from `prepareStep`): mid-run redirection
 *   and "take over" without stopping the run.
 *
 * Pure Web APIs. The one host-clock fallback (`now`) is injectable and carries
 * a local eslint-disable, matching `simpleCache`/`createApprovalSigner`.
 */
import type { StreamPart, PlanTaskSnapshot } from './types/stream';
import type { RunRecord, RunStatus, RunStore } from './types/runtime';

export type { RunRecord, RunStatus, RunStore } from './types/runtime';

/** Injected time source; defaults to the host clock (documented fallback). */
function hostNow(): number {
  // eslint-disable-next-line no-restricted-syntax -- documented host-clock fallback (see file header)
  return Date.now();
}

// ===================================================================
// RunStore reference + manager
// ===================================================================

/** In-memory `RunStore` reference implementation (single runtime). */
export function createInMemoryRunStore(): Required<RunStore> {
  const runs = new Map<string, RunRecord>();
  return {
    create(record) {
      runs.set(record.runId, { ...record });
    },
    update(runId, patch) {
      const existing = runs.get(runId);
      if (existing) runs.set(runId, { ...existing, ...patch, runId });
    },
    get(runId) {
      return runs.get(runId);
    },
    list(filter) {
      const all = [...runs.values()];
      return filter?.status ? all.filter((r) => r.status === filter.status) : all;
    },
    delete(runId) {
      runs.delete(runId);
    },
  };
}

export interface RunManagerOptions {
  store: RunStore;
  /** Time source (defaults to the host clock). Inject for deterministic tests. */
  now?: () => number;
}

/** Snapshot-friendly plan shape accepted by `setPlan`/`emitPlanUpdate` (a `TaskList` fits). */
export interface PlanSnapshotInput {
  goal?: string;
  tasks: PlanTaskSnapshot[];
}

/** Bookkeeping over a `RunStore`: register runs and transition their status. */
export interface RunManager {
  startRun(input: {
    runId: string;
    goal?: string;
    meta?: Record<string, unknown>;
  }): Promise<RunRecord>;
  getRun(runId: string): Promise<RunRecord | undefined>;
  listRuns(filter?: { status?: RunStatus }): Promise<RunRecord[]>;
  setStatus(
    runId: string,
    status: RunStatus,
    extra?: { error?: string; stepIndex?: number },
  ): Promise<void>;
  setPlan(runId: string, plan: PlanSnapshotInput): Promise<void>;
}

/**
 * Build a `RunManager` over a `RunStore`. Pure bookkeeping — it records status
 * transitions and plan snapshots; driving the model stays with `generateText`/
 * `streamChat` (+ `session`) and continuation with `resumeFromCheckpoint`.
 */
export function createRunManager(options: RunManagerOptions): RunManager {
  const now = options.now ?? hostNow;
  const store = options.store;
  return {
    async startRun(input) {
      const t = now();
      const record: RunRecord = {
        runId: input.runId,
        status: 'running',
        ...(input.goal !== undefined ? { goal: input.goal } : {}),
        ...(input.meta !== undefined ? { meta: input.meta } : {}),
        createdAt: t,
        updatedAt: t,
      };
      await store.create(record);
      return record;
    },
    async getRun(runId) {
      return store.get(runId);
    },
    async listRuns(filter) {
      return store.list(filter);
    },
    async setStatus(runId, status, extra) {
      await store.update(runId, {
        status,
        updatedAt: now(),
        ...(extra?.error !== undefined ? { error: extra.error } : {}),
        ...(extra?.stepIndex !== undefined ? { stepIndex: extra.stepIndex } : {}),
      });
    },
    async setPlan(runId, plan) {
      await store.update(runId, {
        plan: { ...(plan.goal !== undefined ? { goal: plan.goal } : {}), tasks: plan.tasks },
        updatedAt: now(),
      });
    },
  };
}

// ===================================================================
// Live-view emitters (feed a UI's plan panel + activity feed)
// ===================================================================

/** A part sink — pass `ctx.emitPart` (present only in a streaming parent). */
export type PartEmitter = ((part: StreamPart) => void) | undefined;

/**
 * Push a live plan snapshot onto the stream (rendered as a to-do panel). A
 * `TaskList` from `@deuz-sdk/core/autonomy` fits `PlanSnapshotInput` directly.
 * No-op when `emit` is undefined (buffered call — nothing to render live).
 */
export function emitPlanUpdate(emit: PartEmitter, plan: PlanSnapshotInput): void {
  emit?.({
    type: 'plan-update',
    ...(plan.goal !== undefined ? { goal: plan.goal } : {}),
    tasks: plan.tasks,
  });
}

export interface EmitActivityOptions {
  level?: 'info' | 'warn' | 'error';
  data?: unknown;
  agentPath?: string[];
}

/** Push one activity-feed line ("opened page", "ran code", …). No-op without a sink. */
export function emitActivity(
  emit: PartEmitter,
  message: string,
  options: EmitActivityOptions = {},
): void {
  emit?.({
    type: 'activity',
    message,
    ...(options.level !== undefined ? { level: options.level } : {}),
    ...(options.data !== undefined ? { data: options.data } : {}),
    ...(options.agentPath !== undefined ? { agentPath: options.agentPath } : {}),
  });
}

// ===================================================================
// Steering (mid-run user injection)
// ===================================================================

/**
 * A queue for messages to inject into a running loop at the NEXT step boundary.
 * Read it from `prepareStep` and append the drained texts as user turns —
 * mid-run redirection and "take over on a CAPTCHA" without stopping the run.
 *
 * ```ts
 * const steering = createSteeringController();
 * streamChat({
 *   model, messages, tools, maxSteps: 20,
 *   prepareStep: ({ messages }) => {
 *     const injected = steering.drain();
 *     return injected.length
 *       ? { messages: [...messages, ...injected.map((content) => ({ role: 'user' as const, content }))] }
 *       : undefined;
 *   },
 * });
 * // elsewhere: steering.enqueue('actually, focus on the pricing page');
 * ```
 */
export interface SteeringController {
  /** Queue a message to inject at the next step boundary. */
  enqueue(text: string): void;
  /** Take and clear all queued messages (call from `prepareStep`). */
  drain(): string[];
  /** How many messages are queued. */
  readonly pending: number;
}

export function createSteeringController(): SteeringController {
  let queue: string[] = [];
  return {
    enqueue(text) {
      queue.push(text);
    },
    drain() {
      const out = queue;
      queue = [];
      return out;
    },
    get pending() {
      return queue.length;
    },
  };
}
