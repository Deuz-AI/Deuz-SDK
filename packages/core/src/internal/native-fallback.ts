/**
 * Model fail-over inside a native run (2.3, 23.4). The legacy `fallbackModels`
 * re-runs a whole call on the next model; a native run is checkpointed, so a
 * fail-over repeats only the model call that failed, inside the same run,
 * budget and checkpoint:
 * - a call fails over only on a retryable transport or provider error before
 *   its first content (`defaultShouldFallback`: network, transport timeout,
 *   5xx, 429/529 after the call's own retries, an open breaker); a refusal, a
 *   policy, budget or validation rejection, an abort and anything after
 *   content stay final;
 * - the failed model is skipped for the rest of the run: every call that would
 *   go to it goes to the first candidate of `[it, ...fallbackModels]` that has
 *   not failed, whether it is the root model, a handoff target's or a
 *   `prepareStep` model;
 * - the checkpoint records each fail-over (`AgentRunEnvelope.models`), so a
 *   resume routes around the same models.
 * Reasoning needs nothing here: each wire replays only its own family's blocks
 * (`internal/reasoning.ts`), so Claude blocks reach another Claude model
 * unchanged and never another provider. Each candidate gets the call's
 * `capabilities` override, and its request is built for its own profile.
 */
import type { LanguageModel } from '../types/model';
import type { ModelCapabilities } from '../core/registry';
import type {
  AgentRunModelAttempt,
  AgentRunModelRef,
  AgentRunModelState,
} from '../types/agent-run';
import { defaultShouldFallback } from './fallback';
import { withCapabilityOverride } from './config-symbol';

/** A model's identity as the checkpoint records it. */
export function modelRef(model: LanguageModel): AgentRunModelRef {
  return { provider: model.provider, protocol: model.surface, modelId: model.modelId };
}

function refKey(ref: AgentRunModelRef): string {
  return `${ref.provider}/${ref.protocol}/${ref.modelId}`;
}

/** The candidates' part of the resume binding. */
export function fallbackBinding(models: readonly LanguageModel[]): string {
  return JSON.stringify(models.map((model) => refKey(modelRef(model))));
}

/** Whether an error that ended a model call before its first content may fail over. */
export function failsOver(error: unknown): boolean {
  return defaultShouldFallback(error);
}

export interface ModelRouter {
  /** The model a call meant for `model` goes to now; undefined when every candidate failed. */
  route(model: LanguageModel): LanguageModel | undefined;
  /**
   * Record that `failed`, the model a call was routed to, failed with `error`:
   * returns the attempt to record, or undefined when no candidate is left.
   */
  fail(
    failed: LanguageModel,
    intended: LanguageModel,
    error: { name: string; message: string; code?: string },
    modelStep: number,
    phase: AgentRunModelAttempt['phase'],
  ): AgentRunModelAttempt | undefined;
  /** The state to checkpoint, with `root` as the run's own model. */
  state(root: LanguageModel): AgentRunModelState;
}

/** A router over `fallbackModels`, resuming from the recorded fail-overs. */
export function createModelRouter(
  fallbackModels: readonly LanguageModel[],
  capabilities: Partial<ModelCapabilities> | undefined,
  recorded: AgentRunModelState | undefined,
): ModelRouter {
  const attempts: AgentRunModelAttempt[] = structuredClone(recorded?.attempts ?? []);
  const failed = new Set(attempts.map((attempt) => refKey(attempt.model)));
  const route = (model: LanguageModel): LanguageModel | undefined => {
    for (const candidate of [model, ...fallbackModels]) {
      if (failed.has(refKey(modelRef(candidate)))) continue;
      // The intended model carries the override already; the merge is idempotent.
      return withCapabilityOverride(candidate, capabilities);
    }
    return undefined;
  };
  return {
    route,
    fail(model, intended, error, modelStep, phase) {
      failed.add(refKey(modelRef(model)));
      const next = route(intended);
      if (!next) return undefined;
      const attempt: AgentRunModelAttempt = {
        attempt: attempts.length + 1,
        model: modelRef(model),
        next: modelRef(next),
        modelStep,
        phase,
        error,
      };
      attempts.push(attempt);
      return attempt;
    },
    state(root) {
      return {
        policy: 1,
        selected: modelRef(route(root) ?? root),
        attempts: structuredClone(attempts),
      };
    },
  };
}
