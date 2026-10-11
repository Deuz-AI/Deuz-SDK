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
import type { Message } from '../types/message';
import type { WireTool } from '../adapters/types';
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

// --- tool-set changes -----------------------------------------------------------
//
// The `tools` array is part of the bound prefix too, so a request in
// stable-prefix mode carries the same array for the whole run leg, and a step
// that offers a different set (`prepareStep.activeTools`, a handoff, an MCP
// catalog change) says so in the conversation instead: one appended system
// message whose `providerMetadata.deuz.toolChanges` lists what is withdrawn and
// what is added. The Anthropic wire renders it as the `tool_removal` /
// `tool_addition` blocks of the beta `mid-conversation-tool-changes-2026-07-01`
// (inline definitions: `inline-tools-2026-09-15`), the shape the SDK's own
// tool runner sends; every other wire skips it, since it carries no text.

/** A change of the tool set offered to the model, from its position in the history onward. */
export interface ToolSetChange {
  /** Tools withdrawn, by name. */
  remove: string[];
  /** Tools offered from here on that were not, or not with this definition. */
  add: WireTool[];
}

/** The tool-set change a message carries, if it is one. */
export function toolSetChangeOf(message: {
  role: string;
  providerMetadata?: Record<string, unknown>;
}): ToolSetChange | undefined {
  if (message.role !== 'system') return undefined;
  const deuz = message.providerMetadata?.deuz as { toolChanges?: unknown } | undefined;
  const change = deuz?.toolChanges as Partial<ToolSetChange> | undefined;
  if (!change || !Array.isArray(change.remove) || !Array.isArray(change.add)) return undefined;
  return { remove: change.remove, add: change.add };
}

/** The system message that carries `change`. */
export function toolSetChangeMessage(change: ToolSetChange): Message {
  return { role: 'system', content: [], providerMetadata: { deuz: { toolChanges: change } } };
}
