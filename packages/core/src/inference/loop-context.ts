/**
 * The native loop's context hook (2.4, spec §2.3 "Native çalışma sırası"),
 * internal. A V3 run hands its loop one; a loop without it sends exactly
 * what it sent in 2.3. Edge-safe.
 *
 * The loop calls it at a fixed point of each step: after compaction (1),
 * after the host's `prepareStep` (2), with the step's real model and active
 * tools resolved (3); the hook refreshes the sources when due (4), compiles
 * and checks the request budget (5) and records the package durably (6)
 * before the loop makes the model call (7). On an overflow retry the loop
 * compacts again (2.3) and asks the hook to place the context again under
 * the smaller budget (8).
 *
 * Placement: the `append` messages join the history once the model call
 * succeeded, right after the messages the step was compiled for (an overflow
 * retry replaces them, so a failed attempt leaves no block behind); the
 * `tail` messages follow the last message of this request only and never
 * reach the history. The loop never touches the system message or the tools.
 */
import type { WireToolRequest } from '../adapters/types';
import type { TelemetryParent } from '../internal/telemetry';
import type { Message } from '../types/message';
import type { LanguageModel } from '../types/model';
import type { Usage } from '../types/usage';

/** What the loop knows when it asks for a step's context. */
export interface LoopContextStep {
  /** The loop's step index in this leg (it repeats across a resume's settle). */
  stepIndex: number;
  /** The history the request carries: compacted, after `prepareStep`. */
  messages: Message[];
  /** The model this step calls (a `prepareStep` or handoff model included). */
  model: LanguageModel;
  /** The tools on this step's wire, as the provider receives them. */
  wire?: WireToolRequest;
  /** The structured-output JSON Schema the request carries (a native final answer call). */
  outputSchema?: unknown;
  /** The step's span, so the hook's own spans nest under it. */
  telemetry?: TelemetryParent;
  signal?: AbortSignal;
}

/** Where a step's context goes. */
export interface LoopContextPlacement {
  /** Joins the history after the step's messages once the model call succeeded. */
  append: Message[];
  /** Ends this request only; never history. */
  tail: Message[];
}

/** The hook a V3 run hands its loop (internal). */
export interface LoopContextHook {
  /** Steps 4 to 6: refresh when due, compile, check, record. Throws to stop the call. */
  beforeModelCall(step: LoopContextStep): Promise<LoopContextPlacement>;
  /**
   * Step 8: the provider refused the request as too long and the loop
   * compacted again (`compacted`: whether that shrank the history). Returns
   * the placement compiled under the smaller budget, or `undefined` when it
   * could not shrink. Mandatory content that does not fit throws
   * `ContextBudgetExceededError`.
   */
  onOverflow(
    step: LoopContextStep & { compacted: boolean },
  ): Promise<LoopContextPlacement | undefined>;
  /** The call succeeded with this usage: the estimator learns from it. */
  afterModelCall?(usage: Usage): void;
}

/** The messages a request sends: the history, the step's append block, then its tail. */
export function placeContext(
  messages: Message[],
  placement: LoopContextPlacement | undefined,
): Message[] {
  if (!placement || (placement.append.length === 0 && placement.tail.length === 0)) return messages;
  return [...messages, ...placement.append, ...placement.tail];
}
