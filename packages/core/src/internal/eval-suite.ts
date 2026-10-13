/**
 * Internals of `runEvalSuite` (2.3, roadmap 23.7): manifest validation, the
 * context one attempt runs in, the harness checks on an attempt, metric
 * aggregation and the opt-in report writer. The public types and the runner
 * live in `../testing`.
 *
 * Edge-safe: a report path is written through `node:fs/promises`, imported
 * lazily through a variable specifier only when a caller passes a path, so no
 * bundler resolves a `node:` builtin for this module.
 */
import type { ToolApprovalRequest, ToolApprovalResponse } from '../types/tool';
import { createMemoryObserver } from '../observe';
import type {
  EvalAggregate,
  EvalAttemptReport,
  EvalRecovery,
  EvalSuiteReport,
  EvalTaskContext,
  EvalTaskManifest,
  EvalTaskOutcome,
  EvalTaskReport,
  EvalTier,
  RunEvalSuiteOptions,
} from '../testing';

const TIERS: readonly EvalTier[] = ['offline', 'real-model'];
const STATUSES: readonly string[] = ['completed', 'suspended', 'stopped', 'failed'];

function positiveInteger(value: unknown): boolean {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;
}

function positiveFinite(value: unknown): boolean {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function stringList(value: unknown): boolean {
  return Array.isArray(value) && value.every((entry) => nonEmptyString(entry));
}

/**
 * Reject a malformed suite before any task runs: a typo in a manifest must not
 * turn into a misleading report.
 */
export function assertEvalSuite(
  tasks: readonly EvalTaskManifest[],
  options: RunEvalSuiteOptions,
): void {
  if (!Array.isArray(tasks)) throw new TypeError('runEvalSuite: tasks must be an array.');
  if (options.repeats !== undefined && !positiveInteger(options.repeats))
    throw new TypeError('runEvalSuite: options.repeats must be a positive integer.');
  if (options.timeoutMs !== undefined && !positiveFinite(options.timeoutMs))
    throw new TypeError('runEvalSuite: options.timeoutMs must be a positive number.');
  const ids = new Set<string>();
  for (const task of tasks) {
    if (!task || typeof task !== 'object')
      throw new TypeError('runEvalSuite: every task must be a manifest object.');
    if (!nonEmptyString(task.id))
      throw new TypeError('runEvalSuite: a task id must be a non-empty string.');
    if (ids.has(task.id)) throw new TypeError(`runEvalSuite: duplicate task id "${task.id}".`);
    ids.add(task.id);
    const where = `runEvalSuite: task "${task.id}"`;
    if (!positiveInteger(task.version))
      throw new TypeError(`${where}: version must be a positive integer.`);
    if (task.tier !== undefined && !TIERS.includes(task.tier))
      throw new TypeError(`${where}: tier must be 'offline' or 'real-model'.`);
    if (!Array.isArray(task.acceptance) || task.acceptance.length === 0)
      throw new TypeError(`${where}: needs at least one acceptance criterion.`);
    for (const criterion of task.acceptance) {
      if (!criterion || !nonEmptyString(criterion.name) || typeof criterion.check !== 'function')
        throw new TypeError(`${where}: every acceptance criterion needs a name and a check.`);
    }
    if (task.repeats !== undefined && !positiveInteger(task.repeats))
      throw new TypeError(`${where}: repeats must be a positive integer.`);
    if (task.timeoutMs !== undefined && !positiveFinite(task.timeoutMs))
      throw new TypeError(`${where}: timeoutMs must be a positive number.`);
    if (typeof task.run !== 'function' && typeof options.run !== 'function')
      throw new TypeError(`${where} has no run, and the suite has no run option.`);
    if (task.grade !== undefined && typeof task.grade !== 'function')
      throw new TypeError(`${where}: grade must be a function.`);
    if (
      task.fault !== undefined &&
      (!nonEmptyString(task.fault?.boundary) || !nonEmptyString(task.fault?.recovery))
    )
      throw new TypeError(`${where}: a fault needs a boundary and a documented recovery.`);
    if (task.approvals !== undefined && !stringList(task.approvals))
      throw new TypeError(`${where}: approvals must list tool names.`);
    if (task.artifacts !== undefined && !stringList(task.artifacts))
      throw new TypeError(`${where}: artifacts must list artifact names.`);
    if (task.tools?.allowed !== undefined && !stringList(task.tools.allowed))
      throw new TypeError(`${where}: tools.allowed must list tool names.`);
    if (task.tools?.scope !== undefined && typeof task.tools.scope !== 'string')
      throw new TypeError(`${where}: tools.scope must be a path prefix.`);
    for (const key of ['usd', 'tokens'] as const) {
      const limit = task.budget?.[key];
      if (
        limit !== undefined &&
        !(typeof limit === 'number' && Number.isFinite(limit) && limit >= 0)
      )
        throw new TypeError(`${where}: budget.${key} must be a non-negative number.`);
    }
  }
}

/** What one attempt recorded through its context. */
export interface EvalAttemptRecord {
  context: EvalTaskContext;
  abort: AbortController;
  effects: string[];
  rescues: string[];
  requiredApprovals: number;
  interruptions: string[];
  artifacts: Record<string, unknown>;
  startFiles: Record<string, string>;
}

/** A fresh context: deep copies of the start snapshot, a memory observer and the recorders. */
export function createEvalAttempt(task: EvalTaskManifest, attempt: number): EvalAttemptRecord {
  const abort = new AbortController();
  const startFiles = structuredClone(task.start?.files ?? {});
  const record: EvalAttemptRecord = {
    abort,
    effects: [],
    rescues: [],
    requiredApprovals: 0,
    interruptions: [],
    artifacts: {},
    startFiles,
    context: undefined as unknown as EvalTaskContext,
  };
  const required = new Set(task.approvals ?? []);
  record.context = {
    task,
    attempt,
    messages: structuredClone(task.start?.messages ?? []),
    files: structuredClone(startFiles),
    store: structuredClone(task.start?.store ?? {}),
    observer: createMemoryObserver(),
    signal: abort.signal,
    effect(key: string) {
      record.effects.push(String(key));
    },
    approve(requests: readonly ToolApprovalRequest[], approved = true): ToolApprovalResponse[] {
      return requests.map((request) => {
        if (required.has(request.toolName)) record.requiredApprovals += 1;
        else
          record.rescues.push(`approval of ${request.toolName}, which the task does not require`);
        return {
          approvalId: request.approvalId,
          approved,
          ...(request.token !== undefined ? { token: request.token } : {}),
        };
      });
    },
    rescue(reason: string) {
      record.rescues.push(String(reason));
    },
    interrupt(boundary: string) {
      record.interruptions.push(String(boundary));
    },
    artifact(name: string, value: unknown) {
      record.artifacts[name] = value;
    },
  };
  return record;
}

const TIMED_OUT = Symbol('timed out');

/**
 * Settle `run` within `timeoutMs`, aborting the attempt's signal when the time
 * is up. A timer exists only while a timeout applies, and is always cleared.
 */
export async function settleWithin<T>(
  run: () => Promise<T>,
  timeoutMs: number | undefined,
  abort: AbortController,
): Promise<T | typeof TIMED_OUT> {
  const pending = Promise.resolve().then(run);
  if (timeoutMs === undefined) return pending;
  // A run that settles after its timeout must never surface as unhandled.
  pending.catch(() => {});
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => {
      abort.abort(new Error(`eval attempt timed out after ${timeoutMs} ms`));
      resolve(TIMED_OUT);
    }, timeoutMs);
  });
  try {
    return await Promise.race([pending, expired]);
  } finally {
    clearTimeout(timer);
  }
}

