/**
 * The goal runtime store (2.4, spec §3.1–§3.2): goals, their inbox, the
 * supervisor's runtime state, durable schedules and their cursors, run
 * intents and accounting watermarks, under one transaction boundary. Its
 * method list is frozen in W0: the supervisor (L4b), the durable scheduler
 * (L5) and the store adapters (L4a: in-memory, SQLite, PostgreSQL) all build
 * on exactly these methods.
 *
 * Rules every adapter keeps:
 * - It is a `GoalStore` (the 2.3 conformance fixture passes against it) with
 *   a scope-checked `load`. `goalId` stays globally unique; every other read
 *   and write takes the tenancy `scope` and never crosses it.
 * - Fencing is revision compare-and-set, as for native runs: a lease token
 *   alone never authorizes a write.
 * - A method that writes several things writes all of them or none, durably,
 *   before it resolves. A refused write changes nothing.
 * - Nothing is deleted in the background: retention is the `prune*` calls.
 * - New tables with their own schema version table (`deuz_goal_runtime_schema`);
 *   no existing schema version changes.
 */
import type { Sha256Digest } from '../../internal/digest';
import type { ScheduleCatchUp } from '../../schedule/scheduler';
import type { AgentResult } from '../../types/agent-run';
import type { ToolApprovalResponse } from '../../types/tool';
import type { WorkingMemorySnapshot } from '../../context/working-memory/types';
import type { GoalEvent, GoalListPage, GoalListQuery, GoalRecord, GoalStore } from '../types';

// ===================================================================
// Runtime state and policy
// ===================================================================

/** The supervisor's limits for one goal; only a revision-checked `updatePolicy` changes them. */
export interface GoalRuntimePolicy {
  /** Automatic new runs per goal. Default 10. */
  maxRuns: number;
  /** Retries of a failure the native run marks retryable. Default 3. */
  maxRetries: number;
  /** Waits before each retry, in ms. Default `[1000, 5000, 30000]`. */
  retryDelaysMs: number[];
  /** How long an applied or disposed inbox payload is kept before its tombstone. Default 7 days. */
  retainPayloadMs: number;
}

/** Where the supervisor stands with a goal. */
export type GoalRuntimePhase =
  /** Nothing to do until an event, a wakeup or a command. */
  | 'idle'
  /** A run intent is recorded and about to start. */
  | 'dispatching'
  /** A native run works on the goal. */
  | 'running'
  /** A failed run waits for its retry time. */
  | 'retrying'
  /** A drain was sent; the run stops at its next safe checkpoint. */
  | 'draining'
  /** The goal is terminal (completed, failed or cancelled). */
  | 'done';

/** The run the supervisor drives for a goal now. */
export interface GoalActiveRun {
  intentId: string;
  runId: string;
  /** 1 for the first run of an intent, plus one per retry. */
  attempt: number;
  startedAt: number;
}

/**
 * The supervisor's durable view of one goal (2.4). A cancel request and its
 * application are separate: a cancel is recorded first and applied at the
 * run's next claim, so a cancel for an idle run (whose lease `signal()`
 * returns false) or one before the first native checkpoint is never lost.
 */
export interface GoalRuntimeState {
  goalId: string;
  scope: string;
  /** 1 when created, plus one on every save: the compare-and-set fence. */
  revision: number;
  policy: GoalRuntimePolicy;
  phase: GoalRuntimePhase;
  activeRun?: GoalActiveRun;
  /** Automatic runs started so far (against `policy.maxRuns`). */
  runs: number;
  /** Retries of the current intent so far (against `policy.maxRetries`). */
  retries: number;
  /** When the next retry may start, epoch ms. */
  retryAt?: number;
  cancel?: { requestedAt: number; reason?: string; appliedAt?: number };
  /**
   * Optional work after the goal's verdict (memory extraction): shown apart,
   * a verified goal completes without waiting for it.
   */
  maintenance?: { status: 'pending' | 'complete' | 'failed'; runId?: string };
  /**
   * The last working memory, handed to the goal's next run only when its
   * scope and `specGeneration` match the goal's; hypotheses keep their status.
   */
  workingMemory?: WorkingMemorySnapshot;
  createdAt: number;
  updatedAt: number;
}

