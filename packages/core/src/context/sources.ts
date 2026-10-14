/**
 * The built-in context sources (2.4): memory, RAG, transcript and the skill
 * catalog, each a `ContextSource`. Off unless the host configures them; the
 * transcript source in particular is never on by default.
 *
 * Every candidate carries the `sha256:<hex>` digest of its text. A source
 * reads only within the scope the host pinned: a request scope may narrow it,
 * never widen it or step into another user, agent or chat (`TypeError`, the
 * same rule as `claimMemoryScope`). Queries are taken as given; no model
 * rewrites them here.
 */
import { sha256Digest } from '../internal/digest';
import { scopeKey, scopeWithin } from '../internal/native-scope';
import { resolveDependencies } from '../internal/resolve-deps';
import type { MemoryScope, MemoryStore, Embedder } from '../memory';
import type { MemorySourceKind, MemorySourceRef, MemorySession } from '../memory/versioned/types';
import type { ScoredChunk } from '../rag';
import type { SkillRegistry } from '../skills';
import type { TranscriptIndex, TranscriptMessage } from '../types/chat-conditional';
import type { Clock } from '../types/deps';
import type { Role } from '../types/message';
import { messageText } from './render';
import type { ContextCandidate, ContextSource, ContextSourceKind } from './types';

/** Shared options of every built-in source. */
export interface ContextSourceOptions {
  /** Default: the source kind (`'memory'`, `'rag'`, …). */
  id?: string;
  /** A required source's failure stops the model call. Default false. */
  required?: boolean;
}

/** Memory candidates from a versioned session, or from a legacy store. */
export type MemoryContextSourceOptions = ContextSourceOptions &
  (
    | { session: MemorySession }
    | {
        store: MemoryStore;
        scope: MemoryScope;
        embedder?: Embedder;
        /** Reads TTL expiry when the request has no `recordedAsOf`. Default: the host clock. */
        clock?: Clock;
      }
  );

/** RAG candidates from the host's retrieval (dense, BM25 or hybrid). */
export interface RagContextSourceOptions extends ContextSourceOptions {
  retrieve(query: string, topK: number, signal?: AbortSignal): Promise<readonly ScoredChunk[]>;
}

/** Past messages from a transcript index, under its scope check. */
export interface TranscriptContextSourceOptions extends ContextSourceOptions {
  index: TranscriptIndex;
  scope: MemoryScope;
  /** Only these chats. */
  chatIds?: readonly string[];
  /** Surrounding messages per hit. Default 0. */
  around?: number;
  /**
   * Message references to resolve and offer ahead of the search hits, e.g.
   * the messages recalled memory records cite (`MemorySourceRef` with
   * `chatId` and `messageId`). Each goes through `resolveSource` under the
   * same scope; one outside it, gone or unknown is left out.
   */
  refs?: () => readonly MemorySourceRef[];
}

/**
 * The skill catalog: only its lines (name and description) and the bodies
 * the model already loaded with `load_skill` (mandatory). A skill body is
 * never injected because retrieval matched it: skills are never activated
 * automatically.
 */
export interface SkillsContextSourceOptions extends ContextSourceOptions {
  registry: SkillRegistry;
  /** The skills the model loaded so far, whose bodies stay in the budget. */
  loaded?: () => readonly string[];
}

const SCOPE_KEYS = ['userId', 'agentId', 'runId', 'actorId', 'chatId'] as const;

/**
 * The scope a source reads: its pinned scope, narrowed by the request's.
 * A field both pin to different values is a widening, refused.
 */
function narrowScope(pinned: MemoryScope, requested: MemoryScope | undefined): MemoryScope {
  if (!requested) return pinned;
  const scope: MemoryScope = { ...pinned };
  for (const key of SCOPE_KEYS) {
    const value = requested[key];
    if (value === undefined) continue;
    if (pinned[key] !== undefined && pinned[key] !== value)
      throw new TypeError(
        `The context scope ${scopeKey(requested)} leaves the source's pinned scope ${scopeKey(pinned)}; a scope may only be narrowed.`,
      );
    scope[key] = value;
  }
  return scope;
}

