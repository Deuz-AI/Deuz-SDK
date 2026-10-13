/**
 * Model profiles (2.3): one explainable record per model descriptor — what the
 * SDK knows about the model and the rules it applies when it builds a request
 * for it.
 *
 *  - KNOWLEDGE: supported / unsupported / unknown capabilities, lifecycle
 *    status, the documented alias target, limits, where the facts come from
 *    and when they were checked.
 *  - REQUEST RULES: where `effort` rides and what `'none'` becomes, what
 *    happens to sampling parameters and forced tool choice, the output cap a
 *    request carries by default — and every value a request changes on the
 *    way, with the typed warning that reports it (`clamps`).
 *
 * Additive to {@link ModelCapabilities}, which stays the single matrix the
 * adapters read: a profile is DERIVED from the same resolution (registry row
 * < factory `capabilities` override) and from the same effort table the
 * adapters use (`core/request-rules.ts`), plus a small table of documentary
 * facts the matrix has no field for. Where a source is silent the profile says
 * `'unknown'` instead of repeating the row's conservative default.
 *
 * Pure and edge-safe: no network call — not at import, not ever. A live
 * catalog refresh (e.g. Anthropic's Models API) is an explicit, separate job.
 * The profile never carries the API key, base URL or any other factory
 * setting. Prices stay in the price table (`priceUsage`, `PRICES_2026`).
 *
 * Nothing here is live-verified (`liveVerified` is always `false`): Anthropic
 * facts are verified against Anthropic's API reference (cached 2026-10-06),
 * the other providers' facts are research-dated (2026-10-09; the earlier GPT-5
 * snapshots' effort sets 2026-10-10).
 */
import type { LanguageModel, ModelSurface } from './types/model';
import {
  getCapabilities,
  isMaxOutputPlaceholder,
  isUndocumentedRow,
  registryMatch,
  type EffortLevel,
  type EffortNoneMapping,
  type ModelCapabilities,
  type RegistryMatch,
} from './core/registry';
import {
  EFFORT_SCALE,
  atMostHigh,
  budgetPeers,
  clampEffortLevel,
  effortWire,
  type EffortField,
  type EffortWire,
} from './core/request-rules';
import { readConfig } from './internal/config-symbol';

/** What is known about one capability (2.3). */
export type ProfileSupport = 'supported' | 'unsupported' | 'unknown';

/** A model's lifecycle status as its provider documents it (2.3). */
export type ModelStatus = 'stable' | 'preview' | 'deprecated' | 'unknown';

/** The capabilities a profile reports as supported / unsupported / unknown (2.3). */
export type ProfileCapability =
  | 'tools'
  | 'vision'
  | 'reasoning'
  | 'structuredOutput'
  | 'caching'
  | 'nativePdf'
  | 'audio';

/** Anthropic `thinking.type` values on the Messages wire (2.3). */
export type AnthropicThinkingType = 'adaptive' | 'enabled' | 'disabled' | 'between_tools';

/** Where `effort` goes on the wire and what each value becomes (2.3). */
export interface ModelProfileEffort {
  /** The request field effort rides on; absent when effort never reaches the wire. */
  field?: EffortField;
  /**
   * Levels that reach the wire as asked, ascending. Any other level is changed
   * on the way (see {@link ModelProfile.clamps}); empty → effort is dropped.
   */
  levels: readonly EffortLevel[];
  /** The provider's documented default when the request carries no effort. */
  default?: EffortLevel;
  /**
   * What `effort: 'none'` becomes: an {@link EffortNoneMapping}, or
   * `'model-default'` — nothing is sent and the model runs at its own default
   * (which, for a model that only reasons when asked to, means no reasoning).
   */
  none: EffortNoneMapping | 'model-default';
}

/** How the model reasons and how its reasoning state reaches the next turn (2.3). */
export interface ModelProfileThinking {
  /**
   * `'always'` — reasoning cannot be turned off; `'default'` — on unless turned
   * off; `'opt-in'` — only when `effort` is set; `'never'` — a non-reasoning
   * model; `'unknown'`.
   */
  mode: 'always' | 'default' | 'opt-in' | 'never' | 'unknown';
  /** The Anthropic `thinking.type` values the model accepts, when documented. */
  types?: readonly AnthropicThinkingType[];
  /**
   * How reasoning state must ride into the next turn: Anthropic thinking blocks
   * (passed back unmodified, signature included), OpenAI encrypted reasoning
   * items, Gemini thought signatures, or the assistant message's
   * `reasoning_content` (DeepSeek, Kimi). `'none'` when there is nothing to carry.
   */
  replay:
    | 'thinking-blocks'
    | 'encrypted-reasoning'
    | 'thought-signatures'
    | 'reasoning-content'
    | 'none'
    | 'unknown';
}