// ===================================================================
// Inbox
// ===================================================================

/**
 * What became of an inbox entry. `'pending'` until applied, also while its
 * `notBefore` lies ahead (an early event is never re-dated to fit a later
 * wait). The others are final: applied, or disposed with an explicit reason.
 */
export type GoalInboxDisposition =
  | 'pending'
  | 'applied'
  /** The goal had already applied an event under its key. */
  | 'duplicate'
  | 'unmatched'
  | 'stale'
  | 'expired'
  /** The goal was already terminal. */
  | 'terminal'
  /** A cancelled schedule ended it before it was applied. */
  | 'cancelled';

/** A delivery to queue for a goal. */
export interface GoalInboxEnqueue {
  scope: string;
  goalId: string;
  /**
   * The dedupe namespace: `schedule:<scheduleId>`, `webhook:<endpoint>[:<account>]`
   * or a host's own. With `scope` and `deliveryId` it forms the entry id.
   */
  namespace: string;
  /** Unique within the namespace: an occurrence id, a webhook delivery id. */
  deliveryId: string;
  event: GoalEvent;
  /** The raw payload, kept until its retention passes (then a content-free tombstone). */
  payload?: { body: string; mediaType?: string };
  /**
   * Canonical-JSON `sha256:<hex>` of the delivery's target and content (goal,
   * event without its timestamps, payload digest): the same entry id with
   * another digest is a conflict.
   */
  digest: Sha256Digest;
}

/** A queued delivery (2.4). Ids outlive their payloads: dedupe never expires by default. */
export interface GoalInboxEntry extends Omit<GoalInboxEnqueue, 'payload'> {
  /** `goalInboxKey(scope, namespace, deliveryId)`. */
  id: string;
  disposition: GoalInboxDisposition;
  payload?: { body: string; mediaType?: string };
  /** The payload was dropped by retention; the entry stays as a tombstone. */
  payloadPruned?: boolean;
  enqueuedAt: number;
  /** When it was applied or disposed. */
  settledAt?: number;
  /** The goal revision its application wrote. */
  goalRevision?: number;
  /** The run intent its application recorded. */
  intentId?: string;
}

/** What an enqueue did. */
export type GoalInboxEnqueueResult =
  /** Queued now: a webhook answers 202 only after this. */
  | { status: 'enqueued'; entry: GoalInboxEntry }
  /** Queued before with the same digest: a webhook answers 200. */
  | { status: 'duplicate'; entry: GoalInboxEntry }
  /** Queued before with another digest: nothing written, a webhook answers 409. */
  | { status: 'conflict'; entry: GoalInboxEntry };

/**
 * Settling one inbox entry (2.4): its disposition, the goal `transitionGoal`
 * produced, the runtime state and a run intent, in one transaction. Each part
 * is checked: the goal at the stored revision plus one, the runtime state at
 * the stored revision plus one, the entry still `'pending'`, the intent id
 * new.
 */
export interface GoalInboxApplication {
  scope: string;
  goalId: string;
  entryId: string;
  disposition: Exclude<GoalInboxDisposition, 'pending'>;
  /** The goal after the transition, when it changed. */
  goal?: GoalRecord;
  runtime?: GoalRuntimeState;
  intent?: GoalRunIntentInput;
}

/** Which inbox entries to list. */
export interface GoalInboxQuery {
  scope: string;
  goalId?: string;
  /** Default: `['pending']`. */
  dispositions?: readonly GoalInboxDisposition[];
  /** Only pending entries whose `notBefore` is absent or at or before this time. */
  dueBy?: number;
  /** 1..1000. Default 100. Oldest first. */
  limit?: number;
  cursor?: string;
}

