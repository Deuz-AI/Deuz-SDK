/**
 * memory.ts — PURE, edge-safe agent-memory orchestration for @deuz-sdk/core (Faz 3).
 *
 * Derived from mem0's extract→reconcile→apply pipeline plus the Obsidian /
 * markdown-graph and Letta/Anthropic memory-tool patterns. Everything stateful
 * (the vector store, the markdown files, mem0-cloud) lives behind the
 * `MemoryStore` seam; embedding is DELEGATED to `embed.ts` via the `Embedder`
 * seam — memory.ts never computes a vector. Only Web APIs are used
 * (`crypto.subtle` for hashing); zero runtime deps.
 *
 * The SAME `MemoryStore` interface backs a cosine vector store AND a
 * markdown+frontmatter+[[links]] store: `search()` owns its own ranking, so a
 * grep/full-text Obsidian backend and a vector backend are interchangeable.
 */
import type { Message } from './types/message';
import type { Clock } from './types/deps';
import type { Tool, ToolSet } from './types/tool';
import type { EmbedManyOptions } from './types/methods';
import type { EmbeddingModel } from './types/model';
// TYPE-ONLY on purpose: the bridge below adapts rag.ts's Embedder shape without
// pulling a byte of `./rag` into the `./memory` bundle.
import type { Embedder as RagEmbedder } from './rag';
import { InvalidRequestError } from './errors';
import { embedMany } from './inference/embed';
import { cosineSimilarity } from './internal/vector';

// ===================================================================
// Canonical record (superset of mem0 + Letta + Graphiti + Obsidian; the extra
// fields are optional so a markdown backend can ignore most of them).
// ===================================================================

export type MemoryKind = 'episodic' | 'semantic' | 'working' | 'procedural';
export type MemoryEventType = 'ADD' | 'UPDATE' | 'DELETE' | 'NOOP';

export interface MemoryScope {
  userId?: string;
  agentId?: string;
  runId?: string;
  actorId?: string;
  /** Chat/conversation identity (1.7 additive) — aligns memory with `ChatStore` records. */
  chatId?: string;
}

export interface MemoryRecord {
  id: string;
  /** Fact string OR markdown body. */
  text: string;
  /** Dedupe key (content hash). */
  hash: string;
  kind: MemoryKind;
  scope: MemoryScope;
  /** YAML-frontmatter-like extras: tags, links [[..]], source, embeddingModelId. */
  metadata?: Record<string, unknown>;
  /** 0..1 importance (Generative-Agents poignancy); never blocks a write. */
  importance?: number;
  /** Inline for the in-memory store; DB-backed adapters omit it. */
  embedding?: number[];
  /** Pin the embedding model so a swapped Embedder (dimension drift) is detectable. */
  embeddingModelId?: string;
  /** Populated on retrieval only. */
  score?: number;
  createdAt: number;
  updatedAt: number;
  lastAccessedAt?: number;
  /** TTL absolute ms epoch. */
  expiresAt?: number;
  /** Bi-temporal (Graphiti): when the fact became true; default createdAt. */
  validAt?: number;
  /** Soft-supersede marker: set instead of hard-deleting when history matters. */
  invalidAt?: number | null;
}

export interface MemoryQuery {
  scope: MemoryScope;
  /** Keyword / markdown-grep query. */
  text?: string;
  /** Pre-embedded by the orchestrator via embed.ts. */
  embedding?: number[];
  kind?: MemoryKind;
  /** Default 5 (mem0 retrieval default). */
  topK?: number;
  /** Bi-temporal point-in-time query. */
  asOf?: number;
  filter?: Record<string, unknown>;
}

export interface MemoryHit {
  record: MemoryRecord;
  score: number;
}

/** Extracted fact (LLM output of the extraction pass). */
export interface MemoryFact {
  text: string;
  kind?: MemoryKind;
  /** 0..1, clamped by {@link parseFacts}; how durable/consequential the model judged the fact. */
  importance?: number;
  /**
   * Related entities/facts the model named (2.0, opt-in via
   * `buildExtractionPrompt(…, { links: true })`). Stored as `metadata.links`,
   * which is the same shape the markdown backend writes for `[[wikilinks]]` —
   * see {@link extractLinks}.
   */
  links?: string[];
}

/** Decision events (mem0 contradiction resolution). `id`s are real record ids (mapped back from temp handles). */
export type MemoryEvent =
  | { type: 'ADD'; text: string; kind?: MemoryKind; importance?: number; links?: string[] }
  | { type: 'UPDATE'; id: string; text: string; oldText: string }
  | { type: 'DELETE'; id: string }
  | { type: 'NOOP'; id: string };

/** The concrete mutation the reducer emits (what the host applies to the store). */
export type MemoryMutation =
  | { op: 'upsert'; record: MemoryRecord; event: MemoryEventType }
  | { op: 'delete'; id: string }
  | { op: 'invalidate'; id: string; invalidAt: number };

export type WritePolicy = 'each-turn' | 'session-end' | 'manual';

// ===================================================================
// Seams (all stateful/IO behind these; defaults are pure / in-memory).
// ===================================================================

/** The ONLY stateful seam — backs a vector store OR markdown files OR mem0-cloud. */
export interface MemoryStore {
  upsert(records: MemoryRecord[]): Promise<void>;
  get(id: string, scope?: MemoryScope): Promise<MemoryRecord | null>;
  /** Owns ranking (cosine | BM25 | grep | hybrid) so any backend fits. */
  search(query: MemoryQuery): Promise<MemoryHit[]>;
  list(scope: MemoryScope, opts?: { kind?: MemoryKind; limit?: number }): Promise<MemoryRecord[]>;
  delete(ids: string[]): Promise<void>;
  update?(id: string, patch: Partial<MemoryRecord>): Promise<void>;
  /**
   * OPTIONAL fast path for write-time dedup (2.0): resolve content hashes to
   * the records that already carry them, in one indexed round-trip. Without it
   * the pipeline falls back to `list(scope)` + an in-memory hash scan, which is
   * correct but O(all records) — fine for the in-memory/markdown backends,
   * wrong for a SQL table with a `hash` index. Omitting it keeps a pre-2.0
   * store valid.
   */
  findByHash?(hashes: string[], scope: MemoryScope): Promise<MemoryRecord[]>;
  /**
   * OPTIONAL fast path for the TTL sweep (2.0): hard-delete every record whose
   * `expiresAt` is at or before `now`, optionally narrowed to a scope, and
   * return HOW MANY were removed. Same rationale as `findByHash` — the fallback
   * is a full `list` + filter + `delete`, which a real database can do in one
   * statement. Omitting it keeps a pre-2.0 store valid.
   */
  deleteExpired?(now: number, scope?: MemoryScope): Promise<number>;
}

