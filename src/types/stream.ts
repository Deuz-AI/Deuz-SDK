import type { Usage, FinishReason } from './usage';

/**
 * Canonical streaming delta. Open discriminated union — consumers should keep a
 * `default` case because Faz 1+ may add variants (additive). `fullStream`
 * yields these; `textStream` is the text-only convenience projection.
 */
export interface TextDeltaPart {
  type: 'text-delta';
  text: string;
}

export interface ReasoningDeltaPart {
  type: 'reasoning-delta';
  text: string;
  signature?: string;
}

export interface ToolCallDeltaPart {
  type: 'tool-call-delta';
  id: string;
  name?: string;
  /** Raw argument JSON fragment — accumulate as string, parse once at block end. */
  argsTextDelta: string;
}

export interface SourcePart {
  type: 'source';
  id: string;
  url?: string;
  title?: string;
}

export interface FinishStreamPart {
  type: 'finish';
  usage: Usage;
  finishReason: FinishReason;
}

export interface ErrorStreamPart {
  type: 'error';
  error: unknown;
}

export type StreamPart =
  | TextDeltaPart
  | ReasoningDeltaPart
  | ToolCallDeltaPart
  | SourcePart
  | FinishStreamPart
  | ErrorStreamPart;
