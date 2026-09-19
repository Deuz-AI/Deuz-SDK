/**
 * Layered context compaction for the agentic loop. PURE + dependency-injected:
 * this module never calls a model itself — the loop injects a `summarize`
 * function and a token `estimate` via {@link ApplyCompactionCtx}. It must not
 * import any inference/loop module (the loop imports it, not vice-versa).
 *
 * Layers run in policy order against the messages NOT protected by the
 * invariants below, re-estimating after each, until fill drops comfortably
 * under the trigger threshold:
 *
 * 1. `prune-tool-results` — old tool outputs become `[pruned N chars]` stubs.
 * 2. `prune-reasoning`    — old assistant reasoning parts are dropped.
 * 3. `summarize`          — the oldest unprotected run collapses into ONE
 *                           rolling summary message (injected summarizer): the
 *                           previous summary is handed back so pass N folds
 *                           into it instead of restarting from scratch.
 *
 * PROTECTED (never modified or removed): every system message, the first user
 * message, the last assistant message and everything after it, and the tail
 * covering the last `keepRecentSteps` assistant turns.
 *
 * IMMUTABILITY: input arrays/objects are never mutated; untouched messages
 * keep reference equality in the output (prompt caching + React state).
 */
import type { Message, Part } from '../types/message';
import type { LanguageModel } from '../types/model';
import { isFatalExecutionError } from '../internal/execution-error';

export type CompactionLayer = 'prune-tool-results' | 'prune-reasoning' | 'summarize';

export interface CompactionPolicy {
  /** Context-fill ratio (estimate/contextWindow) that triggers compaction. Default 0.92. */
  threshold?: number;
  /** Most-recent assistant turns that are untouchable. Default 4. */
  keepRecentSteps?: number;
  /** Layers to apply, in order. Default all three, cheapest first. */
  layers?: CompactionLayer[];
  /** Model the LOOP uses to wire the `summarize` function. Carried through normalize. */
  summarizeModel?: LanguageModel;
  /**
   * REAL tokenizer hook (2.0). Mirrors `CompactionPolicy.countTokens` in
   * `types/config.ts` — this interface is the loop-internal twin of the public
   * one and the two must stay field-for-field identical. Carried through
   * normalize so the caller of `applyCompaction` can build its estimator from it.
   */
  countTokens?: (messages: Message[]) => number;
}

/** `'auto'` = all defaults. */
export type CompactionOption = 'auto' | CompactionPolicy;

/** Emitted once per layer that ran and changed the history. */
export interface CompactionEvent {
  layer: CompactionLayer;
  tokensBefore: number;
  tokensAfter: number;
  /** Layer wall time (0 when no `ctx.now` is injected). Observation-only (1.6) — not on the stream part. */
  durationMs: number;
  /** Message counts around this layer. Observation-only (1.6) — not on the stream part. */
  messagesBefore: number;
  messagesAfter: number;
}

export type NormalizedCompaction = Required<
  Pick<CompactionPolicy, 'threshold' | 'keepRecentSteps' | 'layers'>
> & { summarizeModel?: LanguageModel; countTokens?: (messages: Message[]) => number };

const DEFAULT_LAYERS: CompactionLayer[] = ['prune-tool-results', 'prune-reasoning', 'summarize'];

/** Expand `'auto'`/partial policies to a fully-defaulted one. */
export function normalizeCompaction(option: CompactionOption): NormalizedCompaction {
  const policy = option === 'auto' ? {} : option;
  const rawKeep = policy.keepRecentSteps;
  return {
    threshold: policy.threshold ?? 0.92,
    // Must be a positive integer — a fractional/NaN value would index
    // `assistantIdx` off the end and silently unprotect the whole tail.
    keepRecentSteps: Number.isFinite(rawKeep) ? Math.max(1, Math.floor(rawKeep as number)) : 4,
    layers: policy.layers ?? DEFAULT_LAYERS,
    ...(policy.summarizeModel ? { summarizeModel: policy.summarizeModel } : {}),
    ...(policy.countTokens ? { countTokens: policy.countTokens } : {}),
  };
}

/**
 * Prefix every summary message carries. It is the ONLY marker a later pass has
 * to recognize its own output by — the history it reads back may have crossed a
 * store, a wire, or a React state round-trip, so nothing but the text survives.
 */
export const SUMMARY_SENTINEL = '[Earlier conversation summarized]';

/**
 * True for a message the summarize layer produced. Deliberately narrow (user
 * role, exactly one text part, sentinel prefix) so an ordinary user message
 * that merely quotes the sentinel is not folded away.
 */
export function isSummaryMessage(m: Message): boolean {
  if (m.role !== 'user' || !Array.isArray(m.content) || m.content.length !== 1) return false;
  const part = m.content[0]!;
  return part.type === 'text' && part.text.startsWith(SUMMARY_SENTINEL);
}