/** Delegates to embed.ts. `action` lets Gemini/OpenAI pick a task type. */
export interface Embedder {
  embed(
    texts: string[],
    action: 'add' | 'search' | 'update',
  ): Promise<{ vectors: number[][]; model: string }>;
}

/** Thin wrapper over generateText: prompt in, raw text out (parsers tolerate fences). */
export type MemoryLLM = (prompt: { system: string; user: string }) => Promise<string>;

/** Content-hash seam (mem0 md5 → WebCrypto SHA-256, edge-safe, async). */
export type HashFn = (text: string) => Promise<string>;

/** Pure retrieval rerank seam (Generative-Agents recency·importance·relevance). */
export interface MemoryScorer {
  score(
    record: MemoryRecord,
    ctx: {
      now: number;
      relevance: number;
      weights?: { recency: number; importance: number; relevance: number };
    },
  ): number;
}

export interface MemorySeams {
  store: MemoryStore;
  /** Required only when a vector store's search needs an embedding and the query has none. */
  embedder?: Embedder;
  llm: MemoryLLM;
  clock: Clock;
  generateId: () => string;
  /** Default: WebCrypto SHA-256 hex. */
  hashFn?: HashFn;
  logger?: { warn(m: string, f?: Record<string, unknown>): void };
}

/**
 * Built-in chat memory (1.7, D1): set `memory` on any call and the loop
 * RECALLS relevant memories into the system context before the first model
 * call, then EXTRACTS new facts after the run completes (mem0 pipeline:
 * extract → reconcile → apply) — WITHOUT blocking the response. The extract
 * promise rides the result as `result.memory`; await it on serverless
 * runtimes that freeze after the response. Both halves are best-effort: a
 * failing store/LLM logs and never breaks the chat. Absent option = zero
 * extra work.
 */
export interface MemoryCallOptions {
  seams: MemorySeams;
  /** Mandatory ownership (mem0 rule) — e.g. `{ userId, chatId }`. */
  scope: MemoryScope;
  /** Recall before the first model call (default on, topK 5). `false` disables. */
  recall?:
    | {
        /** Retrieval breadth handed to `store.search` (default 5). */
        topK?: number;
        /** First line of the spliced block (default `'Relevant memories:'`). */
        header?: string;
        /**
         * Rerank the hits before they are rendered. A {@link MemoryScorer}
         * instance is used as-is; the string `'default'` selects
         * {@link defaultMemoryScorer} (recency·importance·relevance) without
         * making the caller import it. Omitted = raw store ranking, i.e. the
         * pre-2.0 behavior.
         */
        scorer?: MemoryScorer | 'default';
        /**
         * Hard character budget for the RENDERED block (see
         * {@link formatMemoriesForPrompt}). Omitted = unbounded, the pre-2.0
         * behavior; set it to keep recall from eating the context window.
         */
        maxChars?: number;
        /**
         * Graph hops to follow out of the primary hits (default 0 = off). See
         * {@link recall} — linked records are appended AFTER the primaries with
         * a decayed score, so the head of the block never changes.
         */
        expandLinks?: number;
      }
    | false;
  /** Extract after the run (default on, LLM-inferred). `false` disables. */
  extract?: { infer?: boolean } | false;
  /**
   * WHEN the extraction pass may run (default `'each-turn'` — the pre-2.0
   * behavior). `'session-end'` and `'manual'` suppress the loop's automatic
   * extract entirely: the SDK cannot know when a session ends, so the host owns
   * the write and calls {@link remember} itself. `extract: false` still wins.
   */
  writePolicy?: WritePolicy;
  /**
   * TTL housekeeping (default `'never'`). `'on-extract'` chains
   * {@link sweepExpired} onto the (non-blocking) extraction pass, so a store
   * with TTL'd records is garbage-collected on write traffic instead of needing
   * a cron. Best-effort like the rest of the memory hooks — a failing sweep logs
   * and never breaks the chat.
   */
  sweep?: 'on-extract' | 'never';
}

// ===================================================================
// Pure helpers (no I/O; deterministic).
// ===================================================================

/** WebCrypto SHA-256 → hex. Edge-safe (no node:crypto). */
export const defaultHashFn: HashFn = async (text: string): Promise<string> => {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const view = new Uint8Array(digest);
  let hex = '';
  for (const b of view) hex += b.toString(16).padStart(2, '0');
  return hex;
};

/** Throw if no scope field is set (mirrors mem0 — at least one of user/agent/run/actor). */
export function assertScope(scope: MemoryScope): void {
  if (!scope.userId && !scope.agentId && !scope.runId && !scope.actorId && !scope.chatId) {
    throw new InvalidRequestError({
      message:
        'MemoryScope requires at least one of userId / agentId / runId / actorId / chatId (mem0 rule).',
    });
  }
}

/** Pure exact-match scope filter the in-memory / markdown store reuses. */
export function matchesScope(rec: MemoryRecord, scope: MemoryScope): boolean {
  if (scope.userId !== undefined && rec.scope.userId !== scope.userId) return false;
  if (scope.agentId !== undefined && rec.scope.agentId !== scope.agentId) return false;
  if (scope.runId !== undefined && rec.scope.runId !== scope.runId) return false;
  if (scope.actorId !== undefined && rec.scope.actorId !== scope.actorId) return false;
  if (scope.chatId !== undefined && rec.scope.chatId !== scope.chatId) return false;
  return true;
}

/** Pure TTL predicate. `now = clock.now()`. */
export function isExpired(rec: MemoryRecord, now: number): boolean {
  return rec.expiresAt !== undefined && rec.expiresAt <= now;
}

