/**
 * The V3 native run record (2.4, spec §4.1): an explicit
 * `checkpointVersion: 3` path for runs that carry compiled context, working
 * memory and versioned-memory intents. The 2.3 `AgentRunEnvelope` (version
 * 1 | 2), `AgentRunStore` and the closed `AgentEvent` union are unchanged:
 * V3 records live in their own tables with their own schema version table
 * (`deuz_runs_v3_schema`), so a 2.3 process never lists, prunes or resumes
 * one, and a 2.3 reader that meets a V3 envelope refuses it without calling
 * a model or a tool. The same executor runs both paths; a V3 record is never
 * written back as version 1 or 2, terminal and maintenance saves included.
 * Types only: the overloads that take these come from the V3 lane.
 */
import type { ContextBlobRef, ContextCompilerState, ContextManifest } from '../context/types';
import type { CreateContextCompilerOptions, ContextCompiler } from '../context/types';
import type {
  CreateWorkingMemoryInput,
  WorkingMemorySnapshot,
} from '../context/working-memory/types';
import type { Sha256Digest } from '../internal/digest';
import type {
  MemoryExtractionInput,
  MemoryForgetEvent,
  MemorySession,
} from '../memory/versioned/types';
import type {
  AgentEvent,
  AgentRunEnvelope,
  AgentRunListPage,
  AgentRunListQuery,
  AgentRunMemoryExtraction,
  AgentRunMemoryState,
  AgentRunOptions,
  AgentRunReconcileOptions,
  AgentStream,
} from './agent-run';

/**
 * A V3 run's memory extraction (2.4): as in 2.3 plus `'partial'` (H5). The
 * planned mutation count is written before any write; a pass that applied
 * fewer ends `'partial'` and is reported to the host.
 */
export interface AgentRunMemoryExtractionV3 extends Omit<AgentRunMemoryExtraction, 'status'> {
  status: 'pending' | 'completed' | 'partial' | 'failed';
  /** Mutations the pass planned, written before the first one. */
  planned?: number;
}

/** A V3 run's memory state: the 2.3 shape with the V3 extraction. */
export interface AgentRunMemoryStateV3 extends Omit<AgentRunMemoryState, 'extraction'> {
  extraction?: AgentRunMemoryExtractionV3;
}

/**
 * One versioned-memory write of a run (2.4, spec §4.1 protocol): a durable
 * intent, the prepared plan, the atomic memory commit with its receipt, then
 * the run's acknowledgment. The memory session prepares the plan and commits
 * it in one call, so the run record never holds the plan itself: a versioned
 * extraction saves only its claim on the intent (`planned`, with the message
 * ids it cites) before that call,
 * and a model tool's write moves with its tool receipt (`intended`,
 * `committed`, `acknowledged`). There is no transaction across the two
 * databases: when the acknowledgment is lost after the commit, the receipt is
 * read back by `operationId`; a change already applied is never applied
 * again, even if the model call before it repeats.
 */
export interface AgentRunMemoryIntentV3 {
  operationId: string;
  status: 'intended' | 'planned' | 'committed' | 'acknowledged';
  /**
   * The digest of the memory operation's request (the receipt's
   * `requestDigest`: the canonical JSON of what was asked, not of the plan),
   * copied from the receipt with a versioned extraction's acknowledgment.
   */
  requestDigest?: Sha256Digest;
  /** The mutations the commit applied (the receipt's entries), copied with the acknowledgment. */
  planned?: number;
  /**
   * The ids of the messages a versioned extraction reads, in order (2.4): the
   * ids the chat projection gives them (`<runId>:<index>`, or a stored chat's
   * own id for an input message it continues), so the memory sources it
   * writes resolve through the transcript index. Saved with its claim
   * (`planned`), so a replay cites the same ones.
   */
  messageIds?: string[];
  /** The memory receipt, once committed. */
  receipt?: { scopeRevision: number; committedAt: number };
  /** The tool call that asked for it, when a model tool did. */
  modelStep?: number;
  toolCallId?: string;
  /**
   * The extraction options of the run's versioned extraction (2.4), kept with
   * its intent so a later `reconcileAgentRun` asks the session for exactly the
   * same operation. Absent for a model tool's write.
   */
  extraction?: Omit<MemoryExtractionInput, 'messages'>;
}