export function isTimedOut(value: unknown): value is typeof TIMED_OUT {
  return value === TIMED_OUT;
}

/** A thrown value as report text. */
export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function isEvalOutcome(value: unknown): value is EvalTaskOutcome {
  return (
    typeof value === 'object' &&
    value !== null &&
    STATUSES.includes((value as { status?: unknown }).status as string)
  );
}

/**
 * Cost and tokens as the outcome reports them: an explicit `costUsd`, else the
 * run's accounting, which spans every leg of a resumed run; the usage, which
 * may cover only the last leg, counts tokens only without an accounting.
 */
export function outcomeCost(outcome: EvalTaskOutcome | undefined): {
  costUsd?: number;
  tokens?: number;
} {
  const costUsd = outcome?.costUsd ?? outcome?.accounting?.spent.usd;
  const tokens = outcome?.accounting?.spent.tokens ?? outcome?.usage?.totalTokens;
  return {
    ...(typeof costUsd === 'number' ? { costUsd } : {}),
    ...(typeof tokens === 'number' ? { tokens } : {}),
  };
}

/** Tool names in call order, from the attempt observer's `tool.started` events. */
export function observedToolCalls(context: EvalTaskContext): string[] {
  return context.observer
    .events()
    .flatMap((event) => (event.type === 'tool.started' ? [event.toolName] : []));
}