/**
 * Pure cosine similarity (edge-safe Float math). Returns 0 on length mismatch /
 * zero vector. Re-exported from `internal/vector.ts` (2.0): `rag.ts` shipped a
 * byte-identical copy, so the two now share ONE implementation — this subpath's
 * public surface is unchanged.
 */
export { cosineSimilarity } from './internal/vector';

/** Default Generative-Agents scorer: w_r·decay + w_i·importance + w_rel·relevance. */
export const defaultMemoryScorer: MemoryScorer = {
  score(record, ctx) {
    const w = ctx.weights ?? { recency: 1, importance: 1, relevance: 1 };
    const hoursSince = Math.max(
      0,
      (ctx.now - (record.lastAccessedAt ?? record.updatedAt)) / 3_600_000,
    );
    const recency = Math.pow(0.995, hoursSince);
    const importance = record.importance ?? 0;
    return w.recency * recency + w.importance * importance + w.relevance * ctx.relevance;
  },
};

// --- prompt building + tolerant parsing ---

/** Strip ```json fences / surrounding prose, leaving the JSON payload (best effort). */
function stripFences(text: string): string {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = (fence?.[1] ?? text).trim();
  // Trim leading/trailing prose around the first {...} / [...] block.
  const firstObj = body.indexOf('{');
  const firstArr = body.indexOf('[');
  const start =
    firstArr === -1 ? firstObj : firstObj === -1 ? firstArr : Math.min(firstObj, firstArr);
  if (start === -1) return body;
  const lastObj = body.lastIndexOf('}');
  const lastArr = body.lastIndexOf(']');
  const end = Math.max(lastObj, lastArr);
  return end > start ? body.slice(start, end + 1) : body;
}

function conversationText(messages: Message[]): string {
  return messages
    .map((m) => {
      const text =
        typeof m.content === 'string'
          ? m.content
          : m.content
              .filter((p): p is Extract<typeof p, { type: 'text' }> => p.type === 'text')
              .map((p) => p.text)
              .join(' ');
      return `${m.role}: ${text}`;
    })
    .filter((line) => line.trim().length > 3)
    .join('\n');
}

/**
 * Build the fact-extraction prompt from a conversation window.
 *
 * 2.0 asks for OBJECT facts — `{text, importance, kind}` — because the pre-2.0
 * bare-string shape left `defaultMemoryScorer`'s importance term permanently 0
 * and every record pinned to a single caller-supplied `kind`. `opts.links`
 * additionally asks for the entities each fact connects to, which is what
 * {@link recall}'s `expandLinks` traverses. {@link parseFacts} still accepts
 * bare strings, so a custom prompt (or a model that ignores the shape) keeps
 * working.
 */
export function buildExtractionPrompt(
  messages: Message[],
  opts?: { customInstructions?: string; links?: boolean },
): { system: string; user: string } {
  const shape = opts?.links
    ? '{"facts":[{"text":"…","importance":<0..1>,"kind":"semantic|episodic|procedural|working",' +
      '"links":["related entity or fact"]}]}'
    : '{"facts":[{"text":"…","importance":<0..1>,"kind":"semantic|episodic|procedural|working"}]}';
  const system =
    'You extract durable, standalone facts about the user/agent from a conversation. ' +
    `Return ONLY JSON of the form ${shape}. ` +
    '"importance" is how durable/consequential the fact is (0 = throwaway, 1 = defining). ' +
    '"kind" is semantic (a stable truth), episodic (one specific event), procedural (how the ' +
    'user wants things done) or working (short-lived context). ' +
    (opts?.links
      ? '"links" names the entities or other facts this one connects to (omit it when there are none). '
      : '') +
    'Each fact must be self-contained (no pronouns referring outside it), atomic, and worth ' +
    'remembering long-term (preferences, identity, goals, constraints, decisions). ' +
    'If there is nothing worth remembering, return {"facts": []}.' +
    (opts?.customInstructions ? `\nAdditional instructions: ${opts.customInstructions}` : '');
  const user = `Conversation:\n${conversationText(messages)}`;
  return { system, user };
}

const MEMORY_KINDS: readonly string[] = ['episodic', 'semantic', 'working', 'procedural'];

/** Accept only the four literals — a hallucinated kind must not widen `MemoryKind`. */
function parseKind(value: unknown): MemoryKind | undefined {
  return typeof value === 'string' && MEMORY_KINDS.includes(value)
    ? (value as MemoryKind)
    : undefined;
}

/** Clamp to [0,1]; drop anything non-finite (a string "high", NaN, Infinity). */
function parseImportance(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return Math.min(1, Math.max(0, value));
}

/** Keep the non-empty strings; drop the array entirely when nothing survives. */
function parseLinks(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const link = item.trim();
    if (link) out.push(link);
  }
  return out.length ? out : undefined;
}

/**
 * Tolerant fact parser: strips fences, validates shape, returns [] on garbage
 * (never throws). Bare strings stay valid (pre-2.0 prompts); object facts get
 * `importance` clamped to [0,1], `kind` checked against the four literals, and
 * `links` filtered to non-empty strings — a field that fails validation is
 * DROPPED, never the fact.
 */
