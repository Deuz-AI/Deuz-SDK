/**
 * `@deuz-sdk/core/autonomy` (1.8) — free-function composition primitives for
 * autonomous, self-verifying, and parallel ("Wide Research") agent loops. No
 * agent class and no new runtime: these build on `generateText` and the loop
 * you already have.
 *
 * - Planner: `planTasks` + the pure `TaskList` reducers (re-exported from `./plan`).
 * - Verified generation: `bestOfN`, `selfConsistency` (the `verifyStep` loop
 *   hook lives on `CommonCallOptions`; its types are re-exported here).
 * - Parallel fan-out: `parallelAgents` runs N independent agents concurrently.
 *
 * Edge-safe (pure Web APIs).
 */
import type { LanguageModel } from './types/model';
import type { Dependencies, UsageMeta } from './types/deps';
import type { Usage, FinishReason } from './types/usage';
import type { ToolSet } from './types/tool';
import { generateText } from './inference/generate-text';
import { mapWithConcurrency } from './internal/p-limit';
import { EMPTY_USAGE, withTotal } from './core/metering';
import { sumUsage } from './inference/loop-shared';

export * from './plan';
export type { VerifyStep, VerifyStepContext, VerifyStepResult } from './types/config';

// ===================================================================
// Verified generation
// ===================================================================

/** One scored candidate produced by `bestOfN`. */
export interface Candidate<T> {
  value: T;
  score: number;
  index: number;
}

export interface BestOfNResult<T> {
  /** The highest-scoring candidate's value. */
  best: T;
  bestScore: number;
  /** Every candidate in generation order (index-stable). */
  candidates: Candidate<T>[];
}

export interface BestOfNOptions<T> {
  /** How many candidates to generate. */
  n: number;
  /** Produce one candidate (called with its 0-based index). */
  generate: (index: number) => Promise<T> | T;
  /** Score a candidate — HIGHER is better. */
  score: (candidate: T, index: number) => number | Promise<number>;
  /** Max concurrent generations. Default `n`. */
  concurrency?: number;
}

/**
 * Generate `n` candidates in parallel (capped), score each, and return the best
 * (first-highest on a tie — deterministic). A verifier-scored best-of-N: the
 * quality lever SDKs rarely ship as a primitive.
 */
export async function bestOfN<T>(options: BestOfNOptions<T>): Promise<BestOfNResult<T>> {
  const indices = Array.from({ length: Math.max(0, options.n) }, (_, i) => i);
  const candidates = await mapWithConcurrency(
    indices,
    options.concurrency ?? options.n,
    async (i): Promise<Candidate<T>> => {
      const value = await options.generate(i);
      const score = await options.score(value, i);
      return { value, score, index: i };
    },
  );
  if (candidates.length === 0) {
    throw new Error('bestOfN requires n >= 1.');
  }
  let best = candidates[0]!;
  for (const c of candidates) {
    if (c.score > best.score) best = c;
  }
  return { best: best.value, bestScore: best.score, candidates };
}

/** One vote group produced by `selfConsistency`. */
export interface VoteGroup<T> {
  key: string;
  value: T;
  votes: number;
}

export interface SelfConsistencyResult<T> {
  /** The most-voted value (first-seen wins a tie). */
  answer: T;
  votes: number;
  total: number;
  /** All groups, sorted by votes desc then first-seen. */
  tally: VoteGroup<T>[];
}

export interface SelfConsistencyOptions<T> {
  n: number;
  generate: (index: number) => Promise<T> | T;
  /** Group key for voting. Default `JSON.stringify`. */
  key?: (candidate: T) => string;
  concurrency?: number;
}

/**
 * Sample `n` candidates and majority-vote them by `key` (default deep-equal via
 * `JSON.stringify`). Returns the most-frequent answer — self-consistency
 * decoding as a one-liner.
 */
