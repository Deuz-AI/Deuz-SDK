/**
 * The built-in context sources (2.4): memory, RAG, transcript and the skill
 * catalog, each a `ContextSource`. Off unless the host configures them; the
 * transcript source in particular is never on by default.
 */
import type { MemoryScope, MemoryStore, Embedder } from '../memory';
import type { MemorySession } from '../memory/versioned/types';
import type { ScoredChunk } from '../rag';
import type { SkillRegistry } from '../skills';
import type { TranscriptIndex } from '../types/chat-conditional';
import { notImplemented } from '../internal/not-implemented';
import type { ContextSource } from './types';

/** Shared options of every built-in source. */
export interface ContextSourceOptions {
  /** Default: the source kind (`'memory'`, `'rag'`, …). */
  id?: string;
  /** A required source's failure stops the model call. Default false. */
  required?: boolean;
}

/** Memory candidates from a versioned session, or from a legacy store. */
export type MemoryContextSourceOptions = ContextSourceOptions &
  ({ session: MemorySession } | { store: MemoryStore; scope: MemoryScope; embedder?: Embedder });

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

/**
 * Memory as a context source (2.4): `session.recall` (versioned, with
 * provenance labels and `recordedAsOf` for restarts) or a legacy store's
 * `search`. With this source the loop's legacy automatic recall is off, and
 * configuring both is refused at configuration time.
 */
export function createMemoryContextSource(_options: MemoryContextSourceOptions): ContextSource {
  return notImplemented('createMemoryContextSource');
}

/** RAG as a context source (2.4): the first link between `/rag` and the loop. */
export function createRagContextSource(_options: RagContextSourceOptions): ContextSource {
  return notImplemented('createRagContextSource');
}

/** Past conversations as a context source (2.4); off by default. */
export function createTranscriptContextSource(
  _options: TranscriptContextSourceOptions,
): ContextSource {
  return notImplemented('createTranscriptContextSource');
}

/** The skill catalog as a context source (2.4). */
export function createSkillsContextSource(_options: SkillsContextSourceOptions): ContextSource {
  return notImplemented('createSkillsContextSource');
}
