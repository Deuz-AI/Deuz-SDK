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
  const rawKeep = policy.keepRecentSteps;
  return {
    threshold: policy.threshold ?? 0.92,
    // Must be a positive integer — a fractional/NaN value would index
    // `assistantIdx` off the end and silently unprotect the whole tail.
    keepRecentSteps: Number.isFinite(rawKeep) ? Math.max(1, Math.floor(rawKeep as number)) : 4,
    layers: policy.layers ?? DEFAULT_LAYERS,
    ...(policy.summarizeModel ? { summarizeModel: policy.summarizeModel } : {}),
  };
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
  try {
    const summary = await ctx.summarize(messages.slice(start, end));
    const summaryMessage: Message = {
      role: 'user',
      content: [{ type: 'text', text: `[Earlier conversation summarized]\n${summary}` }],
    };
    return [...messages.slice(0, start), summaryMessage, ...messages.slice(end)];
  } catch (err) {
    ctx.onSkip?.('summarize', err instanceof Error ? err.message : String(err));
    return messages;
  }
}