/** The compiled context of one model step: its manifest and its package blob. */
export interface AgentRunContextStepV3 {
  step: number;
  manifest: ContextManifest;
  /** The content-addressed package; written once, reused when unchanged. */
  blob: ContextBlobRef;
  /**
   * The digest of the messages the step was compiled for (2.4). A step whose
   * answer was never saved is reopened with the same messages after a
   * restart, and then uses this package again instead of compiling anew.
   */
  input?: string;
  /**
   * The step's first package and the messages it was compiled for, kept when
   * an overflow retry replaced the package (2.4). The loop's compaction
   * during the step is never checkpointed, so a step reopened after a crash
   * during its retry starts again from these messages: it sends this package
   * again, and its retry the recorded one when the compaction gives the same
   * messages again (`input`).
   */
  firstAttempt?: { manifest: ContextManifest; blob: ContextBlobRef; input: string };
}

/** A V3 run's context state: the compiler's state and every step's package reference. */
export interface AgentRunContextStateV3 {
  compiler?: ContextCompilerState;
  steps: AgentRunContextStepV3[];
}

/**
 * The V3 run envelope (2.4). Everything of the 2.3 envelope, version 3, plus
 * the context, the working memory (with the task list itself, so the active
 * task survives a restart) and the memory intents.
 */
export interface AgentRunEnvelopeV3 extends Omit<AgentRunEnvelope, 'version' | 'memory'> {
  version: 3;
  memory?: AgentRunMemoryStateV3;
  context?: AgentRunContextStateV3;
  workingMemory?: WorkingMemorySnapshot;
  memoryIntents?: AgentRunMemoryIntentV3[];
}

/** Reading a context package blob. */
export type ContextBlobRead =
  | { status: 'found'; content: string }
  /** A `forget` redacted it: compile the step's context again. */
  | { status: 'redacted' }
  | { status: 'missing' };

/**
 * Where V3 runs live (2.4): in-memory in `/agent`, SQLite and PostgreSQL in
 * `/ops/sqlite` and `/ops/postgres` (separate tables). Redis has no V3 store
 * in 2.4: a Redis `AgentRunStore` with `checkpointVersion: 3` is refused at
 * configuration time with `UnsupportedStoreError`.
 */
export interface AgentRunStoreV3 {
  /** Marks a V3 store, so a 2.3 store passed for V3 is refused before any write. */
  readonly checkpointVersion: 3;
  load(runId: string): Promise<AgentRunEnvelopeV3 | undefined>;
  /**
   * Commits durably before resolving, only at the stored revision plus one
   * (`RevisionConflictError`, subsystem `'run'`, otherwise). Refuses an
   * envelope whose version is not 3. A run whose package blobs a forget
   * redacted is stored with those packages' retrieval blocks that hold a
   * forgotten record replaced by content-free stand-ins that keep the
   * block's marker.
   */
  save(envelope: AgentRunEnvelopeV3): Promise<void>;
  /** Runs, newest save first, as `AgentRunStore.list`. */
  list(query?: AgentRunListQuery): Promise<AgentRunListPage>;
  /**
   * Stores a context package blob once by digest (idempotent), indexed by
   * the memory records and revisions it contains, so a forget finds it.
   * Rejects content whose digest is not `blob.digest`.
   */
  putBlob(blob: {
    digest: Sha256Digest;
    content: string;
    records: readonly { recordId: string; revision?: number }[];
  }): Promise<void>;
  getBlob(digest: Sha256Digest): Promise<ContextBlobRead>;
  /**
   * The `onForget` listener: redacts every package blob that contains one of
   * the forgotten revisions and marks the manifests that point to it
   * `redacted`. Returns how many blobs it redacted. It also replaces, in
   * place (same revision and last-save time), every stored copy of those
   * packages' retrieval blocks in the runs that point to them (history,
   * checkpoints, result messages) with a content-free stand-in that keeps
   * the block's marker, so a resume still drops it and recompiles the step.
   * A block is the exact message the compiler appended, and it is replaced
   * only when its records include a forgotten one: a user's message that
   * opens with a marker, and an overflow retry's block that dropped the
   * forgotten record, stay. A block a run received in its input messages (a
   * previous run's `result.messages`) is not that run's copy and stays.
   */
  redactForgotten(event: MemoryForgetEvent): Promise<number>;
  /** Retention: deletes terminal runs saved before `terminalBefore`, and blobs only they used. */
  prune(options: { terminalBefore: number }): Promise<number>;
  close?(): Promise<void>;
}