/**
 * The harness checks every attempt gets, beyond the task's acceptance: no
 * effect twice, only allowed tools, no change outside the scope, within
 * budget, every declared artifact made, and a declared fault that fired and
 * recovered the documented way.
 */
export function harnessFailures(
  task: EvalTaskManifest,
  record: EvalAttemptRecord,
  outcome: EvalTaskOutcome | undefined,
  toolCalls: readonly string[],
): string[] {
  const failures: string[] = [];
  const seen = new Map<string, number>();
  for (const key of record.effects) seen.set(key, (seen.get(key) ?? 0) + 1);
  for (const [key, count] of seen) if (count > 1) failures.push(`repeated effect: ${key}`);

  if (task.tools?.allowed) {
    const allowed = new Set(task.tools.allowed);
    for (const name of new Set(toolCalls))
      if (!allowed.has(name)) failures.push(`tool outside the allowed set: ${name}`);
  }

  const scope = task.tools?.scope;
  if (scope !== undefined) {
    const after = record.context.files;
    const paths = new Set([...Object.keys(record.startFiles), ...Object.keys(after)]);
    for (const path of [...paths].sort()) {
      if (record.startFiles[path] !== after[path] && !path.startsWith(scope))
        failures.push(`change outside the scope ${scope}: ${path}`);
    }
  }

  const { costUsd, tokens } = outcomeCost(outcome);
  if (task.budget?.usd !== undefined && costUsd !== undefined && costUsd > task.budget.usd)
    failures.push(`over the usd budget: ${costUsd} > ${task.budget.usd}`);
  if (task.budget?.tokens !== undefined && tokens !== undefined && tokens > task.budget.tokens)
    failures.push(`over the token budget: ${tokens} > ${task.budget.tokens}`);

  for (const name of task.artifacts ?? [])
    if (!(name in record.artifacts)) failures.push(`missing artifact: ${name}`);

  if (task.fault) {
    if (record.interruptions.length === 0)
      failures.push(`fault never fired: ${task.fault.boundary}`);
    else if (outcome !== undefined && outcome.recovery !== task.fault.recovery)
      failures.push(`recovery ${outcome.recovery ?? 'none'}, documented ${task.fault.recovery}`);
  }
  return failures;
}

/**
 * How an attempt came back from its interruptions, if it had any. An accepted
 * outcome that is not `'completed'` (a documented stop or failure) contained
 * the fault without finishing the work. An attempt that executed an effect
 * twice did not come back from it, whatever its acceptance says.
 */
