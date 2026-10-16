import type {
  LanguageModel,
  ModelSurface,
  EmbeddingModel,
  EmbeddingModelSurface,
} from '../types/model';
import type { Logger } from '../types/deps';
import type { WarningSink } from '../internal/warnings';
import { readConfig } from '../internal/config-symbol';

/** A canonical effort level other than `'none'`, in ascending order of depth (2.3). */
export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/**
 * How a model honours `effort: 'none'` (2.3):
 *  - `'send'` — the wire has a real `'none'` value (OpenAI);
 *  - `'thinking-disabled'` / `'thinking-between-tools'` — Anthropic turns
 *    thinking off with `thinking: { type: 'disabled' | 'between_tools' }`;
 *  - `'lowest'` — reasoning cannot be turned off, so the lowest accepted level
 *    is sent with a `clamped-setting` warning;
 *  - `'omit'` — reasoning cannot be turned off and no level is documented, so
 *    nothing is sent and an `unsupported-setting` warning says so.
 */
export type EffortNoneMapping =
  | 'send'
  | 'thinking-disabled'
  | 'thinking-between-tools'
  | 'lowest'
  | 'omit';

/**
 * Single source of truth for per-model behavior. Everything capability-aware
 * (which params to send, structured-output strategy, quirk handling, default
 * max_tokens) reads from here. Unknown slugs DO NOT throw — new models ship
 * constantly — they fall back to a CONSERVATIVE default row by (provider,
 * surface) and `logger.warn`, so a future `claude-opus-4-9` still works.
 */
export interface ModelCapabilities {
  provider: string;
  surface: ModelSurface;
  vision: boolean;
  tools: boolean;
  reasoning: boolean;
  /** Native structured output (json_schema / output_config). */
  structuredOutput: boolean;
  /** Explicit prompt-cache breakpoints are controllable (Anthropic). */
  caching: boolean;
  nativePdf: boolean;
  audio: boolean;
  contextWindow: number;
  /**
   * Output ceiling, sent as the wire's output cap when the caller gives no
   * `maxOutputTokens`. When the row does not know the model's limit (an unknown
   * slug, or a 2.3 row whose limit is undocumented) this is only a conservative
   * PLACEHOLDER (2.3): wires where the cap is optional (OpenAI Chat Completions
   * and Responses, Gemini native) omit it instead of truncating there, and the
   * Anthropic wire — where `max_tokens` is required — sends it; the
   * `unknown-model` warning names that default. A `capabilities: { maxOutput }`
   * override (or `maxOutputTokens` per call) replaces the placeholder.
   */
  maxOutput: number;
  /** Provider returns usage on EVERY chunk → take the LAST (Gemini-compat). */
  usagePerChunk: boolean;
  /** Streaming tool deltas all arrive with index=0 → order-based slotting. */
  toolIndexAllZero: boolean;
  /** Reasoning models reject temperature/topP/max_tokens → strip them. */
  samplingRestrictions: boolean;
  /** How reasoning depth is sent to Anthropic: manual `thinking.budget_tokens`
   *  (pre-4.7) vs `output_config.effort` (Opus 4.7+, Sonnet 5, Fable 5 —
   *  budget_tokens returns 400 there). Non-Anthropic wires ignore this. */
  effortWire: 'budget_tokens' | 'output_config';
  /**
   * A FORCED `toolChoice` (`'required'` or a named tool) is accepted (2.3).
   * `false` → the wire sends auto instead, with a `clamped-setting` warning, and
   * structured output never takes the forced-tool strategy. Absent → not known
   * to be rejected (the wire's own rules apply, e.g. Anthropic's "no forced tool
   * while extended thinking is on").
   */
  forcedToolChoice?: boolean;
  /**
   * Effort levels the model accepts on the wire, ascending (2.3). A requested
   * level the model lacks is clamped DOWN to the nearest accepted one (or up to
   * the lowest) with a `clamped-setting` warning. An EMPTY list means the model
   * exposes no effort control: effort is dropped with an `unsupported-setting`
   * warning. Absent → the wire's historical mapping. `'none'` is never listed —
   * see {@link ModelCapabilities.effortNone}.
   */
  effortLevels?: readonly EffortLevel[];
  /** The provider's documented default effort when none is sent (2.3, informational). */
  effortDefault?: EffortLevel;
  /** How `effort: 'none'` is honoured (2.3). Absent → the wire's historical behaviour. */
  effortNone?: EffortNoneMapping;
  /**
   * The only wires on which this model accepts tool calling (2.3). Absent → any.
   * A tool request on another wire fails fast with an `InvalidRequestError`
   * instead of an opaque provider 400 (e.g. `gpt-6.1-sol` takes tools only on
   * the Responses API).
   */
  toolSurfaces?: readonly ModelSurface[];
  /** False when this row is a fallback for an unknown slug. */
  known: boolean;
}

type Row = Omit<ModelCapabilities, 'known'>;

function row(provider: string, surface: ModelSurface, over: Partial<Row>): Row {
  return {
    provider,
    surface,
    vision: false,
    tools: true,
    reasoning: false,
    structuredOutput: true,
    caching: false,
    nativePdf: false,
    audio: false,
    contextWindow: 128_000,
    maxOutput: 8_192,
    usagePerChunk: false,
    toolIndexAllZero: false,
    samplingRestrictions: false,
    effortWire: 'budget_tokens',
    ...over,
  };
}

/** The conservative output placeholder for a limit the registry does not know. */
const PLACEHOLDER_MAX_OUTPUT = 4_096;

/**
 * Rows whose `maxOutput` is a PLACEHOLDER rather than the model's documented
 * limit (2.3): every fallback row, plus pinned rows whose limit is undocumented.
 * Identity sets — `finalize` tags the frozen copy it hands out, so the wire can
 * tell a placeholder from a real limit without a public flag.
 */
const PLACEHOLDER_ROWS = new WeakSet<Row>();
const PLACEHOLDER_CAPS = new WeakSet<ModelCapabilities>();

// A documented limit and an omitted default request cap are separate facts.
// Keep the server's default without treating the known limit as a placeholder.
const PROVIDER_OUTPUT_DEFAULT_ROWS = new WeakSet<Row>();
const PROVIDER_OUTPUT_DEFAULT_CAPS = new WeakSet<ModelCapabilities>();

