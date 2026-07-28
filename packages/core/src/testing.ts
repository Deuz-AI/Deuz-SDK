/**
 * `@deuz-sdk/core/testing` — deterministic test utilities (1.6.0, M12):
 * golden-replay SSE helpers, a scriptable mock model that drives the REAL
 * adapter + tool loop with zero network, and two eval runners — `runEval`
 * (binary pass/fail) and `runGradedEval` (1.9, partial credit over weighted
 * subtasks). Everything here is edge-safe and fully deterministic: no timers, no
 * ambient randomness, no logging.
 *
 * Golden-replay helpers. Primary strategy (Faz 1.E): inject `deps.fetch` (or a
 * factory `fetch`) that returns a `Response` whose body is an SSE `ReadableStream`
 * built from fixture chunks — fully deterministic, no network interception.
 */

import type { LanguageModel } from './types/model';
import type { Usage, FinishReason } from './types/usage';
import { attachConfig } from './internal/config-symbol';

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