/** The session of a V3 run: required, with a V3 store. */
export interface AgentRunSessionV3 {
  store: AgentRunStoreV3;
  runId: string;
  scope: string;
}

/**
 * The options of a V3 run (2.4): those of a 2.3 native run, an explicit
 * `checkpointVersion: 3`, a required V3 session, and the opt-in 2.4 features.
 * With none of them set, the provider request bodies are byte-identical to
 * 2.3's.
 */
export type AgentRunOptionsV3<T = string> = Omit<AgentRunOptions<T>, 'session'> & {
  checkpointVersion: 3;
  session: AgentRunSessionV3;
  /**
   * The context compiler. With memory as one of its sources, the legacy
   * automatic recall (`memory.recall`) is off; configuring both is refused.
   */
  context?: ContextCompiler | CreateContextCompilerOptions;
  /** Working memory: a snapshot to continue, or what to create; `tools` offers the model its tools. */
  workingMemory?: {
    snapshot?: WorkingMemorySnapshot;
    create?: CreateWorkingMemoryInput;
    tools?: boolean;
  };
  /**
   * Versioned memory: writes go through the intent → plan → commit → ack
   * protocol. `tools` offers the model the session's memory tools (remember,
   * recall, revise, retract), each write recorded as an intent with the
   * session's operation id. `extract` (off by default) extracts what the
   * completed run's turns hold into the session after the outcome is durable,
   * under an operation id the terminal commit records first.
   */
  versionedMemory?: {
    session: MemorySession;
    tools?: boolean;
    extract?: boolean | Omit<MemoryExtractionInput, 'messages'>;
  };
};

/** The events of a V3 run: every `AgentEvent`, plus the V3 ones. `AgentEvent` stays closed. */
export type AgentEventV3<T = string> =
  | AgentEvent<T>
  /** A context package was compiled and recorded for a model step. */
  | { type: 'context'; step: number; manifest: ContextManifest }
  /** The working memory changed. */
  | { type: 'working-memory'; revision: number }
  /** A versioned-memory intent moved on. */
  | { type: 'memory-intent'; operationId: string; status: AgentRunMemoryIntentV3['status'] };

/**
 * A V3 run's stream: an `AgentStream`, so every 2.3 consumer
 * (`toDeuzAgentStreamResponse` included) takes it unchanged, plus `eventsV3`
 * with the V3 events.
 */
export interface AgentStreamV3<T = string> extends AgentStream<T> {
  readonly eventsV3: AsyncIterable<AgentEventV3<T>>;
}

/**
 * What `reconcileAgentRun` settles for a V3 run (2.4): the 2.3 options with
 * `checkpointVersion: 3` and the V3 session. With `versionedMemory`, the
 * run's versioned-memory intents whose acknowledgment was lost are settled
 * from the session's receipts (an operation that committed is replayed,
 * never applied again). The answer is the 2.3 `AgentRunReconciliation`; a V3
 * extraction the stored record holds as `'partial'` is reported there as
 * `'failed'` with its `memory-extraction-partial` warning, as for 2.3 runs.
 */
export type AgentRunReconcileOptionsV3 = Omit<AgentRunReconcileOptions, 'session'> & {
  checkpointVersion: 3;
  session: AgentRunSessionV3;
  versionedMemory?: { session: MemorySession };
};
