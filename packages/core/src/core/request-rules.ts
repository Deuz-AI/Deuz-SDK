/**
 * Request-building rules shared by the four wire adapters (2.3): which effort
 * value reaches the wire, how `effort: 'none'` is honoured, when the output cap
 * may be left off, which wires a model takes tools on — and a typed warning
 * for EVERY value the SDK changes on the way (F26: no silent clamps).
 *
 * Pure and edge-safe: no I/O, no clock, no console. Everything here reads the
 * resolved capability row, so the rules follow the model, not the wire.
 */
import type { BuildContext } from '../adapters/types';
import type { CommonCallOptions } from '../types/config';
import type { CallWarning } from '../types/methods';
import type { ModelSurface } from '../types/model';
import type { ToolChoice } from '../types/tool';
import { InvalidRequestError } from '../errors';
import {
  isMaxOutputPlaceholder,
  type EffortLevel,
  type EffortNoneMapping,
  type ModelCapabilities,
} from './registry';

/** Every canonical level, ascending — the scale effort clamping walks. */
export const EFFORT_SCALE: readonly EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max'];

/**
 * The OpenAI wires' historical levels. `'max'` is not among them, so it still
 * clamps to `'xhigh'` (now with a warning) unless the row lists it — e.g.
 * `gpt-6.1-sol`, where `'max'` is a real value.
 */
export const OPENAI_EFFORT: readonly EffortLevel[] = ['low', 'medium', 'high', 'xhigh'];

/** The request field `effort` is written to (2.3). */
export type EffortField =
  | 'output_config.effort'
  | 'thinking.budget_tokens'
  | 'reasoning_effort'
  | 'reasoning.effort'
  | 'thinkingConfig.thinkingLevel'
  | 'thinkingConfig.thinkingBudget';

/**
 * How one (wire, model) pair carries `effort` (2.3). The single table both the
 * adapters and the model profile read, so what a profile reports is what a
 * request sends.
 */
export interface EffortWire {
  field: EffortField;
  /** Levels the pair takes when the row lists none — the wire's historical mapping. */
  accepted: readonly EffortLevel[];
  /**
   * The wire's historical answer to `'none'` when the row says nothing. Absent →
   * nothing is sent, silently, which leaves the model at its own default.
   */
  noneDefault?: EffortNoneMapping;
  /** A budget wire: the token budget each level is sent as. */
  budgets?: Readonly<Record<EffortLevel, number>>;
}

/** Anthropic `thinking.budget_tokens` per level: 'xhigh' and 'max' share the top budget. */
const ANTHROPIC_BUDGETS: Readonly<Record<EffortLevel, number>> = {
  low: 4_000,
  medium: 10_000,
  high: 24_000,
  xhigh: 48_000,
  max: 48_000,
};

/** Gemini 2.5 `thinkingBudget` per level: 'xhigh' and 'max' share the top budget. */
const GEMINI_BUDGETS: Readonly<Record<EffortLevel, number>> = {
  low: 4096,
  medium: 12288,
  high: 24576,
  xhigh: 32768,
  max: 32768,
};

/** Gemini 3 and Argon use thinkingLevel; Gemini 2.5 uses thinkingBudget. */
function usesThinkingLevel(modelId: string): boolean {
  return modelId === 'gemini-4-argon' || /^gemini-3/.test(modelId);
}

/** Pro-tier Gemini 3 models accept only low/high thinking levels. */
function levelOnlyLowHigh(modelId: string): boolean {
  return /^gemini-3(\.\d+)?-pro/.test(modelId);
}

/** Where `effort` rides for this model on this wire, and what the wire takes by default. */
export function effortWire(
  surface: ModelSurface,
  caps: ModelCapabilities,
  modelId: string,
): EffortWire {
  switch (surface) {
    case 'anthropic':
      // Opus 4.7+/Sonnet 5/Fable 5/Claude 5.x: budget_tokens returns 400 — effort rides output_config.
      return caps.effortWire === 'output_config'
        ? { field: 'output_config.effort', accepted: EFFORT_SCALE }
        : { field: 'thinking.budget_tokens', accepted: EFFORT_SCALE, budgets: ANTHROPIC_BUDGETS };
    case 'chat_completions':
      // 'none' is a real OpenAI value (disables reasoning).
      return { field: 'reasoning_effort', accepted: OPENAI_EFFORT, noneDefault: 'send' };
    case 'responses':
      return { field: 'reasoning.effort', accepted: OPENAI_EFFORT, noneDefault: 'send' };
    case 'native':
      return usesThinkingLevel(modelId)
        ? {
            field: 'thinkingConfig.thinkingLevel',
            accepted: levelOnlyLowHigh(modelId) ? ['low', 'high'] : ['low', 'medium', 'high'],
            ...(modelId === 'gemini-4-argon' ? { noneDefault: 'lowest' as const } : {}),
          }
        : {
            field: 'thinkingConfig.thinkingBudget',
            accepted: EFFORT_SCALE,
            budgets: GEMINI_BUDGETS,
          };
  }
}

