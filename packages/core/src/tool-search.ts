/**
 * `@deuz-sdk/core/tool-search` (2.5) — budget- and policy-aware tool search.
 *
 * A large catalog stays out of the model's context behind one search tool. The
 * model calls it with a query; the result lists the matching tools and makes
 * them callable from the next step on. What sets it apart from a plain tool
 * search is that it is also a policy layer: a tool the execution policy would
 * refuse is never returned, a tool whose estimated cost does not fit the
 * remaining budget is left out (or labelled), and approval-gated and expensive
 * tools are labelled, so the model chooses with the run's limits in view.
 *
 * ```ts
 * const search = createToolSearch({
 *   tools: catalog,                       // 200 tools
 *   alwaysLoaded: ['get_time'],
 *   meta: { render_video: { cost: { usd: 0.4 } } },
 *   budget: { remaining: { usd: 1 } },
 * });
 * await generateText(search.apply({ model, prompt, maxSteps: 8 }));
 * ```
 *
 * ## How it rides the loop
 *
 * No parallel mechanism: it uses the seam the loops already have. `apply`
 * installs a `prepareStep` that returns `activeTools` (the search tool, the
 * always-loaded tools and the surfaced ones), so the legacy loops and a native
 * `runAgent` decide each step's tool set exactly as they would for a
 * hand-written `prepareStep`, MCP hot-swap and stable-prefix tool-set changes
 * included. The surfaced set is READ FROM THE HISTORY (the search results it
 * holds), never kept in a closure, so one search serves concurrent calls, and
 * a native run that resumes from a checkpoint offers the same tools again: its
 * resume binding covers the full catalog, which never changes, while the
 * per-step narrowing is recomputed from the checkpointed history.
 *
 * An `onToolCall` guardrail (`enforce`, default on) refuses a call of a
 * deferred tool the history never surfaced, before the approval gate, so a
 * guessed name cannot bypass the search's own filters. The one `apply`
 * installs also refuses a tool the step never offered whatever its source
 * (a hidden MCP tool from the call's `mcp` entries included).
 *
 * Index: zero-dependency BM25 over each tool's name (weighted), keywords,
 * description and parameter names and descriptions. Lexical only: no
 * embeddings, no prefix or fuzzy matching. Edge-safe: no clock, no I/O, no
 * ambient state.
 */
import { intersectExecutionPolicies } from './execution-policy';
import { readHandoffTarget } from './inference/handoff';
import { isStandardSchema, toJSONSchema } from './schema/bridge';
import type { CommonCallOptions, PrepareStepResult } from './types/config';
import type { ExecutionPolicy, NativeExecutionContext } from './types/execution';
import type { BudgetStore, PersistentBudgetScope } from './types/budget-store';
import type { ToolCallGuardrail, ToolCallGuardrailResult } from './types/guardrails';
import type { JSONSchema } from './types/schema';
import type { Message } from './types/message';
import type { Tool } from './types/tool';
import type {
  ToolApprovalLabel,
  ToolBudgetRemaining,
  ToolCostEstimate,
  ToolSearch,
  ToolSearchApplied,
  ToolSearchCallOptions,
  ToolSearchCatalogTool,
  ToolSearchContext,
  ToolSearchExecuteContext,
  ToolSearchHit,
  ToolSearchMeta,
  ToolSearchOptions,
  ToolSearchQueryOptions,
  ToolSearchResult,
  ToolSearchTool,
  ToolSearchToolEntry,
  ToolSearchToolResult,
} from './types/tool-search';

export type * from './types/tool-search';

/** Default name of the search tool. */
export const TOOL_SEARCH_NAME = 'tool_search';
const DEFAULT_MAX_RESULTS = 5;
const DEFAULT_EXPENSIVE_SHARE = 0.5;
const SELECT_PREFIX = 'select:';

export type ToolSearchErrorCode = 'invalid_options' | 'invalid_query';

/**
 * A misconfigured search (`'invalid_options'`, thrown by `createToolSearch` and
 * `apply`) or an unusable query (`'invalid_query'`). Thrown inside the search
 * tool, an invalid query becomes an `is_error` result the model can correct.
 */
