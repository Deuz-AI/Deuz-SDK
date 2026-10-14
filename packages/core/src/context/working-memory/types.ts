/**
 * Structured working memory (2.4, spec §2.5): what a long task must not lose —
 * its goal and host constraints, the task list and the active task,
 * observations and hypotheses, decisions and open questions, and the paths
 * already tried. A snapshot changes only through schema-checked patches with
 * an expected revision and an operation id; there is no free-form JSON Patch.
 * The host alone sets the goal and constraints and confirms hypotheses and
 * decisions; what a model adds is a proposal, never a verified fact.
 *
 * The critical fields are the goal, the constraints and the active task: the
 * context compiler always places them in the working memory tail, whatever
 * the budget, and selects the other items by priority within the working
 * memory share. Only the host writes the goal and the constraints, so no
 * model write can drop a critical field.
 *
 * The snapshot is plain JSON. The native V3 run checkpoints it (with the task
 * list itself, not only a reference), so the active task survives a restart.
 */
import type { MemorySourceRef } from '../../memory/versioned/types';
import type { TaskList } from '../../plan';

/** Who wrote a field: the host application, or the model through `workingMemoryTools`. */
export type WorkingMemoryWriter = 'host' | 'model';

/** Fields common to every list item. */
export interface WorkingMemoryItemBase {
  /** Stable within its list. */
  id: string;
  text: string;
  /** Who wrote it last. */
  writer: WorkingMemoryWriter;
  /** The snapshot revision that last changed it. */
  revision: number;
  /** What it rests on: messages, tool results, memory records. */
  sources?: MemorySourceRef[];
  /** When it was last changed, epoch ms. */
  at: number;
}

/** The goal the run works towards: host-only. */
export interface WorkingMemoryGoal {
  text: string;
  writer: 'host';
  revision: number;
  at: number;
}

/** A constraint the host sets: host-only, always kept in context. */
export interface WorkingMemoryConstraint extends WorkingMemoryItemBase {
  writer: 'host';
}

/** Something seen while working. */
export type WorkingMemoryObservation = WorkingMemoryItemBase;

/** A hypothesis: `'proposed'` until the host confirms or rejects it. */
export interface WorkingMemoryHypothesis extends WorkingMemoryItemBase {
  status: 'proposed' | 'confirmed' | 'rejected';
}

/** A decision: a model's is `'proposed'` until the host accepts it; the host may revert one. */
export interface WorkingMemoryDecision extends WorkingMemoryItemBase {
  status: 'proposed' | 'accepted' | 'reverted';
  rationale?: string;
}

/** An open question, and its answer once there is one. */
export interface WorkingMemoryQuestion extends WorkingMemoryItemBase {
  status: 'open' | 'answered' | 'dropped';
  answer?: string;
}

/** A path tried, and how it ended. */
export interface WorkingMemoryAttempt extends WorkingMemoryItemBase {
  outcome: 'in-progress' | 'succeeded' | 'failed' | 'abandoned';
  /** Why it failed or was abandoned. */
  detail?: string;
}

/** The task list the run follows, as a versioned copy, and the task it works on. */
export interface WorkingMemoryTasks {
  /** The `TaskList` itself (the planner's record), not a reference to it. */
  list: TaskList;
  /** Plus one whenever `list` is replaced. */
  listRevision: number;
  /** The task the run works on now; a change triggers a context refresh. */
  activeTaskId?: string;
}

/** The lists a patch may add to or remove from. */
export type WorkingMemoryList =
  | 'observations'
  | 'hypotheses'
  | 'decisions'
  | 'questions'
  | 'attempts';

/** A working memory snapshot (2.4), version 1. Plain JSON. */
export interface WorkingMemorySnapshot {
  kind: 'deuz-working-memory';
  version: 1;
  /** 0 when created, plus one on every applied patch. */
  revision: number;
  /** The tenancy scope of the run or goal it belongs to. */
  scope: string;
  /**
   * The supervised goal and the `specGeneration` this snapshot was built
   * under: a supervisor hands a snapshot to a goal's next run only when the
   * scope and the generation match, hypotheses keeping their status.
   */
  goalRef?: { goalId: string; specGeneration?: number };
  goal?: WorkingMemoryGoal;
  constraints: WorkingMemoryConstraint[];
  tasks?: WorkingMemoryTasks;
  observations: WorkingMemoryObservation[];
  hypotheses: WorkingMemoryHypothesis[];
  decisions: WorkingMemoryDecision[];
  questions: WorkingMemoryQuestion[];
  attempts: WorkingMemoryAttempt[];
  /** Operation ids of the last applied patches, oldest first (at most 64): replay dedupe. */
  applied: string[];
  createdAt: number;
  updatedAt: number;
}

