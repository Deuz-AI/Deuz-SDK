/**
 * Reasoning provenance (2.3, F21). A reasoning block is opaque state that only
 * the API which produced it can read back: an Anthropic signature, an OpenAI
 * encrypted reasoning item, a Gemini thought signature, a Chat Completions
 * host's `reasoning_content`. The canonical history is shared by every wire, so
 * a conversation that moves to another provider (fallback, handoff, a
 * `prepareStep` model switch, or the caller's own choice) carries the old
 * provider's reasoning along. Each wire therefore replays only its own family's
 * blocks; the rest stay in the history for the provider that can use them.
 *
 * Pure and edge-safe: no I/O, no logging.
 */
import type { ReasoningPart } from '../types/message';

/** The family a reasoning part came from; `undefined` when a pre-2.3 part does not say. */
export function reasoningSource(part: ReasoningPart): string | undefined {
  if (part.source !== undefined) return part.source;
  // Parts written before 2.3 carry no source, but two kinds name their origin:
  // only OpenAI Responses produced encrypted reasoning, and only Anthropic
  // produced redacted thinking.
  if (part.encrypted) return 'openai';
  if (part.redacted) return 'anthropic';
  return undefined;
}

/**
 * Whether `part` may ride a request of `family`'s wire: its own family's
 * reasoning always, another family's never, and a pre-2.3 part of unknown
 * origin as before 2.3.
 */
export function replaysTo(part: ReasoningPart, family: string): boolean {
  const source = reasoningSource(part);
  return source === undefined || source === family;
}