export function parseFacts(llmText: string): MemoryFact[] {
  try {
    const parsed = JSON.parse(stripFences(llmText)) as unknown;
    const arr = Array.isArray(parsed) ? parsed : (parsed as { facts?: unknown })?.facts;
    if (!Array.isArray(arr)) return [];
    const out: MemoryFact[] = [];
    for (const item of arr) {
      if (typeof item === 'string' && item.trim()) out.push({ text: item.trim() });
      else if (item && typeof item === 'object' && typeof (item as MemoryFact).text === 'string') {
        const raw = item as Record<string, unknown>;
        const text = (raw.text as string).trim();
        if (!text) continue;
        const kind = parseKind(raw.kind);
        const importance = parseImportance(raw.importance);
        const links = parseLinks(raw.links);
        out.push({
          text,
          ...(kind ? { kind } : {}),
          ...(importance !== undefined ? { importance } : {}),
          ...(links ? { links } : {}),
        });
      }
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * Build the ADD/UPDATE/DELETE/NOOP decision prompt. Existing records are sent
 * with TEMP integer ids ('0','1',…) — never real UUIDs — to keep tokens low and
 * stop the model hallucinating ids. Returns the prompt + the temp→real id map.
 */
export function buildDecisionPrompt(
  existing: MemoryRecord[],
  facts: MemoryFact[],
): { system: string; user: string; idMap: Map<string, string> } {
  const idMap = new Map<string, string>();
  const existingForModel = existing.map((rec, i) => {
    const temp = String(i);
    idMap.set(temp, rec.id);
    return { id: temp, text: rec.text };
  });
  const system =
    'You maintain a memory store. Given EXISTING memories (with integer ids) and NEW facts, ' +
    'decide per memory whether to ADD a new memory, UPDATE an existing one (the new fact ' +
    'refines/augments it), DELETE one (the new fact contradicts/negates it), or NOOP. ' +
    'Return ONLY JSON: {"memory":[{"id":"<int for UPDATE/DELETE/NOOP, omit for ADD>",' +
    '"text":"<final text, empty for DELETE>","event":"ADD|UPDATE|DELETE|NOOP",' +
    '"old_memory":"<previous text for UPDATE>"}]}. Use the SAME integer ids for kept/updated/' +
    'deleted memories; ADD entries get no id.';
  const user = `EXISTING:\n${JSON.stringify(existingForModel)}\n\nNEW FACTS:\n${JSON.stringify(
    facts.map((f) => f.text),
  )}`;
  return { system, user, idMap };
}

interface RawDecision {
  id?: string | number;
  text?: string;
  event?: string;
  old_memory?: string;
}

/** Parse the decision JSON; validates every id against idMap, DROPS hallucinated ids. */
export function parseDecision(llmText: string, idMap: Map<string, string>): MemoryEvent[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripFences(llmText));
  } catch {
    return [];
  }
  const arr = Array.isArray(parsed) ? parsed : (parsed as { memory?: unknown })?.memory;
  if (!Array.isArray(arr)) return [];

  const events: MemoryEvent[] = [];
  for (const raw of arr as RawDecision[]) {
    const event = String(raw.event ?? '').toUpperCase();
    const text = typeof raw.text === 'string' ? raw.text : '';
    if (event === 'ADD') {
      if (text.trim()) events.push({ type: 'ADD', text: text.trim() });
      continue;
    }
    const temp = raw.id === undefined ? undefined : String(raw.id);
    const realId = temp !== undefined ? idMap.get(temp) : undefined;
    if (!realId) continue; // hallucinated / unknown id → drop
    if (event === 'UPDATE' && text.trim()) {
      events.push({ type: 'UPDATE', id: realId, text: text.trim(), oldText: raw.old_memory ?? '' });
    } else if (event === 'DELETE') {
      events.push({ type: 'DELETE', id: realId });
    } else if (event === 'NOOP') {
      events.push({ type: 'NOOP', id: realId });
    }
  }
  return events;
}

export interface ApplyContext {
  clock: Clock;
  generateId: () => string;
  scope: MemoryScope;
  hashFn: HashFn;
  ttlMs?: number;
  supersede?: 'soft' | 'hard';
  kind?: MemoryKind;
  /** Pre-computed embeddings keyed by fact text (for ADD/UPDATE records). */
  embeddings?: Map<string, number[]>;
  embeddingModelId?: string;
  /** Base metadata every written record inherits (tags, source, …); event links merge ON TOP. */
  metadata?: Record<string, unknown>;
}

/** PURE reducer: turn decision events into concrete store mutations. */
export async function applyEvents(
  events: MemoryEvent[],
  existing: MemoryRecord[],
  ctx: ApplyContext,
): Promise<MemoryMutation[]> {
  const byId = new Map(existing.map((r) => [r.id, r]));
  const now = ctx.clock.now();
  const mutations: MemoryMutation[] = [];

  for (const ev of events) {
    if (ev.type === 'NOOP') continue;
    if (ev.type === 'DELETE') {
      if (ctx.supersede === 'soft') mutations.push({ op: 'invalidate', id: ev.id, invalidAt: now });
      else mutations.push({ op: 'delete', id: ev.id });
      continue;
    }
    if (ev.type === 'ADD') {
      // Extraction-time enrichment (2.0): the event carries the importance and
      // the graph links the fact was extracted with; `metadata.links` is the
      // same key `extractLinks` reads back, and ctx.metadata stays underneath.
      const metadata =
        ev.links?.length || ctx.metadata
          ? { ...ctx.metadata, ...(ev.links?.length ? { links: ev.links } : {}) }
          : undefined;
      const record: MemoryRecord = {
        id: ctx.generateId(),
        text: ev.text,
        hash: await ctx.hashFn(ev.text),
        kind: ev.kind ?? ctx.kind ?? 'semantic',
        scope: ctx.scope,
        ...(metadata ? { metadata } : {}),
        ...(ev.importance !== undefined ? { importance: ev.importance } : {}),
        createdAt: now,
        updatedAt: now,
        validAt: now,
        ...(ctx.ttlMs ? { expiresAt: now + ctx.ttlMs } : {}),
        ...(ctx.embeddings?.has(ev.text) ? { embedding: ctx.embeddings.get(ev.text) } : {}),
        ...(ctx.embeddingModelId ? { embeddingModelId: ctx.embeddingModelId } : {}),
      };
      mutations.push({ op: 'upsert', record, event: 'ADD' });
      continue;
    }
    // UPDATE — keep id, replace text, refresh updatedAt; keep prevText in metadata.
    const prev = byId.get(ev.id);
    const record: MemoryRecord = {
      id: ev.id,
      text: ev.text,
      hash: await ctx.hashFn(ev.text),
      kind: prev?.kind ?? ctx.kind ?? 'semantic',
      scope: prev?.scope ?? ctx.scope,
      metadata: { ...ctx.metadata, ...prev?.metadata, prevText: ev.oldText || prev?.text },
      ...(prev?.importance !== undefined ? { importance: prev.importance } : {}),
      createdAt: prev?.createdAt ?? now,
      updatedAt: now,
      validAt: prev?.validAt ?? now,
      ...(prev?.expiresAt
        ? { expiresAt: prev.expiresAt }
        : ctx.ttlMs
          ? { expiresAt: now + ctx.ttlMs }
          : {}),
      ...(ctx.embeddings?.has(ev.text) ? { embedding: ctx.embeddings.get(ev.text) } : {}),
      ...(ctx.embeddingModelId ? { embeddingModelId: ctx.embeddingModelId } : {}),
    };
    mutations.push({ op: 'upsert', record, event: 'UPDATE' });
  }
  return mutations;
}

// ===================================================================
// High-level orchestrators (take seams as args; no globals, no Date.now).
// ===================================================================

export interface RememberOptions {
  /** Default true. false → store raw turns verbatim, ZERO llm/embed calls (mem0 infer=False). */
  infer?: boolean;
  ttlMs?: number;
  /** Default 'hard' (DELETE). 'soft' → invalidate (Graphiti bi-temporal). */
  supersede?: 'soft' | 'hard';
  /** Existing-memory retrieval breadth for reconciliation (default 5). */
  topK?: number;
  kind?: MemoryKind;
  customInstructions?: string;
  /**
   * Ask the extraction pass for per-fact graph links (default false). Costs a
   * few prompt tokens and lands as `metadata.links`, which {@link recall}'s
   * `expandLinks` traverses.
   */
  links?: boolean;
  /** Default true → applies mutations to the store. false → plan-only (host applies). */
  apply?: boolean;
  /** Swap the LLM extraction step entirely. */
  customExtract?: (messages: Message[]) => Promise<MemoryFact[]> | MemoryFact[];
}

/**
 * Which of `hashes` the store ALREADY holds in this scope — the write-time
 * dedup gate (2.0). One `findByHash` round-trip when the backend indexes hashes;
 * an empty set (i.e. "write it") when it does not, because scanning every record
 * of every scope on every turn would cost more than the duplicate row it saves.
 * A store that wants dedup implements the optional method.
 */
async function knownHashes(
  store: MemoryStore,
  hashes: string[],
  scope: MemoryScope,
): Promise<Set<string>> {
  if (!store.findByHash || hashes.length === 0) return new Set();
  const found = await store.findByHash(hashes, scope);
  return new Set(found.map((r) => r.hash));
}

/**
 * Copy the extraction metadata (kind/importance/links) onto the ADD events the
 * reconciler produced, matching on the EXACT fact text. Deliberately not fuzzy:
 * when the decision pass rewrote the wording, the numbers no longer describe
 * that string, and a wrong importance is worse than none.
 */
function enrichAddEvents(events: MemoryEvent[], facts: Map<string, MemoryFact>): MemoryEvent[] {
  if (facts.size === 0) return events;
  return events.map((ev) => {
    if (ev.type !== 'ADD') return ev;
    const fact = facts.get(ev.text);
    if (!fact) return ev;
    return {
      ...ev,
      ...(ev.kind === undefined && fact.kind ? { kind: fact.kind } : {}),
      ...(fact.importance !== undefined ? { importance: fact.importance } : {}),
      ...(fact.links?.length ? { links: fact.links } : {}),
    };
  });
}

/**
 * Drop ADD events whose content hash is already spoken for — within this very
 * batch, among the records the reconciliation pass retrieved, or (fast path) in
 * the store. A dropped ADD leaves NO trace: emitting a NOOP would tell the
 * caller a record was inspected when none was. UPDATE/DELETE/NOOP pass through
 * untouched — an UPDATE is addressed by id, so its hash colliding is not a
 * duplicate but a convergence.
 */
async function dedupeAddEvents(
  events: MemoryEvent[],
  existing: MemoryRecord[],
  ctx: { store: MemoryStore; scope: MemoryScope; hashFn: HashFn },
): Promise<MemoryEvent[]> {
  const adds = events.filter(
    (ev): ev is Extract<MemoryEvent, { type: 'ADD' }> => ev.type === 'ADD',
  );
  if (adds.length === 0) return events;

  const existingHashes = new Set(existing.map((r) => r.hash));
  const batch = new Set<string>();
  const dropped = new Set<MemoryEvent>();
  const pending = new Map<MemoryEvent, string>();
  for (const ev of adds) {
    const hash = await ctx.hashFn(ev.text);
    if (batch.has(hash) || existingHashes.has(hash)) {
      dropped.add(ev);
      continue;
    }
    batch.add(hash);
    pending.set(ev, hash);
  }

  const stored = await knownHashes(ctx.store, [...pending.values()], ctx.scope);
  if (stored.size) {
    for (const [ev, hash] of pending) if (stored.has(hash)) dropped.add(ev);
  }
  return dropped.size ? events.filter((ev) => !dropped.has(ev)) : events;
}

async function applyMutations(store: MemoryStore, mutations: MemoryMutation[]): Promise<void> {
  const upserts = mutations.filter(
    (m): m is Extract<MemoryMutation, { op: 'upsert' }> => m.op === 'upsert',
  );
  const deletes = mutations.filter(
    (m): m is Extract<MemoryMutation, { op: 'delete' }> => m.op === 'delete',
  );
  const invalidates = mutations.filter(
    (m): m is Extract<MemoryMutation, { op: 'invalidate' }> => m.op === 'invalidate',
  );
  if (upserts.length) await store.upsert(upserts.map((m) => m.record));
  if (deletes.length) await store.delete(deletes.map((m) => m.id));
  for (const inv of invalidates) {
    if (store.update) await store.update(inv.id, { invalidAt: inv.invalidAt });
    else await store.delete([inv.id]); // backend without soft-delete → hard delete
  }
}

/**
 * mem0 add() pipeline, pure-glue:
 *   assertScope → (infer ? extract→embed→search→decide : raw) → applyEvents → [apply]
 * Returns the mutations (whether or not they were applied).
 */
export async function remember(
  messages: Message[],
  scope: MemoryScope,
  seams: MemorySeams,
  opts: RememberOptions = {},
): Promise<MemoryMutation[]> {
  assertScope(scope);
  const hashFn = seams.hashFn ?? defaultHashFn;
  const apply = opts.apply !== false;
  const infer = opts.infer !== false;

  // --- infer=false short-circuit: store raw turns, ZERO llm/embed (cost escape hatch) ---
  if (!infer) {
    const now = seams.clock.now();
    // Hash FIRST, mint ids second: the dedup gate must not burn a generateId()
    // on a turn it is about to drop (scripted-id fixtures pin the sequence).
    const batch = new Set<string>();
    const pending: Array<{ text: string; hash: string }> = [];
    for (const m of messages) {
      const raw =
        typeof m.content === 'string' ? m.content : conversationText([m]).replace(/^[^:]+:\s*/, '');
      const text = raw.trim();
      if (!text) continue;
      const hash = await hashFn(text);
      if (batch.has(hash)) continue; // the same turn twice in one window
      batch.add(hash);
      pending.push({ text, hash });
    }
    const stored = await knownHashes(
      seams.store,
      pending.map((p) => p.hash),
      scope,
    );
    const mutations: MemoryMutation[] = [];
    for (const p of pending) {
      if (stored.has(p.hash)) continue; // already remembered verbatim
      mutations.push({
        op: 'upsert',
        event: 'ADD',
        record: {
          id: seams.generateId(),
          text: p.text,
          hash: p.hash,
          kind: opts.kind ?? 'episodic',
          scope,
          createdAt: now,
          updatedAt: now,
          validAt: now,
          ...(opts.ttlMs ? { expiresAt: now + opts.ttlMs } : {}),
        },
      });
    }
    if (apply && mutations.length) await applyMutations(seams.store, mutations);
    return mutations;
  }

  // --- infer=true: extract → embed → search → decide → apply ---
  let facts: MemoryFact[];
  if (opts.customExtract) {
    facts = await opts.customExtract(messages);
  } else {
    const text = await seams.llm(
      buildExtractionPrompt(messages, {
        customInstructions: opts.customInstructions,
        links: opts.links,
      }),
    );
    facts = parseFacts(text);
  }
  if (facts.length === 0) return [];

  // Keep the extraction metadata addressable by exact text — the reconciler
  // speaks in fact strings, so this is the only join key that exists.
  const factByText = new Map(facts.map((f) => [f.text, f]));

  // Embed facts (for ADD records + reconciliation search), if an embedder is wired.
  const embeddings = new Map<string, number[]>();
  let embeddingModelId: string | undefined;
  if (seams.embedder) {
    const { vectors, model } = await seams.embedder.embed(
      facts.map((f) => f.text),
      'add',
    );
    embeddingModelId = model;
    facts.forEach((f, i) => {
      if (vectors[i]) embeddings.set(f.text, vectors[i]!);
    });
  }

  // Gather existing memories to reconcile against (scoped, top-K per fact, deduped).
  const topK = opts.topK ?? 5;
  const existingById = new Map<string, MemoryRecord>();
  for (const fact of facts) {
    const hits = await seams.store.search({
      scope,
      text: fact.text,
      embedding: embeddings.get(fact.text),
      topK,
    });
    for (const h of hits) existingById.set(h.record.id, h.record);
  }
  const existing = [...existingById.values()];

  // Decide ADD/UPDATE/DELETE/NOOP and reduce to mutations.
  const decisionPrompt = buildDecisionPrompt(existing, facts);
  const decisionText = await seams.llm({
    system: decisionPrompt.system,
    user: decisionPrompt.user,
  });
  const decided = parseDecision(decisionText, decisionPrompt.idMap);
  const events = await dedupeAddEvents(enrichAddEvents(decided, factByText), existing, {
    store: seams.store,
    scope,
    hashFn,
  });
  const mutations = await applyEvents(events, existing, {
    clock: seams.clock,
    generateId: seams.generateId,
    scope,
    hashFn,
    ttlMs: opts.ttlMs,
    supersede: opts.supersede,
    kind: opts.kind,
    embeddings,
    embeddingModelId,
  });

  if (apply && mutations.length) await applyMutations(seams.store, mutations);
  return mutations;
}

/**
 * TTL garbage collection (2.0): hard-delete every record in `scope` whose
 * `expiresAt` has passed and return HOW MANY went. `isExpired` only HIDES an
 * expired record at read time, so without a sweep a TTL'd store grows forever.
 *
 * Fast path when the backend implements `deleteExpired` (one DELETE statement);
 * otherwise `list` + filter + `delete`, which is correct everywhere and cheap
 * for the in-memory/markdown backends. Deliberately hard-deletes even under a
 * `supersede: 'soft'` policy — an expiry is a lifetime ending, not a fact being
 * contradicted.
 */
export async function sweepExpired(
  store: MemoryStore,
  scope: MemoryScope,
  clock: Clock,
): Promise<number> {
  const now = clock.now();
  if (store.deleteExpired) return store.deleteExpired(now, scope);
  const records = await store.list(scope);
  const expired = records.filter((r) => isExpired(r, now));
  if (expired.length) await store.delete(expired.map((r) => r.id));
  return expired.length;
}

/** Plan-only alias (apply:false). Host owns sync-vs-defer scheduling. */
export function planMemory(
  messages: Message[],
  scope: MemoryScope,
  seams: MemorySeams,
  opts: RememberOptions = {},
): Promise<MemoryMutation[]> {
  return remember(messages, scope, seams, { ...opts, apply: false });
}

// ===================================================================
// Graph traversal (Obsidian / Graphiti): the links were always WRITTEN — 2.0
// finally READS them.
// ===================================================================

const WIKILINK_RE = /\[\[([^\][]+)\]\]/g;

/** How many link targets a single hop may chase (a fan-out fuse, not a budget). */
const MAX_LINKS_PER_HOP = 8;

/**
 * The outgoing edges of a record: its `metadata.links` array plus every
 * `[[wikilink]]` in the body, deduped in that order.
 *
 * Surrounding brackets are STRIPPED from `metadata.links` entries, because both
 * spellings mean the same node — the markdown backend round-trips a frontmatter
 * `links: ["[[project]]"]` while an LLM-extracted fact writes `"project"` — and
 * without normalization the same neighbour would be visited twice.
 */
export function extractLinks(record: MemoryRecord): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (raw: string): void => {
    const link = raw.trim().replace(/^\[\[/, '').replace(/\]\]$/, '').trim();
    if (!link || seen.has(link)) return;
    seen.add(link);
    out.push(link);
  };
  const meta = record.metadata?.links;
  if (Array.isArray(meta)) for (const l of meta) if (typeof l === 'string') push(l);
  for (const m of record.text.matchAll(WIKILINK_RE)) push(m[1]!);
  return out;
}

