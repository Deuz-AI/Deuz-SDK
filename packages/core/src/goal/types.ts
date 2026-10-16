/**
 * Goal, wakeup and event contracts (2.3, roadmap 23.6): plain, versioned JSON
 * a host persists and moves forward with pure transitions. Nothing here runs a
 * model, a timer or a service. The 2.4 goal runtime (`@deuz-sdk/core/goal/runtime`:
 * the supervisor, the durable scheduler and the webhook handler) builds on these
 * records.
 */

/** Where a goal stands. A goal no model call works on is never done by that alone. */
export type GoalStatus = 'active' | 'waiting' | 'completed' | 'failed' | 'cancelled';

/**
 * Why a waiting goal makes no progress: a person, an outside event, other
 * goals or runs, a time, or a spent budget (which only a revision raising the
 * budget, or a cancel, ends). A budget wait keeps the wait it interrupted,
 * and a raised budget puts that one back.
 */
export type GoalWaitReason = 'user' | 'event' | 'dependency' | 'wakeup' | 'budget';

/** The kinds of senders a goal event can have. */
export type GoalEventSourceType =
  | 'schedule'
  | 'signal'
  | 'user'
  | 'run'
  | 'goal'
  | 'wakeup'
  | 'custom';

/** Who sent an event: a schedule's ID, a webhook's name, a run or goal ID. */
export interface GoalEventSource {
  type: GoalEventSourceType;
  id?: string;
}

/** A goal or native run another goal waits for. */
export interface GoalDependency {
  kind: 'goal' | 'run';
  id: string;
  /** Set once an event from it arrived, or by the wait request when it already finished. */
  settled?: boolean;
}

interface GoalWaitBase {
  /**
   * This wait's identity. An event that answers it carries it as
   * `correlationId`; one answering an earlier wait is stale.
   */
  id: string;
  /**
   * When the goal began waiting, epoch ms. An event older than this cannot end
   * the wait, except one reporting a dependency: a completion is a state.
   */
  since: number;
  /** What the goal waits for, for people. */
  note?: string;
}

/** An explicit reason a goal is waiting (2.3). Present exactly while `status` is `'waiting'`. */
export type GoalWaiting =
  | (GoalWaitBase & { reason: 'user' })
  | (GoalWaitBase & {
      reason: 'event';
      /** The events that end the wait: this source type, and this source ID when set. */
      source: GoalEventSource;
    })
  | (GoalWaitBase & { reason: 'dependency'; on: GoalDependency[] })
  | (GoalWaitBase & {
      reason: 'wakeup';
      /** The next wakeup, epoch ms: a `tick` at or after it, or an event dated then. */
      at: number;
      /** Only this schedule's occurrences wake the goal. */
      schedule?: string;
    })
  | (GoalWaitBase & {
      reason: 'budget';
      /** The limit that ran out. */
      limit: 'usd' | 'tokens';
      /**
       * The wait the spent budget interrupted, as it was: a raised budget puts
       * it back, `id` and `since` included. Events that answer it still apply
       * meanwhile, as does a tick once its wakeup is due, and what ends it
       * removes it.
       */
      interrupted?: Exclude<GoalWaiting, { reason: 'budget' }>;
    });

type WaitRequestOf<W> = W extends GoalWaiting ? Omit<W, 'id' | 'since'> & { id?: string } : never;

/**
 * A wait to enter: `id` defaults to `<goalId>#<revision>`, the revision the
 * wait begins at, and `since` to the transition's time. A budget wait only
 * comes from a `charge`. A dependency wait whose every dependency is
 * `settled` is over as it begins: the goal stays, or becomes, active.
 */
export type GoalWaitRequest = WaitRequestOf<Exclude<GoalWaiting, { reason: 'budget' }>>;

/** One acceptance criterion. */
export interface GoalCriterion {
  id: string;
  /** What must be true, in words. */
  description: string;
  /** Default true: the goal completes only once it passes. An optional one only informs. */
  required?: boolean;
}

/**
 * Where evidence, or a verdict, comes from. `'model'` is the working model's
 * own claim: it never makes a criterion pass on its own.
 */