export async function selfConsistency<T>(
  options: SelfConsistencyOptions<T>,
): Promise<SelfConsistencyResult<T>> {
  const indices = Array.from({ length: Math.max(0, options.n) }, (_, i) => i);
  const key = options.key ?? ((v: T) => JSON.stringify(v));
  const values = await mapWithConcurrency(indices, options.concurrency ?? options.n, (i) =>
    Promise.resolve(options.generate(i)),
  );
  if (values.length === 0) {
    throw new Error('selfConsistency requires n >= 1.');
  }
  const groups = new Map<string, VoteGroup<T>>();
  const order: string[] = [];
  for (const value of values) {
    const k = key(value);
    const existing = groups.get(k);
    if (existing) existing.votes += 1;
    else {
      groups.set(k, { key: k, value, votes: 1 });
      order.push(k);
    }
  }
  // Sort by votes desc, then by first-seen order (stable, deterministic).
  const tally = order
    .map((k) => groups.get(k)!)
    .sort((a, b) =>
      b.votes !== a.votes ? b.votes - a.votes : order.indexOf(a.key) - order.indexOf(b.key),
    );
  const winner = tally[0]!;
  return { answer: winner.value, votes: winner.votes, total: values.length, tally };
}

// ===================================================================
// Parallel agents ("Wide Research")
// ===================================================================

/** A single task for `parallelAgents`. A bare string is shorthand for `{ prompt }`. */
export interface ParallelAgentTask {
  prompt: string;
  /** Per-task system-prompt override (falls back to the shared `system`). */
  system?: string;
  /** Label echoed back on the result for correlation. */
  label?: string;
}

export interface ParallelAgentResult {
  label?: string;
  prompt: string;
  text: string;
  usage: Usage;
  finishReason: FinishReason;
}

export interface ParallelAgentsResult {
  results: ParallelAgentResult[];
  /** Usage summed across every sub-agent. */
  usage: Usage;
}

export interface ParallelAgentsOptions {
  model: LanguageModel;
  /** One agent per task. A bare string is `{ prompt }`. */
  tasks: (string | ParallelAgentTask)[];
  /** Shared system prompt for tasks without their own. */
  system?: string;
  /** Tools available to every sub-agent. */
  tools?: ToolSet;
  /** Max steps for each sub-agent's own loop. Default 1. */
  maxSteps?: number;
  /** Max sub-agents running at once. Default 5. */
  concurrency?: number;
  signal?: AbortSignal;
  deps?: Dependencies;
  onUsage?: (usage: Usage, meta: UsageMeta) => void;
}

/**
 * Run many independent agents concurrently over a list of tasks and collect
 * their results — Manus's "Wide Research" fan-out. Each task drives its own
 * `generateText` loop; usage is summed. Order of `results` matches `tasks`.
 */
export async function parallelAgents(
  options: ParallelAgentsOptions,
): Promise<ParallelAgentsResult> {
  const tasks = options.tasks.map((t) => (typeof t === 'string' ? { prompt: t } : t));
  const results = await mapWithConcurrency(
    tasks,
    options.concurrency ?? 5,
    async (task): Promise<ParallelAgentResult> => {
      const system = task.system ?? options.system;
      const out = await generateText({
        model: options.model,
        messages: [
          ...(system ? [{ role: 'system' as const, content: system }] : []),
          { role: 'user' as const, content: task.prompt },
        ],
        ...(options.tools ? { tools: options.tools } : {}),
        ...(options.maxSteps !== undefined ? { maxSteps: options.maxSteps } : {}),
        ...(options.signal ? { signal: options.signal } : {}),
        ...(options.deps ? { deps: options.deps } : {}),
        ...(options.onUsage ? { onUsage: options.onUsage } : {}),
      });
      return {
        ...(task.label !== undefined ? { label: task.label } : {}),
        prompt: task.prompt,
        text: out.text,
        usage: out.usage,
        finishReason: out.finishReason,
      };
    },
  );
  let usage: Usage = EMPTY_USAGE;
  for (const r of results) usage = sumUsage(usage, r.usage);
  return { results, usage: withTotal(usage) };
}