function providerOutputDefault(provider: string, surface: ModelSurface, over: Partial<Row>): Row {
  const result = row(provider, surface, over);
  PROVIDER_OUTPUT_DEFAULT_ROWS.add(result);
  return result;
}

/** Whether an optional wire cap is left to the provider unless explicitly overridden. */
export function omitsDefaultOutputCap(caps: ModelCapabilities): boolean {
  return isMaxOutputPlaceholder(caps) || PROVIDER_OUTPUT_DEFAULT_CAPS.has(caps);
}

/** A pinned row whose output limit is undocumented: `maxOutput` is a placeholder. */
function undocumentedOutput(provider: string, surface: ModelSurface, over: Partial<Row>): Row {
  const r = row(provider, surface, { ...over, maxOutput: PLACEHOLDER_MAX_OUTPUT });
  PLACEHOLDER_ROWS.add(r);
  return r;
}

/**
 * True when `caps.maxOutput` is only a placeholder (2.3): no registry row knows
 * the limit and neither override layer set one. Wires where the output cap is
 * optional omit it in that case; Anthropic, where it is required, sends it.
 */
export function isMaxOutputPlaceholder(caps: ModelCapabilities): boolean {
  return PLACEHOLDER_CAPS.has(caps);
}

/**
 * Provider placeholder for a row describing an OPEN-WEIGHT model that any host
 * may serve (2.3): `finalize` reports the caller's own provider instead.
 */
const ANY_HOST = '*';

const CLAUDE_5_EFFORT: readonly EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max'];

/**
 * Claude 5.x request rules (2.3, F14). Verified against Anthropic's API
 * reference (cached 2026-10-06), NOT live-verified:
 *  - effort rides `output_config.effort` (low…max); `thinking.budget_tokens`
 *    returns 400;
 *  - no sampling parameters: Fable 5.1 / Opus 5.5 reject every value, Sonnet
 *    5.5 / Haiku 5.5 accept only the defaults (Haiku: temperature 1 or top_p
 *    0.99, never both) — so all of them are stripped, and reported;
 *  - structured output via `output_config.format`, prompt caching, vision;
 *  - 1M context / 128K output.
 */
function claude5(over: Partial<Row>): Row {
  return row('anthropic', 'anthropic', {
    vision: true,
    reasoning: true,
    caching: true,
    contextWindow: 1_000_000,
    maxOutput: 128_000,
    effortWire: 'output_config',
    samplingRestrictions: true,
    effortLevels: CLAUDE_5_EFFORT,
    ...over,
  });
}

/**
 * `claude-{fable,opus,sonnet,haiku}-N…` with N ≥ 5 (2.3, F14). On the
 * Anthropic wire an id in this family that has no row of its own still gets
 * the Claude 5.x request rules — never `budget_tokens`, never sampling
 * parameters, never a forced tool_choice — instead of the generic fallback,
 * whose `budget_tokens` wire and raw temperature 400 on every current Claude.
 */
export function isClaude5Family(modelId: string): boolean {
  const match = /^claude-(?:fable|opus|sonnet|haiku)-(\d+)(?=$|[-.@:_])/.exec(modelId);
  return match !== null && Number(match[1]) >= 5;
}

/** The family fallback: the strictest documented 5.x rules, since the id is unknown. */
function claude5FamilyRow(): Row {
  return claude5({ forcedToolChoice: false, effortNone: 'lowest' });
}

