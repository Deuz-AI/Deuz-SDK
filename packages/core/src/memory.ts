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
import { InvalidRequestError } from './errors';
import { embedMany } from './inference/embed';

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
  importance?: number;
}

/** Decision events (mem0 contradiction resolution). `id`s are real record ids (mapped back from temp handles). */
export type MemoryEvent =
  | { type: 'ADD'; text: string; kind?: MemoryKind }
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
  recall?: { topK?: number; header?: string } | false;
  /** Extract after the run (default on, LLM-inferred). `false` disables. */
  extract?: { infer?: boolean } | false;
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
  return true;
}

/** Pure TTL predicate. `now = clock.now()`. */
export function isExpired(rec: MemoryRecord, now: number): boolean {
  return rec.expiresAt !== undefined && rec.expiresAt <= now;
}

/** Pure cosine similarity (edge-safe Float math). Returns 0 on length mismatch / zero vector. */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

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

/** Build the fact-extraction prompt from a conversation window. */
export function buildExtractionPrompt(
  messages: Message[],
  opts?: { customInstructions?: string },
): { system: string; user: string } {
  const system =
    'You extract durable, standalone facts about the user/agent from a conversation. ' +
    'Return ONLY JSON of the form {"facts": ["fact 1", "fact 2"]}. ' +
    'Each fact must be self-contained (no pronouns referring outside it), atomic, and worth ' +
    'remembering long-term (preferences, identity, goals, constraints, decisions). ' +
    'If there is nothing worth remembering, return {"facts": []}.' +
    (opts?.customInstructions ? `\nAdditional instructions: ${opts.customInstructions}` : '');
  const user = `Conversation:\n${conversationText(messages)}`;
  return { system, user };
}

/** Tolerant fact parser: strips fences, validates shape, returns [] on garbage (never throws). */
export function parseFacts(llmText: string): MemoryFact[] {
  try {
    const parsed = JSON.parse(stripFences(llmText)) as unknown;
    const arr = Array.isArray(parsed) ? parsed : (parsed as { facts?: unknown })?.facts;
    if (!Array.isArray(arr)) return [];
    const out: MemoryFact[] = [];
    for (const item of arr) {
      if (typeof item === 'string' && item.trim()) out.push({ text: item.trim() });
      else if (item && typeof item === 'object' && typeof (item as MemoryFact).text === 'string') {
        const f = item as MemoryFact;
        if (f.text.trim())
          out.push({ text: f.text.trim(), kind: f.kind, importance: f.importance });
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
      const record: MemoryRecord = {
        id: ctx.generateId(),
        text: ev.text,
        hash: await ctx.hashFn(ev.text),
        kind: ev.kind ?? ctx.kind ?? 'semantic',
        scope: ctx.scope,
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
      metadata: { ...prev?.metadata, prevText: ev.oldText || prev?.text },
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
  /** Default true → applies mutations to the store. false → plan-only (host applies). */
  apply?: boolean;
  /** Swap the LLM extraction step entirely. */
  customExtract?: (messages: Message[]) => Promise<MemoryFact[]> | MemoryFact[];
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
    const records: MemoryRecord[] = [];
    for (const m of messages) {
      const text =
        typeof m.content === 'string' ? m.content : conversationText([m]).replace(/^[^:]+:\s*/, '');
      if (!text.trim()) continue;
      records.push({
        id: seams.generateId(),
        text: text.trim(),
        hash: await hashFn(text.trim()),
        kind: opts.kind ?? 'episodic',
        scope,
        createdAt: now,
        updatedAt: now,
        validAt: now,
        ...(opts.ttlMs ? { expiresAt: now + opts.ttlMs } : {}),
      });
    }
    const mutations: MemoryMutation[] = records.map((record) => ({
      op: 'upsert',
      record,
      event: 'ADD',
    }));
    if (apply && mutations.length) await applyMutations(seams.store, mutations);
    return mutations;
  }

  // --- infer=true: extract → embed → search → decide → apply ---
  let facts: MemoryFact[];
  if (opts.customExtract) {
    facts = await opts.customExtract(messages);
  } else {
    const text = await seams.llm(
      buildExtractionPrompt(messages, { customInstructions: opts.customInstructions }),
    );
    facts = parseFacts(text);
  }
  if (facts.length === 0) return [];

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
  const events = parseDecision(decisionText, decisionPrompt.idMap);
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

/** Plan-only alias (apply:false). Host owns sync-vs-defer scheduling. */
export function planMemory(
  messages: Message[],
  scope: MemoryScope,
  seams: MemorySeams,
  opts: RememberOptions = {},
): Promise<MemoryMutation[]> {
  return remember(messages, scope, seams, { ...opts, apply: false });
}

/** Retrieval glue: embed query (if text & embedder) → store.search → drop-expired → optional rerank. */
export async function recall(
  query: MemoryQuery,
  seams: MemorySeams,
  opts: { scorer?: MemoryScorer; dropExpired?: boolean } = {},
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
  return hits;
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
      return opts?.limit ? out.slice(0, opts.limit) : out;
    },
    async delete(ids) {
      for (const id of ids) records.delete(id);
    },
    async update(id, patch) {
      const r = records.get(id);
      if (r) records.set(id, { ...r, ...patch });
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