export class ToolSearchError extends Error {
  readonly name = 'ToolSearchError';

  constructor(
    readonly code: ToolSearchErrorCode,
    message: string,
  ) {
    super(message);
  }
}

// --- Search metadata on a tool ---------------------------------------------

const META = Symbol.for('deuz.toolSearchMeta');

/**
 * Attach search metadata (estimated cost, extra keywords) to a tool without
 * changing the `Tool` type. Returns a shallow COPY carrying it under a
 * symbol key; the original is untouched. The loop never reads it and no wire
 * carries it. `createToolSearch({ meta })` wins over it for the same tool.
 *
 * ```ts
 * const renderVideo = withSearchMeta(tool({ ... }), { cost: { usd: 0.4 } });
 * ```
 */
export function withSearchMeta<T extends object>(tool: T, meta: ToolSearchMeta): T {
  validateMeta('withSearchMeta', meta);
  return { ...tool, [META]: Object.freeze({ ...meta }) };
}

/** The search metadata `withSearchMeta` attached to a tool, if any. */
export function searchMetaOf(tool: object): ToolSearchMeta | undefined {
  return (tool as { [META]?: ToolSearchMeta })[META];
}

function validateMeta(where: string, meta: ToolSearchMeta): void {
  if (meta === null || typeof meta !== 'object')
    throw new ToolSearchError('invalid_options', `${where}: metadata must be an object.`);
  const cost = meta.cost;
  if (cost !== undefined) {
    for (const key of ['usd', 'tokens'] as const) {
      const value = cost[key];
      if (value !== undefined && (!Number.isFinite(value) || value < 0))
        throw new ToolSearchError(
          'invalid_options',
          `${where}: cost.${key} must be a finite nonnegative number.`,
        );
    }
  }
  if (
    meta.keywords !== undefined &&
    (!Array.isArray(meta.keywords) || meta.keywords.some((k) => typeof k !== 'string'))
  )
    throw new ToolSearchError('invalid_options', `${where}: keywords must be strings.`);
}

// --- Tokenizer and BM25 index ----------------------------------------------

const STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from', 'in', 'into', 'is', 'it',
  'its', 'of', 'on', 'or', 'that', 'the', 'this', 'to', 'with', 'tool', 'tools',
]); // prettier-ignore

/** Light plural folding, so `emails` meets `email` and `queries` meets `query`. */
function stem(token: string): string {
  if (token.length > 4 && token.endsWith('ies')) return `${token.slice(0, -3)}y`;
  if (token.length > 3 && token.endsWith('s') && !token.endsWith('ss')) return token.slice(0, -1);
  return token;
}

/**
 * Split text into search terms: camelCase, snake_case, kebab-case and
 * punctuation all separate words; case folds; stop words drop; plurals fold.
 * Unicode letters and digits count as word characters.
 */
export function tokenizeForSearch(text: string): string[] {
  // The second split is a lookahead, not `(\p{Lu}+)(\p{Lu}\p{Ll})`: that form
  // backtracks quadratically on a long run of capitals (40k chars took ~0.7 s).
  return text
    .replace(/([\p{Ll}\p{N}])(\p{Lu})/gu, '$1 $2')
    .replace(/(\p{Lu})(?=\p{Lu}\p{Ll})/gu, '$1 ')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((token) => token.length > 0 && !STOP_WORDS.has(token))
    .map(stem);
}

/** One tool as the index sees it. */
export interface ToolIndexEntry {
  readonly name: string;
  readonly description?: string;
  /** JSON Schema of the parameters: property names and descriptions are indexed. */
  readonly parameters?: JSONSchema;
  readonly keywords?: readonly string[];
}

/** A built BM25 index over tool entries. */
export interface ToolIndex {
  /** Number of indexed tools. */
  readonly size: number;
  /** Matching tools, best first; ties keep catalog order. Only scores above 0. */
  search(query: string, limit?: number): { name: string; score: number }[];
}

const K1 = 1.2;
const B = 0.75;
/** Field weights: a term in the name counts three times, a keyword twice. */
const NAME_WEIGHT = 3;
const KEYWORD_WEIGHT = 2;