function source(
  kind: ContextSourceKind,
  options: ContextSourceOptions,
  query: ContextSource['query'],
): ContextSource {
  return { id: options.id ?? kind, kind, required: options.required ?? false, query };
}

/**
 * Memory as a context source (2.4): `session.recall` (versioned, with
 * provenance labels and `recordedAsOf` for restarts) or a legacy store's
 * `search`. With this source the loop's legacy automatic recall is off, and
 * configuring both is refused at configuration time.
 *
 * A session's scope is fixed: a request scope it is not within is refused.
 * The legacy adapter reads `store.search` within its narrowed scope (with the
 * query embedded by `embedder`, action `'search'`, when one is given), and
 * leaves out records invalidated, or expired at `request.recordedAsOf` (the
 * compiler's clock; else `clock`). Legacy records carry no revision or origin.
 */
export function createMemoryContextSource(options: MemoryContextSourceOptions): ContextSource {
  if ('session' in options) {
    const { session } = options;
    return source('memory', options, async (request) => {
      if (request.scope && !scopeWithin(session.scope, request.scope))
        throw new TypeError(
          `The memory session's scope ${scopeKey(session.scope)} is wider than the context scope ${scopeKey(request.scope)}; a scope may only be narrowed.`,
        );
      const hits = await session.recall({
        text: request.text,
        topK: request.limit,
        ...(request.recordedAsOf !== undefined ? { recordedAsOf: request.recordedAsOf } : {}),
        ...(request.signal ? { signal: request.signal } : {}),
      });
      return Promise.all(
        hits.slice(0, request.limit).map(
          async ({ record, score, match }): Promise<ContextCandidate> => ({
            recordId: record.id,
            revision: record.revision,
            text: record.text,
            digest: await sha256Digest(record.text),
            score,
            provenance: {
              origin: record.origin,
              sourceKinds: [...new Set(record.sources.map((ref) => ref.kind))].sort(),
            },
            query: request.text,
            match,
          }),
        ),
      );
    });
  }
  const { store, embedder } = options;
  const clock = options.clock ?? resolveDependencies().clock;
  return source('memory', options, async (request) => {
    const scope = narrowScope(options.scope, request.scope);
    let embedding: number[] | undefined;
    if (embedder && request.text) {
      const { vectors } = await embedder.embed([request.text], 'search');
      embedding = vectors[0];
    }
    const hits = await store.search({
      scope,
      text: request.text,
      ...(embedding ? { embedding } : {}),
      topK: request.limit,
    });
    const now = request.recordedAsOf ?? clock.now();
    const live = hits.filter(
      ({ record }) =>
        !(record.expiresAt !== undefined && record.expiresAt <= now) && record.invalidAt == null,
    );
    return Promise.all(
      live.slice(0, request.limit).map(
        async ({ record, score }): Promise<ContextCandidate> => ({
          recordId: record.id,
          text: record.text,
          digest: await sha256Digest(record.text),
          score,
          query: request.text,
          match: embedding ? 'vector' : 'lexical',
        }),
      ),
    );
  });
}

/**
 * RAG as a context source (2.4): the first link between `/rag` and the loop.
 * Wire it to `retrieve` or `hybridRetrieve`, e.g.
 * `retrieve: (query, topK) => hybridRetrieve(query, deps, { topK })`. A
 * chunk's record id is its `meta.id` when that is a string, else its index.
 */
export function createRagContextSource(options: RagContextSourceOptions): ContextSource {
  return source('rag', options, async (request) => {
    const chunks = await options.retrieve(request.text, request.limit, request.signal);
    return Promise.all(
      chunks.slice(0, request.limit).map(
        async (chunk): Promise<ContextCandidate> => ({
          recordId: typeof chunk.meta?.id === 'string' ? chunk.meta.id : String(chunk.index),
          text: chunk.text,
          digest: await sha256Digest(chunk.text),
          score: chunk.score,
          query: request.text,
        }),
      ),
    );
  });
}

const ROLE_KIND: Record<Role, MemorySourceKind> = {
  user: 'user',
  assistant: 'assistant',
  tool: 'tool',
  system: 'host',
};