/** A page of inbox entries, oldest first. */
export interface GoalInboxPage {
  entries: GoalInboxEntry[];
  cursor?: string;
}

// ===================================================================
// Durable schedules
// ===================================================================

/** A local time a DST change skips: run once at the first valid instant after it, or skip it. */
export type ScheduleDstGap = 'shift' | 'skip';

/** A local time a DST change repeats: run once (the first), or at both instants. */
export type ScheduleDstOverlap = 'first' | 'both';

/**
 * When a durable schedule fires (2.4): five-field cron in an IANA time zone,
 * evaluated with `Intl` and no dependency (edge-safe).
 */
export interface ScheduleSpec {
  cron: string;
  /** IANA time zone. Default `'UTC'`. */
  timezone?: string;
  /** Default `'shift'`: a daily 02:30 job still runs on the day the clock skips 02:30. */
  dstGap?: ScheduleDstGap;
  /** Default `'first'`: a fixed-time job runs once; `'both'` delivers two occurrences with distinct UTC ids. */
  dstOverlap?: ScheduleDstOverlap;
  /** Default `'latest'`; `'all'` and `'none'` are supported. */
  catchUp?: ScheduleCatchUp;
}

/** What a schedule delivers with each occurrence. */
export interface DurableScheduleEvent {
  /** The wait the occurrence answers (`GoalEvent.correlationId`). */
  correlationId?: string;
  /** The event expires this long after its occurrence. */
  expiresAfterMs?: number;
}

/** A durable schedule (2.4): it targets one existing goal and never creates goals. */
export interface DurableSchedule {
  scheduleId: string;
  scope: string;
  goalId: string;
  spec: ScheduleSpec;
  event?: DurableScheduleEvent;
  status: 'active' | 'paused' | 'cancelled';
  /** 1 when created, plus one on every change. */
  revision: number;
  /** A change takes effect from this UTC instant (its explicit transition boundary). */
  effectiveFrom: number;
  /**
   * The schedule cursor, UTC epoch ms: every occurrence at or before it was
   * scanned and delivered or skipped. Advanced only with its deliveries.
   */
  scheduleCursor: number;
  /**
   * An unfinished catch-up scan (`'latest'` delivers nothing until its window
   * is scanned completely): the window end it is scanning towards.
   */
  scanTo?: number;
  createdAt: number;
  updatedAt: number;
}

/** A schedule as the host defines it; the store fills in the rest. */
export interface DurableScheduleInput {
  scheduleId: string;
  scope: string;
  goalId: string;
  spec: ScheduleSpec;
  event?: DurableScheduleEvent;
}

/** One occurrence the scheduler handled. */
export interface ScheduleOccurrenceRecord {
  /** `<scheduleId>@<UTC ms>`: the goal-event key space, distinct per DST repeat. */
  occurrenceId: string;
  scheduleId: string;
  scope: string;
  goalId: string;
  /** The occurrence's UTC instant. */
  at: number;
  /** Delivered to the inbox, or skipped by policy. */
  disposition: 'delivered' | 'skipped';
  reason?: 'dst-gap-skip' | 'catch-up-none' | 'catch-up-latest' | 'paused' | 'cancelled';
  inboxEntryId?: string;
  recordedAt: number;
}

/**
 * Advancing a schedule's cursor (2.4): the occurrences in
 * `(fromCursor, toCursor]` are recorded, the delivered ones enqueued in the
 * goal's inbox (deduplicated by occurrence id), and the cursor moved, in one
 * transaction, only if the schedule is still active at `expectedRevision` with
 * its cursor at `fromCursor`.
 */