/**
 * Three separate output concepts (2.3, F08): the model's limits, and the cap a
 * request carries when the call passes no `maxOutputTokens`.
 */
export interface ModelProfileLimits {
  /** Total context window in tokens; absent when undocumented. */
  contextWindow?: number;
  /** The provider's output maximum in tokens; absent when undocumented. */
  maxOutput?: number;
  /**
   * The output cap a request carries by default: a token count, or
   * `'omitted'` — the wire's cap is optional and the provider's own default
   * applies (an undocumented limit is never guessed onto the wire).
   */
  defaultOutputCap: number | 'omitted';
}

/** What happens to `temperature` / `topP` (2.3). */
export interface ModelProfileSampling {
  /**
   * What the SDK does with them: sends them, strips them (reported as
   * `unsupported-setting`), or strips them only while extended thinking is on
   * (reported as `clamped-setting`).
   */
  handling: 'sent' | 'stripped' | 'stripped-while-thinking';
  /** What the provider accepts: any value, only the defaults, none at all — or unknown. */
  accepted: 'any' | 'defaults-only' | 'none' | 'unknown';
  /** The documented rule, in words, when there is one. */
  rule?: string;
}

/** How the provider counts reasoning tokens (2.3). */
export interface ModelProfileUsage {
  /**
   * The provider's own output count already includes reasoning tokens. Either
   * way, the SDK's `Usage.outputTokens` includes them after normalization.
   */
  reasoningInclusive: boolean | 'unknown';
}

/** How prompt caching works for this model (2.3). Cache prices live in the price table. */
export interface ModelProfileCache {
  /**
   * `'breakpoints'` — explicit `cache_control` (Anthropic); `'implicit'` — the
   * provider caches matching prefixes on its own (OpenAI); `'cached-content'`
   * — implicit caching plus explicit cached-content resources (Gemini native).
   */
  mode: 'breakpoints' | 'implicit' | 'cached-content' | 'unknown';
  /** The call option `promptCaching` reaches the wire (elsewhere it is ignored or dropped). */
  promptCaching: 'supported' | 'unsupported';
}

/** One value a request changes on the way to the wire, and the warning that says so (2.3). */
export interface ModelProfileClamp {
  /** The call option that is changed. */
  setting:
    | 'effort'
    | 'temperature'
    | 'topP'
    | 'toolChoice'
    | 'mode'
    | 'maxOutputTokens'
    | 'promptCaching';
  /** The value asked for (`'*'`: any value). */
  from: string;
  /** What the request carries instead, in the wire's own terms; `'dropped'` when nothing is sent. */
  to: string;
  /** The typed `CallWarning` the call reports for it. */
  warning: 'clamped-setting' | 'unsupported-setting';
  /** When it happens, if not always. */
  when?: string;
}

/**
 * Everything the SDK knows about one model descriptor, and the request rules it
 * applies (2.3). Resolve one with {@link resolveModelProfile}.
 */
export interface ModelProfile {
  /** The descriptor's provider id — the host that serves the call. */
  provider: string;
  /** The model id as passed to the factory. */
  requestedId: string;
  /**
   * What the provider documents this id resolving to (an alias's target), as
   * the provider names it — not necessarily a callable id. Absent when undocumented.
   */
  resolvedId?: string;
  /** The wire protocol the descriptor speaks. */
  protocol: ModelSurface;
  /** How the registry answered: a pinned row, the Claude 5.x family rules, or the conservative fallback. */
  match: RegistryMatch;
  /** Lifecycle status as documented; `'unknown'` when no source states it. */
  status: ModelStatus;
  /** What is known about each capability. A factory `capabilities` claim counts as known. */
  capabilities: Readonly<Record<ProfileCapability, ProfileSupport>>;
  effort: ModelProfileEffort;
  thinking: ModelProfileThinking;
  limits: ModelProfileLimits;
  sampling: ModelProfileSampling;
  /** The model accepts a forced `toolChoice` (`'required'` or a named tool). */
  forcedToolChoice: ProfileSupport;
  /** The model accepts a conversation that ends with an assistant turn (prefill). */
  prefill: ProfileSupport;
  /** The only wires the model takes tool calling on; absent → any. */
  toolProtocols?: readonly ModelSurface[];
  usage: ModelProfileUsage;
  cache: ModelProfileCache;
  /** A refusal arrives as a successful response with a refusal stop reason (Anthropic). */
  refusal: 'stop-reason' | 'unknown';
  /** Every value a request changes on the way to the wire, and the warning it reports. */
  clamps: readonly ModelProfileClamp[];
  /** Where the facts come from. */
  sourceUrl?: string;
  /** When the facts were checked (ISO date). */
  checkedAt?: string;
  /** Always `false`: no profile has been verified against the live API. */
  liveVerified: false;
  /** Caveats and documented gaps, in words. */
  notes: readonly string[];
}

