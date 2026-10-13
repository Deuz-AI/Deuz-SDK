/**
 * `@deuz-sdk/core/testing` — deterministic test utilities (1.6.0, M12):
 * golden-replay SSE helpers, a scriptable mock model that drives the REAL
 * adapter + tool loop with zero network, and two eval runners — `runEval`
 * (binary pass/fail) and `runGradedEval` (1.9, partial credit over weighted
 * subtasks). Everything here is edge-safe and fully deterministic: no timers, no
 * ambient randomness, no logging. `runEvalSuite` (2.3) adds versioned task
 * manifests with per-attempt metrics; it reads a clock for durations (inject
 * one for determinism), sets a timer only while a task timeout applies, and
 * touches `node:fs` only when asked to write its report to a path.
 *
 * Golden-replay helpers. Primary strategy (Faz 1.E): inject `deps.fetch` (or a
 * factory `fetch`) that returns a `Response` whose body is an SSE `ReadableStream`
 * built from fixture chunks — fully deterministic, no network interception.
 */

import type { LanguageModel } from './types/model';
import type { Usage, FinishReason } from './types/usage';
import type { Message } from './types/message';
import type { BudgetTotals } from './types/execution';
import type { ToolApprovalRequest, ToolApprovalResponse } from './types/tool';
import type { MemoryObserver } from './observe';
import { attachConfig } from './internal/config-symbol';
import {
  aggregateByTier,
  assertEvalSuite,
  createEvalAttempt,
  deliverEvalReport,
  errorText,
  harnessFailures,
  isEvalOutcome,
  isTimedOut,
  observedToolCalls,
  outcomeCost,
  recoveryOf,
  repeatedEffectCount,
  settleWithin,
  taskMetrics,
} from './internal/eval-suite';

/** Build a streaming `text/event-stream` Response from raw chunk strings. */
export function sseResponse(chunks: string[], init: ResponseInit = {}): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
    ...init,
  });
}

/** Format `event:`/`id:`/`data:` blocks into a single SSE wire string. */
export function sseEvents(
  events: { event?: string; data: unknown; id?: string | number }[],
): string {
  return events
    .map((e) => {
      const data = typeof e.data === 'string' ? e.data : JSON.stringify(e.data);
      const id = e.id !== undefined ? `id: ${e.id}\n` : '';
      return `${e.event ? `event: ${e.event}\n` : ''}${id}data: ${data}\n\n`;
    })
    .join('');
}

/** A fetch that always returns the given Response (records the last request). */
export function mockFetch(response: Response | (() => Response)): {
  fetch: typeof fetch;
  calls: { url: string; init?: RequestInit }[];
} {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return typeof response === 'function' ? response() : response;
  }) as typeof fetch;
  return { fetch: fn, calls };
}

/** A fetch that returns a different Response per call (last repeats). Records each request. */
export function mockFetchSequence(responses: (() => Response)[]): {
  fetch: typeof fetch;
  calls: { url: string; init?: RequestInit }[];
} {
  const calls: { url: string; init?: RequestInit }[] = [];
  let i = 0;
  const fn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    const make = responses[Math.min(i, responses.length - 1)]!;
    i++;
    return make();
  }) as typeof fetch;
  return { fetch: fn, calls };
}

// ===================================================================
// Deterministic mock model
// ===================================================================

/** One synthesized tool call inside a {@link MockResponse}. */
export interface MockToolCall {
  toolName: string;
  /** Parsed args — serialized onto the wire as the JSON `arguments` string. */
  args: unknown;
  /** Fixed id; omitted → sequential `call_1`, `call_2`, … per model instance. */
  id?: string;
}

/** One scripted model turn. One entry is consumed per invocation; the last repeats. */
export interface MockResponse {
  text?: string;
  toolCalls?: MockToolCall[];
  /**
   * Merged over deterministic defaults (10 input / 5 output tokens).
   * `cacheWriteTokens`/`cacheWrite1hTokens` have no Chat Completions wire form
   * and are ignored.
   */
  usage?: Partial<Usage>;
  /**
   * Default: `'tool_calls'` when `toolCalls` is non-empty, else `'stop'`.
   * `'error'`/`'aborted'` have no wire form and clamp to `'stop'`.
   */
  finishReason?: FinishReason;
}

export interface CreateMockModelOptions {
  responses: MockResponse[];
}