export type GoalEvidenceSource =
  | 'test'
  | 'artifact'
  | 'human'
  | 'verifier'
  | 'tool'
  | 'external'
  | 'model';

/** The host verifier that produced evidence (2.4): its id and the version of its checks. */
export interface GoalVerifierRef {
  id: string;
  version: string;
}

/**
 * A reference to evidence kept elsewhere: a test report, a file, a review, a
 * run. The 2.4 fields bind it to what it was produced from; each is optional,
 * and a record written by 2.3 carries none of them.
 */
export interface GoalEvidence {
  id: string;
  source: GoalEvidenceSource;
  /** Where it lives: a path, a URL, an artifact or run ID. */
  ref: string;
  /** For example `sha256:<hex>` of the artifact. */
  digest?: string;
  summary?: string;
  /** The native run that produced it. */
  runId?: string;
  /** When it was recorded, epoch ms. */
  at: number;
  /**
   * The criterion it was produced for (2.4). Evidence that names a criterion
   * supports a verdict on that criterion only.
   */
  criterionId?: string;
  /** The host verifier that produced it, and the version of its checks (2.4). */
  verifier?: GoalVerifierRef;
  /**
   * The goal's spec generation it was produced against (2.4). On a goal with
   * a `specGeneration`, only evidence of the current generation supports a
   * pass; evidence recorded without one is stamped with the current one.
   */
  specGeneration?: number;
  /** `sha256:<hex>` of the artifact it was checked against (2.4). */
  artifactDigest?: `sha256:${string}`;
  /** The `deuz-workspace-v1` digest of the workspace it was checked against (2.4). */
  workspaceDigest?: `sha256:${string}`;
}

/** A criterion's verdict. */
export type GoalVerdict = 'passed' | 'failed' | 'inconclusive';

/** The latest verdict on one criterion, and what it rests on. */
export interface GoalCriterionResult {
  criterionId: string;
  verdict: GoalVerdict;
  /** Who or what reached the verdict. */
  source: GoalEvidenceSource;
  /** The evidence it rests on: IDs in the record's `evidence`. */
  evidence: string[];
  note?: string;
  at: number;
}

/** Spending limits for the goal as a whole, across its runs. */
export interface GoalBudget {
  usd?: number;
  tokens?: number;
}

/** What the goal's runs spent, as reported by `charge`. */
export interface GoalSpend {
  usd: number;
  tokens: number;
}

/** How a goal ended. Present exactly once it is terminal. */
export interface GoalOutcome {
  /**
   * `'accepted'`: every required criterion passed on evidence. `'deadline'`:
   * the deadline passed first. `'failed'` and `'cancelled'`: by command.
   */
  reason: 'accepted' | 'deadline' | 'failed' | 'cancelled';
  detail?: string;
  at: number;
}

/**
 * A goal (2.3), version 1. Plain JSON: store it as it is. Every change goes
 * through `transitionGoal`, which returns a new record one revision higher.
 */
export interface GoalRecord {
  kind: 'deuz-goal';
  version: 1;
  goalId: string;
  /** Tenant or workflow scope; events for the goal carry the same. */
  scope: string;
  /** Increases by one on every change: a store saves only the stored revision plus one. */
  revision: number;
  /** The goal this one serves. */
  parentGoalId?: string;
  /** The native run working on the goal, or the last one that did. */
  runId?: string;
  objective: string;
  criteria: GoalCriterion[];
  /** Append-only. */
  evidence: GoalEvidence[];
  /** The latest verdict per criterion. */
  results: GoalCriterionResult[];
  budget?: GoalBudget;
  spent: GoalSpend;
  /** Epoch ms. The first transition at or after it fails the goal. */
  deadline?: number;
  status: GoalStatus;
  waiting?: GoalWaiting;
  outcome?: GoalOutcome;
  /** Dedupe keys of the last events the goal applied, oldest first (at most 64). */
  seen: string[];
  /**
   * Keys of the last charges the goal applied, oldest first (at most 64): a
   * window of their own, so a charge and an event may share a key, such as a
   * run ID. A writer may leave it out when empty.
   */
  charged: string[];
  createdAt: number;
  updatedAt: number;
  /** Application data, JSON. */
  meta?: Record<string, unknown>;
  /**
   * The generation of the goal's spec (2.4), present only on a goal that opted
   * in (`createGoal({ specGeneration })`, a supervisor, or a `revise` with
   * `nextSpecGeneration`). A change of the objective or the criteria, or a
   * `revise` that names a changed host constraint or verifier, starts the next
   * generation, and every verdict reached before it becomes `'inconclusive'`.
   * Without it a goal keeps the 2.3 rules: a `revise` drops only the verdict of
   * a criterion whose text changed, and a new objective keeps the verdicts.
   * Charges, maintenance and every other change leave it, and the evidence, alone.
   */
  specGeneration?: number;
}