// ===================================================================
// Documentary facts — only what the capability row has no field for, or
// where the row's value is a conservative default rather than a fact.
// Numbers come from the row; a fact never repeats one.
// ===================================================================

interface Facts {
  status?: ModelStatus;
  resolvedId?: string;
  sourceUrl?: string;
  checkedAt?: string;
  /** Row values the source does not state: reported as unknown. */
  unknown?: readonly (ProfileCapability | 'contextWindow')[];
  /** The provider's output maximum, where the row's `maxOutput` is a lower default cap. */
  maxOutput?: number;
  thinking?: Partial<Pick<ModelProfileThinking, 'mode' | 'types'>>;
  sampling?: Pick<ModelProfileSampling, 'accepted' | 'rule'>;
  prefill?: ProfileSupport;
  notes?: readonly string[];
}

/** Anthropic's model catalog — the API reference the 5.x rules were verified against. */
const ANTHROPIC_SOURCE = {
  sourceUrl: 'https://platform.claude.com/docs/en/models/overview',
  checkedAt: '2026-10-06',
} as const;

/** The research date of every non-Anthropic fact (roadmap 5.3). */
const RESEARCHED = '2026-10-09';

const OPENAI_MODELS = 'https://developers.openai.com/api/docs/models';
const DEEPSEEK_SOURCE = {
  sourceUrl: 'https://api-docs.deepseek.com/quick_start/pricing/',
  checkedAt: RESEARCHED,
} as const;

const CLAUDE_5_UNSTATED = ['nativePdf', 'audio'] as const;
const NO_SAMPLING = {
  accepted: 'none',
  rule: 'temperature, top_p and top_k are rejected (400)',
} as const;
const GPT_6_UNSTATED = ['tools', 'vision', 'structuredOutput', 'nativePdf', 'audio'] as const;
/** What the compat-host sources leave open (the rows keep their conservative defaults). */
const COMPAT_UNSTATED = [
  'vision',
  'structuredOutput',
  'nativePdf',
  'audio',
  'contextWindow',
] as const;
const GPT_5_MINIMAL = [
  "OpenAI documents effort minimal, low, medium and high; 'minimal' has no Deuz level, so 'none' is sent as 'low' (research-dated 2026-10-10, not live-verified).",
] as const;
/**
 * A priced GPT-5 snapshot pinned with no researched facts (F19). Like
 * gpt-6-astra, its limits, vision and sampling rules stay unstated, and since
 * 'none' rides the OpenAI wire's historical mapping, no thinking mode is claimed.
 */
const GPT_5_UNRESEARCHED: Facts = /* @__PURE__ */ (() => ({
  unknown: [...GPT_6_UNSTATED, 'contextWindow'],
  thinking: { mode: 'unknown' },
  sampling: { accepted: 'unknown' },
}))();
const DEEPSEEK_V4_NOTES = [
  'Always reasons; reasoning tokens share the output budget, so a cap sized for the answer alone can return an empty answer.',
  'Rejects response_format json_schema, and a forced tool_choice in thinking mode.',
  'Keep reasoning_content across a multi-turn tool conversation.',
] as const;