export interface ScheduleAdvance {
  scope: string;
  scheduleId: string;
  expectedRevision: number;
  fromCursor: number;
  toCursor: number;
  /** The unfinished scan's end after this step, or undefined once complete. */
  scanTo?: number;
  occurrences: (Omit<ScheduleOccurrenceRecord, 'recordedAt' | 'inboxEntryId'> & {
    /** The inbox delivery of a `'delivered'` occurrence. */
    delivery?: GoalInboxEnqueue;
  })[];
}

/** What an advance did. */
export type ScheduleAdvanceResult =
  | { status: 'advanced'; schedule: DurableSchedule; enqueued: number; duplicates: number }
  /** The revision or cursor moved, or the schedule is no longer active: nothing written. */
  | { status: 'conflict'; schedule?: DurableSchedule };

/** Which occurrence records to list (2.4). */
export interface ScheduleOccurrenceQuery {
  scope: string;
  scheduleId?: string;
  /** 1..1000. Default 100. Oldest occurrence first. */
  limit?: number;
  cursor?: string;
}

/** A page of occurrence records, by occurrence time, then occurrence id. */
export interface ScheduleOccurrencePage {
  occurrences: ScheduleOccurrenceRecord[];
  cursor?: string;
}

/** Which schedules to list. */
export interface DurableScheduleQuery {
  scope?: string;
  goalId?: string;
  statuses?: readonly DurableSchedule['status'][];
  /** 1..1000. Default 100. */
  limit?: number;
  cursor?: string;
}

/** A page of schedules, by schedule id. */
export interface DurableSchedulePage {
  schedules: DurableSchedule[];
  cursor?: string;
}

// ===================================================================
// Run intents
// ===================================================================

/**
 * A durable intent to start or resume a native run for a goal (2.4), recorded
 * before the run is launched, so a crash in between is recovered, never
 * repeated blindly.
 */
export interface GoalRunIntentInput {
  /** Unique per intent, e.g. `<goalId>#<goal revision>`. */
  intentId: string;
  scope: string;
  goalId: string;
  kind: 'start' | 'resume' | 'retry';
  /** The V3 run to start or resume. */
  runId: string;
  attempt: number;
  /** Not to be launched before this time (a retry's wait). */
  notBefore?: number;
  /** What caused it. */
  cause?: { inboxEntryId?: string; command?: string };
  /** Stored approval verdicts a retry passes back as `approvalResponses`. */
  approvalResponses?: ToolApprovalResponse[];
}

/** A recorded intent and where it stands. */
export interface GoalRunIntent extends GoalRunIntentInput {
  status: 'pending' | 'claimed' | 'launched' | 'completed' | 'failed' | 'cancelled';
  /** 1 when recorded, plus one on every change. */
  revision: number;
  /** The executor that claimed it, with the lease token it held then. */
  claim?: { owner: string; token: number; at: number };
  outcome?: {
    status: AgentResult['status'];
    reason?: string;
    error?: { name: string; message: string; code?: string };
  };
  recordedAt: number;
  updatedAt: number;
}

/** Which intents to list. */
export interface GoalRunIntentQuery {
  scope?: string;
  goalId?: string;
  /** Default: `['pending', 'claimed', 'launched']` (the ones to recover). */
  statuses?: readonly GoalRunIntent['status'][];
  /** 1..1000. Default 100. Oldest first. */
  limit?: number;
  cursor?: string;
}

/** A page of intents, oldest first. */
export interface GoalRunIntentPage {
  intents: GoalRunIntent[];
  cursor?: string;
}

// ===================================================================
// Accounting watermarks
// ===================================================================

/**
 * How much of one run's durable ledger is already charged to its goal (2.4):
 * the supervisor charges ledger differences above the watermark exactly
 * once, never trusting only `AgentResult.accounting`. Uncertain amounts stay
 * held as reservations; a late charge raises `spent` but never reopens a
 * completed goal.
 */