/** Resolve one link target: an id first (`store.get`), then a title/text search. */
async function resolveLink(
  link: string,
  scope: MemoryScope,
  store: MemoryStore,
): Promise<MemoryRecord | null> {
  const byId = await store.get(link, scope);
  if (byId) return byId;
  const hits = await store.search({ scope, text: link, topK: 1 });
  const first = hits[0];
  return first && first.score > 0 ? first.record : null;
}

/**
 * Retrieval glue: embed query (if text & embedder) → store.search →
 * drop-expired → optional rerank → optional link expansion.
 *
 * `expandLinks: n` walks up to `n` hops out of the primary hits (2.0). Linked
 * records are APPENDED, never interleaved: the primaries keep the head of the
 * list exactly as scoring left them, so turning expansion on can only add
 * context, never displace it. Each hop multiplies its parent hit's score by
 * `0.5 ** hop`, so a neighbour never outranks what pulled it in. A `seen` set of
 * record ids makes an A↔B cycle terminate, the fan-out is capped at
 * {@link MAX_LINKS_PER_HOP} targets per hop and the whole expansion at
 * `2 × topK` extra records. Expansion is BEST-EFFORT — a store that throws
 * mid-walk logs and yields the primaries plus whatever was already resolved.
 */
export async function recall(
  query: MemoryQuery,
  seams: MemorySeams,
  opts: { scorer?: MemoryScorer; dropExpired?: boolean; expandLinks?: number } = {},
): Promise<MemoryHit[]> {
  assertScope(query.scope);
  let q = query;
  if (q.text && !q.embedding && seams.embedder) {
    const { vectors } = await seams.embedder.embed([q.text], 'search');
    if (vectors[0]) q = { ...q, embedding: vectors[0] };
  }
  let hits = await seams.store.search(q);

  if (opts.dropExpired !== false) {
    const now = seams.clock.now();
    hits = hits.filter((h) => !isExpired(h.record, now));
  }

  const scorer = opts.scorer;
  if (scorer) {
    const now = seams.clock.now();
    hits = hits
      .map((h) => ({
        record: h.record,
        score: scorer.score(h.record, { now, relevance: h.score }),
      }))
      .sort((a, b) => b.score - a.score);
  }

  const hops = opts.expandLinks ?? 0;
  if (hops <= 0 || hits.length === 0) return hits;

  const now = seams.clock.now();
  const cap = 2 * (query.topK ?? 5);
  const seen = new Set(hits.map((h) => h.record.id));
  const extra: MemoryHit[] = [];
  let frontier = hits;
  try {
    for (let hop = 1; hop <= hops && frontier.length && extra.length < cap; hop++) {
      const targets: Array<{ link: string; parent: MemoryHit }> = [];
      const visited = new Set<string>();
      for (const parent of frontier) {
        for (const link of extractLinks(parent.record)) {
          if (visited.has(link)) continue;
          visited.add(link);
          targets.push({ link, parent });
          if (targets.length >= MAX_LINKS_PER_HOP) break;
        }
        if (targets.length >= MAX_LINKS_PER_HOP) break;
      }

      const next: MemoryHit[] = [];
      for (const { link, parent } of targets) {
        const record = await resolveLink(link, query.scope, seams.store);
        if (!record || seen.has(record.id)) continue;
        if (record.invalidAt != null || isExpired(record, now)) continue;
        seen.add(record.id);
        const hit: MemoryHit = { record, score: parent.score * Math.pow(0.5, hop) };
        extra.push(hit);
        next.push(hit);
        if (extra.length >= cap) break;
      }
      frontier = next;
    }
  } catch (error) {
    seams.logger?.warn('memory link expansion failed', { error });
  }
  return [...hits, ...extra];
}