// The tables below spread shared sources, which a bundler cannot prove free of
// side effects, so each is built by a pure-annotated call: an app that never
// calls resolveModelProfile does not carry them.
const FACTS: Readonly<Record<string, Facts>> = /* @__PURE__ */ (() => ({
  // --- Anthropic: verified against Anthropic's API reference (cached
  // 2026-10-06), not live-verified. ---
  'claude-fable-5-1': {
    ...ANTHROPIC_SOURCE,
    status: 'stable',
    unknown: CLAUDE_5_UNSTATED,
    thinking: { mode: 'always', types: ['adaptive'] },
    sampling: NO_SAMPLING,
    prefill: 'unsupported',
    notes: [
      'Requires 30-day data retention; zero data retention only with Anthropic’s explicit approval.',
    ],
  },
  'claude-opus-5-5': {
    ...ANTHROPIC_SOURCE,
    status: 'stable',
    unknown: CLAUDE_5_UNSTATED,
    thinking: { mode: 'always', types: ['adaptive'] },
    sampling: NO_SAMPLING,
    prefill: 'unsupported',
  },
  'claude-sonnet-5-5': {
    ...ANTHROPIC_SOURCE,
    status: 'stable',
    unknown: CLAUDE_5_UNSTATED,
    thinking: { mode: 'default', types: ['adaptive', 'between_tools'] },
    sampling: { accepted: 'defaults-only', rule: 'a non-default sampling value is rejected (400)' },
    prefill: 'unsupported',
    notes: [
      "Thinking turns off only through thinking.type 'between_tools', at effort high or below; 'disabled' is rejected.",
    ],
  },
  'claude-haiku-5-5': {
    ...ANTHROPIC_SOURCE,
    status: 'stable',
    unknown: CLAUDE_5_UNSTATED,
    thinking: { mode: 'default', types: ['adaptive', 'disabled'] },
    sampling: {
      accepted: 'defaults-only',
      rule: 'temperature 1 or top_p 0.99 only, never both; no top_k',
    },
    prefill: 'unsupported',
    notes: [
      "Thinking can be 'disabled' only at effort high or below.",
      'A forced tool_choice is accepted, but that turn skips thinking.',
      'No server-side fallback.',
    ],
  },
  'claude-opus-5': {
    ...ANTHROPIC_SOURCE,
    status: 'stable',
    unknown: CLAUDE_5_UNSTATED,
    notes: ["The previous Opus: thinking can be 'disabled' only at effort high or below."],
  },

  // --- OpenAI: research-dated (2026-10-09), not live-verified. ---
  'gpt-6.1-sol': {
    sourceUrl: 'https://developers.openai.com/api/docs/models/gpt-6.1-sol',
    checkedAt: RESEARCHED,
    unknown: ['vision', 'structuredOutput', 'nativePdf', 'audio'],
    sampling: { accepted: 'unknown' },
    notes: ['Tool calling runs on the Responses API only; Chat Completions works without tools.'],
  },
  'gpt-6-astra': {
    sourceUrl: OPENAI_MODELS,
    checkedAt: RESEARCHED,
    unknown: [...GPT_6_UNSTATED, 'contextWindow'],
    // Whether reasoning can be turned off is undocumented: 'none' rides the
    // OpenAI wire's historical mapping, but no mode is claimed.
    thinking: { mode: 'unknown' },
    sampling: { accepted: 'unknown' },
  },
  'gpt-6-luna': {
    sourceUrl: OPENAI_MODELS,
    checkedAt: RESEARCHED,
    unknown: [...GPT_6_UNSTATED, 'contextWindow'],
    sampling: { accepted: 'unknown' },
    notes: ["Documents effort 'none'; that is not generalised to gpt-6.1-sol."],
  },
  'gpt-5.5': {
    sampling: { accepted: 'unknown' },
    notes: [
      'A reasoning row on Chat Completions (max_completion_tokens, no sampling parameters): not live-verified.',
    ],
  },
  'gpt-5.5-pro': {
    sampling: { accepted: 'unknown' },
    notes: [
      'A reasoning row on Chat Completions (max_completion_tokens, no sampling parameters): not live-verified.',
    ],
  },
  // The GPT-5 snapshots' effort sets as OpenAI publishes them (the rows hold
  // the levels): research-dated 2026-10-10, not live-verified.
  'gpt-5': { notes: GPT_5_MINIMAL },
  'gpt-5-mini': { notes: GPT_5_MINIMAL },
  'gpt-5-nano': { notes: GPT_5_MINIMAL },
  'gpt-5.1': {
    notes: [
      'OpenAI documents effort none, low, medium and high (research-dated 2026-10-10, not live-verified).',
    ],
  },
  'gpt-5.2': {
    notes: [
      'OpenAI documents effort none, low, medium, high and xhigh (research-dated 2026-10-10, not live-verified).',
    ],
  },
  'gpt-5-pro': {
    unknown: [...GPT_6_UNSTATED, 'contextWindow'],
    sampling: { accepted: 'unknown' },
    notes: [
      "OpenAI documents effort high only, so any other level and 'none' are sent as 'high' (research-dated 2026-10-10, not live-verified).",
    ],
  },
  // The other F19 rows that pin no limits: nothing about them was researched.
  'gpt-5.6': GPT_5_UNRESEARCHED,
  'gpt-5.6-sol': GPT_5_UNRESEARCHED,
  'gpt-5.6-terra': GPT_5_UNRESEARCHED,
  'gpt-5.6-luna': GPT_5_UNRESEARCHED,
  'gpt-5.2-pro': GPT_5_UNRESEARCHED,
  'gpt-5.4-pro': GPT_5_UNRESEARCHED,
  'gpt-5.2-codex': GPT_5_UNRESEARCHED,

  // --- Google: research-dated (2026-10-09), not live-verified. ---
  'gemini-3.8-flash': {
    sourceUrl: 'https://ai.google.dev/gemini-api/docs/latest-model',
    checkedAt: RESEARCHED,
    status: 'stable',
    unknown: ['vision', 'caching', 'nativePdf', 'audio', 'contextWindow'],
    sampling: { accepted: 'unknown' },
    notes: [
      "Thinking levels low/medium/high (default medium); there is no 'minimal', so reasoning cannot be turned off.",
      'Do not carry thinking_budget, sampling, prefill or candidate_count settings over from older models automatically.',
    ],
  },
  'gemini-3.1-pro-preview': {
    sourceUrl: 'https://ai.google.dev/gemini-api/docs/models/gemini-3.1-pro-preview',
    checkedAt: RESEARCHED,
    status: 'preview',
    notes: ['A preview profile of its own: it does not inherit the gemini-3.8-flash rules.'],
  },
  'gemini-3-pro': {
    status: 'deprecated',
    resolvedId: 'gemini-3.1-pro-preview',
    notes: ['Shut down on 2026-03-09; the id now aliases gemini-3.1-pro-preview.'],
  },

  // --- DeepSeek: research-dated (2026-10-09), not live-verified. ---
  'deepseek-flash': {
    ...DEEPSEEK_SOURCE,
    resolvedId: 'V4.1-Flash',
    unknown: COMPAT_UNSTATED,
    thinking: { mode: 'unknown' },
    sampling: { accepted: 'unknown' },
    notes: [
      "Treated like the always-reasoning V4 family: effort 'none' is not sent.",
      'Keep reasoning_content across a multi-turn tool conversation.',
      'Prices depend on the time of day (peak and off-peak windows in UTC).',
    ],
  },
  'deepseek-v4-pro': {
    ...DEEPSEEK_SOURCE,
    resolvedId: 'V4-Pro-0813',
    // json_schema is a verified rejection on V4, so structuredOutput stays
    // stated. The forced tool_choice rejection is the row's own field.
    unknown: ['vision', 'nativePdf', 'audio', 'contextWindow'],
    maxOutput: 65_536,
    sampling: { accepted: 'unknown' },
    notes: DEEPSEEK_V4_NOTES,
  },
  'deepseek-v4-flash': {
    ...DEEPSEEK_SOURCE,
    unknown: ['vision', 'nativePdf', 'audio', 'contextWindow'],
    maxOutput: 65_536,
    sampling: { accepted: 'unknown' },
    notes: [
      ...DEEPSEEK_V4_NOTES,
      'A legacy alias: do not price it as an independent current model.',
    ],
  },

  // --- Kimi, Z.ai: research-dated (2026-10-09), not live-verified. ---
  'kimi-k3': {
    sourceUrl: 'https://platform.kimi.ai/docs/guide/kimi-k3-quickstart',
    checkedAt: RESEARCHED,
    unknown: COMPAT_UNSTATED,
    sampling: { accepted: 'unknown' },
    notes: [
      'Never send the K2.x thinking parameter.',
      'Keep the whole assistant message — reasoning_content and tool_calls — across a tool conversation.',
    ],
  },
  'kimi-k2.7-code': {
    sourceUrl: 'https://platform.kimi.ai/docs/guide/kimi-k2-7-code-quickstart',
    checkedAt: RESEARCHED,
    unknown: COMPAT_UNSTATED,
    sampling: { accepted: 'unknown' },
    notes: ["No non-thinking mode, and K3's effort levels do not apply: no effort is sent."],
  },
  'glm-5.3': {
    sourceUrl: 'https://docs.z.ai/guides/llm/glm-5.3',
    checkedAt: RESEARCHED,
    // Text-only is documented, so vision / PDF / audio stay stated (unsupported).
    unknown: ['structuredOutput', 'contextWindow'],
    sampling: { accepted: 'unknown' },
    notes: [
      "Access depends on the account and its Coding Plan history, so the endpoint is never guessed from the id: createGLM defaults to BigModel (open.bigmodel.cn); pass baseURL for Z.ai's international API.",
      "thinking.type 'disabled' is unsupported. Effort rides reasoning_effort on the OpenAI-compatible wire.",
    ],
  },

  // --- Open weights: the official model card, research-dated (2026-10-09). ---
  'Qwen/Qwen3-Coder-Next': {
    sourceUrl: 'https://huggingface.co/Qwen/Qwen3-Coder-Next',
    checkedAt: RESEARCHED,
    unknown: ['tools', 'vision', 'structuredOutput', 'nativePdf', 'audio'],
    notes: [
      "Tool calling needs the serving engine's qwen3_coder tool parser; the engine, chat template, quantization and configured context decide what works.",
      'No dedicated vLLM/SGLang factory: use createOpenAICompatible with a baseURL.',
    ],
  },
}))();