export interface GoalLedgerWatermark {
  scope: string;
  goalId: string;
  runId: string;
  tokens: number;
  usd: number;
  reservedTokens: number;
  reservedUsd: number;
  /** 1 when first written, plus one on every advance. */
  revision: number;
  updatedAt: number;
}

/** Advancing a watermark together with the goal charge it produced. */
export interface GoalWatermarkAdvance {
  scope: string;
  goalId: string;
  runId: string;
  /** The stored watermark's revision; 0 for the first advance. */
  expectedRevision: number;
  next: Pick<GoalLedgerWatermark, 'tokens' | 'usd' | 'reservedTokens' | 'reservedUsd'>;
  /** The goal after the `charge` command, saved at the stored revision plus one. */
  goal: GoalRecord;
}

// ===================================================================
// Results and retention
// ===================================================================

/** What a checked write did. */
export type GoalRuntimeCommitResult =
  | { status: 'committed' }
  /** One check failed: nothing written. Re-read and decide again. */
  | {
      status: 'conflict';
      reason:
        | 'goal-revision'
        | 'runtime-revision'
        | 'entry-settled'
        | 'intent-exists'
        | 'intent-revision'
        | 'watermark-revision'
        | 'scope-mismatch';
    };

/** Retention options; times are epoch ms on the store's clock. */
export interface GoalRuntimePruneOptions {
  /** Delete before this time. */
  before: number;
  scope?: string;
}

// ===================================================================
// The store
// ===================================================================

/** The goal runtime store (2.4): a `GoalStore` plus the supervisor's and scheduler's state. */
export interface GoalRuntimeStore extends GoalStore {
  /**
   * The goal, or undefined. With `scope`, a goal of another scope reads as
   * undefined too (its existence is not disclosed).
   */
  load(goalId: string, options?: { scope?: string }): Promise<GoalRecord | undefined>;
  /** Commits only at the stored revision plus one (1 for a new goal), else `revision_conflict`. */
  save(record: GoalRecord): Promise<void>;
  list(query?: GoalListQuery): Promise<GoalListPage>;

  runtime: {
    get(scope: string, goalId: string): Promise<GoalRuntimeState | undefined>;
    /**
     * Saves at the stored revision plus one (1 for a new state). With `goal`,
     * also saves the goal at its stored revision plus one, in the same
     * transaction (a command, `updatePolicy`, a cancel request).
     */
    save(state: GoalRuntimeState, goal?: GoalRecord): Promise<GoalRuntimeCommitResult>;
  };

  inbox: {
    /** Queues a delivery once per entry id; see `GoalInboxEnqueueResult`. */
    enqueue(delivery: GoalInboxEnqueue): Promise<GoalInboxEnqueueResult>;
    /** Settles an entry with its goal, runtime state and intent, atomically. */
    apply(application: GoalInboxApplication): Promise<GoalRuntimeCommitResult>;
    get(scope: string, entryId: string): Promise<GoalInboxEntry | undefined>;
    list(query: GoalInboxQuery): Promise<GoalInboxPage>;
  };

  schedules: {
    /** Creates (revision 1) or changes a schedule at `expectedRevision`; a change sets `effectiveFrom`. */
    put(
      schedule: DurableScheduleInput,
      options: { expectedRevision: number; effectiveFrom: number },
    ): Promise<{ status: 'committed'; schedule: DurableSchedule } | { status: 'conflict' }>;
    get(scope: string, scheduleId: string): Promise<DurableSchedule | undefined>;
    list(query?: DurableScheduleQuery): Promise<DurableSchedulePage>;
    /** Stops new scans; pending deliveries already in the inbox stay. */
    pause(
      scope: string,
      scheduleId: string,
      options: { expectedRevision: number },
    ): Promise<{ status: 'committed'; schedule: DurableSchedule } | { status: 'conflict' }>;
    resume(
      scope: string,
      scheduleId: string,
      options: { expectedRevision: number; effectiveFrom: number },
    ): Promise<{ status: 'committed'; schedule: DurableSchedule } | { status: 'conflict' }>;
    /** Ends the schedule and disposes its still-pending deliveries as `'cancelled'`. */
    cancel(
      scope: string,
      scheduleId: string,
      options: { expectedRevision: number },
    ): Promise<{ status: 'committed'; schedule: DurableSchedule } | { status: 'conflict' }>;
    /** Moves the cursor and commits the occurrences into the inbox atomically. */
    advance(advance: ScheduleAdvance): Promise<ScheduleAdvanceResult>;
    /**
     * The occurrence records the scheduler wrote, oldest occurrence first. Optional in
     * the interface; the in-memory, SQLite and PostgreSQL stores all have it.
     */
    occurrences?(query: ScheduleOccurrenceQuery): Promise<ScheduleOccurrencePage>;
  };