/** A reference to an event's payload, kept in your storage rather than in the envelope. */
export interface GoalPayloadRef {
  ref: string;
  /** For example `sha256:<hex>`, as `handleSignal` keys a body. */
  digest?: string;
  mediaType?: string;
  bytes?: number;
}

/**
 * A wakeup or outside event addressed to a goal (2.3), version 1. `key` is its
 * dedupe key, in the same space as a schedule occurrence key (`<id>@<at>`) and
 * a signal key (a delivery ID or `sha256:<hex>` of the body), so one claim
 * dedupes all three.
 */
export interface GoalEvent {
  kind: 'deuz-goal-event';
  version: 1;
  /** This event's identity; defaults to `key`. */
  id: string;
  source: GoalEventSource;
  scope: string;
  goalId: string;
  /** The native run it concerns. */
  runId?: string;
  key: string;
  /** When it happened, epoch ms. */
  at: number;
  /** Not to be applied before this time. */
  notBefore?: number;
  /** Not to be applied at or after this time. */
  expiresAt?: number;
  payload?: GoalPayloadRef;
  /** The wait (or request) this event answers. */
  correlationId?: string;
  /** The event that caused this one. */
  causationId?: string;
}

/** A criterion as given to `createGoal` or `revise`. */
export type GoalCriterionInput = GoalCriterion;

/**
 * Evidence as given to a command; `at` defaults to the transition's time and,
 * on a goal with a `specGeneration`, `specGeneration` to the current one.
 */
export type GoalEvidenceInput = Omit<GoalEvidence, 'at'> & { at?: number };

/** A verdict as given to `evaluate`; `evidence` defaults to none, `at` to the transition's time. */
export type GoalCriterionResultInput = Omit<GoalCriterionResult, 'at' | 'evidence'> & {
  evidence?: string[];
  at?: number;
};

/** What `transitionGoal` applies (2.3): your intent, or an event. */
export type GoalCommand =
  /** Enter a wait (replacing another, unless the budget is spent). */
  | { type: 'wait'; wait: GoalWaitRequest }
  /** End a wait yourself, e.g. when the person answered in your own UI. */
  | { type: 'resume' }
  /** Apply an outside event: it may end the wait, or be dropped with a reason. */
  | { type: 'event'; event: GoalEvent }
  /** Record evidence. */
  | { type: 'evidence'; evidence: GoalEvidenceInput[] }
  /** Record verdicts, and the evidence they rest on. */
  | { type: 'evaluate'; results: GoalCriterionResultInput[]; evidence?: GoalEvidenceInput[] }
  /** Complete the goal: only once every required criterion passed on evidence. */
  | { type: 'complete' }
  | { type: 'fail'; reason: string }
  | { type: 'cancel'; reason?: string }
  /** Add what a run spent; a repeated `key` is a duplicate. */
  | { type: 'charge'; usd?: number; tokens?: number; key?: string }
  /** Change the goal; `null` removes the budget, the deadline or the metadata. */
  | {
      type: 'revise';
      objective?: string;
      criteria?: GoalCriterionInput[];
      budget?: GoalBudget | null;
      deadline?: number | null;
      meta?: Record<string, unknown> | null;
      /**
       * A relevant host constraint or a verifier changed (2.4): start the next
       * spec generation even when the objective and criteria stay the same,
       * which makes every earlier verdict `'inconclusive'`. On a goal without a
       * `specGeneration` this opts it in at generation 1.
       */
      nextSpecGeneration?: boolean;
    }
  /** Name the native run that works on the goal now. */
  | { type: 'link-run'; runId: string }
  /** Apply time alone: a passed deadline, a due wakeup. */
  | { type: 'tick' };