/** An unknown `claude-{fable,opus,sonnet,haiku}-N` (N ≥ 5): the family rules, not facts about the id. */
const CLAUDE_5_FAMILY: Facts = /* @__PURE__ */ (() => ({
  ...ANTHROPIC_SOURCE,
  thinking: { mode: 'always', types: ['adaptive'] },
  sampling: { accepted: 'unknown' },
  prefill: 'unsupported',
  notes: [
    'No row of its own: the strictest documented Claude 5.x rules apply — effort on output_config, no budget_tokens, no sampling parameters, no forced tool_choice.',
  ],
}))();

const CAPABILITIES: readonly ProfileCapability[] = [
  'tools',
  'vision',
  'reasoning',
  'structuredOutput',
  'caching',
  'nativePdf',
  'audio',
];

/**
 * Resolve the profile of a model descriptor (2.3) — the registry row plus any
 * factory `capabilities` override, read through the documentary facts above.
 * Unknown ids never throw: they get a profile whose facts are `'unknown'`.
 *
 * ```ts
 * import { resolveModelProfile } from '@deuz-sdk/core';
 *
 * const profile = resolveModelProfile(anthropic('claude-opus-5-5'));
 * profile.effort.none; // 'lowest' — Opus 5.5 cannot turn thinking off
 * profile.clamps;      // every value a request changes, and the warning it reports
 * ```
 *
 * A frozen copy, rebuilt on every call. Pure: no network, no logging, no key.
 */
