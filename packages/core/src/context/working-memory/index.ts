/**
 * Working memory (2.4, spec §2.5): `createWorkingMemory`,
 * `applyWorkingMemoryPatch` and `workingMemoryTools`. Pure and edge-safe;
 * published from `@deuz-sdk/core/context`.
 */
import type { AgentToolSet } from '../../types/agent-run';
import { notImplemented } from '../../internal/not-implemented';
import type {
  ApplyWorkingMemoryPatchOptions,
  CreateWorkingMemoryInput,
  WorkingMemoryPatch,
  WorkingMemoryPatchResult,
  WorkingMemorySnapshot,
  WorkingMemoryToolsOptions,
} from './types';

export type * from './types';

/**
 * A new snapshot at revision 0 (2.4): the host's goal and constraints (writer
 * `'host'`), the task list copy (`listRevision` 1) and its active task, empty
 * lists otherwise. Pure.
 */
export function createWorkingMemory(_input: CreateWorkingMemoryInput): WorkingMemorySnapshot {
  return notImplemented('createWorkingMemory');
}

/**
 * Applies a patch (2.4), pure and deterministic, never mutating `snapshot`:
 *
 * - an `operationId` in `snapshot.applied` returns `'duplicate'`;
 * - an `expectedRevision` other than `snapshot.revision` returns `'conflict'`;
 * - every operation is checked first; the first refused one returns
 *   `'rejected'` with its index and reason (a host-only operation from the
 *   model is `'forbidden'`), and nothing is applied;
 * - otherwise all operations apply in order, the revision goes up by one, the
 *   operation id joins `applied` (the oldest dropped past 64), and each
 *   changed item records the writer, the new revision and `options.now`.
 *
 * A model's hypothesis or decision enters as `'proposed'` and only a host
 * operation changes that status.
 */
export function applyWorkingMemoryPatch(
  _snapshot: WorkingMemorySnapshot,
  _patch: WorkingMemoryPatch,
  _options: ApplyWorkingMemoryPatchOptions,
): WorkingMemoryPatchResult {
  return notImplemented('applyWorkingMemoryPatch');
}

/**
 * The model's working-memory tools (2.4): read the snapshot, add
 * observations, hypotheses, decision proposals, questions and attempts, and
 * update its own items. Every write is a patch with writer `'model'` and an
 * operation id from the model step and tool call id (a replayed call is a
 * `'duplicate'`); a refusal is returned to the model as a tool error. The
 * tools never persist anything themselves: the run's checkpoint does.
 */
export function workingMemoryTools(_options: WorkingMemoryToolsOptions): AgentToolSet {
  return notImplemented('workingMemoryTools');
}
