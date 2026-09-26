import { createBudgetLedger, intersectBudgetLimits } from './budget-ledger';
import type {
  BudgetLedger,
  BudgetLimits,
  BudgetScope,
  ExecutionChildOptions,
  ExecutionContextOptions,
  ExecutionContextRestoreOptions,
  ExecutionContextSnapshot,
  ExecutionPolicy,
  NativeExecutionContext,
} from './types/execution';

export type ExecutionPolicyErrorCode =
  | 'invalid_policy'
  | 'invalid_context'
  | 'tool_not_allowed'
  | 'model_not_allowed'
  | 'depth_exceeded'
  | 'deadline_exceeded';

export class ExecutionPolicyError extends Error {
  readonly name = 'ExecutionPolicyError';
  readonly fatalExecution = true;

  constructor(
    readonly code: ExecutionPolicyErrorCode,
    message: string,
  ) {
    super(message);
  }
}

function allowlist(value: readonly string[] | undefined): readonly string[] | undefined {
  if (value === undefined) return undefined;
  if (
    !Array.isArray(value) ||
    value.some((item) => typeof item !== 'string' || item.length === 0)
  ) {
    throw new ExecutionPolicyError('invalid_policy', 'Allowlists must contain nonempty strings.');
  }
  return Object.freeze([...new Set(value)]);
}

function policy(input: ExecutionPolicy = {}): ExecutionPolicy {
  if (input === null || typeof input !== 'object')
    throw new ExecutionPolicyError('invalid_policy', 'Policy must be an object.');
  const allowedTools = allowlist(input.allowedTools);
  const allowedModels = allowlist(input.allowedModels);
  if (
    input.maxDepth !== undefined &&
    (!Number.isSafeInteger(input.maxDepth) || input.maxDepth < 0)
  ) {
    throw new ExecutionPolicyError(
      'invalid_policy',
      'maxDepth must be a nonnegative safe integer.',
    );
  }
  if (
    input.deadlineAt !== undefined &&
    (!Number.isFinite(input.deadlineAt) || input.deadlineAt < 0)
  ) {
    throw new ExecutionPolicyError(
      'invalid_policy',
      'deadlineAt must be a finite nonnegative timestamp.',
    );
  }
  if (input.requireApproval !== undefined && typeof input.requireApproval !== 'boolean') {
    throw new ExecutionPolicyError('invalid_policy', 'requireApproval must be boolean.');
  }
  return Object.freeze({
    ...(allowedTools !== undefined ? { allowedTools } : {}),
    ...(allowedModels !== undefined ? { allowedModels } : {}),
    ...(input.maxDepth !== undefined ? { maxDepth: input.maxDepth } : {}),
    ...(input.requireApproval !== undefined ? { requireApproval: input.requireApproval } : {}),
    ...(input.deadlineAt !== undefined ? { deadlineAt: input.deadlineAt } : {}),
  });
}

/** Intersect mandatory constraints; callers cannot override inherited restrictions. */
export function intersectExecutionPolicies(
  parent: ExecutionPolicy = {},
  child: ExecutionPolicy = {},
): ExecutionPolicy {
  const a = policy(parent);
  const b = policy(child);
  const intersect = (left: readonly string[] | undefined, right: readonly string[] | undefined) =>
    left === undefined
      ? right
      : right === undefined
        ? left
        : left.filter((item) => right.includes(item));
  const min = (left: number | undefined, right: number | undefined) =>
    left === undefined ? right : right === undefined ? left : Math.min(left, right);
  return policy({
    allowedTools: intersect(a.allowedTools, b.allowedTools),
    allowedModels: intersect(a.allowedModels, b.allowedModels),
    maxDepth: min(a.maxDepth, b.maxDepth),
    deadlineAt: min(a.deadlineAt, b.deadlineAt),
    requireApproval:
      a.requireApproval === undefined && b.requireApproval === undefined
        ? undefined
        : a.requireApproval === true || b.requireApproval === true,
  });
}

export interface ExecutionPolicyCheck {
  readonly toolName?: string;
  readonly modelId?: string;
  /** Injected clock value. Required for contexts with an absolute deadline. */
  readonly now?: number;
}

/** Approval must additionally be enforced by the tool approval gate. */
export function assertExecutionPolicy(
  context: NativeExecutionContext,
  check: ExecutionPolicyCheck = {},
): void {
  const constraints = context.policy;
  if (constraints.maxDepth !== undefined && context.depth > constraints.maxDepth) {
    throw new ExecutionPolicyError(
      'depth_exceeded',
      `Execution depth ${context.depth} exceeds ${constraints.maxDepth}.`,
    );
  }
  if (constraints.deadlineAt !== undefined) {
    if (check.now === undefined || !Number.isFinite(check.now)) {
      throw new ExecutionPolicyError(
        'invalid_context',
        'A current clock value is required to enforce the execution deadline.',
      );
    }
    if (check.now >= constraints.deadlineAt)
      throw new ExecutionPolicyError('deadline_exceeded', 'Execution deadline has elapsed.');
  }
  if (
    check.toolName !== undefined &&
    constraints.allowedTools !== undefined &&
    !constraints.allowedTools.includes(check.toolName)
  ) {
    throw new ExecutionPolicyError(
      'tool_not_allowed',
      `Tool is not allowed by execution policy: ${check.toolName}.`,
    );
  }
  if (
    check.modelId !== undefined &&
    constraints.allowedModels !== undefined &&
    !constraints.allowedModels.includes(check.modelId)
  ) {
    throw new ExecutionPolicyError(
      'model_not_allowed',
      `Model is not allowed by execution policy: ${check.modelId}.`,
    );
  }
}

