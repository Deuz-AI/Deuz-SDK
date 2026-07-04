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
 * 3. `summarize`          — the oldest unprotected run collapses into one
 *                           assistant summary message (injected summarizer).
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
}

/** `'auto'` = all defaults. */
export type CompactionOption = 'auto' | CompactionPolicy;

/** Emitted once per layer that ran and changed the history. */
export interface CompactionEvent {
  layer: CompactionLayer;
  tokensBefore: number;
  tokensAfter: number;
}

export type NormalizedCompaction = Required<
  Pick<CompactionPolicy, 'threshold' | 'keepRecentSteps' | 'layers'>
> & { summarizeModel?: LanguageModel };

const DEFAULT_LAYERS: CompactionLayer[] = ['prune-tool-results', 'prune-reasoning', 'summarize'];

/** Expand `'auto'`/partial policies to a fully-defaulted one. */
export function normalizeCompaction(option: CompactionOption): NormalizedCompaction {
  const policy = option === 'auto' ? {} : option;
  return {
    threshold: policy.threshold ?? 0.92,
    keepRecentSteps: policy.keepRecentSteps ?? 4,
    layers: policy.layers ?? DEFAULT_LAYERS,
    ...(policy.summarizeModel ? { summarizeModel: policy.summarizeModel } : {}),
  };
}

export interface ApplyCompactionCtx {
  /** Token estimate for a message array (injected; never a network call here). */
  estimate(messages: Message[]): number;
  contextWindow: number;
  /** Injected by the loop; resolves to the summary text. May throw — compaction survives. */
  summarize?: (messagesToSummarize: Message[]) => Promise<string>;
  /** Wired to `logger.warn` by the loop; fired when a layer is skipped. */
  onSkip?: (layer: CompactionLayer, reason: string) => void;
}

/**
 * Run the policy's layers until fill drops to `threshold * 0.8` or layers run
 * out. Below the trigger threshold the input array is returned unchanged
 * (same reference, no events). Never throws.
 */
export async function applyCompaction(
  messages: Message[],
  policy: NormalizedCompaction,
  ctx: ApplyCompactionCtx,
): Promise<{ messages: Message[]; events: CompactionEvent[] }> {
  if (ctx.estimate(messages) / ctx.contextWindow <= policy.threshold) {
    return { messages, events: [] };
  }
  const target = policy.threshold * 0.8;
  const events: CompactionEvent[] = [];
  let current = messages;
  for (const layer of policy.layers) {
    const tokensBefore = ctx.estimate(current);
    const next = await runLayer(layer, current, policy.keepRecentSteps, ctx);
    if (next !== current) {
      current = next;
      events.push({ layer, tokensBefore, tokensAfter: ctx.estimate(current) });
    }
    if (ctx.estimate(current) / ctx.contextWindow <= target) break;
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
 * and the tail from the `keepRecentSteps`-th-from-last assistant message to
 * the end (at minimum from the LAST assistant message, even at 0).
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
  const anchor = assistantIdx[Math.max(assistantIdx.length - Math.max(keepRecentSteps, 1), 0)];
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
      const raw = typeof p.result === 'string' ? p.result : JSON.stringify(p.result);
      msgChanged = true;
      return { ...p, result: `[pruned ${raw === undefined ? 0 : raw.length} chars]` };
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
 * Collapse the oldest contiguous run of unprotected messages into one
 * assistant summary. A throwing summarizer only skips the layer (`onSkip`) —
 * the loop must never die from compaction.
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
  if (end - start < 1) return messages;
  try {
    const summary = await ctx.summarize(messages.slice(start, end));
    const summaryMessage: Message = {
      role: 'assistant',
      content: [{ type: 'text', text: `[Earlier conversation summarized]\n${summary}` }],
    };
    return [...messages.slice(0, start), summaryMessage, ...messages.slice(end)];
  } catch (err) {
    ctx.onSkip?.('summarize', err instanceof Error ? err.message : String(err));
    return messages;
  }
}