export function resolveModelProfile(model: LanguageModel): ModelProfile {
  const caps = getCapabilities(model);
  const match = registryMatch(model);
  const facts =
    match === 'exact'
      ? Object.hasOwn(FACTS, model.modelId)
        ? FACTS[model.modelId]
        : undefined
      : match === 'family'
        ? CLAUDE_5_FAMILY
        : undefined;
  const claimed: Partial<Record<string, unknown>> = readConfig(model)?.capabilities ?? {};
  const protocol = model.surface;
  const wire = effortWire(protocol, caps, model.modelId);
  // A pinned row that leaves its output limit undocumented pins only what its
  // request rules need. Without a documentary entry, its other values are the
  // row's conservative defaults: never facts, whatever an override claims.
  const undocumented = facts === undefined && isUndocumentedRow(model);

  /** Known = the caller claimed it, or a pinned row states it and no fact marks it unstated. */
  const known = (key: ProfileCapability | 'contextWindow'): boolean =>
    claimed[key] !== undefined ||
    (match === 'exact' && !undocumented && !facts?.unknown?.includes(key));

  const capabilities = Object.fromEntries(
    CAPABILITIES.map((key): [ProfileCapability, ProfileSupport] => [
      key,
      !known(key) ? 'unknown' : caps[key] ? 'supported' : 'unsupported',
    ]),
  ) as Record<ProfileCapability, ProfileSupport>;

  const levels = caps.reasoning ? ascending(caps.effortLevels ?? wire.accepted) : [];
  const none: ModelProfileEffort['none'] = caps.reasoning
    ? (caps.effortNone ?? wire.noneDefault ?? 'model-default')
    : 'model-default';
  const effort: ModelProfileEffort = {
    ...(levels.length > 0 ? { field: wire.field } : {}),
    levels,
    ...(caps.effortDefault !== undefined ? { default: caps.effortDefault } : {}),
    none,
  };

  const handling: ModelProfileSampling['handling'] =
    caps.samplingRestrictions && protocol !== 'native'
      ? 'stripped'
      : protocol === 'anthropic' && caps.reasoning && wire.budgets
        ? 'stripped-while-thinking'
        : 'sent';
  const sampling: ModelProfileSampling = {
    handling,
    accepted:
      facts?.sampling?.accepted ??
      (match !== 'exact' || undocumented ? 'unknown' : caps.samplingRestrictions ? 'none' : 'any'),
    ...(facts?.sampling?.rule !== undefined ? { rule: facts.sampling.rule } : {}),
  };

  const contextWindow = known('contextWindow') ? caps.contextWindow : undefined;
  const maxOutput =
    claimed.maxOutput !== undefined
      ? caps.maxOutput
      : (facts?.maxOutput ??
        (match === 'exact' && !isMaxOutputPlaceholder(caps) ? caps.maxOutput : undefined));
  const limits: ModelProfileLimits = {
    ...(contextWindow !== undefined ? { contextWindow } : {}),
    ...(maxOutput !== undefined ? { maxOutput } : {}),
    // Anthropic's max_tokens is required, so even a placeholder is sent there.
    defaultOutputCap:
      protocol !== 'anthropic' && isMaxOutputPlaceholder(caps) ? 'omitted' : caps.maxOutput,
  };

  const thinking: ModelProfileThinking = {
    mode: facts?.thinking?.mode ?? thinkingMode(caps, wire, none, known('reasoning')),
    ...(facts?.thinking?.types ? { types: [...facts.thinking.types] } : {}),
    replay:
      (match === 'fallback' || undocumented) && claimed.reasoning === undefined
        ? 'unknown'
        : replayFor(protocol, model.provider, caps.reasoning),
  };

  const profile: ModelProfile = {
    provider: model.provider,
    requestedId: model.modelId,
    ...(facts?.resolvedId !== undefined ? { resolvedId: facts.resolvedId } : {}),
    protocol,
    match,
    status: facts?.status ?? 'unknown',
    capabilities,
    effort,
    thinking,
    limits,
    sampling,
    // The row's own field, never a fact beside it: what the profile reports is
    // what the wire does with a forced choice.
    forcedToolChoice:
      caps.forcedToolChoice === undefined
        ? 'unknown'
        : caps.forcedToolChoice
          ? 'supported'
          : 'unsupported',
    prefill: facts?.prefill ?? 'unknown',
    ...(caps.toolSurfaces ? { toolProtocols: [...caps.toolSurfaces] } : {}),
    usage: {
      reasoningInclusive:
        protocol === 'native'
          ? false
          : protocol === 'chat_completions' && model.provider !== 'openai'
            ? 'unknown'
            : true,
    },
    cache: {
      mode:
        protocol === 'anthropic'
          ? 'breakpoints'
          : protocol === 'native'
            ? 'cached-content'
            : model.provider === 'openai'
              ? 'implicit'
              : 'unknown',
      promptCaching: protocol === 'anthropic' && caps.caching ? 'supported' : 'unsupported',
    },
    refusal: protocol === 'anthropic' ? 'stop-reason' : 'unknown',
    clamps: clampsFor(protocol, caps, wire, levels, none, handling),
    ...(facts?.sourceUrl !== undefined ? { sourceUrl: facts.sourceUrl } : {}),
    ...(facts?.checkedAt !== undefined ? { checkedAt: facts.checkedAt } : {}),
    liveVerified: false,
    notes: [
      ...(facts?.notes ?? []),
      ...(match === 'fallback'
        ? [
            `No registry row for '${model.modelId}': the conservative ${model.provider}/${protocol} defaults apply.`,
          ]
        : []),
    ],
  };
  return deepFreeze(profile);
}