/** Property names and descriptions of a JSON Schema, a few levels deep. */
function schemaText(schema: unknown, out: string[], depth = 0): void {
  if (depth > 4 || schema === null || typeof schema !== 'object') return;
  const node = schema as Record<string, unknown>;
  if (typeof node.description === 'string') out.push(node.description);
  if (typeof node.title === 'string' && depth > 0) out.push(node.title);
  const properties = node.properties;
  if (properties && typeof properties === 'object') {
    for (const [key, child] of Object.entries(properties as Record<string, unknown>)) {
      out.push(key);
      schemaText(child, out, depth + 1);
    }
  }
  if (node.items) schemaText(node.items, out, depth + 1);
  for (const key of ['anyOf', 'oneOf', 'allOf'] as const) {
    const list = node[key];
    if (Array.isArray(list)) for (const child of list) schemaText(child, out, depth + 1);
  }
}

/**
 * Build a BM25 index (k1 1.2, b 0.75) over tool entries. Pure and
 * synchronous; the order of `entries` breaks score ties.
 */
export function createToolIndex(entries: readonly ToolIndexEntry[]): ToolIndex {
  const docs = entries.map((entry) => {
    const tf = new Map<string, number>();
    let length = 0;
    const add = (text: string, weight: number) => {
      for (const term of tokenizeForSearch(text)) {
        tf.set(term, (tf.get(term) ?? 0) + weight);
        length += weight;
      }
    };
    add(entry.name, NAME_WEIGHT);
    for (const keyword of entry.keywords ?? []) add(keyword, KEYWORD_WEIGHT);
    if (entry.description) add(entry.description, 1);
    const params: string[] = [];
    schemaText(entry.parameters, params);
    for (const text of params) add(text, 1);
    return { name: entry.name, tf, length };
  });
  const df = new Map<string, number>();
  for (const doc of docs) for (const term of doc.tf.keys()) df.set(term, (df.get(term) ?? 0) + 1);
  const total = docs.length;
  const avgdl = total === 0 ? 0 : docs.reduce((sum, doc) => sum + doc.length, 0) / total;
  return Object.freeze({
    size: total,
    search(query: string, limit = Number.POSITIVE_INFINITY) {
      const terms = [...new Set(tokenizeForSearch(query))];
      if (terms.length === 0 || total === 0) return [];
      const scored: { name: string; score: number; index: number }[] = [];
      docs.forEach((doc, index) => {
        let score = 0;
        for (const term of terms) {
          const freq = doc.tf.get(term);
          if (!freq) continue;
          const n = df.get(term) ?? 0;
          const idf = Math.log(1 + (total - n + 0.5) / (n + 0.5));
          score += (idf * freq * (K1 + 1)) / (freq + K1 * (1 - B + (B * doc.length) / avgdl));
        }
        if (score > 0) scored.push({ name: doc.name, score, index });
      });
      scored.sort((a, b) => b.score - a.score || a.index - b.index);
      return scored.slice(0, limit).map(({ name, score }) => ({ name, score }));
    },
  });
}

// --- Remaining budget sources ------------------------------------------------

/** The tighter of two remaining budgets, per dimension. */
function tighter(
  a: ToolBudgetRemaining | undefined,
  b: ToolBudgetRemaining | undefined,
): ToolBudgetRemaining | undefined {
  if (!a) return b;
  if (!b) return a;
  const min = (x?: number, y?: number) =>
    x === undefined ? y : y === undefined ? x : Math.min(x, y);
  const usd = min(a.usd, b.usd);
  const tokens = min(a.tokens, b.tokens);
  return {
    ...(usd !== undefined ? { usd } : {}),
    ...(tokens !== undefined ? { tokens } : {}),
  };
}

/**
 * The budget an execution context has left: for every scope on its path, the
 * scope's limit minus what its ledger has committed (spent plus held), the
 * tightest scope winning per dimension, never below 0. `undefined` when no
 * scope bounds either dimension.
 */