/** The collision-free scope ID of a child context (shared with the swarm scheduler). */
export function childScopeId(parent: string, child: string): string {
  return `${parent}/${encodeURIComponent(child)}`;
}

function scope(id: string, budget: BudgetLimits): BudgetScope {
  if (typeof id !== 'string' || id.length === 0)
    throw new ExecutionPolicyError('invalid_context', 'scopeId must be a nonempty string.');
  return Object.freeze({ id, budget: intersectBudgetLimits(budget) });
}

function context(
  constraints: ExecutionPolicy,
  budget: BudgetLimits,
  depth: number,
  scopes: readonly BudgetScope[],
  ledger: BudgetLedger,
): NativeExecutionContext {
  const scopeId = scopes[scopes.length - 1]!.id;
  const current: NativeExecutionContext = {
    policy: constraints,
    budget,
    depth,
    scopeId,
    ledger,
    child(options: ExecutionChildOptions) {
      // Validate the raw component before encoding it into a collision-free path.
      scope(options.scopeId, {});
      const childPolicy = intersectExecutionPolicies(constraints, options.policy);
      const childDepth = depth + 1;
      if (childPolicy.maxDepth !== undefined && childDepth > childPolicy.maxDepth) {
        throw new ExecutionPolicyError(
          'depth_exceeded',
          `Execution depth ${childDepth} exceeds ${childPolicy.maxDepth}.`,
        );
      }
      const childBudget = intersectBudgetLimits(budget, options.budget);
      const childScope = scope(childScopeId(scopeId, options.scopeId), childBudget);
      return context(
        childPolicy,
        childBudget,
        childDepth,
        Object.freeze([...scopes, childScope]),
        ledger,
      );
    },
    reserve(input) {
      assertExecutionPolicy(current, { modelId: input.modelId, now: input.now });
      return ledger.reserve({ ...input, scopes });
    },
    snapshot(): ExecutionContextSnapshot {
      const saved = ledger.snapshot();
      return Object.freeze({
        // Persistent admission must not be dropped by a 2.1 reader: it refuses version 2.
        version: saved.admission ? 2 : 1,
        policy: constraints,
        budget,
        depth,
        scopeId,
        scopes,
        ledger: saved,
      });
    },
  };
  return Object.freeze(current);
}

/** Create an immutable root context or recover a complete context and its ledger. */
export function createExecutionContext(
  options: ExecutionContextOptions | ExecutionContextRestoreOptions = {},
): NativeExecutionContext {
  const saved = options.snapshot;
  if (saved) {
    if (
      (saved.version !== 1 && saved.version !== 2) ||
      // Version 2 exists only to carry persistent admission, and always does.
      (saved.version === 2) !== (saved.ledger?.admission !== undefined) ||
      !Number.isSafeInteger(saved.depth) ||
      saved.depth < 0 ||
      !Array.isArray(saved.scopes) ||
      saved.scopes.length !== saved.depth + 1 ||
      saved.scopes[saved.depth]?.id !== saved.scopeId
    ) {
      throw new ExecutionPolicyError(
        'invalid_context',
        'Unsupported or malformed execution snapshot.',
      );
    }
    const constraints = intersectExecutionPolicies(saved.policy, options.policy);
    const budget = intersectBudgetLimits(saved.budget, options.budget);
    const scopes = saved.scopes.map((item, index) => {
      if (index > 0 && !item.id.startsWith(`${saved.scopes[index - 1]!.id}/`)) {
        throw new ExecutionPolicyError('invalid_context', 'Invalid execution scope ancestry.');
      }
      return scope(
        item.id,
        index === saved.depth ? intersectBudgetLimits(item.budget, budget) : item.budget,
      );
    });
    const ids = new Set(scopes.map((item) => item.id));
    if (ids.size !== scopes.length)
      throw new ExecutionPolicyError('invalid_context', 'Duplicate execution scope IDs.');
    if (constraints.maxDepth !== undefined && saved.depth > constraints.maxDepth) {
      throw new ExecutionPolicyError(
        'depth_exceeded',
        'Recovered context exceeds its execution depth limit.',
      );
    }
    const ledger = createBudgetLedger({
      snapshot: saved.ledger,
      ...(saved.depth === 0 ? { budget } : {}),
      persist: options.persist,
      admission: options.admission,
    });
    return context(constraints, budget, saved.depth, Object.freeze(scopes), ledger);
  }
  const constraints = policy(options.policy);
  const budget = intersectBudgetLimits(options.budget);
  const root = scope('scopeId' in options ? (options.scopeId ?? 'root') : 'root', budget);
  const ledger = createBudgetLedger({
    budget,
    persist: options.persist,
    admission: options.admission,
  });
  return context(constraints, budget, 0, Object.freeze([root]), ledger);
}

export type {
  ExecutionChildOptions,
  ExecutionContextOptions,
  ExecutionContextRestoreOptions,
  ExecutionContextSnapshot,
  ExecutionPolicy,
  ExecutionReservationInput,
  NativeExecutionContext,
} from './types/execution';
