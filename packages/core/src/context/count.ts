/**
 * The one token counter (2.4, spec §2.3): `createTokenEstimator` counts
 * messages; these helpers count a text placed inside a message and what a
 * request costs beyond its messages (tool schemas, the output schema and the
 * provider's framing), through the same estimator, so its calibration
 * applies to every part. These are estimates: a provider's real count may
 * differ, which is why the manifest names the estimator it used. Edge-safe.
 */
import { createTokenEstimator, type TokenEstimator } from '../internal/estimate-tokens';
import type { Message } from '../types/message';

/**
 * Tokens Anthropic adds to a request that carries tools (its tool-use system
 * prompt, documented as 346 tokens with `tool_choice` auto or none). An
 * estimate; pass `framingTokens` to use your own figure.
 */
export const ANTHROPIC_TOOL_FRAMING_TOKENS = 346;

/** The fixed cost of one tool definition beyond its text (name, braces, keys). */
const TOOL_DEFINITION_TOKENS = 10;

/** The estimator used when none is given: uncalibrated, so counts are stable. */
const DEFAULT_ESTIMATOR = createTokenEstimator();

/** A tool as the request sends it: its name, description and JSON Schema. */
export interface ContextToolSchema {
  name: string;
  description?: string;
  /** The tool's input JSON Schema. */
  parameters?: unknown;
}

/** What a request sends besides its messages. */
export interface RequestOverheadInput {
  /** The active tools' definitions. */
  tools?: readonly ContextToolSchema[];
  /** The structured-output JSON Schema, when there is one. */
  outputSchema?: unknown;
  /** The provider id: `'anthropic'` adds its tool-use framing when tools are present. */
  provider?: string;
  /** The provider's framing in tokens, replacing the built-in figure. */
  framingTokens?: number;
}

function safeJson(value: unknown): string {
  if (value === undefined) return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return '';
  }
}

/**
 * The tokens `text` adds inside a message: the estimator's count of a
 * one-message array, less that of an empty message (the per-message
 * overhead). 0 for an empty text.
 */
export function estimateTextTokens(
  text: string,
  estimator: TokenEstimator = DEFAULT_ESTIMATOR,
): number {
  if (text === '') return 0;
  const full = estimator.estimate([{ role: 'user', content: text }]);
  const empty = estimator.estimate([{ role: 'user', content: '' }]);
  return Math.max(0, full - empty);
}

/**
 * What a request costs beyond its messages (2.4): every tool definition
 * (name, description, schema), the output schema, and the provider's framing
 * (`framingTokens`, or Anthropic's tool-use prompt when tools are present).
 * Never throws: a schema JSON cannot encode counts as empty.
 */
export function estimateRequestOverhead(
  input: RequestOverheadInput,
  estimator: TokenEstimator = DEFAULT_ESTIMATOR,
): number {
  const tools = input.tools ?? [];
  let total = 0;
  for (const tool of tools) {
    const text = `${tool.name}\n${tool.description ?? ''}\n${safeJson(tool.parameters)}`;
    total += estimateTextTokens(text, estimator) + TOOL_DEFINITION_TOKENS;
  }
  if (input.outputSchema !== undefined)
    total += estimateTextTokens(safeJson(input.outputSchema), estimator);
  if (input.framingTokens !== undefined) total += Math.max(0, Math.ceil(input.framingTokens));
  else if (tools.length > 0 && input.provider === 'anthropic')
    total += ANTHROPIC_TOOL_FRAMING_TOKENS;
  return total;
}

/** The full request estimate (2.4): its messages plus `estimateRequestOverhead`. */
export function estimateRequestTokens(
  input: RequestOverheadInput & { messages: Message[] },
  estimator: TokenEstimator = DEFAULT_ESTIMATOR,
): number {
  return estimator.estimate(input.messages) + estimateRequestOverhead(input, estimator);
}