export function remainingFromExecution(
  execution: NativeExecutionContext,
): ToolBudgetRemaining | undefined {
  let remaining: ToolBudgetRemaining | undefined;
  for (const scope of execution.snapshot().scopes) {
    const { usd, tokens } = scope.budget;
    if (usd === undefined && tokens === undefined) continue;
    const committed = execution.ledger.totals(scope.id).committed;
    remaining = tighter(remaining, {
      ...(usd !== undefined ? { usd: Math.max(0, usd - committed.usd) } : {}),
      ...(tokens !== undefined ? { tokens: Math.max(0, tokens - committed.tokens) } : {}),
    });
  }
  return remaining;
}

/**
 * The budget persistent scopes have left in a `BudgetStore`: each scope's
 * limits minus its committed usage, the tightest scope winning per dimension,
 * never below 0. A windowed scope counts usage since `now - window.ms`, so it
 * needs `now` from the injected clock; omitting it for one throws.
 */
export async function remainingFromBudgetStore(
  store: Pick<BudgetStore, 'usage'>,
  scopes: readonly PersistentBudgetScope[],
  now?: number,
): Promise<ToolBudgetRemaining | undefined> {
  let remaining: ToolBudgetRemaining | undefined;
  for (const scope of scopes) {
    const { usd, tokens } = scope.limits;
    if (usd === undefined && tokens === undefined) continue;
    if (scope.window && (now === undefined || !Number.isFinite(now)))
      throw new ToolSearchError(
        'invalid_options',
        `remainingFromBudgetStore: scope '${scope.key}' has a window, so the current time is required.`,
      );
    const used = await store.usage(
      scope.key,
      scope.window ? { since: now! - scope.window.ms } : undefined,
    );
    remaining = tighter(remaining, {
      ...(usd !== undefined ? { usd: Math.max(0, usd - used.usd) } : {}),
      ...(tokens !== undefined ? { tokens: Math.max(0, tokens - used.tokens) } : {}),
    });
  }
  return remaining;
}

// --- The search --------------------------------------------------------------

function fits(cost: ToolCostEstimate | undefined, remaining: ToolBudgetRemaining | undefined) {
  if (!cost || !remaining) return true;
  if (cost.usd !== undefined && remaining.usd !== undefined && cost.usd > remaining.usd)
    return false;
  if (cost.tokens !== undefined && remaining.tokens !== undefined && cost.tokens > remaining.tokens)
    return false;
  return true;
}

function approvalOf(tool: ToolSearchCatalogTool, policy: ExecutionPolicy): ToolApprovalLabel {
  if (policy.requireApproval === true || tool.needsApproval === true) return true;
  return typeof tool.needsApproval === 'function' ? 'conditional' : false;
}

function parseArgs(args: unknown, maxResults: number): { query: string; limit: number } {
  if (args === null || typeof args !== 'object')
    throw new ToolSearchError('invalid_query', 'tool_search expects an object with a "query".');
  const { query, limit } = args as { query?: unknown; limit?: unknown };
  if (typeof query !== 'string' || query.trim().length === 0)
    throw new ToolSearchError('invalid_query', 'tool_search needs a nonempty "query" string.');
  if (limit !== undefined && (!Number.isSafeInteger(limit) || (limit as number) < 1))
    throw new ToolSearchError('invalid_query', '"limit" must be a positive integer.');
  return {
    query: query.trim(),
    limit: Math.min((limit as number | undefined) ?? maxResults, maxResults),
  };
}

/** The tool names a search result in the history lists; `undefined` when it cannot be read. */
function namesInResult(result: unknown): string[] | undefined {
  let value = result;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return undefined;
    }
  }
  if (value === null || typeof value !== 'object') return undefined;
  const tools = (value as { tools?: unknown }).tools;
  if (!Array.isArray(tools)) return undefined;
  return tools
    .map((entry) => (entry as { name?: unknown } | null)?.name)
    .filter((name): name is string => typeof name === 'string');
}

/** Whether the history holds a call of one of the call's handoff (transfer) tools. */
function handedOff(messages: readonly Message[], transfers: ReadonlySet<string>): boolean {
  return messages.some(
    (message) =>
      Array.isArray(message.content) &&
      message.content.some((part) => part.type === 'tool_use' && transfers.has(part.name)),
  );
}