// 2026-current slugs (pinned; adjust at launch). See plan's wire reference.
const REGISTRY: Record<string, Row> = {
  // --- Anthropic (surface 'anthropic') ---
  // 2.3 (F14) — the current Claude 5.x ids (see `claude5` for the shared rules).
  // A forced tool_choice 400s on Fable 5.1 / Opus 5.5 / Sonnet 5.5; Haiku 5.5
  // accepts it but skips thinking. `effort: 'none'`: Fable 5.1 and Opus 5.5
  // cannot turn thinking off (→ low); Sonnet 5.5 → `between_tools`, Haiku 5.5
  // → `disabled`, both only at effort ≤ high, which their defaults satisfy.
  'claude-fable-5-1': claude5({ forcedToolChoice: false, effortNone: 'lowest' }),
  'claude-opus-5-5': claude5({
    forcedToolChoice: false,
    effortNone: 'lowest',
    effortDefault: 'medium',
  }),
  'claude-sonnet-5-5': claude5({
    forcedToolChoice: false,
    effortNone: 'thinking-between-tools',
    effortDefault: 'high',
  }),
  'claude-haiku-5-5': claude5({
    forcedToolChoice: true,
    effortNone: 'thinking-disabled',
    effortDefault: 'medium',
  }),
  // The previous Opus: thinking can be disabled, at effort ≤ high only.
  'claude-opus-5': claude5({ effortNone: 'thinking-disabled' }),
  'claude-fable-5': claude5({}), // temperature/top_p/top_k non-default → 400
  'claude-sonnet-5': claude5({}),
  'claude-opus-4-8': row('anthropic', 'anthropic', {
    vision: true,
    reasoning: true,
    caching: true,
    contextWindow: 1_000_000,
    maxOutput: 128_000,
    effortWire: 'output_config',
    samplingRestrictions: true,
  }),
  'claude-opus-4-7': row('anthropic', 'anthropic', {
    vision: true,
    reasoning: true,
    caching: true,
    contextWindow: 1_000_000,
    maxOutput: 128_000,
    effortWire: 'output_config',
    samplingRestrictions: true,
  }),
  'claude-opus-4-6': row('anthropic', 'anthropic', {
    vision: true,
    reasoning: true,
    caching: true,
    contextWindow: 1_000_000,
    maxOutput: 128_000,
  }),
  'claude-sonnet-4-6': row('anthropic', 'anthropic', {
    vision: true,
    reasoning: true,
    caching: true,
    contextWindow: 1_000_000,
    maxOutput: 64_000,
  }),
  'claude-haiku-4-5': row('anthropic', 'anthropic', {
    vision: true,
    reasoning: true,
    caching: true,
    contextWindow: 200_000,
    maxOutput: 64_000,
  }),
  // 2.3 (F19): priced models the registry did not know, which fell back to a
  // row that disables thinking and caching. Extended thinking on budget_tokens.
  // Not live-verified.
  'claude-opus-4-5': row('anthropic', 'anthropic', {
    vision: true,
    reasoning: true,
    caching: true,
    contextWindow: 200_000,
    maxOutput: 64_000,
  }),
  'claude-sonnet-4-5': row('anthropic', 'anthropic', {
    vision: true,
    reasoning: true,
    caching: true,
    contextWindow: 200_000,
    maxOutput: 64_000,
  }),

  // --- OpenAI Chat Completions (GPT-5.4+ expose reasoning_effort here too) ---
  // 2.3 (F08): reasoning rows, so sampling is stripped and the cap rides
  // `max_completion_tokens` next to reasoning_effort (the samplingRestrictions
  // note above). NOT live-verified.
  'gpt-5.5': row('openai', 'chat_completions', {
    vision: true,
    reasoning: true,
    samplingRestrictions: true,
    contextWindow: 1_050_000,
    maxOutput: 128_000,
  }),
  'gpt-5.5-pro': row('openai', 'chat_completions', {
    vision: true,
    reasoning: true,
    samplingRestrictions: true,
    contextWindow: 1_050_000,
    maxOutput: 128_000,
  }),

  // --- OpenAI Responses (reasoning + tools live here) ---
  // 2.3 (F08) — the current GPT-6 ids. Research-dated (roadmap 5.3,
  // 2026-10-09), NOT live-verified: only the documented facts are pinned, the
  // rest keeps the OpenAI reasoning-row defaults (sampling stripped) and the
  // model profile marks it unknown.
  // gpt-6.1-sol: 1_050_000 context / 128_000 output; effort low…max where 'max'
  // is a real value (no max→xhigh) and 'none'/'minimal' do not exist; tool
  // calling only on Responses (Chat Completions works tool-less).
  'gpt-6.1-sol': row('openai', 'responses', {
    reasoning: true,
    samplingRestrictions: true,
    contextWindow: 1_050_000,
    maxOutput: 128_000,
    effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
    effortNone: 'lowest',
    toolSurfaces: ['responses'],
  }),
  // Limits undocumented → placeholder cap, never sent. Luna documents 'none'.
  'gpt-6-astra': undocumentedOutput('openai', 'responses', {
    reasoning: true,
    samplingRestrictions: true,
  }),
  'gpt-6-luna': undocumentedOutput('openai', 'responses', {
    reasoning: true,
    samplingRestrictions: true,
    effortNone: 'send',
  }),
  'gpt-5.4': row('openai', 'responses', {
    vision: true,
    reasoning: true,
    samplingRestrictions: true,
    contextWindow: 400_000,
    maxOutput: 128_000,
  }),
  'gpt-5.4-mini': row('openai', 'responses', {
    vision: true,
    reasoning: true,
    samplingRestrictions: true,
    contextWindow: 400_000,
    maxOutput: 128_000,
  }),
  'gpt-5.4-nano': row('openai', 'responses', {
    vision: true,
    reasoning: true,
    samplingRestrictions: true,
    contextWindow: 400_000,
    maxOutput: 128_000,
  }),
  'gpt-5.3-codex': row('openai', 'responses', {
    vision: true,
    reasoning: true,
    samplingRestrictions: true,
    contextWindow: 400_000,
    maxOutput: 128_000,
  }),
  // 2.3 (F19): priced OpenAI models the registry did not know. They fell back to
  // a non-reasoning row, so `effort` was dropped and `temperature` was sent to
  // a reasoning model. Every GPT-5 model reasons and rejects sampling
  // parameters. The GPT-5.6 rows (GPT-5.6 is Sol) and the pro/codex snapshots
  // pin no limits: placeholder cap, never sent. Not live-verified.
  // Effort: the level sets OpenAI publishes per snapshot, research-dated
  // (2026-10-10) and NOT live-verified. gpt-5 / -mini / -nano take
  // minimal…high, and 'minimal' has no Deuz level, so 'none' is sent as 'low';
  // gpt-5.1 takes none…high, gpt-5.2 none…xhigh, gpt-5-pro high only. No set
  // is pinned for the GPT-5.6 rows or the 5.2-pro / 5.4-pro / 5.2-codex
  // snapshots: they keep the wire's historical mapping, like gpt-6-astra.
  'gpt-5.6-sol': undocumentedOutput('openai', 'responses', {
    reasoning: true,
    samplingRestrictions: true,
  }),
  'gpt-5.6': undocumentedOutput('openai', 'responses', {
    reasoning: true,
    samplingRestrictions: true,
  }),
  'gpt-5.6-terra': undocumentedOutput('openai', 'responses', {
    reasoning: true,
    samplingRestrictions: true,
  }),
  'gpt-5.6-luna': undocumentedOutput('openai', 'responses', {
    reasoning: true,
    samplingRestrictions: true,
  }),
  'gpt-5.2': row('openai', 'responses', {
    vision: true,
    reasoning: true,
    samplingRestrictions: true,
    contextWindow: 400_000,
    maxOutput: 128_000,
    effortLevels: ['low', 'medium', 'high', 'xhigh'],
    effortNone: 'send',
  }),
  'gpt-5.1': row('openai', 'responses', {
    vision: true,
    reasoning: true,
    samplingRestrictions: true,
    contextWindow: 400_000,
    maxOutput: 128_000,
    effortLevels: ['low', 'medium', 'high'],
    effortNone: 'send',
  }),
  'gpt-5': row('openai', 'responses', {
    vision: true,
    reasoning: true,
    samplingRestrictions: true,
    contextWindow: 400_000,
    maxOutput: 128_000,
    effortLevels: ['low', 'medium', 'high'],
    effortNone: 'lowest',
  }),
  'gpt-5-mini': row('openai', 'responses', {
    vision: true,
    reasoning: true,
    samplingRestrictions: true,
    contextWindow: 400_000,
    maxOutput: 128_000,
    effortLevels: ['low', 'medium', 'high'],
    effortNone: 'lowest',
  }),
  'gpt-5-nano': row('openai', 'responses', {
    vision: true,
    reasoning: true,
    samplingRestrictions: true,
    contextWindow: 400_000,
    maxOutput: 128_000,
    effortLevels: ['low', 'medium', 'high'],
    effortNone: 'lowest',
  }),
  'gpt-5.4-pro': undocumentedOutput('openai', 'responses', {
    reasoning: true,
    samplingRestrictions: true,
  }),
  'gpt-5.2-pro': undocumentedOutput('openai', 'responses', {
    reasoning: true,
    samplingRestrictions: true,
  }),
  'gpt-5.2-codex': undocumentedOutput('openai', 'responses', {
    reasoning: true,
    samplingRestrictions: true,
  }),
  'gpt-5-pro': undocumentedOutput('openai', 'responses', {
    reasoning: true,
    samplingRestrictions: true,
    effortLevels: ['high'],
    effortNone: 'lowest',
  }),
  'o4-mini': row('openai', 'responses', {
    vision: true,
    reasoning: true,
    samplingRestrictions: true,
    contextWindow: 200_000,
    maxOutput: 100_000,
  }),

  // --- xAI Grok (Chat Completions wire; reasoning on by default) ---
  'grok-4.3': row('xai', 'chat_completions', {
    vision: true,
    reasoning: true,
    contextWindow: 1_000_000,
    maxOutput: 128_000,
  }),

  // --- Google Gemini via OpenAI-compat (limited surface; usage-per-chunk quirk) ---
  'gemini-3.1-pro': row('google', 'chat_completions', {
    vision: true,
    contextWindow: 1_000_000,
    maxOutput: 64_000,
    usagePerChunk: true,
    toolIndexAllZero: true,
  }),
  'gemini-3.1-pro-preview': row('google', 'chat_completions', {
    vision: true,
    contextWindow: 1_000_000,
    maxOutput: 64_000,
    usagePerChunk: true,
    toolIndexAllZero: true,
  }),
  'gemini-3.5-flash': row('google', 'chat_completions', {
    vision: true,
    contextWindow: 1_000_000,
    maxOutput: 64_000,
    usagePerChunk: true,
    toolIndexAllZero: true,
  }),
  'gemini-2.5-pro': row('google', 'chat_completions', {
    vision: true,
    contextWindow: 1_000_000,
    maxOutput: 64_000,
    usagePerChunk: true,
    toolIndexAllZero: true,
  }),
  'gemini-2.5-flash': row('google', 'chat_completions', {
    vision: true,
    contextWindow: 1_000_000,
    maxOutput: 64_000,
    usagePerChunk: true,
    toolIndexAllZero: true,
  }),

  // --- OpenAI-compatible hosts (providers-compat.ts) — 2026 flagships only.
  // structuredOutput stays OFF (json_schema support varies across these hosts;
  // generateObject falls back to the tool strategy, which they all speak).
  // Unknown slugs keep falling back to conservative (provider, surface) defaults. ---
  'llama-4-maverick': row('groq', 'chat_completions', {
    vision: true, // natively multimodal on Groq
    structuredOutput: false,
    contextWindow: 131_072,
  }),
  'deepseek-v3.2': row('deepseek', 'chat_completions', {
    structuredOutput: false,
  }),
  // DeepSeek v4 always reasons — there is no switch, and `reasoning_content`
  // comes back on every call. Two consequences verified against the live API
  // (test/live/deepseek.live.test.ts):
  //   - reasoning tokens are drawn from the SAME budget as the answer, so a
  //     `maxOutputTokens` sized for the reply alone yields an empty string;
  //   - it rejects `response_format: json_schema` ("unavailable now") AND forced
  //     `tool_choice` ("Thinking mode does not support this tool_choice"), which
  //     is both of `generateObject`'s strategies. Use `generateText` with the
  //     shape in the prompt until a `json_object` strategy exists.
  // maxOutput stays at the 8_192 default: the wire accepts up to 65_536, but a
  // default that high turns one runaway thinking pass into a real bill. Raise it
  // per call when a long answer needs the room.
  // 2.3 (F26): reasoning cannot be turned off, so `effort: 'none'` is dropped
  // (reported) instead of being sent as `reasoning_effort: 'none'`. The forced
  // tool_choice rejection above is stated too (F14): a forced choice is sent as
  // auto with a `clamped-setting` warning, and `generateObject` takes the json
  // strategy — which V4 also rejects, so the gap stays (live-verified).
  'deepseek-v4-flash': row('deepseek', 'chat_completions', {
    reasoning: true,
    structuredOutput: false,
    forcedToolChoice: false,
    effortNone: 'omit',
  }),
  'deepseek-v4-pro': row('deepseek', 'chat_completions', {
    reasoning: true,
    structuredOutput: false,
    forcedToolChoice: false,
    effortNone: 'omit',
  }),
  // 2.3 (F08) — research-dated (roadmap 5.3, 2026-10-09), NOT live-verified.
  // `deepseek-flash` resolves to V4.1-Flash and returns `reasoning_content`;
  // it is treated like the always-reasoning V4 family above ('none' omitted).
  // Limits undocumented → placeholder cap, never sent.
  'deepseek-flash': undocumentedOutput('deepseek', 'chat_completions', {
    reasoning: true,
    structuredOutput: false,
    effortNone: 'omit',
  }),
  'mistral-large-latest': row('mistral', 'chat_completions', {
    vision: true, // Mistral Large 3 is multimodal-by-design
    structuredOutput: false,
    contextWindow: 256_000,
  }),
  'kimi-k2': row('moonshot', 'chat_completions', {
    structuredOutput: false,
    contextWindow: 131_072,
  }),
  // 2.3 (F08) — research-dated (roadmap 5.3, 2026-10-09), NOT live-verified.
  // kimi-k3: reasoning cannot be turned off; reasoning_effort low/high/max,
  // default max ('max' is a real value). Never the K2.x thinking parameter.
  'kimi-k3': undocumentedOutput('moonshot', 'chat_completions', {
    reasoning: true,
    structuredOutput: false,
    effortLevels: ['low', 'high', 'max'],
    effortDefault: 'max',
    effortNone: 'lowest',
  }),
  // kimi-k2.7-code has no non-thinking mode either, and K3's effort scheme
  // does not carry over: no effort level is documented, so none is sent.
  'kimi-k2.7-code': undocumentedOutput('moonshot', 'chat_completions', {
    reasoning: true,
    structuredOutput: false,
    effortLevels: [],
    effortNone: 'omit',
  }),
  'qwen3-max': row('qwen', 'chat_completions', {
    structuredOutput: false,
    contextWindow: 262_144,
  }),
  'glm-4.6': row('glm', 'chat_completions', {
    structuredOutput: false,
    contextWindow: 200_000,
  }),
  // 2.3 (F08) — research-dated (roadmap 5.3, 2026-10-09), NOT live-verified.
  // glm-5.3: text-only, reasoning cannot be turned off (`thinking.type:
  // disabled` is unsupported); effort low/high/max, default max, sent as
  // reasoning_effort on this wire. Access depends on the account, so the
  // endpoint is never guessed from the id: Z.ai's international API is a
  // `baseURL` (createGLM defaults to BigModel).
  'glm-5.3': undocumentedOutput('glm', 'chat_completions', {
    reasoning: true,
    structuredOutput: false,
    effortLevels: ['low', 'high', 'max'],
    effortDefault: 'max',
    effortNone: 'lowest',
  }),
  'minimax-m2': row('minimax', 'chat_completions', {
    structuredOutput: false,
    contextWindow: 200_000,
  }),

  // --- 2.0 hosts. Every slug below is pinned from a public catalog and marked
  // `verify slug at publish`: these vendors rename far more often than the
  // flagships above, and a stale key here costs nothing (unknown → conservative
  // fallback) but a WRONG key would hand out capabilities the model lacks. ---

  // Perplexity Sonar — search-grounded. `tools: false` is the load-bearing flag:
  // the search runs server-side and the API rejects a `tools` array, so no
  // client tool loop and no tool-strategy structured output.
  sonar: row('perplexity', 'chat_completions', {
    tools: false,
    structuredOutput: false,
    contextWindow: 128_000,
  }), // verify slug at publish
  'sonar-pro': row('perplexity', 'chat_completions', {
    tools: false,
    structuredOutput: false,
    contextWindow: 200_000,
  }), // verify slug at publish
  'sonar-reasoning-pro': row('perplexity', 'chat_completions', {
    reasoning: true,
    tools: false,
    structuredOutput: false,
    contextWindow: 128_000,
  }), // verify slug at publish

  // Cohere via the OpenAI compatibility endpoint.
  'command-a-03-2025': row('cohere', 'chat_completions', {
    structuredOutput: false,
    contextWindow: 256_000,
  }), // verify slug at publish

  // DeepInfra (org/Model slugs).
  'meta-llama/Llama-4-Maverick-17B-128E-Instruct': row('deepinfra', 'chat_completions', {
    vision: true,
    structuredOutput: false,
    contextWindow: 131_072,
  }), // verify slug at publish
  'deepseek-ai/DeepSeek-V3.2': row('deepinfra', 'chat_completions', {
    structuredOutput: false,
    contextWindow: 163_840,
  }), // verify slug at publish

  // NVIDIA NIM (vendor/model slugs, lowercased).
  'meta/llama-4-maverick-17b-128e-instruct': row('nvidia', 'chat_completions', {
    vision: true,
    structuredOutput: false,
    contextWindow: 131_072,
  }), // verify slug at publish
  'nvidia/llama-3.3-nemotron-super-49b-v1.5': row('nvidia', 'chat_completions', {
    reasoning: true,
    structuredOutput: false,
    contextWindow: 131_072,
  }), // verify slug at publish

  // SambaNova Cloud (bare CamelCase slugs).
  'Llama-4-Maverick-17B-128E-Instruct': row('sambanova', 'chat_completions', {
    vision: true,
    structuredOutput: false,
    contextWindow: 131_072,
  }), // verify slug at publish
  'Meta-Llama-3.3-70B-Instruct': row('sambanova', 'chat_completions', {
    structuredOutput: false,
    contextWindow: 131_072,
  }), // verify slug at publish

  // Hyperbolic (org/Model slugs).
  'Qwen/Qwen3-235B-A22B-Instruct': row('hyperbolic', 'chat_completions', {
    structuredOutput: false,
    contextWindow: 262_144,
  }), // verify slug at publish
  'moonshotai/Kimi-K2-Instruct': row('hyperbolic', 'chat_completions', {
    structuredOutput: false,
    contextWindow: 131_072,
  }), // verify slug at publish

  // --- Ollama and LM Studio (2.0) have NO rows here, on purpose. ---
  // Their slugs are whatever the USER pulled — `qwen3`, `llama3.2:3b`,
  // `my-finetune:latest`, a GGUF filename — so any pinned list would be wrong
  // for almost everyone and would go stale the moment a new tag lands. They
  // take the documented unknown-slug path instead: `defaultRow(provider,
  // 'chat_completions')` (tools OFF, maxOutput 4096) plus one `unknown-model`
  // warning, and the user states the truth once through the factory-level
  // `capabilities` override, which `finalize()` merges over the row:
  //
  //   createOllama({ capabilities: { tools: true, maxOutput: 32_000 } })
  //
  // That override channel is exactly why `CompatSettings.capabilities` is
  // public in 2.0. Same reasoning applies to any self-hosted vLLM/llama.cpp
  // reached through `createOpenAICompatible`.
  //
  // The one exception (2.3): an open-weight model under its CANONICAL
  // `Org/Model` id, which names the weights rather than a local tag. Such a row
  // carries the `ANY_HOST` provider and answers for whichever host serves it.

  // 2.3 (F08) — official model card, research-dated 2026-10-09, NOT
  // live-verified. Non-thinking only (never infer reasoning from the Qwen3
  // family), 262_144 native context. Tool calling depends on the engine's
  // qwen3_coder parser, and the output limit is undocumented (cap left off).
  'Qwen/Qwen3-Coder-Next': undocumentedOutput(ANY_HOST, 'chat_completions', {
    structuredOutput: false,
    contextWindow: 262_144,
  }),
};