/** The summary body of a summary message, sentinel (and its newline) stripped. */
function summaryBody(m: Message): string {
  const part = Array.isArray(m.content) ? m.content[0] : undefined;
  const text = part?.type === 'text' ? part.text : '';
  return text.slice(SUMMARY_SENTINEL.length).replace(/^\n/, '');
}

/** Stringify arbitrary tool payloads without ever throwing (circular refs, BigInt). */
function safeStringify(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return '';
  }
}

export interface ApplyCompactionCtx {
  /** Token estimate for a message array (injected; never a network call here). */
  estimate(messages: Message[]): number;
  contextWindow: number;
  /**
   * Injected by the loop; resolves to the summary text. May throw — compaction
   * survives. `previousSummary` is the rolling summary already in the history
   * (sentinel stripped) on every pass after the first, so the summarizer folds
   * the new slice INTO it instead of summarizing a summary.
   */
  summarize?: (messagesToSummarize: Message[], previousSummary?: string) => Promise<string>;
  /** Wired to `logger.warn` by the loop; fired when a layer is skipped. */
  onSkip?: (layer: CompactionLayer, reason: string) => void;
  /** Injected clock (observation timing) — pure module, never Date.now here. */
  now?: () => number;
  /**
   * `'threshold'` (default) only compacts once estimated fill crosses the
   * policy threshold. `'force'` skips that gate entirely — it is what an
   * overflow recovery (a provider that already rejected the request) and the
   * manual `compactMessages()` API run in, where the fill question is settled.
   */
  mode?: 'threshold' | 'force';
}

/**
 * Run the policy's layers until fill drops to `threshold * 0.8` or layers run
 * out. Below the trigger threshold the input array is returned unchanged
 * (same reference, no events). Never throws.
 *
 * In `mode: 'force'` the trigger gate is skipped and the target tightens to
 * `threshold * 0.5`: a forced run means the window ALREADY overflowed, and
 * stopping just under the trigger buys one more round-trip before the next
 * rejection. With no finite `contextWindow` there is no ratio to test at all,
 * so every layer runs exactly once — no early stop.
 */
export async function applyCompaction(
  messages: Message[],
  policy: NormalizedCompaction,
  ctx: ApplyCompactionCtx,
): Promise<{ messages: Message[]; events: CompactionEvent[] }> {
  const force = ctx.mode === 'force';
  const windowed = !force || (Number.isFinite(ctx.contextWindow) && ctx.contextWindow > 0);
  if (!force && ctx.estimate(messages) / ctx.contextWindow <= policy.threshold) {
    return { messages, events: [] };
  }
  const target = policy.threshold * (force ? 0.5 : 0.8);
  const events: CompactionEvent[] = [];
  let current = messages;
  for (const layer of policy.layers) {
    const tokensBefore = ctx.estimate(current);
    const messagesBefore = current.length;
    const layerStart = ctx.now?.() ?? 0;
    const next = await runLayer(layer, current, policy.keepRecentSteps, ctx);
    if (next !== current) {
      current = next;
      events.push({
        layer,
        tokensBefore,
        tokensAfter: ctx.estimate(current),
        durationMs: ctx.now ? Math.max(0, ctx.now() - layerStart) : 0,
        messagesBefore,
        messagesAfter: current.length,
      });
    }
    if (windowed && ctx.estimate(current) / ctx.contextWindow <= target) break;
  }
  return { messages: current, events };
}

async function runLayer(
  layer: CompactionLayer,
  messages: Message[],
  keepRecentSteps: number,
  ctx: ApplyCompactionCtx,
): Promise<Message[]> {
  const prot = protectedIndices(messages, keepRecentSteps);
  switch (layer) {
    case 'prune-tool-results':
      return pruneToolResults(messages, prot);
    case 'prune-reasoning':
      return pruneReasoning(messages, prot);
    case 'summarize':
      return summarizeRun(messages, prot, ctx);
  }
}

/**
 * Indices that no layer may touch: system messages, the first user message,
 * the LAST message (the pending question / current turn — critical when no
 * assistant turn exists yet), and the tail from the `keepRecentSteps`-th-from-
 * last assistant message to the end.
 */