/** Canonical finish reason → Chat Completions wire `finish_reason`. */
function toWireFinish(response: MockResponse): string {
  const reason =
    response.finishReason ?? ((response.toolCalls?.length ?? 0) > 0 ? 'tool_calls' : 'stop');
  switch (reason) {
    case 'length':
    case 'tool_calls':
    case 'content_filter':
      return reason;
    default:
      return 'stop';
  }
}

interface WireUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  prompt_tokens_details?: { cached_tokens: number };
  completion_tokens_details?: { reasoning_tokens?: number; audio_tokens?: number };
}

/** Map `Partial<Usage>` onto the OpenAI usage chunk (`prompt_tokens` includes cached). */
function toWireUsage(usage: Partial<Usage> | undefined): WireUsage {
  const input = usage?.inputTokens ?? 10;
  const cached = usage?.cachedReadTokens ?? 0;
  const output = usage?.outputTokens ?? 5;
  const prompt = input + cached;
  const wire: WireUsage = {
    prompt_tokens: prompt,
    completion_tokens: output,
    total_tokens: usage?.totalTokens ?? prompt + output,
  };
  if (cached > 0) wire.prompt_tokens_details = { cached_tokens: cached };
  const details: { reasoning_tokens?: number; audio_tokens?: number } = {};
  if (usage?.reasoningTokens) details.reasoning_tokens = usage.reasoningTokens;
  if (usage?.audioTokens) details.audio_tokens = usage.audioTokens;
  if (details.reasoning_tokens !== undefined || details.audio_tokens !== undefined) {
    wire.completion_tokens_details = details;
  }
  return wire;
}

/** Synthesize one well-formed OpenAI Chat Completions SSE turn for a scripted response. */
function mockSseTurn(response: MockResponse, nextId: () => string): string {
  const events: { data: unknown }[] = [];

  const text = response.text ?? '';
  if (text.length > 0) {
    // Two deltas, so stream consumers see real incremental chunks.
    const mid = Math.ceil(text.length / 2);
    for (const piece of [text.slice(0, mid), text.slice(mid)]) {
      if (piece) {
        events.push({
          data: { choices: [{ index: 0, delta: { content: piece }, finish_reason: null }] },
        });
      }
    }
  }

  (response.toolCalls ?? []).forEach((call, index) => {
    const id = call.id ?? nextId();
    const args = typeof call.args === 'string' ? call.args : (JSON.stringify(call.args) ?? '{}');
    // Real OpenAI shape: id + name arrive first (empty arguments), then the
    // argument JSON rides a second delta that carries only the index.
    events.push({
      data: {
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                { index, id, type: 'function', function: { name: call.toolName, arguments: '' } },
              ],
            },
            finish_reason: null,
          },
        ],
      },
    });
    events.push({
      data: {
        choices: [
          {
            index: 0,
            delta: { tool_calls: [{ index, function: { arguments: args } }] },
            finish_reason: null,
          },
        ],
      },
    });
  });

  events.push({
    data: { choices: [{ index: 0, delta: {}, finish_reason: toWireFinish(response) }] },
  });
  events.push({ data: { choices: [], usage: toWireUsage(response.usage) } });
  events.push({ data: '[DONE]' });
  return sseEvents(events);
}

/**
 * A deterministic `LanguageModel` (provider `'mock'`, surface
 * `'chat_completions'`, modelId `'mock-model'`) whose attached factory `fetch`
 * synthesizes a well-formed OpenAI Chat Completions SSE stream per invocation —
 * driving the REAL adapter + tool loop end-to-end with zero network. One
 * {@link MockResponse} is consumed per model call; the last repeats forever.
 * Tool-call ids count up (`call_1`, `call_2`, …) across the model's lifetime —
 * never crypto. An empty `responses` array yields empty turns (no text, finish
 * `'stop'`, default usage).
 */
export function createMockModel(options: CreateMockModelOptions): LanguageModel {
  let invocation = 0;
  let toolIds = 0;
  const nextId = (): string => {
    toolIds += 1;
    return `call_${toolIds}`;
  };
  const fetchImpl = (async (_input: RequestInfo | URL, _init?: RequestInit) => {
    const { responses } = options;
    const response = responses[Math.min(invocation, responses.length - 1)] ?? {};
    invocation += 1;
    return sseResponse([mockSseTurn(response, nextId)]);
  }) as typeof fetch;

  const model: LanguageModel = {
    provider: 'mock',
    modelId: 'mock-model',
    surface: 'chat_completions',
  };
  // apiKey 'mock' + an explicit baseURL so resolve-call never throws for a
  // provider with no default wire URL. The URL is never actually dialed.
  return attachConfig(model, {
    provider: 'mock',
    apiKey: 'mock',
    baseURL: 'https://mock.invalid/v1',
    fetch: fetchImpl,
  });
}

