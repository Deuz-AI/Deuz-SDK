/**
 * Types of budget- and policy-aware tool search (2.5). The implementation lives
 * in `src/tool-search.ts`; these are pure data and function shapes.
 */
import type { CommonCallOptions } from './config';
import type { ExecutionPolicy, NativeExecutionContext } from './execution';
import type { Guardrails, ToolCallGuardrail } from './guardrails';
import type { JSONSchema } from './schema';
import type { Message } from './message';

/**
 * What one call of a tool is expected to cost, beyond the model call that
 * issues it: a paid API, a sub-agent's own model calls, a large result the
 * model will read. Either dimension may be omitted; an omitted dimension never
 * excludes a tool. Values are finite and nonnegative.
 */
export interface ToolCostEstimate {
  /** Estimated USD per call. */
  readonly usd?: number;
  /** Estimated tokens per call (sub-agent spend, or the result's size in the context). */
  readonly tokens?: number;
}

/**
 * Search metadata of one tool. It never reaches a wire and never changes how
 * the tool runs: the loop does not read it.
 */
export interface ToolSearchMeta {
  /** Estimated cost per call; see {@link ToolCostEstimate}. */
  readonly cost?: ToolCostEstimate;
  /** Extra search terms (aliases, domain words) indexed with the tool's name. */
  readonly keywords?: readonly string[];
}

/** The budget a search measures tool costs against. A missing dimension is unbounded. */
export interface ToolBudgetRemaining {
  readonly usd?: number;
  readonly tokens?: number;
}

/** What a remaining-budget source and a model-driven search can see. */
export interface ToolSearchContext {
  /** The history at the time of the search (the search call's own turn included). */
  readonly messages?: readonly Message[];
  /** The run's execution context, when the call carries one (always in a native run). */
  readonly execution?: NativeExecutionContext;
  /** The call's opaque `runtimeContext`, forwarded untouched (legacy loop only). */
  readonly runtimeContext?: unknown;
}

/** Where a search reads the remaining budget from. */
export type ToolBudgetSource =
  | ToolBudgetRemaining
  | ((
      context: ToolSearchContext,
    ) => ToolBudgetRemaining | undefined | Promise<ToolBudgetRemaining | undefined>);

/** Budget filtering and labelling of a search. */
export interface ToolSearchBudgetOptions {
  /**
   * The remaining budget, or a function that reads it per search (from a
   * `BudgetStore` with `remainingFromBudgetStore`, for example). When the
   * search runs inside a call that carries an execution context, its ledger's
   * remaining budget (`remainingFromExecution`) applies too, and the tighter
   * of the two wins per dimension.
   */
  readonly remaining?: ToolBudgetSource;
  /**
   * A tool whose estimated cost does not fit the remaining budget:
   * `'exclude'` (the default) leaves it out of the results, so it is never
   * loaded; `'label'` returns it marked `overBudget: true`.
   */
  readonly overBudget?: 'exclude' | 'label';
  /**
   * When a fitting tool is labelled `expensive`: its estimate reaches `usd` or
   * `tokens`, or `share` (default 0.5) of the remaining budget in either
   * dimension. Pass `share: 1` or more to label on absolute thresholds only.
   */
  readonly expensive?: { readonly usd?: number; readonly tokens?: number; readonly share?: number };
}

/** Options of {@link createToolSearch}. `T` is a legacy `ToolSet` or a native `AgentToolSet`. */
export interface ToolSearchOptions<T extends Record<string, ToolSearchCatalogTool>> {
  /** The full catalog. Every tool not in `alwaysLoaded` is deferred behind the search tool. */
  readonly tools: T;
  /**
   * Tools offered on every step without a search. A name outside `tools` is
   * passed through unchanged, which is how a tool the loop adds by itself (an
   * MCP tool from the call's `mcp` entries) stays visible and callable.
   */
  readonly alwaysLoaded?: readonly string[];
  /** The search tool's name. Default `'tool_search'`. It must not name a catalog tool. */
  readonly name?: string;
  /** The search tool's description, replacing the default one. */
  readonly description?: string;
  /** Most tools one search returns, and the cap on the model's `limit`. Default 5. */
  readonly maxResults?: number;
  /** Per-tool search metadata by tool name; wins over `withSearchMeta` on the tool. */
  readonly meta?: Readonly<Record<string, ToolSearchMeta>>;
  /** Budget filtering and labelling. Without it, costs are reported but never compared. */
  readonly budget?: ToolSearchBudgetOptions;
  /**
   * An execution policy to apply to results, intersected with the policy of
   * the execution context a search runs under: a tool outside `allowedTools`
   * is never returned, and `requireApproval` labels every tool.
   */
  readonly policy?: ExecutionPolicy;
  /**
   * Refuse a call of a deferred tool the history never surfaced (default
   * true), through an `onToolCall` guardrail that `apply` installs. The model
   * learns to search first; the call becomes a `permission-denied` result.
   * Because the history can be forged, a surfaced name outside the static
   * `policy`'s `allowedTools` never counts, and under `overBudget: 'exclude'`
   * a tool with a cost estimate is re-checked against `budget.remaining` at
   * call time (refused when it no longer fits, or when that source throws).
   *
   * The guardrail `apply` installs also refuses a call of any other tool that
   * is neither the search tool, nor in `alwaysLoaded`, nor one of the call's
   * own `tools`: a tool the loop merges in from the call's `mcp` entries is
   * hidden under search and refused too, unless `alwaysLoaded` names it. It
   * lets through a sub-agent's calls (`agentPath` set) and, once the history
   * holds a call of one of the call's handoff tools, calls it cannot judge.
   */
  readonly enforce?: boolean;
}

