/**
 * Pure, edge-safe token estimator used for compaction thresholds (NOT for
 * budget stops — those read real usage). Char-count heuristic (~3.6 chars per
 * token) corrected by a session-local EMA factor fed from actual usage; all
 * state lives inside the created instance so estimates stay deterministic.
 */
import type { Message, Part } from '../types/message';

export interface TokenEstimator {
  /** Calibrated token estimate for a message array (0 for an empty array). */
  estimate(messages: Message[]): number;
  /** Feed real input-token usage after a step to tighten future estimates. */
  calibrate(actualInputTokens: number, estimatedAtCall: number): void;
}

const CHARS_PER_TOKEN = 3.6;
const MESSAGE_OVERHEAD_TOKENS = 4;
const IMAGE_PART_TOKENS = 1600;
const TOOL_PART_OVERHEAD_TOKENS = 10;
const DOCUMENT_PART_TOKENS = 1000;
const UNKNOWN_PART_TOKENS = 8;
const FACTOR_MIN = 0.5;
const FACTOR_MAX = 2.0;
const EMA_WEIGHT = 0.3;

/** Stringify arbitrary tool payloads without ever throwing (circular refs, undefined). */
function safeStringify(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return '';
  }
}

function estimatePart(part: Part): number {
  switch (part.type) {
    case 'text':
    case 'reasoning':
      return part.text.length / CHARS_PER_TOKEN;
    case 'image':
      return IMAGE_PART_TOKENS;
    case 'tool_use':
      return safeStringify(part.input).length / CHARS_PER_TOKEN + TOOL_PART_OVERHEAD_TOKENS;
    case 'tool_result':
      return safeStringify(part.result).length / CHARS_PER_TOKEN + TOOL_PART_OVERHEAD_TOKENS;
    default: {
      // Future-proof: `Part` is exhaustive today, but new kinds may arrive at
      // runtime (e.g. document/file parts) before the union grows.
      const unknown = part as { type?: string; data?: unknown };
      if (unknown.type === 'document' || unknown.type === 'file') {
        return typeof unknown.data === 'string'
          ? unknown.data.length / CHARS_PER_TOKEN
          : DOCUMENT_PART_TOKENS;
      }
      return UNKNOWN_PART_TOKENS;
    }
  }
}

function estimateBase(messages: Message[]): number {
  let total = 0;
  for (const message of messages) {
    total += MESSAGE_OVERHEAD_TOKENS;
    if (typeof message.content === 'string') {
      total += message.content.length / CHARS_PER_TOKEN;
    } else {
      for (const part of message.content) total += estimatePart(part);
    }
  }
  return total;
}

/** Create an estimator with its own EMA correction factor (starts at 1.0). */
export function createTokenEstimator(): TokenEstimator {
  let factor = 1.0;

  return {
    estimate(messages) {
      return Math.ceil(estimateBase(messages) * factor);
    },
    calibrate(actualInputTokens, estimatedAtCall) {
      if (estimatedAtCall <= 0) return;
      const ratio = actualInputTokens / estimatedAtCall;
      const next = (1 - EMA_WEIGHT) * factor + EMA_WEIGHT * ratio;
      factor = Math.min(FACTOR_MAX, Math.max(FACTOR_MIN, next));
    },
  };
}