/** Render hits into a system-prompt string (RAG-style splice). Pure formatting. */
export function formatMemoriesForPrompt(
  hits: MemoryHit[],
  opts?: { header?: string; maxChars?: number },
): string {
  const header = opts?.header ?? 'Relevant memories:';
  const lines = hits.map((h) => `- ${h.record.text}`);
  let body = `${header}\n${lines.join('\n')}`;
  if (opts?.maxChars && body.length > opts.maxChars) body = body.slice(0, opts.maxChars);
  return hits.length ? body : '';
}

// ===================================================================
// Model-driven write path (Letta / Anthropic memory-tool style).
// Provider-agnostic ToolSet whose execute() delegates to the store seam.
// ===================================================================

export interface MemoryToolOptions {
  scope: MemoryScope;
  seams: MemorySeams;
}

/** memory_append / memory_search / memory_update / memory_delete / memory_view. */
export function createMemoryTools(opts: MemoryToolOptions): ToolSet {
  const { scope, seams } = opts;
  const hashFn = seams.hashFn ?? defaultHashFn;

  const append: Tool = {
    description: 'Append a new memory (a durable fact worth remembering).',
    parameters: {
      type: 'object',
      properties: { text: { type: 'string' }, kind: { type: 'string' } },
      required: ['text'],
    },
    execute: async (rawArgs) => {
      const args = rawArgs as { text: string; kind?: MemoryKind };
      const now = seams.clock.now();
      const record: MemoryRecord = {
        id: seams.generateId(),
        text: args.text,
        hash: await hashFn(args.text),
        kind: args.kind ?? 'semantic',
        scope,
        createdAt: now,
        updatedAt: now,
        validAt: now,
      };
      await seams.store.upsert([record]);
      return { id: record.id };
    },
  };

  const search: Tool = {
    description: 'Search stored memories by a query string.',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string' }, topK: { type: 'number' } },
      required: ['query'],
    },
    execute: async (rawArgs) => {
      const args = rawArgs as { query: string; topK?: number };
      const hits = await recall({ scope, text: args.query, topK: args.topK ?? 5 }, seams);
      return hits.map((h) => ({ id: h.record.id, text: h.record.text, score: h.score }));
    },
  };

  const update: Tool = {
    description: 'Replace the text of an existing memory by id.',
    parameters: {
      type: 'object',
      properties: { id: { type: 'string' }, text: { type: 'string' } },
      required: ['id', 'text'],
    },
    execute: async (rawArgs) => {
      const args = rawArgs as { id: string; text: string };
      const patch = {
        text: args.text,
        hash: await hashFn(args.text),
        updatedAt: seams.clock.now(),
      };
      if (seams.store.update) await seams.store.update(args.id, patch);
      else {
        const existing = await seams.store.get(args.id, scope);
        if (existing) await seams.store.upsert([{ ...existing, ...patch }]);
      }
      return { id: args.id };
    },
  };

  const remove: Tool = {
    description: 'Delete a memory by id.',
    parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    execute: async (rawArgs) => {
      const args = rawArgs as { id: string };
      await seams.store.delete([args.id]);
      return { id: args.id, deleted: true };
    },
  };

  const view: Tool = {
    description: 'List stored memories for the current scope.',
    parameters: {
      type: 'object',
      properties: { kind: { type: 'string' }, limit: { type: 'number' } },
    },
    execute: async (rawArgs) => {
      const args = rawArgs as { kind?: MemoryKind; limit?: number };
      const records = await seams.store.list(scope, { kind: args.kind, limit: args.limit ?? 50 });
      return records.map((r) => ({ id: r.id, text: r.text, kind: r.kind }));
    },
  };

  return {
    memory_append: append,
    memory_search: search,
    memory_update: update,
    memory_delete: remove,
    memory_view: view,
  };
}

