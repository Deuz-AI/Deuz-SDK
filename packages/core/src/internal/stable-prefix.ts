/**
 * Stable transcript prefix (2.3, F22).
 *
 * Claude Fable 5.1, Opus 5.5, Sonnet 5.5 and Haiku 5.5 bind each thinking
 * block's signature to the conversation before it: the top-level `system`, the
 * `tools` array and every earlier message must reach the API byte-identical
 * on every later request, or a replayed block is invalid (Anthropic API
 * reference, cached 2026-10-06; on accounts opened from 2026-08-31 the request
 * fails with 400, older accounts opt in). Appended messages, `role: 'system'`
 * ones included, and every parameter outside system, tools and messages
 * (`max_tokens`, effort, `tool_choice`) may change.
 *
 * A request to such a model is in STABLE-PREFIX MODE: the loops append instead
 * of rewriting (memory recall, handoff instructions, tool-set changes), and
 * compaction replaces the whole history with one summary. Other models keep the
 * 2.2 placements. Not live-verified.
 */
import type { LanguageModel } from '../types/model';
import { registryMatch } from '../core/registry';

/** The models that bind thinking to the prefix; an unknown 5.x id on the family fallback counts too. */
const PREFIX_BOUND_MODELS: ReadonlySet<string> = new Set([
  'claude-fable-5-1',
  'claude-opus-5-5',
  'claude-sonnet-5-5',
  'claude-haiku-5-5',
]);

/** True when `model` binds its thinking blocks to the transcript prefix (Anthropic wire only). */
export function bindsThinkingToPrefix(model: LanguageModel): boolean {
  if (model.surface !== 'anthropic') return false;
  return PREFIX_BOUND_MODELS.has(model.modelId) || registryMatch(model) === 'family';
}