/**
 * The fields a catalog tool needs for indexing and labelling. Both `Tool`
 * and native `AgentTool` satisfy it.
 */
export interface ToolSearchCatalogTool {
  description?: string;
  parameters: unknown;
  needsApproval?: unknown;
  type?: 'function' | 'provider';
}

/** How a tool's approval reads to the model: always, never, or depending on its arguments. */
export type ToolApprovalLabel = boolean | 'conditional';

/** One search result, with its labels. */
export interface ToolSearchHit {
  readonly name: string;
  readonly description?: string;
  /** BM25 relevance (higher is better); `select:` hits score 0. */
  readonly score: number;
  /**
   * `true` when the tool's `needsApproval` is `true` or the policy has
   * `requireApproval`; `'conditional'` when `needsApproval` is a function of the
   * arguments; `false` otherwise.
   */
  readonly requiresApproval: ToolApprovalLabel;
  /** The tool's estimated cost per call, when known. */
  readonly estimatedCost?: ToolCostEstimate;
  /** The estimate is large; see {@link ToolSearchBudgetOptions.expensive}. */
  readonly expensive: boolean;
  /** The estimate does not fit the remaining budget (returned only under `overBudget: 'label'`). */
  readonly overBudget: boolean;
  /** The tool is always loaded, so it needs no search to be callable. */
  readonly alwaysLoaded: boolean;
}

/** What a direct search returns. */
export interface ToolSearchResult {
  readonly query: string;
  /** Matching tools, most relevant first. */
  readonly hits: readonly ToolSearchHit[];
  /** Matching tools left out: over budget (under `'exclude'`) or refused by the policy. */
  readonly withheld: { readonly budget: number; readonly policy: number };
  /** The remaining budget the search measured against, when one was known. */
  readonly remaining?: ToolBudgetRemaining;
}

/** Options of one direct search. */
export interface ToolSearchQueryOptions {
  /** Most hits to return; capped by `maxResults`. */
  readonly limit?: number;
  /** The context remaining-budget sources and the execution policy are read from. */
  readonly context?: ToolSearchContext;
}

/** The arguments the model passes to the search tool. */
export interface ToolSearchArgs {
  query: string;
  limit?: number;
}

/** One tool as the model sees it in a search result: labels appear only when they apply. */
export interface ToolSearchToolEntry {
  name: string;
  description?: string;
  requiresApproval?: true | 'conditional';
  estimatedCost?: ToolCostEstimate;
  expensive?: true;
  overBudget?: true;
}

/** The search tool's result, as it enters the history. */
export interface ToolSearchToolResult {
  query: string;
  tools: ToolSearchToolEntry[];
  withheld?: { budget: number; policy: number };
  note: string;
}

/** The context the search tool's `execute` reads; legacy and native tool contexts both fit it. */
export interface ToolSearchExecuteContext {
  messages?: Message[];
  execution?: NativeExecutionContext;
  runtimeContext?: unknown;
}

/** The search tool: valid in a legacy `ToolSet` and in a native `AgentToolSet`. */
export interface ToolSearchTool {
  description: string;
  parameters: JSONSchema;
  execute: (args: unknown, context: ToolSearchExecuteContext) => Promise<ToolSearchToolResult>;
}

/**
 * The call options `apply` composes with. A legacy call and a native run both
 * have them. `apply` accepts any options object and checks these fields when
 * present; the rest (`model`, `prompt`, `maxSteps`, ...) pass through untyped
 * by it and are checked by the call they are handed to.
 */