/** Messages as `role: text` lines in chat order; messages without text are left out. */
function transcriptText(messages: readonly TranscriptMessage[]): string {
  return [...messages]
    .sort((a, b) => a.index - b.index)
    .map((entry) => [entry.message.role, messageText(entry.message)] as const)
    .filter(([, text]) => text !== '')
    .map(([role, text]) => `${role}: ${text}`)
    .join('\n');
}

async function transcriptCandidate(
  messages: readonly TranscriptMessage[],
  hit: TranscriptMessage,
  score: number,
  query: string,
  match: string,
): Promise<ContextCandidate | undefined> {
  const text = transcriptText(messages);
  if (text === '') return undefined;
  return {
    recordId: `${hit.chatId}/${hit.messageId}`,
    text,
    digest: await sha256Digest(text),
    score,
    provenance: {
      sourceKinds: [...new Set(messages.map((entry) => ROLE_KIND[entry.message.role]))].sort(),
    },
    query,
    match,
  };
}

/**
 * Past conversations as a context source (2.4); off by default. Searches the
 * index within the narrowed scope (`limit`, `around`, `chatIds`), and offers
 * the resolved `refs` first (`match: 'source-ref'`, ranked above every hit).
 * A candidate's text is its messages as `role: text` lines in chat order.
 */
export function createTranscriptContextSource(
  options: TranscriptContextSourceOptions,
): ContextSource {
  return source('transcript', options, async (request) => {
    const scope = narrowScope(options.scope, request.scope);
    const around = options.around ?? 0;
    const hits = request.text.trim()
      ? await options.index.search(scope, request.text, {
          limit: request.limit,
          ...(around > 0 ? { around } : {}),
          ...(options.chatIds ? { chatIds: options.chatIds } : {}),
          ...(request.signal ? { signal: request.signal } : {}),
        })
      : [];
    const top = Math.max(0, ...hits.map((hit) => hit.score));
    const seen = new Set<string>();
    const refs = (options.refs?.() ?? []).filter((ref) => {
      if (ref.chatId === undefined || ref.messageId === undefined) return false;
      const key = `${ref.chatId}/${ref.messageId}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    const resolved = await Promise.all(refs.map((ref) => options.index.resolveSource(scope, ref)));
    const candidates = await Promise.all([
      ...resolved.map((message) =>
        message
          ? transcriptCandidate([message], message, top + 1, request.text, 'source-ref')
          : undefined,
      ),
      ...hits.map((hit) =>
        transcriptCandidate([...(hit.around ?? []), hit], hit, hit.score, request.text, 'lexical'),
      ),
    ]);
    return candidates
      .filter((candidate): candidate is ContextCandidate => candidate !== undefined)
      .slice(0, request.limit);
  });
}

/**
 * The skill catalog as a context source (2.4). Catalog lines (`name (id):
 * description`) come from `registry.match` on the query, which ranks and
 * never triggers; an empty query offers none. Each skill in `loaded()` is
 * read once through `registry.trigger` and offered whole as a mandatory
 * candidate (`<id>/SKILL.md`, `match: 'loaded'`).
 */
export function createSkillsContextSource(options: SkillsContextSourceOptions): ContextSource {
  const { registry } = options;
  return source('skills', options, async (request) => {
    const candidates: ContextCandidate[] = [];
    for (const id of [...new Set(options.loaded?.() ?? [])]) {
      const manifest = await registry.trigger(id);
      candidates.push({
        recordId: `${id}/SKILL.md`,
        text: manifest.body,
        digest: await sha256Digest(manifest.body),
        score: 0,
        mandatory: true,
        match: 'loaded',
      });
    }
    if (request.text.trim() === '') return candidates;
    const catalog = new Map((await registry.catalog()).map((entry) => [entry.id, entry]));
    const matches = await registry.match(request.text, { topK: request.limit });
    for (const match of matches) {
      const entry = catalog.get(match.id);
      if (!entry) continue;
      const text = `${entry.name} (${entry.id}): ${entry.description}`;
      candidates.push({
        recordId: entry.id,
        text,
        digest: await sha256Digest(text),
        score: match.score,
        query: request.text,
        match: 'catalog',
      });
    }
    return candidates;
  });
}