// ===================================================================
// Reference in-memory store + embedder adapter (tests / examples / defaults).
// The REAL store (markdown files, a vector DB, mem0) is always injected.
// ===================================================================

/** Pure in-memory MemoryStore: cosine when the query has an embedding, else substring grep. */
export function createInMemoryMemoryStore(): MemoryStore {
  const records = new Map<string, MemoryRecord>();
  return {
    async upsert(recs) {
      for (const r of recs) records.set(r.id, r);
    },
    async get(id, scope) {
      const r = records.get(id);
      if (!r) return null;
      if (scope && !matchesScope(r, scope)) return null;
      return r;
    },
    async search(query) {
      const topK = query.topK ?? 5;
      const candidates = [...records.values()].filter(
        (r) =>
          matchesScope(r, query.scope) &&
          (query.kind ? r.kind === query.kind : true) &&
          r.invalidAt == null,
      );
      let scored: MemoryHit[];
      if (query.embedding) {
        scored = candidates.map((r) => ({
          record: r,
          score: r.embedding ? cosineSimilarity(query.embedding!, r.embedding) : 0,
        }));
      } else if (query.text) {
        const q = query.text.toLowerCase();
        scored = candidates.map((r) => ({
          record: r,
          score: r.text.toLowerCase().includes(q) ? 1 : 0,
        }));
      } else {
        scored = candidates.map((r) => ({ record: r, score: 0 }));
      }
      return scored.sort((a, b) => b.score - a.score).slice(0, topK);
    },
    async list(scope, opts) {
      // Exclude soft-deleted records (invalidAt set) — consistent with search().
      const out = [...records.values()].filter(
        (r) =>
          matchesScope(r, scope) &&
          (opts?.kind ? r.kind === opts.kind : true) &&
          r.invalidAt == null,
      );
      // `limit: 0` means none, the way slice reads it — not "unlimited". The
      // persistent packs push it into SQL/Redis, so a truthiness check here
      // would make the same call return everything on one backend and nothing
      // on the others.
      return opts?.limit === undefined ? out : out.slice(0, opts.limit);
    },
    async delete(ids) {
      for (const id of ids) records.delete(id);
    },
    async update(id, patch) {
      const r = records.get(id);
      if (r) records.set(id, { ...r, ...patch });
    },
    async findByHash(hashes, scope) {
      // Soft-deleted records are invisible here for the same reason they are in
      // search()/list(): a fact the host invalidated must not silently block the
      // model from learning it again.
      const wanted = new Set(hashes);
      return [...records.values()].filter(
        (r) => wanted.has(r.hash) && matchesScope(r, scope) && r.invalidAt == null,
      );
    },
    async deleteExpired(now, scope) {
      const doomed = [...records.values()].filter(
        (r) => isExpired(r, now) && (scope ? matchesScope(r, scope) : true),
      );
      for (const r of doomed) records.delete(r.id);
      return doomed.length;
    },
  };
}