export interface ToolSearchCallOptions {
  tools?: Record<string, unknown>;
  activeTools?: string[];
  prepareStep?: CommonCallOptions['prepareStep'];
  guardrails?: Guardrails;
}

/**
 * The caller's own `tools` in options `O`. With none, `U` infers as `unknown`
 * and this is `{}`, which leaves the intersection it joins unchanged.
 */
type OwnToolsOf<O> = O extends { tools?: infer U } ? NonNullable<U> : unknown;

/** The three fields `apply` sets on the options it returns. */
export interface ToolSearchAppliedFields<O, T extends Record<string, ToolSearchCatalogTool>> {
  /** The caller's own tools, the catalog, and the search tool. */
  tools: OwnToolsOf<O> & T & Record<string, ToolSearchTool>;
  /** The composed `prepareStep`: the caller's first, then the search's `activeTools`. */
  prepareStep: NonNullable<CommonCallOptions['prepareStep']>;
  /**
   * The search guardrail first when `enforce` holds (named `'tool-search'`, it
   * also refuses tools the step never offered), then the caller's; otherwise
   * the caller's.
   */
  guardrails?: Guardrails;
}

/**
 * What `apply` returns for call options `O` over catalog `T`: every field of
 * `O` with its own type, except the three `apply` replaces (see
 * {@link ToolSearchAppliedFields}). It is a mapped type over `O`, not an
 * `Omit`, so TypeScript can infer `O` back from the call it is handed to: in
 * `runAgent(search.apply({ ..., checkpointVersion: 3 }))` the literal keeps
 * its type and selects the V3 overload.
 */
export type ToolSearchApplied<O, T extends Record<string, ToolSearchCatalogTool>> = {
  [K in keyof O]: K extends keyof ToolSearchAppliedFields<O, T>
    ? ToolSearchAppliedFields<O, T>[K]
    : O[K];
} & ToolSearchAppliedFields<O, T>;

/** A tool search over one catalog; see {@link createToolSearch}. */
export interface ToolSearch<T extends Record<string, ToolSearchCatalogTool>> {
  /** The search tool's name. */
  readonly name: string;
  /** The catalog plus the search tool. Pass it as the call's `tools`. */
  readonly tools: T & Record<string, ToolSearchTool>;
  /** The search tool on its own. */
  readonly searchTool: ToolSearchTool;
  /** Search the catalog directly, without a model. */
  search(query: string, options?: ToolSearchQueryOptions): Promise<ToolSearchResult>;
  /**
   * The catalog tools the history has surfaced: every tool a successful search
   * call returned. Read from the search results in the history, so it survives
   * a checkpoint and a resume; a result that compaction pruned is recomputed
   * from its recorded query against the catalog and the static policy.
   */
  surfaced(messages: readonly Message[]): Promise<string[]>;
  /** The names to offer for a history: the search tool, the always-loaded tools, the surfaced ones. */
  activeTools(messages: readonly Message[]): Promise<string[]>;
  /** A `prepareStep` that sets `activeTools`; `apply` composes it with the caller's. */
  readonly prepareStep: NonNullable<CommonCallOptions['prepareStep']>;
  /**
   * The `onToolCall` guardrail that refuses deferred tools the history never
   * surfaced, and (under `overBudget: 'exclude'`) ones that no longer fit
   * `budget.remaining`. It judges catalog tools only; the guardrail `apply`
   * installs wraps it and also refuses tools the step never offered (see
   * `enforce`).
   */
  readonly guardrail: ToolCallGuardrail;
  /**
   * Wire the search into a call's options (legacy `generateText`/`streamChat`,
   * native `runAgent`/`streamAgent`): `tools`, a composed `prepareStep`, and the
   * guardrail when `enforce` holds. The caller's own `tools` stay always loaded;
   * its `activeTools` (static or per step) can only narrow what search offers.
   *
   * The options are typed `O & ToolSearchCallOptions`, not `O extends
   * ToolSearchCallOptions`: that constraint has only optional fields, so a
   * call's options sharing none of them (`{ model, prompt, maxSteps }`) would
   * fail TypeScript's weak-type check and lose their own type. The result keeps
   * `O`'s other fields as given; see {@link ToolSearchApplied}.
   *
   * @example
   * ```ts
   * const result = await generateText(search.apply({ model, prompt, maxSteps: 8 }));
   * const run = await runAgent(search.apply({ model, prompt, maxSteps: 8 }));
   * ```
   */
  apply<O extends object>(options: O & ToolSearchCallOptions): ToolSearchApplied<O, T>;
}