/** The other levels a budget wire sends with the same budget as `level`. */
export function budgetPeers(
  budgets: Readonly<Record<EffortLevel, number>>,
  level: EffortLevel,
): EffortLevel[] {
  return EFFORT_SCALE.filter((other) => other !== level && budgets[other] === budgets[level]);
}

/**
 * What reporting needs. Without `warnings` and `logger` nothing is reported, so
 * native admission can replay a rule silently (F12).
 */
type RequestContext = { call: Pick<BuildContext['call'], 'provider' | 'modelId'> } & Pick<
  BuildContext,
  'logger' | 'warnings'
>;

/** What {@link planEffort} reads. Every `BuildContext` is one. */
export type EffortContext = RequestContext & {
  caps: ModelCapabilities;
  options: Pick<CommonCallOptions, 'effort'>;
};

/**
 * Report a value the request builder changed or dropped. Typed on the call's
 * sink (deduped across the steps of a run) and logged ONCE: the log line is
 * written only when the sink reports the entry as new, so a loop that rebuilds
 * the request every step does not repeat it, and a run past the sink's list cap
 * still logs a new one. A direct `buildRequest` with no sink still logs.
 */
export function reportRequestWarning(ctx: RequestContext, warning: CallWarning): void {
  if (ctx.warnings && !ctx.warnings.add(warning, { mirror: false })) return;
  ctx.logger?.warn(warning.message, {
    warning: warning.type,
    ...(warning.setting !== undefined ? { setting: warning.setting } : {}),
    provider: ctx.call.provider,
    modelId: ctx.call.modelId,
  });
}

/** A value the wire carries in a different form than the caller asked for. */
export function reportClamp(ctx: RequestContext, setting: string, message: string): void {
  reportRequestWarning(ctx, { type: 'clamped-setting', setting, message });
}

/** A value the wire cannot carry at all. */
export function reportDrop(ctx: RequestContext, setting: string, message: string): void {
  reportRequestWarning(ctx, { type: 'unsupported-setting', setting, message });
}

const rank = (level: EffortLevel): number => EFFORT_SCALE.indexOf(level);

/**
 * `requested` when the model accepts it; otherwise the nearest accepted level
 * BELOW it (never more reasoning than asked for), or the lowest accepted level
 * when none is below. `undefined` only for an empty list.
 */
export function clampEffortLevel(
  requested: EffortLevel,
  accepted: readonly EffortLevel[],
): EffortLevel | undefined {
  if (accepted.includes(requested)) return requested;
  const ascending = [...accepted].sort((a, b) => rank(a) - rank(b));
  let below: EffortLevel | undefined;
  for (const level of ascending) if (rank(level) <= rank(requested)) below = level;
  return below ?? ascending[0];
}

/** True when `level` is known and no deeper than `'high'`. */
export function atMostHigh(level: EffortLevel | undefined): boolean {
  return level !== undefined && rank(level) <= rank('high');
}

/** What reaches the wire for `options.effort`. Empty = send nothing. */
export interface EffortPlan {
  /** A level to send, already clamped to what the model accepts. */
  level?: EffortLevel;
  /** Budget wires: the token budget `level` is sent as. */
  budget?: number;
  /** Send the wire's literal `'none'` (OpenAI). */
  none?: true;
  /** Turn thinking off instead of sending a level (Anthropic). */
  thinkingOff?: 'disabled' | 'between_tools';
}

/**
 * Decide what the wire carries for `options.effort` and report every change.
 *
 * `wire` is this (model, wire) pair's entry from {@link effortWire}: its
 * `accepted` levels apply when the row lists none, its `noneDefault` answers
 * `'none'` when the row says nothing, and on a budget wire a level that shares
 * its budget with another is reported too. Effort is gated on `caps.reasoning`
 * exactly as before; `core/inference.ts` reports that drop.
 */
