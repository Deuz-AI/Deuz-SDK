/**
 * Canonical message & content-part types. Locked in the 1.0 public surface:
 * adding a new `Part` kind later is a breaking change, so all known kinds
 * (including `reasoning`) MUST exist now even if values are stubbed.
 */

export type Role = 'system' | 'user' | 'assistant' | 'tool';

export interface TextPart {
  type: 'text';
  text: string;
  /**
   * Opaque provider round-trip data for this text (2.3 additive), echoed back
   * on the next turn by the wire that set it: Gemini can sign a plain text part
   * (`{ google: { thoughtSignature } }`). Other wires ignore it.
   */
  providerMetadata?: Record<string, unknown>;
}

export interface ImagePart {
  type: 'image';
  /** base64 string, data URL, http URL, or raw bytes. */
  image: string | Uint8Array;
  mediaType?: string;
}

export interface ToolUsePart {
  type: 'tool_use';
  id: string;
  name: string;
  input: unknown;
  /**
   * Opaque provider round-trip data that MUST be echoed back on the next turn
   * (e.g. Gemini's `extra_content.google.thought_signature` — without it the
   * follow-up request 400s). Set by the adapter, serialized back by it.
   */
  providerMetadata?: Record<string, unknown>;
}

export interface ToolResultPart {
  type: 'tool_result';
  toolUseId: string;
  result: unknown;
  isError?: boolean;
}

/**
 * Reasoning / thinking content. MUST round-trip in the agentic loop:
 * Anthropic requires `thinking` + `signature`, Gemini `thoughtSignature`,
 * OpenAI Responses encrypted reasoning. Dropping it breaks multi-step tools.
 *
 * One part per provider block (2.3): a block whose `text` is empty but which
 * carries a `signature` is real (Claude's default `display: 'omitted'`), and
 * blocks are never merged or reordered, because a modified block is rejected.
 */
export interface ReasoningPart {
  type: 'reasoning';
  text: string;
  signature?: string;
  /** `text` is an opaque encrypted payload (OpenAI Responses), not display text. */
  encrypted?: boolean;
  /** `text` is the opaque `data` of a provider-redacted block (Anthropic `redacted_thinking`). */
  redacted?: boolean;
  /**
   * The provider family whose API produced this block (2.3 additive):
   * `'anthropic'`, `'openai'`, `'google'`, or the Chat Completions host's
   * provider id (for example `'deepseek'`). A wire replays only its own
   * family's reasoning, so another provider never receives it. A part without
   * one (written before 2.3) keeps the 2.2 behaviour.
   */
  source?: string;
}

export type Part = TextPart | ImagePart | ToolUsePart | ToolResultPart | ReasoningPart;

export interface Message {
  role: Role;
  content: string | Part[];
  /** Provider round-trip metadata at the message level (e.g. `{ openai: { phase } }`). Additive, optional. */
  providerMetadata?: Record<string, unknown>;
}