/** One change in a patch. Host-only operations are refused for a model writer. */
export type WorkingMemoryOperation =
  /** Host only. */
  | { op: 'set-goal'; text: string }
  /** Host only. */
  | { op: 'add-constraint'; id?: string; text: string; sources?: MemorySourceRef[] }
  /** Host only. */
  | { op: 'remove-constraint'; id: string }
  /** Host only (the planner): replaces the task list copy and bumps `listRevision`. */
  | { op: 'set-tasks'; list: TaskList; activeTaskId?: string }
  | { op: 'set-active-task'; taskId: string | null }
  | { op: 'add-observation'; id?: string; text: string; sources?: MemorySourceRef[] }
  /** A model's hypothesis enters as `'proposed'`. */
  | { op: 'add-hypothesis'; id?: string; text: string; sources?: MemorySourceRef[] }
  /** Host only. */
  | { op: 'set-hypothesis-status'; id: string; status: 'confirmed' | 'rejected' }
  /** A model's decision enters as `'proposed'`, a host's as `'accepted'`. */
  | {
      op: 'add-decision';
      id?: string;
      text: string;
      rationale?: string;
      sources?: MemorySourceRef[];
    }
  /** Host only. */
  | { op: 'set-decision-status'; id: string; status: 'accepted' | 'reverted' }
  | { op: 'add-question'; id?: string; text: string }
  | { op: 'answer-question'; id: string; answer: string }
  | { op: 'drop-question'; id: string }
  | {
      op: 'record-attempt';
      id?: string;
      text: string;
      outcome: WorkingMemoryAttempt['outcome'];
      detail?: string;
      sources?: MemorySourceRef[];
    }
  | {
      op: 'update-attempt';
      id: string;
      outcome: WorkingMemoryAttempt['outcome'];
      detail?: string;
    }
  /** The host may remove any item; a model only items it wrote (`'forbidden'` otherwise). */
  | { op: 'remove'; list: WorkingMemoryList; id: string };

/**
 * A change to a snapshot: applied whole or not at all, only at
 * `expectedRevision`, once per `operationId`.
 */
export interface WorkingMemoryPatch {
  /** The idempotency key; a model tool derives it from its model step and tool call id. */
  operationId: string;
  expectedRevision: number;
  writer: WorkingMemoryWriter;
  operations: WorkingMemoryOperation[];
}

/** Why a patch was refused. */
export type WorkingMemoryRejection =
  /** A host-only operation from the model, or a model removing a host's item. */
  | 'forbidden'
  /** An id the snapshot does not have, or an id that already exists on add. */
  | 'unknown-id'
  | 'duplicate-id'
  /** A malformed operation (empty text, unknown op or list, bad status). */
  | 'invalid';

/** What `applyWorkingMemoryPatch` did; the snapshot is always the one to keep. */
export type WorkingMemoryPatchResult =
  | { status: 'applied'; snapshot: WorkingMemorySnapshot }
  /** The operation id was applied before: nothing changed. */
  | { status: 'duplicate'; snapshot: WorkingMemorySnapshot }
  /** `expectedRevision` is not the snapshot's: nothing changed. */
  | { status: 'conflict'; snapshot: WorkingMemorySnapshot }
  | {
      status: 'rejected';
      snapshot: WorkingMemorySnapshot;
      reason: WorkingMemoryRejection;
      /** The index of the refused operation in `operations`. */
      operation: number;
    };

/** What `createWorkingMemory` starts from. */
export interface CreateWorkingMemoryInput {
  scope: string;
  goal?: string;
  constraints?: readonly string[];
  tasks?: { list: TaskList; activeTaskId?: string };
  goalRef?: { goalId: string; specGeneration?: number };
  /** Creation time, epoch ms (the injected clock). */
  now: number;
}

/** Options of `applyWorkingMemoryPatch`. */
export interface ApplyWorkingMemoryPatchOptions {
  /** The change time, epoch ms (the injected clock). */
  now: number;
  /** Generates ids for added items without one; defaults to `<list>-<revision>-<index>`. */
  generateId?: () => string;
}

/**
 * The working memory a run holds (2.4): the loop's V3 state. A model tool
 * patches it through `apply`; the change becomes durable with the tool's
 * receipt in the same native checkpoint.
 */
export interface WorkingMemoryHandle {
  current(): WorkingMemorySnapshot;
  apply(patch: WorkingMemoryPatch): WorkingMemoryPatchResult | Promise<WorkingMemoryPatchResult>;
}

/** Options of `workingMemoryTools`. */
export interface WorkingMemoryToolsOptions {
  memory: WorkingMemoryHandle;
  /** Tool name prefix. Default `'working_memory'`. */
  prefix?: string;
}