// ===================================================================
// Minimal eval runner
// ===================================================================

export interface EvalCase<I, O> {
  name: string;
  input: I;
  expected?: O;
  /** Custom pass predicate; overrides the default JSON deep-equal. */
  check?: (output: O, expected: O | undefined) => boolean | Promise<boolean>;
}

export interface EvalCaseResult {
  name: string;
  passed: boolean;
  error?: string;
}

export interface EvalReport {
  /** `passed / total` (0 when there are no cases). */
  score: number;
  total: number;
  passed: number;
  /** One entry per case, in input order. */
  results: EvalCaseResult[];
}

/**
 * Run every case through `run` sequentially (deterministic order — no timers,
 * no logging). Pass rules: a custom `check` wins; otherwise JSON.stringify
 * deep-equal against `expected` when present; otherwise the case passes if
 * `run` returns. A thrown `run` (or `check`) marks the case failed with the
 * error message captured.
 */
export async function runEval<I, O>(
  cases: EvalCase<I, O>[],
  run: (input: I) => Promise<O>,
): Promise<EvalReport> {
  const results: EvalCaseResult[] = [];
  for (const c of cases) {
    try {
      const output = await run(c.input);
      const passed = c.check
        ? await c.check(output, c.expected)
        : c.expected !== undefined
          ? JSON.stringify(output) === JSON.stringify(c.expected)
          : true;
      results.push({ name: c.name, passed });
    } catch (err) {
      results.push({
        name: c.name,
        passed: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  const passed = results.filter((r) => r.passed).length;
  const total = results.length;
  return { score: total === 0 ? 0 : passed / total, total, passed, results };
}

// ===================================================================
// Graded eval runner — partial credit (1.9, N3)
// ===================================================================

/** One weighted sub-check of a {@link GradedCase}. */
export interface GradedSubtask {
  /** Label used in `failures`. Default `subtask N` (1-based). */
  name?: string;
  check: (out: unknown) => boolean | Promise<boolean>;
  /**
   * Relative weight WITHIN its case; default 1. Weights need not sum to
   * anything. Non-finite, zero and negative values fall back to 1 — a 0 weight
   * would make a subtask unscoreable, and an all-zero case undividable.
   */
  weight?: number;
}

export interface GradedCase<I> {
  name: string;
  input: I;
  subtasks: GradedSubtask[];
}

export interface GradedCaseResult {
  name: string;
  /** 0..1 — weighted share of this case's subtasks that passed. */
  score: number;
  /** Subtasks that passed (UNWEIGHTED count, for reading the report). */
  passed: number;
  /** Subtasks attempted. */
  total: number;
  /** Labels of failed subtasks; a THROWN check reads `label: message`. */
  failures: string[];
  /**
   * Case-level failure (`run` threw, or the case has no subtasks) — the same
   * channel `EvalCaseResult.error` uses. Distinct from `failures`, which is
   * per-subtask.
   */
  error?: string;
}

export interface GradedEvalReport {
  /** 0..1 — the mean of the case scores (see {@link runGradedEval}). */
  score: number;
  /** One entry per case, in input order. */
  results: GradedCaseResult[];
}

/** Weight guard: only a finite, strictly positive number is honoured. */
function subtaskWeight(weight: number | undefined): number {
  return typeof weight === 'number' && Number.isFinite(weight) && weight > 0 ? weight : 1;
}

/**
 * Dense grading: score each case by the WEIGHTED share of its subtasks that
 * passed, instead of {@link runEval}'s binary pass/fail. Binary grading collapses
 * the ranking on multi-part tasks — "4 of 5 done" and "0 of 5 done" both read as
 * one failure — which is exactly the signal you need when comparing two prompts.
 * Sequential and deterministic, like `runEval`: no timers, no logging.
 *
 * Aggregation: `score` is the plain MEAN of the case scores, so every case counts
 * equally however many subtasks it carries (otherwise one 20-subtask case would
 * dominate a 20-case suite). Weighting cases by their subtask count instead is
 * derivable from `results`.
 *
 * Failure rules, all reported and none fatal:
 * - a subtask returning false → counted failed, label pushed to `failures`;
 * - a subtask THROWING → counted failed too, `failures` gets `label: message`
 *   (a broken check must not be able to crash the suite);
 * - `run` throwing → the whole case scores 0 with `error` set and no subtask
 *   run (there is no output to check);
 * - a case with NO subtasks → scores 0 with `error: 'no subtasks'`, and `run` is
 *   NOT invoked. It asserts nothing, so scoring it 1 would let a typo'd fixture
 *   silently inflate the suite — the opposite of what a grader is for.
 *
 * An empty `cases` array scores 0, matching `runEval`.
 */
export async function runGradedEval<I>(
  cases: GradedCase<I>[],
  run: (input: I) => Promise<unknown>,
): Promise<GradedEvalReport> {
  const results: GradedCaseResult[] = [];
  for (const c of cases) {
    const total = c.subtasks.length;
    if (total === 0) {
      results.push({
        name: c.name,
        score: 0,
        passed: 0,
        total: 0,
        failures: [],
        error: 'no subtasks',
      });
      continue;
    }

    let output: unknown;
    try {
      output = await run(c.input);
    } catch (err) {
      results.push({
        name: c.name,
        score: 0,
        passed: 0,
        total,
        failures: [],
        error: err instanceof Error ? err.message : String(err),
      });
      continue;
    }

    const failures: string[] = [];
    let passed = 0;
    let earned = 0;
    let weightTotal = 0;
    for (const [index, subtask] of c.subtasks.entries()) {
      const label = subtask.name ?? `subtask ${index + 1}`;
      const weight = subtaskWeight(subtask.weight);
      weightTotal += weight;
      let ok = false;
      try {
        ok = await subtask.check(output);
      } catch (err) {
        // A throwing check is a REPORTED failure, never a crash.
        failures.push(`${label}: ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }
      if (ok) {
        passed += 1;
        earned += weight;
      } else {
        failures.push(label);
      }
    }
    results.push({ name: c.name, score: earned / weightTotal, passed, total, failures });
  }

  const score =
    results.length === 0 ? 0 : results.reduce((sum, r) => sum + r.score, 0) / results.length;
  return { score, results };
}

// ===================================================================
// Eval suites — versioned task manifests (2.3, roadmap 23.7)
// ===================================================================

/**
 * Where a task runs. `'offline'` tasks drive scripted models and are
 * deterministic; `'real-model'` tasks need a provider and its key. The two are
 * separate experiments: a report never adds their numbers together.
 */
export type EvalTier = 'offline' | 'real-model';

/** The state a task starts from. Every attempt gets its own deep copy. */
export interface EvalTaskSnapshot {
  /** The conversation so far. */
  messages?: Message[];
  /** Workspace files, path to content. */
  files?: Record<string, string>;
  /** Any JSON state the task seeds its stores with: a stored run envelope, rows, counters. */
  store?: Record<string, unknown>;
}

/** One acceptance criterion: the task succeeds only when every criterion holds. */
export interface EvalAcceptance<O = unknown> {
  /** Label used in `failures`. */
  name: string;
  /** Relative weight for the default partial-credit score; default 1 (as {@link GradedSubtask}). */
  weight?: number;
  /** Judge the outcome and the attempt's final state. A throw is a failed criterion. */
  check(outcome: EvalTaskOutcome<O>, context: EvalTaskContext): boolean | Promise<boolean>;
}

/** The model a task is meant for. Descriptive: the task's `run` builds the model. */
export interface EvalTaskModel {
  provider?: string;
  /** The model ID, e.g. `'claude-sonnet-4-6'`. */
  id?: string;
  /** The wire protocol, e.g. `'chat_completions'`, `'responses'`, `'messages'`. */
  protocol?: string;
  effort?: string;
}

/**
 * A versioned eval task (2.3). `id` names the task for good; bump `version`
 * whenever its start state, acceptance or grading changes, so results of two
 * versions are never compared as one task.
 */
export interface EvalTaskManifest<O = unknown> {
  id: string;
  /** A positive integer. */
  version: number;
  title?: string;
  /** Default `'offline'`. */
  tier?: EvalTier;
  tags?: readonly string[];
  start?: EvalTaskSnapshot;
  /** At least one. Success needs all of them. */
  acceptance: readonly EvalAcceptance<O>[];
  /**
   * Partial credit in 0..1 (clamped). Default: the weighted share of the
   * acceptance criteria that held, as {@link runGradedEval} scores a case.
   */
  grade?(outcome: EvalTaskOutcome<O>, context: EvalTaskContext): number | Promise<number>;
  tools?: {
    /** The tools the run may call; a call to any other fails the attempt. */
    allowed?: readonly string[];
    /** A path prefix of `start.files`: a change to a file outside it fails the attempt. */
    scope?: string;
  };
  model?: EvalTaskModel;
  /** Checked against the cost and tokens the outcome reports. */
  budget?: { usd?: number; tokens?: number };
  /** Per attempt. Default: `RunEvalSuiteOptions.timeoutMs`, else none. */
  timeoutMs?: number;
  /** Attempts. Default: `RunEvalSuiteOptions.repeats`, else 1. */
  repeats?: number;
  /** Artifacts every attempt must record through `context.artifact`. */
  artifacts?: readonly string[];
  /**
   * Tools whose approval is part of the task. Approving them is a required
   * approval; approving any other tool counts as a human rescue.
   */
  approvals?: readonly string[];
  /**
   * The fault this task injects and the recovery its documentation promises.
   * The attempt fails when the fault never fired (`context.interrupt`) or the
   * outcome's `recovery` is another one.
   */
  fault?: { boundary: string; recovery: string };
  /** Environment variables a real-model task needs; see `RunEvalSuiteOptions.skip`. */
  env?: readonly string[];
  /** Run one attempt. Default: `RunEvalSuiteOptions.run`. */
  run?(context: EvalTaskContext): Promise<EvalTaskOutcome<O>>;
}

/**
 * What an attempt returns. A native `AgentResult` is one as it stands, so a
 * task can return `runAgent(...)` directly.
 */
export interface EvalTaskOutcome<O = unknown> {
  /** What the run claimed. `'completed'` with failed acceptance is a false completion. */
  status: 'completed' | 'suspended' | 'stopped' | 'failed';
  output?: O;
  text?: string;
  reason?: string;
  error?: { name: string; message: string; code?: string };
  /** `totalTokens` is the token metric when there is no `accounting`. */
  usage?: Usage;
  /**
   * The run's accounting, across every leg: `spent.usd` is the cost when
   * `costUsd` is absent, and `spent.tokens` the token metric.
   */
  accounting?: BudgetTotals;
  costUsd?: number;
  /** The recovery the run took after an interruption, compared with `fault.recovery`. */
  recovery?: string;
}

/** What a task's `run` gets for one attempt. */
export interface EvalTaskContext {
  readonly task: EvalTaskManifest;
  /** Zero-based. */
  readonly attempt: number;
  /** Copies of the start snapshot; changes stay within this attempt. */
  readonly messages: Message[];
  readonly files: Record<string, string>;
  readonly store: Record<string, unknown>;
  /** Pass as `deps.observer`: its `tool.started` events feed the allowed-tools check. */
  readonly observer: MemoryObserver;
  /** Aborted when the attempt times out. */
  readonly signal: AbortSignal;
  /** Record one execution of an external effect by its real-world identity. */
  effect(key: string): void;
  /**
   * A human answers approval requests. Returns the verdicts for
   * `approvalResponses`, signed tokens echoed back.
   */
  approve(requests: readonly ToolApprovalRequest[], approved?: boolean): ToolApprovalResponse[];
  /** A human stepped in where the task needed no one. */
  rescue(reason: string): void;
  /** The injected fault fired at this boundary. */
  interrupt(boundary: string): void;
  /** Keep a JSON value in the report under this name. */
  artifact(name: string, value: unknown): void;
}

/**
 * How an attempt came back from its interruptions: `'not-needed'` (nothing was
 * interrupted), `'recovered'` (completed and accepted without a human rescue),
 * `'rescued'` (completed and accepted after a human rescue), `'contained'`
 * (accepted, but the documented outcome is a stop or a failure: the work did
 * not finish) or `'failed'` (not accepted, or an effect ran twice). An attempt
 * that repeated an effect is never `'recovered'`, `'rescued'` or `'contained'`.
 * The other harness checks, a recovery path other than `fault.recovery`
 * included, fail the attempt's `success` but leave its class alone.
 */
export type EvalRecovery = 'not-needed' | 'recovered' | 'rescued' | 'contained' | 'failed';

export interface EvalAttemptReport {
  /** Zero-based. */
  attempt: number;
  status: EvalTaskOutcome['status'] | 'timeout' | 'error';
  /** Every acceptance criterion held and no harness check failed. */
  success: boolean;
  /** 0..1. */
  score: number;
  /** Failed criteria (`name`, or `name: message` for a throwing check), then harness checks. */
  failures: string[];
  /** Why the run produced no outcome: a throw or the timeout. */
  error?: string;
  /** The run claimed `'completed'` and failed acceptance. */
  falseCompleted: boolean;
  /**
   * Spent, as far as known: a lower bound when calls ran without a price or
   * with an unknown outcome (those stay held in the outcome's `accounting`).
   */
  costUsd?: number;
  tokens?: number;
  durationMs: number;
  /** Interventions the task did not need: explicit rescues and undeclared approvals. */
  humanRescues: number;
  /** Approvals of the tools the manifest's `approvals` lists. */
  requiredApprovals: number;
  /** Effect executions beyond the first per key. */
  repeatedEffects: number;
  /** Tool names in call order, as the observer saw them. */
  toolCalls: string[];
  recovery: EvalRecovery;
  /** The outcome's `recovery`. */
  recoveryPath?: string;
  /** The boundaries `context.interrupt` recorded. */
  interruptions: string[];
  artifacts?: Record<string, unknown>;
}

/** Metrics of one task, or of every task of a tier. */
export interface EvalAggregate {
  tasks: number;
  skipped: number;
  attempts: number;
  successes: number;
  /** `successes / attempts`; 0 without attempts. */
  successRate: number;
  falseCompleted: number;
  /** The sum of the reported costs. */
  costUsd: number;
  tokens: number;
  durationMs: number;
  humanRescues: number;
  requiredApprovals: number;
  repeatedEffects: number;
  recovery: Record<EvalRecovery, number>;
}

export interface EvalTaskReport {
  id: string;
  version: number;
  title?: string;
  tier: EvalTier;
  tags?: readonly string[];
  model?: EvalTaskModel;
  budget?: { usd?: number; tokens?: number };
  fault?: { boundary: string; recovery: string };
  /** Why the task did not run. */
  skipped?: string;
  attempts: EvalAttemptReport[];
  metrics: EvalAggregate;
}

/** The JSON report of {@link runEvalSuite}. */
export interface EvalSuiteReport {
  format: 'deuz-eval-suite';
  version: 1;
  name?: string;
  /** In suite order. */
  tasks: EvalTaskReport[];
  /** Per tier present in the suite; offline and real-model numbers are never mixed. */
  aggregate: Partial<Record<EvalTier, EvalAggregate>>;
}

export interface RunEvalSuiteOptions {
  /** Recorded in the report. */
  name?: string;
  /** The runner for tasks without their own `run`. */
  run?(context: EvalTaskContext): Promise<EvalTaskOutcome>;
  /** Attempts for tasks that set none. Default 1. */
  repeats?: number;
  /** Per-attempt timeout for tasks that set none. Default none. */
  timeoutMs?: number;
  /** A reason to skip a task (a missing key, say); the report lists it without attempts. */
  skip?(task: EvalTaskManifest): string | undefined;
  /** Milliseconds for `durationMs`. Default `Date.now`. */
  clock?: () => number;
  /**
   * Opt-in JSON report: a file path (written with `node:fs`, its directory
   * created) or a callback. Nothing is written without it.
   */
  report?: string | ((report: EvalSuiteReport) => void | Promise<void>);
}

/**
 * Run versioned eval tasks (2.3) and measure every attempt: success, false
 * completion, cost, duration, human rescues (apart from required approvals),
 * repeated effects and recovery, per task and per tier. Sequential, in suite
 * order. A malformed suite throws a `TypeError` before any task runs; a task
 * that throws or times out is a failed attempt, never a crash. Acceptance is
 * graded through {@link runGradedEval}.
 *
 * Beyond its acceptance, an attempt fails when it executed an effect twice,
 * called a tool outside `tools.allowed`, changed a file outside `tools.scope`,
 * went over `budget`, missed a declared artifact, or, for a fault scenario,
 * never hit its fault or recovered another way than documented.
 *
 * Returns the report; writes it only to `options.report`.
 */
export async function runEvalSuite(
  tasks: readonly EvalTaskManifest[],
  options: RunEvalSuiteOptions = {},
): Promise<EvalSuiteReport> {
  assertEvalSuite(tasks, options);
  const clock = options.clock ?? Date.now;
  const reports: EvalTaskReport[] = [];
  for (const task of tasks) {
    const skipped = options.skip?.(task);
    const attempts: EvalAttemptReport[] = [];
    if (!skipped) {
      const repeats = task.repeats ?? options.repeats ?? 1;
      for (let attempt = 0; attempt < repeats; attempt++)
        attempts.push(await runEvalAttempt(task, attempt, options, clock));
    }
    reports.push({
      id: task.id,
      version: task.version,
      ...(task.title !== undefined ? { title: task.title } : {}),
      tier: task.tier ?? 'offline',
      ...(task.tags !== undefined ? { tags: [...task.tags] } : {}),
      ...(task.model !== undefined ? { model: { ...task.model } } : {}),
      ...(task.budget !== undefined ? { budget: { ...task.budget } } : {}),
      ...(task.fault !== undefined ? { fault: { ...task.fault } } : {}),
      ...(skipped ? { skipped } : {}),
      attempts,
      metrics: taskMetrics(attempts, Boolean(skipped)),
    });
  }
  const report: EvalSuiteReport = {
    format: 'deuz-eval-suite',
    version: 1,
    ...(options.name !== undefined ? { name: options.name } : {}),
    tasks: reports,
    aggregate: aggregateByTier(reports),
  };
  if (options.report !== undefined) await deliverEvalReport(options.report, report);
  return report;
}

async function runEvalAttempt(
  task: EvalTaskManifest,
  attempt: number,
  options: RunEvalSuiteOptions,
  clock: () => number,
): Promise<EvalAttemptReport> {
  const record = createEvalAttempt(task, attempt);
  const { context } = record;
  const timeoutMs = task.timeoutMs ?? options.timeoutMs;
  const started = clock();
  let outcome: EvalTaskOutcome | undefined;
  let status: EvalAttemptReport['status'];
  let error: string | undefined;
  try {
    const settled = await settleWithin(
      () => (task.run ? task.run(context) : options.run!(context)),
      timeoutMs,
      record.abort,
    );
    if (isTimedOut(settled)) {
      status = 'timeout';
      error = `timed out after ${timeoutMs} ms`;
    } else if (isEvalOutcome(settled)) {
      outcome = settled;
      status = settled.status;
    } else {
      status = 'error';
      error = 'run returned no outcome with a status';
    }
  } catch (thrown) {
    status = 'error';
    error = errorText(thrown);
  }
  const durationMs = clock() - started;

  let score = 0;
  let accepted = false;
  const failures: string[] = [];
  if (outcome) {
    const reached = outcome;
    // One graded case whose subtasks are the acceptance criteria: weights,
    // and throwing checks reported as failures, come from runGradedEval.
    const graded = await runGradedEval(
      [
        {
          name: task.id,
          input: reached,
          subtasks: task.acceptance.map((criterion) => ({
            name: criterion.name,
            ...(criterion.weight !== undefined ? { weight: criterion.weight } : {}),
            check: () => criterion.check(reached, context),
          })),
        },
      ],
      async (input) => input,
    );
    const result = graded.results[0]!;
    failures.push(...result.failures);
    accepted = result.failures.length === 0 && result.error === undefined;
    score = result.score;
    if (task.grade) {
      try {
        const grade = await task.grade(reached, context);
        score = Number.isFinite(grade) ? Math.min(1, Math.max(0, grade)) : 0;
      } catch (thrown) {
        score = 0;
        failures.push(`grade: ${errorText(thrown)}`);
      }
    }
  }
  const toolCalls = observedToolCalls(context);
  failures.push(...harnessFailures(task, record, outcome, toolCalls));
  return {
    attempt,
    status,
    success: outcome !== undefined && accepted && failures.length === 0,
    score,
    failures,
    ...(error !== undefined ? { error } : {}),
    falseCompleted: outcome?.status === 'completed' && !accepted,
    ...outcomeCost(outcome),
    durationMs,
    humanRescues: record.rescues.length,
    requiredApprovals: record.requiredApprovals,
    repeatedEffects: repeatedEffectCount(record.effects),
    toolCalls,
    recovery: recoveryOf(record, outcome, accepted),
    ...(outcome?.recovery !== undefined ? { recoveryPath: outcome.recovery } : {}),
    interruptions: [...record.interruptions],
    ...(Object.keys(record.artifacts).length > 0 ? { artifacts: { ...record.artifacts } } : {}),
  };
}