/** Levels in canonical ascending order (an override may list them in any order). */
function ascending(levels: readonly EffortLevel[]): EffortLevel[] {
  return EFFORT_SCALE.filter((level) => levels.includes(level));
}

/** The reasoning mode the request rules imply, when no fact states it. */
function thinkingMode(
  caps: ModelCapabilities,
  wire: EffortWire,
  none: ModelProfileEffort['none'],
  reasoningKnown: boolean,
): ModelProfileThinking['mode'] {
  if (!reasoningKnown) return 'unknown';
  if (!caps.reasoning) return 'never';
  if (wire.field === 'thinking.budget_tokens') return 'opt-in';
  switch (none) {
    case 'send':
    case 'thinking-disabled':
    case 'thinking-between-tools':
      return 'default';
    case 'lowest':
    case 'omit':
      return 'always';
    default:
      return 'unknown';
  }
}

/** How reasoning state rides into the next turn on this wire. */
function replayFor(
  protocol: ModelSurface,
  provider: string,
  reasoning: boolean,
): ModelProfileThinking['replay'] {
  if (!reasoning) return 'none';
  switch (protocol) {
    case 'anthropic':
      return 'thinking-blocks';
    case 'responses':
      return 'encrypted-reasoning';
    case 'native':
      return 'thought-signatures';
    case 'chat_completions':
      if (provider === 'deepseek' || provider === 'moonshot') return 'reasoning-content';
      // OpenAI's Chat Completions never returns reasoning, so there is nothing to carry.
      return provider === 'openai' ? 'none' : 'unknown';
  }
}