export function recoveryOf(
  record: EvalAttemptRecord,
  outcome: EvalTaskOutcome | undefined,
  accepted: boolean,
): EvalRecovery {
  if (record.interruptions.length === 0) return 'not-needed';
  if (!accepted || repeatedEffectCount(record.effects) > 0) return 'failed';
  if (outcome?.status !== 'completed') return 'contained';
  return record.rescues.length > 0 ? 'rescued' : 'recovered';
}

/** Repeats beyond the first execution of each effect key. */
export function repeatedEffectCount(effects: readonly string[]): number {
  return effects.length - new Set(effects).size;
}

/** Sums of money and time drift in floating point; reports keep nine decimals. */
function tidy(value: number): number {
  return Math.round(value * 1e9) / 1e9;
}

function emptyAggregate(): EvalAggregate {
  return {
    tasks: 0,
    skipped: 0,
    attempts: 0,
    successes: 0,
    successRate: 0,
    falseCompleted: 0,
    costUsd: 0,
    tokens: 0,
    durationMs: 0,
    humanRescues: 0,
    requiredApprovals: 0,
    repeatedEffects: 0,
    recovery: { 'not-needed': 0, recovered: 0, rescued: 0, contained: 0, failed: 0 },
  };
}

function addAttempt(total: EvalAggregate, attempt: EvalAttemptReport): void {
  total.attempts += 1;
  if (attempt.success) total.successes += 1;
  if (attempt.falseCompleted) total.falseCompleted += 1;
  total.costUsd = tidy(total.costUsd + (attempt.costUsd ?? 0));
  total.tokens += attempt.tokens ?? 0;
  total.durationMs = tidy(total.durationMs + attempt.durationMs);
  total.humanRescues += attempt.humanRescues;
  total.requiredApprovals += attempt.requiredApprovals;
  total.repeatedEffects += attempt.repeatedEffects;
  total.recovery[attempt.recovery] += 1;
}

function finish(total: EvalAggregate): EvalAggregate {
  total.successRate = total.attempts === 0 ? 0 : total.successes / total.attempts;
  return total;
}

/** One task's metrics over its attempts. */
export function taskMetrics(
  attempts: readonly EvalAttemptReport[],
  skipped: boolean,
): EvalAggregate {
  const total = emptyAggregate();
  if (skipped) total.skipped = 1;
  else total.tasks = 1;
  for (const attempt of attempts) addAttempt(total, attempt);
  return finish(total);
}

/**
 * Per tier, never mixed: offline scripted tasks and real-model tasks are
 * separate experiments, so their numbers are never added together.
 */
export function aggregateByTier(tasks: readonly EvalTaskReport[]): EvalSuiteReport['aggregate'] {
  const aggregate: EvalSuiteReport['aggregate'] = {};
  for (const task of tasks) {
    const total = (aggregate[task.tier] ??= emptyAggregate());
    total.tasks += task.metrics.tasks;
    total.skipped += task.metrics.skipped;
    for (const attempt of task.attempts) addAttempt(total, attempt);
  }
  for (const tier of TIERS) {
    const total = aggregate[tier];
    if (total) finish(total);
  }
  return aggregate;
}

interface ReportFs {
  mkdir(path: string, options: { recursive: true }): Promise<unknown>;
  writeFile(path: string, data: string, encoding: 'utf8'): Promise<void>;
}

/** Hand the report to the caller's callback, or write it as JSON to the caller's path. */
export async function deliverEvalReport(
  target: NonNullable<RunEvalSuiteOptions['report']>,
  report: EvalSuiteReport,
): Promise<void> {
  if (typeof target === 'function') {
    await target(report);
    return;
  }
  let fs: ReportFs;
  try {
    const spec: string = 'node:fs/promises';
    fs = (await import(spec)) as ReportFs;
  } catch (cause) {
    throw new Error(
      'runEvalSuite: writing the report to a path needs node:fs (Node, Bun or Deno); pass a callback instead.',
      { cause },
    );
  }
  const dir = target.replace(/[\\/][^\\/]*$/, '');
  if (dir !== target && dir.length > 0) await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(target, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
}
