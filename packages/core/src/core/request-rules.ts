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

type RequestContext = Pick<BuildContext, 'call' | 'logger' | 'warnings'>;

/**
 * Report a value the request builder changed or dropped. Typed on the call's
 * sink (deduped across the steps of a run) and logged ONCE: the log line is
 * written only when the sink accepted the entry, so a loop that rebuilds the
 * request every step does not repeat it. A direct `buildRequest` with no sink
 * still logs.
 */
export function reportRequestWarning(ctx: RequestContext, warning: CallWarning): void {
  const sink = ctx.warnings;
  if (sink) {
    const before = sink.list().length;
    sink.add(warning, { mirror: false });
    if (sink.list().length === before) return;
  }
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
  /** Send the wire's literal `'none'` (OpenAI). */
  none?: true;
  /** Turn thinking off instead of sending a level (Anthropic). */
  thinkingOff?: 'disabled' | 'between_tools';
}

/**
 * Decide what the wire carries for `options.effort` and report every change.
 *
 * `accepted` is what this (model, wire) pair takes when the row lists nothing
 * (the wire's historical mapping); `noneDefault` is the wire's historical
 * answer to `'none'` — absent means "send nothing, silently", which leaves the
 * model at its own default. Effort is gated on `caps.reasoning` exactly as
 * before; `core/inference.ts` reports that drop.
 */
export function planEffort(
  ctx: BuildContext,
  accepted: readonly EffortLevel[],
  noneDefault?: EffortNoneMapping,
): EffortPlan {
  const { caps, options, call } = ctx;
  const effort = options.effort;
  if (!caps.reasoning || effort === undefined) return {};
  const levels = caps.effortLevels ?? accepted;
  const who = `${call.provider}/${call.modelId}`;

  if (effort === 'none') {
    const mapping = caps.effortNone ?? noneDefault;
    if (mapping === undefined) return {};
    if (mapping === 'send') return { none: true };
    if (mapping === 'thinking-disabled') return { thinkingOff: 'disabled' };
    if (mapping === 'thinking-between-tools') return { thinkingOff: 'between_tools' };
    const lowest = mapping === 'lowest' ? clampEffortLevel('low', levels) : undefined;
    if (lowest !== undefined) {
      reportClamp(
        ctx,
        'effort',
        `effort 'none' was sent as '${lowest}': ${who} cannot turn reasoning off.`,
      );
      return { level: lowest };
    }
    reportDrop(
      ctx,
      'effort',
      `effort 'none' was dropped from the request: ${who} cannot turn reasoning off and ` +
        'documents no effort level to send instead.',
    );
    return {};
  }

  if (levels.length === 0) {
    reportDrop(
      ctx,
      'effort',
      `effort '${effort}' was dropped from the request: ${who} documents no effort levels.`,
    );
    return {};
  }
  const level = clampEffortLevel(effort, levels)!;
  if (level !== effort) {
    reportClamp(
      ctx,
      'effort',
      `effort '${effort}' was sent as '${level}': ${who} accepts ${levels.join('/')}.`,
    );
  }
  return { level };
}

/**
 * The output cap for a wire where it is OPTIONAL (2.3): the caller's
 * `maxOutputTokens`, else the row's limit — or `undefined` (leave it off) when
 * the row only holds a placeholder. An unknown model is then bounded by the
 * provider's own default instead of being truncated at the SDK's 4096 guess.
 */
export function optionalOutputCap(
  caps: ModelCapabilities,
  options: CommonCallOptions,
): number | undefined {
  if (options.maxOutputTokens !== undefined) return options.maxOutputTokens;
  return isMaxOutputPlaceholder(caps) ? undefined : caps.maxOutput;
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