  intents: {
    /**
     * Records a new intent (`'intent-exists'` for a known id). With `runtime`
     * (and `goal`), saves them in the same transaction at their stored
     * revisions plus one, so a supervisor whose view is stale cannot record a
     * retry or a command's run (the second argument is a 2.4 addition).
     */
    record(
      intent: GoalRunIntentInput,
      options?: { runtime?: GoalRuntimeState; goal?: GoalRecord },
    ): Promise<GoalRuntimeCommitResult>;
    get(scope: string, intentId: string): Promise<GoalRunIntent | undefined>;
    /**
     * Claims a pending intent (or one claimed under a lower token) for an
     * executor at `expectedRevision`; a fresh claim with a higher token fences
     * the old executor out of `launched` and `complete`.
     */
    claim(
      scope: string,
      intentId: string,
      claim: { owner: string; token: number; expectedRevision: number },
    ): Promise<{ status: 'committed'; intent: GoalRunIntent } | { status: 'conflict' }>;
    /** Marks the run launched (its first native checkpoint exists). */
    launched(
      scope: string,
      intentId: string,
      options: { token: number; expectedRevision: number },
    ): Promise<GoalRuntimeCommitResult>;
    /**
     * Records the run's outcome. With `runtime` (and `goal`), saves them in the
     * same transaction at their stored revisions plus one.
     */
    complete(
      scope: string,
      intentId: string,
      completion: {
        token: number;
        expectedRevision: number;
        status: 'completed' | 'failed' | 'cancelled';
        outcome?: GoalRunIntent['outcome'];
        runtime?: GoalRuntimeState;
        goal?: GoalRecord;
      },
    ): Promise<GoalRuntimeCommitResult>;
    list(query?: GoalRunIntentQuery): Promise<GoalRunIntentPage>;
  };

  watermarks: {
    get(scope: string, goalId: string, runId: string): Promise<GoalLedgerWatermark | undefined>;
    /** Advances the watermark and saves the charged goal, atomically. */
    advance(advance: GoalWatermarkAdvance): Promise<GoalRuntimeCommitResult>;
  };

  /**
   * Replaces the payloads of entries settled before `before` with content-free
   * tombstones (`payloadPruned`); ids stay, so dedupe holds. Returns how many.
   */
  prunePayloads(options: GoalRuntimePruneOptions): Promise<number>;
  /**
   * Deletes settled inbox entries before `before`, ids included: a delivery
   * repeated after that is queued again. Only when the host sets a dedupe
   * window. Returns how many.
   */
  pruneInbox(options: GoalRuntimePruneOptions): Promise<number>;
  /** Deletes occurrence records before `before` (`pruneOccurrences({ olderThan })`). */
  pruneOccurrences(options: GoalRuntimePruneOptions): Promise<number>;
  /** Deletes completed, failed and cancelled intents updated before `before`. */
  pruneIntents(options: GoalRuntimePruneOptions): Promise<number>;
  /** Releases a connection the store opened itself; a borrowed one stays open. */
  close?(): Promise<void>;
}