/**
 * Defer a tool catalog behind one budget- and policy-aware search tool. See
 * the module header for how it rides the loop, and {@link ToolSearchOptions}.
 *
 * Throws `ToolSearchError('invalid_options')` for a search tool name that
 * names a catalog tool, a `maxResults` that is not a positive integer, or
 * invalid metadata; `ExecutionPolicyError` for an invalid `policy`.
 */
export function createToolSearch<T extends Record<string, ToolSearchCatalogTool>>(
  options: ToolSearchOptions<T>,
): ToolSearch<T> {
  const catalog = options.tools;
  if (catalog === null || typeof catalog !== 'object')
    throw new ToolSearchError('invalid_options', 'createToolSearch: tools must be an object.');
  const name = options.name ?? TOOL_SEARCH_NAME;
  if (typeof name !== 'string' || name.length === 0)
    throw new ToolSearchError('invalid_options', 'createToolSearch: name must be nonempty.');
  if (Object.hasOwn(catalog, name))
    throw new ToolSearchError(
      'invalid_options',
      `createToolSearch: the search tool name '${name}' is already a catalog tool.`,
    );
  const maxResults = options.maxResults ?? DEFAULT_MAX_RESULTS;
  if (!Number.isSafeInteger(maxResults) || maxResults < 1)
    throw new ToolSearchError(
      'invalid_options',
      'createToolSearch: maxResults must be a positive integer.',
    );
  const overBudget = options.budget?.overBudget ?? 'exclude';
  if (overBudget !== 'exclude' && overBudget !== 'label')
    throw new ToolSearchError(
      'invalid_options',
      "createToolSearch: budget.overBudget must be 'exclude' or 'label'.",
    );
  const expensive = options.budget?.expensive ?? {};
  const expensiveShare = expensive.share ?? DEFAULT_EXPENSIVE_SHARE;
  const staticPolicy = intersectExecutionPolicies(options.policy ?? {}, {});
  const enforce = options.enforce ?? true;
  const names = Object.keys(catalog);
  const alwaysLoaded = [...new Set(options.alwaysLoaded ?? [])];
  const loaded = new Set(alwaysLoaded);
  const deferred = new Set(names.filter((n) => !loaded.has(n)));

  const metaByName = new Map<string, ToolSearchMeta>();
  for (const toolName of names) {
    const own = searchMetaOf(catalog[toolName] as object);
    const given = options.meta?.[toolName];
    if (given) validateMeta(`meta.${toolName}`, given);
    const meta = given ?? own;
    if (meta) metaByName.set(toolName, meta);
  }

  // Built once, lazily: a Standard Schema converts through the optional peer
  // (async). One that cannot convert is indexed by name and description only.
  let indexPromise: Promise<ToolIndex> | undefined;
  const ready = (): Promise<ToolIndex> =>
    (indexPromise ??= (async () => {
      const entries: ToolIndexEntry[] = [];
      for (const toolName of names) {
        const tool = catalog[toolName]!;
        let parameters: JSONSchema | undefined;
        if (tool.type !== 'provider' && tool.parameters && typeof tool.parameters === 'object') {
          try {
            parameters = isStandardSchema(tool.parameters)
              ? await toJSONSchema(tool.parameters)
              : (tool.parameters as JSONSchema);
          } catch {
            parameters = undefined;
          }
        }
        const meta = metaByName.get(toolName);
        entries.push({
          name: toolName,
          ...(tool.description ? { description: tool.description } : {}),
          ...(parameters ? { parameters } : {}),
          ...(meta?.keywords ? { keywords: meta.keywords } : {}),
        });
      }
      return createToolIndex(entries);
    })());

  async function remainingFor(
    context: ToolSearchContext | undefined,
  ): Promise<ToolBudgetRemaining | undefined> {
    const source = options.budget?.remaining;
    const given =
      typeof source === 'function' ? await source(context ?? {}) : (source ?? undefined);
    const fromExecution = context?.execution
      ? remainingFromExecution(context.execution)
      : undefined;
    return tighter(given, fromExecution);
  }

  function isExpensive(cost: ToolCostEstimate | undefined, remaining?: ToolBudgetRemaining) {
    if (!cost) return false;
    if (expensive.usd !== undefined && cost.usd !== undefined && cost.usd >= expensive.usd)
      return true;
    if (
      expensive.tokens !== undefined &&
      cost.tokens !== undefined &&
      cost.tokens >= expensive.tokens
    )
      return true;
    if (!remaining || expensiveShare <= 0) return false;
    const share = (value?: number, limit?: number) =>
      value !== undefined && limit !== undefined && value > 0 && value >= limit * expensiveShare;
    return share(cost.usd, remaining.usd) || share(cost.tokens, remaining.tokens);
  }

  async function run(
    query: string,
    limit: number,
    context: ToolSearchContext | undefined,
    withBudget: boolean,
  ): Promise<ToolSearchResult> {
    const index = await ready();
    const candidates = query.toLowerCase().startsWith(SELECT_PREFIX)
      ? [
          ...new Set(
            query
              .slice(SELECT_PREFIX.length)
              .split(',')
              .map((n) => n.trim())
              .filter((n) => Object.hasOwn(catalog, n)),
          ),
        ].map((n) => ({ name: n, score: 0 }))
      : index.search(query);
    const policy = context?.execution
      ? intersectExecutionPolicies(staticPolicy, context.execution.policy)
      : staticPolicy;
    const remaining = withBudget ? await remainingFor(context) : undefined;
    const hits: ToolSearchHit[] = [];
    const withheld = { budget: 0, policy: 0 };
    for (const candidate of candidates) {
      if (policy.allowedTools !== undefined && !policy.allowedTools.includes(candidate.name)) {
        withheld.policy += 1;
        continue;
      }
      const cost = metaByName.get(candidate.name)?.cost;
      const fitting = fits(cost, remaining);
      if (!fitting && overBudget === 'exclude') {
        withheld.budget += 1;
        continue;
      }
      if (hits.length >= limit) continue;
      const tool = catalog[candidate.name]!;
      hits.push(
        Object.freeze({
          name: candidate.name,
          ...(tool.description ? { description: tool.description } : {}),
          score: candidate.score,
          requiresApproval: approvalOf(tool, policy),
          ...(cost ? { estimatedCost: cost } : {}),
          expensive: isExpensive(cost, remaining),
          overBudget: !fitting,
          alwaysLoaded: loaded.has(candidate.name),
        }),
      );
    }
    return Object.freeze({
      query,
      hits: Object.freeze(hits),
      withheld: Object.freeze(withheld),
      ...(remaining ? { remaining } : {}),
    });
  }

  async function search(query: string, opts: ToolSearchQueryOptions = {}) {
    const parsed = parseArgs(
      { query, ...(opts.limit !== undefined ? { limit: opts.limit } : {}) },
      maxResults,
    );
    return run(parsed.query, parsed.limit, opts.context, true);
  }

  const searchTool: ToolSearchTool = Object.freeze({
    description:
      options.description ??
      `Search the tool catalog and load matching tools. Only loaded tools can be called: ` +
        `call this first with a few words describing the capability you need, then call a ` +
        `returned tool on your next step. Use "select:name1,name2" to load tools by exact name. ` +
        `Results respect the run's budget and permissions; tools marked requiresApproval wait for a human.`,
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Words describing the capability needed, or "select:<name>,<name>".',
        },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: maxResults,
          description: `Most tools to return (default and maximum ${maxResults}).`,
        },
      },
      required: ['query'],
      additionalProperties: false,
    },
    async execute(args: unknown, ctx: ToolSearchExecuteContext): Promise<ToolSearchToolResult> {
      const parsed = parseArgs(args, maxResults);
      const result = await run(
        parsed.query,
        parsed.limit,
        {
          ...(ctx?.messages ? { messages: ctx.messages } : {}),
          ...(ctx?.execution ? { execution: ctx.execution } : {}),
          ...(ctx?.runtimeContext !== undefined ? { runtimeContext: ctx.runtimeContext } : {}),
        },
        true,
      );
      const tools = result.hits.map(
        (hit): ToolSearchToolEntry => ({
          name: hit.name,
          ...(hit.description ? { description: hit.description } : {}),
          ...(hit.requiresApproval !== false ? { requiresApproval: hit.requiresApproval } : {}),
          ...(hit.estimatedCost ? { estimatedCost: hit.estimatedCost } : {}),
          ...(hit.expensive ? { expensive: true as const } : {}),
          ...(hit.overBudget ? { overBudget: true as const } : {}),
        }),
      );
      const withheld = result.withheld.budget + result.withheld.policy > 0;
      return {
        query: result.query,
        tools,
        ...(withheld ? { withheld: { ...result.withheld } } : {}),
        note:
          tools.length > 0
            ? 'These tools are loaded and callable from your next step.'
            : 'No loadable tool matched. Try other words, or "select:<name>".',
      };
    },
  });

  // History is not trusted to stay inside the static policy: a forged search
  // result (a client-posted history) must not unlock a tool the policy refuses.
  const permitted = (toolName: string) =>
    Object.hasOwn(catalog, toolName) &&
    (staticPolicy.allowedTools === undefined || staticPolicy.allowedTools.includes(toolName));

  async function surfaced(messages: readonly Message[]): Promise<string[]> {
    const calls = new Map<string, unknown>();
    const out = new Set<string>();
    for (const message of messages) {
      if (!Array.isArray(message.content)) continue;
      for (const part of message.content) {
        if (part.type === 'tool_use') {
          // A later call of ANOTHER tool reusing the id (some providers number
          // calls per response) must not let its result pass as a search result.
          if (part.name === name) calls.set(part.id, part.input);
          else calls.delete(part.id);
        } else if (part.type === 'tool_result' && !part.isError && calls.has(part.toolUseId)) {
          const input = calls.get(part.toolUseId);
          calls.delete(part.toolUseId);
          let listed = namesInResult(part.result);
          if (listed === undefined) {
            // Compaction pruned the result: recompute it from the recorded query.
            try {
              const parsed = parseArgs(input, maxResults);
              listed = (await run(parsed.query, parsed.limit, undefined, false)).hits.map(
                (hit) => hit.name,
              );
            } catch {
              listed = [];
            }
          }
          for (const toolName of listed) if (permitted(toolName)) out.add(toolName);
        }
      }
    }
    return [...out];
  }

  async function activeTools(messages: readonly Message[]): Promise<string[]> {
    return [...new Set([name, ...alwaysLoaded, ...(await surfaced(messages))])];
  }

  const prepareStep: NonNullable<CommonCallOptions['prepareStep']> = async (ctx) => ({
    activeTools: await activeTools(ctx.messages),
  });

  const guardrail: ToolCallGuardrail = async (
    ctx,
  ): Promise<ToolCallGuardrailResult | undefined> => {
    const toolName = ctx.toolCall.toolName;
    if (!deferred.has(toolName)) return undefined;
    if (!(await surfaced(ctx.messages)).includes(toolName))
      return {
        action: 'block',
        reason: `Tool '${toolName}' is not loaded. Call ${name} to find and load it first.`,
      };
    // The history alone does not prove the tool passed the budget filter (it
    // can be forged), so an excluded-over-budget tool is re-checked at call
    // time against the caller's budget source. Fails closed.
    const cost = metaByName.get(toolName)?.cost;
    if (!cost || overBudget !== 'exclude' || !options.budget?.remaining) return undefined;
    let remaining: ToolBudgetRemaining | undefined;
    try {
      remaining = await remainingFor({
        messages: ctx.messages,
        ...(ctx.runtimeContext !== undefined ? { runtimeContext: ctx.runtimeContext } : {}),
      });
    } catch {
      return { action: 'block', reason: `Tool '${toolName}': the remaining budget is unknown.` };
    }
    if (fits(cost, remaining)) return undefined;
    return {
      action: 'block',
      reason: `Tool '${toolName}' does not fit the remaining budget.`,
    };
  };
  Object.defineProperty(guardrail, 'name', { value: 'tool-search' });

  const tools = Object.freeze({ ...catalog, [name]: searchTool }) as T &
    Record<string, ToolSearchTool>;

  function apply<O extends object>(
    callOptions: O & ToolSearchCallOptions,
  ): ToolSearchApplied<O, T> {
    const own = callOptions.tools ?? {};
    if (Object.hasOwn(own, name) && own[name] !== searchTool)
      throw new ToolSearchError(
        'invalid_options',
        `apply: the call's tools already have a tool named '${name}'.`,
      );
    // The call's own tools outside the catalog stay loaded on every step.
    const extras = Object.keys(own).filter((n) => n !== name && !Object.hasOwn(catalog, n));
    const offeredAlways = new Set([name, ...alwaysLoaded, ...extras]);
    const transfers = new Set(
      extras.filter((n) => readHandoffTarget(own[n] as Tool) !== undefined),
    );
    // The loop also merges in tools of its own (the call's `mcp` entries).
    // The composed `prepareStep` leaves them off the wire, and `activeTools`
    // does not restrict execution, so this guardrail refuses any name that is
    // neither offered on every step nor a catalog tool (judged as above).
    // Two cases it cannot judge pass: a sub-agent inherits the guardrail but
    // runs its own tool set, and after a handoff the loop offers the target's
    // whole set (the search tool is no longer in it).
    const callGuardrail: ToolCallGuardrail = async (ctx) => {
      const toolName = ctx.toolCall.toolName;
      if (Object.hasOwn(catalog, toolName)) return guardrail(ctx);
      if (offeredAlways.has(toolName) || (ctx.agentPath?.length ?? 0) > 0) return undefined;
      if (transfers.size > 0 && handedOff(ctx.messages, transfers)) return undefined;
      return {
        action: 'block',
        reason: `Tool '${toolName}' is not offered on this step.`,
      };
    };
    Object.defineProperty(callGuardrail, 'name', { value: 'tool-search' });
    const staticActive = callOptions.activeTools;
    const hostPrepare = callOptions.prepareStep;
    const composed: NonNullable<CommonCallOptions['prepareStep']> = async (ctx) => {
      const theirs: PrepareStepResult | undefined = hostPrepare
        ? await hostPrepare(ctx)
        : undefined;
      let active = [
        ...new Set([...(await activeTools(theirs?.messages ?? ctx.messages)), ...extras]),
      ];
      if (staticActive) active = active.filter((n) => staticActive.includes(n));
      if (theirs?.activeTools) {
        const narrowed = theirs.activeTools;
        active = active.filter((n) => narrowed.includes(n));
      }
      // An empty list makes the loop fall back to EVERY tool; offer the search
      // tool with no choice instead, so nothing deferred leaks onto the wire.
      if (active.length === 0) return { ...theirs, activeTools: [name], toolChoice: 'none' };
      return { ...theirs, activeTools: active };
    };
    const hostGuards = callOptions.guardrails?.onToolCall;
    const applied = {
      ...callOptions,
      tools: { ...own, ...tools },
      prepareStep: composed,
      ...(enforce
        ? {
            guardrails: {
              ...callOptions.guardrails,
              onToolCall: [
                callGuardrail,
                ...(hostGuards === undefined
                  ? []
                  : Array.isArray(hostGuards)
                    ? hostGuards
                    : [hostGuards]),
              ],
            },
          }
        : {}),
    };
    return applied as ToolSearchApplied<O, T>;
  }

  return Object.freeze({
    name,
    tools,
    searchTool,
    search,
    surfaced,
    activeTools,
    prepareStep,
    guardrail,
    apply,
  });
}

/**
 * One-shot direct search: build a search over `options.tools` and run `query`
 * against it, without a model. For repeated searches keep a
 * `createToolSearch` instance, which builds its index once.
 */
export async function searchTools<T extends Record<string, ToolSearchCatalogTool>>(
  query: string,
  options: ToolSearchOptions<T> & ToolSearchQueryOptions,
): Promise<ToolSearchResult> {
  const { limit, context, ...rest } = options;
  return createToolSearch(rest).search(query, {
    ...(limit !== undefined ? { limit } : {}),
    ...(context ? { context } : {}),
  });
}