/**
 * Bridge a RAG `Embedder` (`./rag`) into a memory `Embedder` (2.0).
 *
 * The two subsystems grew incompatible seams: RAG's takes only texts and
 * advertises `dims`, memory's takes a task `action` and reports the model id it
 * used. Rather than break either public type, this adapter lets ONE embedder
 * back both — the memory side simply has no task type to pass on. Supply
 * `modelId` when you care about the `embeddingModelId` dimension-drift guard on
 * written records; without it the records are pinned to `'unknown'`.
 */
export function memoryEmbedderFromRag(e: RagEmbedder, opts?: { modelId?: string }): Embedder {
  return {
    async embed(texts) {
      return { vectors: await e.embed(texts), model: opts?.modelId ?? 'unknown' };
    },
  };
}

/** Build an `Embedder` seam from an `EmbeddingModel`, delegating to embed.ts. */
export function createEmbedder(
  model: EmbeddingModel,
  baseOptions?: Omit<EmbedManyOptions, 'model' | 'values' | 'taskType'>,
): Embedder {
  return {
    async embed(texts, action) {
      const taskType = action === 'search' ? 'search_query' : 'search_document';
      const { embeddings } = await embedMany({ ...baseOptions, model, values: texts, taskType });
      return { vectors: embeddings, model: model.modelId };
    },
  };
}