// --- Gemini NATIVE (generateContent) rows — surface:'native', keyed separately
// from the compat rows so the SAME slug can be used on either wire. ---
const NATIVE_REGISTRY: Record<string, Row> = {
  'gemini-3.1-pro-preview': row('google', 'native', {
    vision: true,
    reasoning: true,
    caching: true,
    nativePdf: true,
    audio: true,
    contextWindow: 1_000_000,
    maxOutput: 64_000,
  }),
  // 2.3 (F19): the GA id of the preview above. It is priced and pinned on the
  // compat wire with the same 1M / 64K limits, but this table missed it, so the
  // native wire ran it on the fallback. Same row as the preview; not live-verified.
  'gemini-3.1-pro': row('google', 'native', {
    vision: true,
    reasoning: true,
    caching: true,
    nativePdf: true,
    audio: true,
    contextWindow: 1_000_000,
    maxOutput: 64_000,
  }),
  'gemini-3.1-flash-lite': row('google', 'native', {
    vision: true,
    reasoning: true,
    caching: true,
    nativePdf: true,
    audio: true,
    contextWindow: 1_000_000,
    maxOutput: 64_000,
  }),
  // gemini-3-pro was shut down 2026-03-09 and now aliases gemini-3.1-pro-preview;
  // the row stays so the alias keeps its pinned capabilities.
  'gemini-3-pro': row('google', 'native', {
    vision: true,
    reasoning: true,
    caching: true,
    nativePdf: true,
    audio: true,
    contextWindow: 1_000_000,
    maxOutput: 64_000,
  }),
  'gemini-3.5-flash': row('google', 'native', {
    vision: true,
    reasoning: true,
    caching: true,
    nativePdf: true,
    audio: true,
    contextWindow: 1_000_000,
    maxOutput: 64_000,
  }),
  // Official model cards checked 2026-10-17, not live-verified. Updating
  // catalog facts must not silently start sending a larger default output cap.
  'gemini-3.8-flash': providerOutputDefault('google', 'native', {
    vision: true,
    reasoning: true,
    caching: true,
    nativePdf: true,
    audio: true,
    contextWindow: 1_048_576,
    maxOutput: 65_536,
    effortLevels: ['low', 'medium', 'high'],
    effortDefault: 'medium',
    effortNone: 'lowest',
  }),
  // Input, thinking and output share one window. This is the per-stream limit,
  // not a claim that native long-decode continuation is implemented.
  'gemini-4-argon': providerOutputDefault('google', 'native', {
    vision: true,
    reasoning: true,
    caching: true,
    nativePdf: true,
    audio: true,
    contextWindow: 1_048_576,
    maxOutput: 65_536,
    effortLevels: ['low', 'medium', 'high'],
    effortDefault: 'medium',
    effortNone: 'lowest',
  }),
  'gemini-2.5-pro': row('google', 'native', {
    vision: true,
    reasoning: true,
    caching: true,
    nativePdf: true,
    audio: true,
    contextWindow: 1_000_000,
    maxOutput: 64_000,
  }),
  'gemini-2.5-flash': row('google', 'native', {
    vision: true,
    reasoning: true,
    caching: true,
    nativePdf: true,
    audio: true,
    contextWindow: 1_000_000,
    maxOutput: 64_000,
  }),
};

