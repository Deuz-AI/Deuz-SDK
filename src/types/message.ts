/**
 * Canonical message & content-part types. Locked in the 1.0 public surface:
 * adding a new `Part` kind later is a breaking change, so all known kinds
 * (including `reasoning`) MUST exist now even if values are stubbed.
 */

export type Role = 'system' | 'user' | 'assistant' | 'tool';

export interface TextPart {
  type: 'text';
  text: string;
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
 */
export interface ReasoningPart {
  type: 'reasoning';
  text: string;
  signature?: string;
  encrypted?: boolean;
  redacted?: boolean;
}

export type Part = TextPart | ImagePart | ToolUsePart | ToolResultPart | ReasoningPart;

export interface Message {
  role: Role;
  content: string | Part[];
}