/**
 * Every value a request changes for this model, mirroring the adapters' rules
 * (core/request-rules.ts and the four `buildRequest`s) — the profile tests
 * cross-check it against real requests.
 */
function clampsFor(
  protocol: ModelSurface,
  caps: ModelCapabilities,
  wire: EffortWire,
  levels: readonly EffortLevel[],
  none: ModelProfileEffort['none'],
  sampling: ModelProfileSampling['handling'],
): ModelProfileClamp[] {
  const out: ModelProfileClamp[] = [];
  const clamp = (
    setting: ModelProfileClamp['setting'],
    from: string,
    to: string,
    when?: string,
  ): void => {
    out.push({ setting, from, to, warning: 'clamped-setting', ...(when ? { when } : {}) });
  };
  const drop = (setting: ModelProfileClamp['setting'], from: string): void => {
    out.push({ setting, from, to: 'dropped', warning: 'unsupported-setting' });
  };

  for (const level of EFFORT_SCALE) {
    if (levels.length === 0) {
      drop('effort', level);
      continue;
    }
    const sent = clampEffortLevel(level, levels)!;
    if (sent !== level) clamp('effort', level, sent);
    else if (wire.budgets && budgetPeers(wire.budgets, level).length > 0) {
      clamp('effort', level, `${wire.field} ${wire.budgets[level]}`);
    }
  }
  if (caps.reasoning && (none === 'lowest' || none === 'omit')) {
    const lowest = none === 'lowest' ? clampEffortLevel('low', levels) : undefined;
    if (lowest !== undefined) clamp('effort', 'none', lowest);
    else drop('effort', 'none');
  }
  // Anthropic turns thinking off only at effort ≤ high: without a documented
  // default within that limit, the request pins output_config.effort 'low'.
  if (
    wire.field === 'output_config.effort' &&
    (none === 'thinking-disabled' || none === 'thinking-between-tools') &&
    !atMostHigh(caps.effortDefault)
  ) {
    clamp('effort', 'none', 'low');
  }

  const thinking = 'effort is set (extended thinking is on)';
  if (sampling === 'stripped') {
    drop('temperature', '*');
    drop('topP', '*');
  } else if (sampling === 'stripped-while-thinking') {
    clamp('temperature', '*', 'dropped', thinking);
    clamp('topP', '*', 'dropped', thinking);
  }

  const forced = ["'required'", "{ type: 'tool' }"];
  if (caps.forcedToolChoice === false) {
    for (const from of forced) clamp('toolChoice', from, 'auto');
  } else if (protocol === 'anthropic' && caps.forcedToolChoice === undefined && caps.reasoning) {
    for (const from of forced) clamp('toolChoice', from, 'auto', thinking);
  }

  // generateObject / streamObject: an explicit `mode: 'tool'` runs the json
  // strategy where the forced tool cannot be taken (inference/object-shared.ts).
  if (
    caps.forcedToolChoice === false ||
    (protocol === 'anthropic' && caps.effortWire === 'output_config')
  ) {
    clamp('mode', "'tool'", 'json');
  } else if (protocol === 'anthropic' && caps.reasoning) {
    clamp('mode', "'tool'", 'json', thinking);
  }

  if (protocol === 'anthropic' && caps.reasoning && wire.budgets) {
    clamp(
      'maxOutputTokens',
      'below thinking.budget_tokens + 1024',
      'thinking.budget_tokens + 1024',
      thinking,
    );
  }
  if (protocol === 'anthropic' && !caps.caching) drop('promptCaching', '*');
  return out;
}

/** Freeze a plain profile object and everything inside it. */
function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const inner of Object.values(value)) deepFreeze(inner);
    Object.freeze(value);
  }
  return value;
}