/** Conservative fallback for an unknown slug — risky flags default OFF. */
function defaultRow(provider: string, surface: ModelSurface): Row {
  const isGeminiCompat = provider === 'google' && surface === 'chat_completions';
  const fallback = row(provider, surface, {
    tools: false,
    reasoning: false,
    structuredOutput: false,
    contextWindow: 128_000,
    // A placeholder (2.3): omitted where the wire allows; Anthropic's required
    // max_tokens still gets it (named in the unknown-model warning) — too high
    // would 400, so keep it low.
    maxOutput: PLACEHOLDER_MAX_OUTPUT,
    usagePerChunk: isGeminiCompat,
    toolIndexAllZero: isGeminiCompat,
  });
  PLACEHOLDER_ROWS.add(fallback);
  return fallback;
}

/** Native-Gemini fallback for an unknown `surface:'native'` slug (full caps ON). */
function defaultNativeRow(): Row {
  const fallback = row('google', 'native', {
    vision: true,
    reasoning: true,
    caching: true,
    nativePdf: true,
    audio: true,
    contextWindow: 1_000_000,
    maxOutput: 64_000, // placeholder (2.3): the native wire omits it
  });
  PLACEHOLDER_ROWS.add(fallback);
  return fallback;
}

/** How a descriptor's slug was answered (2.3; also read by the model profile). */
export type RegistryMatch = 'exact' | 'family' | 'fallback';