function protectedIndices(messages: Message[], keepRecentSteps: number): Set<number> {
  const prot = new Set<number>();
  const assistantIdx: number[] = [];
  let firstUser = -1;
  for (let i = 0; i < messages.length; i++) {
    const role = messages[i]!.role;
    if (role === 'system') prot.add(i);
    else if (role === 'user' && firstUser < 0) firstUser = i;
    else if (role === 'assistant') assistantIdx.push(i);
  }
  if (firstUser >= 0) prot.add(firstUser);
  // Always protect the final message: with no assistant turn yet (e.g. several
  // pasted user docs) it is the actual question — summarizing it away would
  // delete the request and end the history on an assistant turn.
  if (messages.length > 0) prot.add(messages.length - 1);
  // Integer, ≥1 — belt-and-suspenders even if a raw policy skipped normalize.
  const keep = Number.isFinite(keepRecentSteps) ? Math.max(1, Math.floor(keepRecentSteps)) : 1;
  const anchor = assistantIdx[Math.max(assistantIdx.length - keep, 0)];
  if (anchor !== undefined) {
    for (let i = anchor; i < messages.length; i++) prot.add(i);
  }
  return prot;
}

const PRUNED_RE = /^\[pruned \d+ chars\]$/;

/** Old tool outputs → `[pruned N chars]` stubs; `toolUseId`/`isError` survive. */
function pruneToolResults(messages: Message[], prot: Set<number>): Message[] {
  let changed = false;
  const out = messages.map((m, i) => {
    if (prot.has(i) || !Array.isArray(m.content)) return m;
    let msgChanged = false;
    const parts = m.content.map((p): Part => {
      if (p.type !== 'tool_result') return p;
      if (typeof p.result === 'string' && PRUNED_RE.test(p.result)) return p;
      // safeStringify, not bare JSON.stringify: a circular/BigInt tool result
      // would otherwise throw and violate the never-throws contract.
      const raw = safeStringify(p.result);
      msgChanged = true;
      return { ...p, result: `[pruned ${raw.length} chars]` };
    });
    if (!msgChanged) return m;
    changed = true;
    return { ...m, content: parts };
  });
  return changed ? out : messages;
}

/** Drop reasoning parts from old assistant turns. */
function pruneReasoning(messages: Message[], prot: Set<number>): Message[] {
  let changed = false;
  const out = messages.map((m, i) => {
    if (prot.has(i) || m.role !== 'assistant' || !Array.isArray(m.content)) return m;
    const kept = m.content.filter((p) => p.type !== 'reasoning');
    if (kept.length === m.content.length) return m;
    // An all-reasoning message is skipped, not emptied: providers reject empty
    // content arrays and a fabricated blank text part would corrupt the turn.
    if (kept.length === 0) return m;
    changed = true;
    return { ...m, content: kept };
  });
  return changed ? out : messages;
}

/**
 * Collapse the oldest contiguous run of unprotected messages into ONE user
 * summary message. User role (not assistant) is deliberate: an assistant
 * summary spliced right before the protected anchor assistant would merge into
 * one turn on the wire, breaking Anthropic's "thinking block must lead the
 * turn" rule when extended thinking + tool results follow (→ 400). A throwing
 * summarizer only skips the layer (`onSkip`) — the loop never dies from it.
 *
 * ROLLING: on a later pass the run already starts with the previous summary.
 * It is pulled out, handed to the summarizer as `previousSummary`, and only the
 * genuinely new messages are summarized — then BOTH are replaced by the single
 * folded result. INVARIANT: however many passes run, at most one summary
 * message ever sits at the head of the unprotected region. Collecting *every*
 * summary in the run (not just a leading one) is defensive: a shifted protected
 * boundary or a hand-edited history can strand more than one, and losing them
 * would silently drop the oldest context.
 */
async function summarizeRun(
  messages: Message[],
  prot: Set<number>,
  ctx: ApplyCompactionCtx,
): Promise<Message[]> {
  if (!ctx.summarize || messages.length - prot.size < 2) return messages;
  let start = 0;
  while (start < messages.length && prot.has(start)) start++;
  let end = start;
  while (end < messages.length && !prot.has(end)) end++;
  // Require a run of ≥2 messages: a lone unprotected message (e.g. an assistant
  // whose tool_result was split off by an injected protected message) saves
  // little and risks orphaning a tool_use/tool_result pair.
  if (end - start < 2) return messages;
  const run = messages.slice(start, end);
  const newSlice = run.filter((m) => !isSummaryMessage(m));
  // Nothing but summaries in the run: re-summarizing a summary spends a model
  // call to lose detail. Leave the history exactly as it is.
  if (newSlice.length === 0) return messages;
  const prior = run.filter(isSummaryMessage);
  const previousSummary = prior.length > 0 ? prior.map(summaryBody).join('\n') : undefined;
  try {
    const summary = await ctx.summarize(newSlice, previousSummary);
    const summaryMessage: Message = {
      role: 'user',
      content: [{ type: 'text', text: `${SUMMARY_SENTINEL}\n${summary}` }],
    };
    return [...messages.slice(0, start), summaryMessage, ...messages.slice(end)];
  } catch (err) {
    if (isFatalExecutionError(err)) throw err;
    ctx.onSkip?.('summarize', err instanceof Error ? err.message : String(err));
    return messages;
  }
}