/** Why a transition changed nothing it was asked to. */
export type GoalTransitionReason =
  /** An event or charge whose key the goal already applied. */
  | 'duplicate'
  /** An event answering an earlier wait, or older than the wait (unless it reports a dependency). */
  | 'stale'
  /** An event applied at or after its `expiresAt`. */
  | 'expired'
  /** An event applied before its `notBefore`: deliver it again then. */
  | 'early'
  /** An event the goal does not wait for. */
  | 'unmatched'
  /** The goal already ended. */
  | 'terminal'
  /** Nothing to change. */
  | 'unchanged'
  /** `complete` while a required criterion has not passed on evidence. */
  | 'acceptance-not-passed'
  /** The budget is spent: raise it with `revise`, or cancel. */
  | 'budget-exhausted'
  /** A deadline at or before the transition's time. */
  | 'deadline-passed'
  /** A verdict on a criterion the goal does not have. */
  | 'unknown-criterion'
  /** A verdict resting on evidence the goal does not have. */
  | 'unknown-evidence'
  /** Evidence under an ID the goal holds with other content. */
  | 'evidence-conflict';

/** What `transitionGoal` did. Save `record` when `changed` is true. */
export interface GoalTransition {
  record: GoalRecord;
  changed: boolean;
  /**
   * `'applied'`: the command or event took effect. `'ignored'`: the goal
   * dropped an event, a charge or a no-op. `'rejected'`: the goal refused the
   * command. A passed deadline fails the goal first, so `changed` can be true
   * on any outcome.
   */
  outcome: 'applied' | 'ignored' | 'rejected';
  reason?: GoalTransitionReason;
  /** After `evaluate` and `complete`: where acceptance stands. */
  acceptance?: GoalAcceptance;
}

/** Acceptance of one criterion. */
export interface GoalCriterionAcceptance {
  criterionId: string;
  required: boolean;
  verdict: GoalVerdict;
  /** Who reached the verdict, when there is one. */
  source?: GoalEvidenceSource;
  evidence: string[];
  note?: string;
}

/** Where a goal's acceptance stands (2.3). */
export interface GoalAcceptance {
  /**
   * `'passed'`: every required criterion passed on evidence. `'failed'`: a
   * required criterion failed. Otherwise `'inconclusive'`.
   */
  verdict: GoalVerdict;
  criteria: GoalCriterionAcceptance[];
}

/** Which goals `GoalStore.list` returns. */
export interface GoalListQuery {
  /** Only goals in one of these statuses; an empty list matches none. */
  statuses?: readonly GoalStatus[];
  scope?: string;
  /** 1..1000. Default 100. */
  limit?: number;
  /** The `cursor` of the previous page. */
  cursor?: string;
}

/** A page of goals, newest change first (`updatedAt`, then goal ID, descending). */
export interface GoalListPage {
  goals: GoalRecord[];
  /** Present when more goals follow. */
  cursor?: string;
}

/**
 * Where goal records live (2.3): the host's persistence boundary. A store
 * keeps records by goal ID, returns copies, and commits a save only when its
 * revision is the stored revision plus one (1 for a new goal), durably before
 * it resolves; any other save rejects with a revision conflict and writes
 * nothing. Run the conformance fixture against your own store.
 */
export interface GoalStore {
  load(goalId: string): GoalRecord | undefined | Promise<GoalRecord | undefined>;
  save(record: GoalRecord): void | Promise<void>;
  /** Optional: a page of goals, newest change first. */
  list?(query?: GoalListQuery): Promise<GoalListPage>;
}