/**
 * A table's own row for `modelId` (2.3): `constructor`, `toString` or
 * `__proto__` are model ids like any other, never inherited object members.
 */
function ownRow<T>(table: Record<string, T>, modelId: string): T | undefined {
  return Object.hasOwn(table, modelId) ? table[modelId] : undefined;
}

/** The table entry for a descriptor — pure, no logging. */
function lookup(model: LanguageModel): { row: Row; match: RegistryMatch } {
  // Native surface is keyed in its own table so a slug can serve both wires.
  if (model.surface === 'native') {
    const nrow = ownRow(NATIVE_REGISTRY, model.modelId);
    return nrow ? { row: nrow, match: 'exact' } : { row: defaultNativeRow(), match: 'fallback' };
  }
  const known = ownRow(REGISTRY, model.modelId);
  if (known) return { row: known, match: 'exact' };
  if (model.surface === 'anthropic' && isClaude5Family(model.modelId)) {
    return { row: claude5FamilyRow(), match: 'family' };
  }
  return { row: defaultRow(model.provider, model.surface), match: 'fallback' };
}

/** Which kind of registry entry answers for `model` (2.3). Pure: never warns. */
export function registryMatch(model: LanguageModel): RegistryMatch {
  return lookup(model).match;
}

/**
 * @internal True when a pinned row whose output limit is undocumented answers
 * for `model` (2.3), whatever an override claims. Such a row pins only what its
 * request rules need, so the model profile never reports its other values as
 * facts unless a documentary entry states them. Not part of the package surface.
 */
export function isUndocumentedRow(model: LanguageModel): boolean {
  const { row, match } = lookup(model);
  return match === 'exact' && PLACEHOLDER_ROWS.has(row);
}

/**
 * @internal Every pinned slug with its table (2.3): the price-table consistency
 * test (F19) walks it. Not part of the package surface.
 */
export function pinnedModelIds(): { native: readonly string[]; other: readonly string[] } {
  return { native: Object.keys(NATIVE_REGISTRY), other: Object.keys(REGISTRY) };
}