export function planEffort(ctx: EffortContext, wire: EffortWire): EffortPlan {
  const { caps, options, call } = ctx;
  const effort = options.effort;
  if (!caps.reasoning || effort === undefined) return {};
  const levels = caps.effortLevels ?? wire.accepted;
  const who = `${call.provider}/${call.modelId}`;

  let level: EffortLevel;
  if (effort === 'none') {
    const mapping = caps.effortNone ?? wire.noneDefault;
    if (mapping === undefined) return {};
    if (mapping === 'send') return { none: true };
    if (mapping === 'thinking-disabled') return { thinkingOff: 'disabled' };
    if (mapping === 'thinking-between-tools') return { thinkingOff: 'between_tools' };
    const lowest = mapping === 'lowest' ? clampEffortLevel('low', levels) : undefined;
    if (lowest === undefined) {
      reportDrop(
        ctx,
        'effort',
        `effort 'none' was dropped from the request: ${who} cannot turn reasoning off and ` +
          'documents no effort level to send instead.',
      );
      return {};
    }
    reportClamp(
      ctx,
      'effort',
      `effort 'none' was sent as '${lowest}': ${who} cannot turn reasoning off.`,
    );
    level = lowest;
  } else {
    if (levels.length === 0) {
      reportDrop(
        ctx,
        'effort',
        `effort '${effort}' was dropped from the request: ${who} documents no effort levels.`,
      );
      return {};
    }
    level = clampEffortLevel(effort, levels)!;
    if (level !== effort) {
      reportClamp(
        ctx,
        'effort',
        `effort '${effort}' was sent as '${level}': ${who} accepts ${levels.join('/')}.`,
      );
    } else if (wire.budgets && budgetPeers(wire.budgets, level).length > 0) {
      const same = [level, ...budgetPeers(wire.budgets, level)].sort((a, b) => rank(a) - rank(b));
      reportClamp(
        ctx,
        'effort',
        `effort '${level}' was sent as ${wire.field} ${wire.budgets[level]}: that wire gives ` +
          `'${same.join("' and '")}' the same budget (${call.modelId}).`,
      );
    }
  }
  return wire.budgets ? { level, budget: wire.budgets[level] } : { level };
}

/**
 * The output cap for a wire where it is OPTIONAL (2.3): the caller's
 * `maxOutputTokens`, else the row's limit — or `undefined` (leave it off) when
 * the row only holds a placeholder. An unknown model is then bounded by the
 * provider's own default instead of being truncated at the SDK's 4096 guess.
 */
export function optionalOutputCap(
  caps: ModelCapabilities,
  options: Pick<CommonCallOptions, 'maxOutputTokens'>,
): number | undefined {
  if (options.maxOutputTokens !== undefined) return options.maxOutputTokens;
  return isMaxOutputPlaceholder(caps) ? undefined : caps.maxOutput;
}

/**
 * Anthropic's `max_tokens` (2.3). The field is REQUIRED on this wire, so an
 * unknown model's placeholder is still sent. While extended thinking runs on a
 * `budget_tokens` budget the cap is raised to `budget + 1024`, even over an
 * explicit `maxOutputTokens`. The adapter and native admission both call this,
 * so a reservation covers the cap the wire sends (F12).
 */
export function anthropicMaxTokens(
  caps: ModelCapabilities,
  requested: number | undefined,
  budget: number | undefined,
): number {
  const cap = requested ?? caps.maxOutput;
  return budget !== undefined && cap < budget + 1_024 ? budget + 1_024 : cap;
}

/** `'required'` or a named tool — the choices a model may refuse to be forced into. */
export function isForcedToolChoice(choice: ToolChoice | undefined): boolean {
  return choice === 'required' || (typeof choice === 'object' && choice !== null);
}

/** How a forced choice reads in a warning. */
export function describeToolChoice(choice: ToolChoice): string {
  return typeof choice === 'object'
    ? `{ type: 'tool', toolName: '${choice.toolName}' }`
    : `'${choice}'`;
}

/**
 * Fail fast when the model takes tools only on another wire (2.3) — e.g.
 * `gpt-6.1-sol` calls tools on the Responses API only. A tool request (or the
 * forced-tool structured-output strategy) on the wrong wire would otherwise be
 * an opaque provider 400; this names the cure.
 */
export function assertToolSurface(ctx: BuildContext, surface: ModelSurface): void {
  const allowed = ctx.caps.toolSurfaces;
  if (!allowed || allowed.includes(surface)) return;
  const wantsTools = (ctx.tools?.tools.length ?? 0) > 0 || ctx.object?.strategy === 'tool';
  if (!wantsTools) return;
  throw new InvalidRequestError({
    message:
      `${ctx.call.modelId} accepts tool calling only on the ${allowed.join('/')} wire, not ` +
      `${surface}. Use the matching factory (for OpenAI: createOpenAIResponses) or drop the tools.`,
    provider: ctx.call.provider,
  });
}