/**
 * What the unknown-model warning says about the output cap (2.3). The
 * optional-cap wires send none; Anthropic's `max_tokens` is required, so an
 * unknown model gets the placeholder — the documented default lives in the
 * warning itself, with both ways to set a real value. Silent when an override
 * already supplied the limit.
 */
function outputCapNote(
  model: LanguageModel,
  resolved: Row,
  overrides: Partial<ModelCapabilities> | undefined,
): string {
  if (!PLACEHOLDER_ROWS.has(resolved)) return '';
  if (overrides?.maxOutput !== undefined) return '';
  if (readConfig(model)?.capabilities?.maxOutput !== undefined) return '';
  return model.surface === 'anthropic'
    ? ` (max_tokens ${resolved.maxOutput}, which the Anthropic wire requires — pass ` +
        'maxOutputTokens or capabilities: { maxOutput } for longer answers)'
    : ' (no output cap is sent unless you pass maxOutputTokens)';
}

/**
 * Apply the capability OVERRIDES and freeze (1.9). This is the SINGLE merge site
 * for the whole SDK — precedence, lowest to highest:
 *
 *   registry row  <  factory `capabilities` (config Symbol)  <  per-call override
 *
 * Both override channels arrive here as ONE already-merged blob on the config
 * Symbol (`internal/config-symbol.ts` merges per-call over factory when it builds
 * the per-call descriptor clone), so no call path can ever observe a different
 * matrix than any other.
 *
 * NOTHING is validated: a garbage value rides through untouched and the "unknown
 * slugs never throw" policy stays intact — an override is a claim about the
 * model, not a request the SDK can check. Only `undefined` values are skipped,
 * so a generic wrapper forwarding `{ maxOutput: undefined }` cannot blank a field
 * (which would send `max_tokens: undefined` and 400 on Anthropic).
 *
 * The result is a FROZEN COPY. Returning the live `REGISTRY` row would let one
 * caller mutate a module-level singleton and poison every later call in the
 * process.
 *
 * One exception to "nothing is validated" (2.3, F14): on the Anthropic wire a
 * Claude 5.x id keeps effort on `output_config` and sampling stripped whatever
 * an override claims, because both are documented 400s for the whole family —
 * see {@link enforceClaude5}.
 */
function finalize(
  row: Row,
  known: boolean,
  model: LanguageModel,
  overrides?: Partial<ModelCapabilities>,
  logger?: Logger,
  warnings?: WarningSink,
): ModelCapabilities {
  const caps: ModelCapabilities = { ...row, known };
  // An open-weight row answers for whichever host serves it.
  if (row.provider === ANY_HOST) caps.provider = model.provider;
  // Factory blob first, explicit argument last — per-call always outranks factory.
  const factory = readConfig(model)?.capabilities;
  apply(caps, factory);
  apply(caps, overrides);
  if (model.surface === 'anthropic' && isClaude5Family(model.modelId)) {
    enforceClaude5(caps, model, logger, warnings);
  }
  const frozen = Object.freeze(caps);
  if (
    PLACEHOLDER_ROWS.has(row) &&
    factory?.maxOutput === undefined &&
    overrides?.maxOutput === undefined
  ) {
    PLACEHOLDER_CAPS.add(frozen);
  }
  if (
    PROVIDER_OUTPUT_DEFAULT_ROWS.has(row) &&
    factory?.maxOutput === undefined &&
    overrides?.maxOutput === undefined
  ) {
    PROVIDER_OUTPUT_DEFAULT_CAPS.add(frozen);
  }
  return frozen;
}

/**
 * The two Claude 5.x rules no override may break (2.3, F14): effort stays on
 * `output_config` (`thinking.budget_tokens` is a 400) and sampling parameters
 * stay stripped (any non-default value is a 400). Verified against Anthropic's
 * API reference (cached 2026-10-06), not live-verified. A contrary override is
 * overruled and reported — once in the log, once as a typed warning.
 */
function enforceClaude5(
  caps: ModelCapabilities,
  model: LanguageModel,
  logger: Logger | undefined,
  warnings: WarningSink | undefined,
): void {
  if (caps.effortWire === 'output_config' && caps.samplingRestrictions) return;
  caps.effortWire = 'output_config';
  caps.samplingRestrictions = true;
  const message =
    `The capabilities override for '${model.modelId}' was overruled: Claude 5.x models reject ` +
    'thinking.budget_tokens and sampling parameters, so effort stays on output_config and ' +
    'temperature/topP stay stripped.';
  logger?.warn(message, {
    provider: model.provider,
    modelId: model.modelId,
    surface: model.surface,
  });
  warnings?.add(
    { type: 'unsupported-setting', setting: 'capabilities', message },
    { mirror: false },
  );
}

/** Shallow-assign the DEFINED keys of one override layer. No validation, ever. */
function apply(caps: ModelCapabilities, overrides: Partial<ModelCapabilities> | undefined): void {
  if (!overrides) return;
  const defined: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(overrides)) {
    if (value !== undefined) defined[key] = value;
  }
  Object.assign(caps, defined);
}

/**
 * Resolve capabilities for a model descriptor; warns (once-ish) on unknown slugs.
 * The warning fires on the ROW, before any override is applied: an override says
 * the caller knows better, not that the registry knows the slug.
 *
 * `overrides` is for call sites that hold the options object; sites that only
 * hold a descriptor (the pump, both object entry points) get the caller's
 * per-call override through the config Symbol of the per-call descriptor clone
 * built at the call boundary (`internal/config-symbol.ts:withCapabilityOverride`).
 * Either route lands in {@link finalize}, so the matrix is identical.
 *
 * `warnings` (1.9) is the per-call sink that turns the fallback from a log line
 * into a typed `{ type: 'unknown-model' }` the caller can read off the result.
 * It is recorded QUIETLY — the `logger?.warn` above it is the pre-1.9 line, in
 * the pre-1.9 shape (provider/modelId/surface fields), and the whole point is
 * that a log-based workflow sees EXACTLY what it saw before, once. A KNOWN slug
 * returns before either channel: a false `unknown-model` would fire on every
 * call of every user, so both exits are behind the same early return.
 */
export function getCapabilities(
  model: LanguageModel,
  logger?: Logger,
  overrides?: Partial<ModelCapabilities>,
  warnings?: WarningSink,
): ModelCapabilities {
  const { row: resolved, match } = lookup(model);
  if (match === 'exact') return finalize(resolved, true, model, overrides, logger, warnings);
  const base =
    model.surface === 'native'
      ? `Unknown native model '${model.modelId}' — using Gemini-native defaults`
      : match === 'family'
        ? `Unknown model '${model.modelId}' — using the Claude 5.x family rules for ${model.provider}/${model.surface}`
        : `Unknown model '${model.modelId}' — using conservative ${model.provider}/${model.surface} defaults`;
  const message = `${base}${outputCapNote(model, resolved, overrides)}.`;
  logger?.warn(message, {
    provider: model.provider,
    modelId: model.modelId,
    surface: model.surface,
  });
  // Already logged by the line above — record only (see WarningSink.add).
  warnings?.add({ type: 'unknown-model', message }, { mirror: false });
  return finalize(resolved, false, model, overrides, logger, warnings);
}

/**
 * Public read accessor for a model's effective capability matrix (1.9) —
 * registry row plus any factory-level `capabilities` override carried by the
 * descriptor. Gate your own UI on it instead of hard-coding a slug list:
 *
 * ```ts
 * const caps = getModelCapabilities(model);
 * if (caps.vision) showImageUpload();
 * if (!caps.known) showNewModelHint(); // conservative fallback row
 * ```
 *
 * A frozen COPY: mutating the result is a no-op (and never touches the registry),
 * so the next call sees the same matrix. Unknown slugs never throw and, since no
 * `logger` is threaded here, a read never emits a warning either.
 *
 * NOTE: it reports what the SDK BELIEVES. `tools` in particular is read by no
 * adapter (verified) — it neither enables nor disables tool calling.
 */
export function getModelCapabilities(model: LanguageModel): Readonly<ModelCapabilities> {
  return getCapabilities(model);
}

// ===================================================================
// Embedding capabilities (Faz 3) — kept SEPARATE from ModelCapabilities so
// chat rows are untouched and the two model kinds never cross-contaminate.
// ===================================================================

export interface EmbeddingCapabilities {
  provider: string;
  surface: EmbeddingModelSurface;
  /** False only for a slug we explicitly know is NOT an embedding model. */
  embedding: boolean;
  /** Native output dimension (before optional Matryoshka truncation). */
  embeddingDimensions: number;
  /** Max inputs per request (provider-enforced; drives chunk-batching). */
  embeddingMaxBatch: number;
  /** Provider returns a usage/token count on the response. */
  reportsUsage: boolean;
  /** `encoding_format: 'base64'` is accepted (compact wire for large batches). */
  supportsBase64: boolean;
  /** A task-type / input-type hint is accepted. */
  supportsTaskType: boolean;
  /** False when this row is a fallback for an unknown slug. */
  known: boolean;
}

type EmbeddingRow = Omit<EmbeddingCapabilities, 'known'>;

function embRow(
  provider: string,
  surface: EmbeddingModelSurface,
  over: Partial<EmbeddingRow>,
): EmbeddingRow {
  return {
    provider,
    surface,
    embedding: true,
    embeddingDimensions: 1536,
    embeddingMaxBatch: 96,
    reportsUsage: false,
    supportsBase64: false,
    supportsTaskType: false,
    ...over,
  };
}

// 2026-pinned embedding slugs; verify dims/limits at publish (see openQuestions).
const EMBEDDING_REGISTRY: Record<string, EmbeddingRow> = {
  // --- OpenAI ---
  'text-embedding-3-small': embRow('openai', 'openai-embeddings', {
    embeddingDimensions: 1536,
    embeddingMaxBatch: 2048,
    reportsUsage: true,
    supportsBase64: true,
  }),
  'text-embedding-3-large': embRow('openai', 'openai-embeddings', {
    embeddingDimensions: 3072,
    embeddingMaxBatch: 2048,
    reportsUsage: true,
    supportsBase64: true,
  }),

  // --- Google Gemini (native embeddings) ---
  'gemini-embedding-2': embRow('google', 'gemini-embeddings', {
    embeddingDimensions: 3072, // MRL 128–3072 via outputDimensionality
    embeddingMaxBatch: 100,
    reportsUsage: false,
    supportsTaskType: false, // gemini-embedding-2 dropped task_type — instructions ride the prompt
  }),
  'gemini-embedding-001': embRow('google', 'gemini-embeddings', {
    embeddingDimensions: 3072,
    embeddingMaxBatch: 100,
    reportsUsage: false,
    supportsTaskType: true,
  }),
  // text-embedding-004 was shut down 2026-01-14 — intentionally absent.

  // --- Voyage AI (optional catalog) ---
  'voyage-3.5': embRow('voyage', 'voyage-embeddings', {
    embeddingDimensions: 1024,
    embeddingMaxBatch: 1000,
    reportsUsage: true,
    supportsBase64: true,
    supportsTaskType: true,
  }),
  'voyage-3.5-lite': embRow('voyage', 'voyage-embeddings', {
    embeddingDimensions: 1024,
    embeddingMaxBatch: 1000,
    reportsUsage: true,
    supportsBase64: true,
    supportsTaskType: true,
  }),
};

/** Conservative fallback for an unknown embedding slug (risky flags OFF). */
function defaultEmbeddingRow(provider: string, surface: EmbeddingModelSurface): EmbeddingRow {
  const dims = surface === 'gemini-embeddings' ? 768 : 1024;
  return embRow(provider, surface, {
    embeddingDimensions: dims,
    embeddingMaxBatch: 96,
    reportsUsage: false,
    supportsBase64: false,
    supportsTaskType: surface !== 'openai-embeddings',
  });
}

/** Resolve embedding capabilities; warns on unknown slugs (mirrors getCapabilities). */
export function getEmbeddingCapabilities(
  model: EmbeddingModel,
  logger?: Logger,
): EmbeddingCapabilities {
  const known = ownRow(EMBEDDING_REGISTRY, model.modelId);
  if (known) return { ...known, known: true };
  logger?.warn(
    `Unknown embedding model '${model.modelId}' — using conservative ${model.provider}/${model.surface} defaults.`,
    { provider: model.provider, modelId: model.modelId, surface: model.surface },
  );
  return { ...defaultEmbeddingRow(model.provider, model.surface), known: false };
}
