/**
 * Helpers shared by the versioned memory store, session, tools and import
 * (2.4): scope identity, input validation, the record and text digests, a
 * small lexical scorer and an async mutex. Pure and edge-safe; nothing here
 * imports `memory.ts` at runtime (it pulls the embedding client).
 */
import { InvalidRequestError } from '../../errors';
import { digestJson, isSha256Digest, sha256Digest, type Sha256Digest } from '../../internal/digest';
import { scopeKey } from '../../internal/native-scope';
import type { MemoryKind, MemoryScope } from '../../memory';
import type {
  MemoryLink,
  MemoryOrigin,
  MemorySourceKind,
  MemorySourceRef,
  VersionedMemoryRecord,
} from './types';

export { scopeKey };

const SCOPE_FIELDS = ['userId', 'agentId', 'runId', 'actorId', 'chatId'] as const;
const SOURCE_KINDS: readonly string[] = ['user', 'assistant', 'tool', 'external', 'host'];
const MEMORY_KINDS: readonly string[] = ['episodic', 'semantic', 'working', 'procedural'];
const ORIGINS: readonly string[] = ['asserted', 'inferred'];

export function invalid(message: string): InvalidRequestError {
  return new InvalidRequestError({ message });
}

/**
 * A memory scope: at least one field set, every set field a non-empty string.
 * Returns a copy holding only the scope fields.
 */
export function checkScope(scope: unknown, what = 'scope'): MemoryScope {
  if (scope === null || typeof scope !== 'object') throw invalid(`The ${what} must be an object.`);
  const out: MemoryScope = {};
  for (const field of SCOPE_FIELDS) {
    const value = (scope as MemoryScope)[field];
    if (value === undefined) continue;
    if (typeof value !== 'string' || value === '')
      throw invalid(`The ${what} field ${field} must be a non-empty string.`);
    out[field] = value;
  }
  if (Object.keys(out).length === 0)
    throw invalid(`The ${what} needs at least one of userId, agentId, runId, actorId or chatId.`);
  return out;
}

export function isSourceKind(value: unknown): value is MemorySourceKind {
  return typeof value === 'string' && SOURCE_KINDS.includes(value);
}

export function isMemoryKind(value: unknown): value is MemoryKind {
  return typeof value === 'string' && MEMORY_KINDS.includes(value);
}

export function isOrigin(value: unknown): value is MemoryOrigin {
  return typeof value === 'string' && ORIGINS.includes(value);
}

const OPTIONAL_SOURCE_FIELDS = [
  'runId',
  'chatId',
  'messageId',
  'toolCallId',
  'toolName',
  'uri',
] as const;

/** At least one source; each with a known kind, a `sha256:` digest and string ids. */
export function checkSources(sources: unknown, what: string): MemorySourceRef[] {
  if (!Array.isArray(sources) || sources.length === 0)
    throw invalid(`${what} needs at least one source.`);
  return sources.map((source: unknown, index) => {
    const ref = source as MemorySourceRef | null;
    if (ref === null || typeof ref !== 'object' || !isSourceKind(ref.kind))
      throw invalid(
        `${what} source ${index} has no valid kind (user, assistant, tool, external, host).`,
      );
    if (!isSha256Digest(ref.digest))
      throw invalid(`${what} source ${index} needs a sha256:<hex> digest.`);
    const out: MemorySourceRef = { kind: ref.kind, digest: ref.digest };
    for (const field of OPTIONAL_SOURCE_FIELDS) {
      const value = ref[field];
      if (value === undefined) continue;
      if (typeof value !== 'string')
        throw invalid(`${what} source ${index}: ${field} must be a string.`);
      out[field] = value;
    }
    return out;
  });
}

export function checkLinks(links: unknown, what: string): MemoryLink[] | undefined {
  if (links === undefined) return undefined;
  if (!Array.isArray(links)) throw invalid(`${what} links must be an array.`);
  return links.map((link: unknown, index) => {
    const value = link as MemoryLink | null;
    if (
      value === null ||
      typeof value !== 'object' ||
      typeof value.recordId !== 'string' ||
      !value.recordId
    )
      throw invalid(`${what} link ${index} needs a recordId.`);
    if (value.relation !== undefined && typeof value.relation !== 'string')
      throw invalid(`${what} link ${index}: relation must be a string.`);
    return value.relation === undefined
      ? { recordId: value.recordId }
      : { recordId: value.recordId, relation: value.relation };
  });
}

export function checkImportance(value: unknown, what: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1)
    throw invalid(`${what} importance must be a number from 0 to 1.`);
  return value;
}

/**
 * The warning every versioned memory store logs when `pruneOperations`
 * deleted receipts (with `{ count, olderThan }`): those ids lose dedupe.
 */
export function pruneOperationsWarning(count: number): string {
  return (
    `Versioned memory: pruned ${count} operation receipt(s). Their operation ids no longer ` +
    'deduplicate: a redelivery of one of them is applied again.'
  );
}

export function checkTime(value: unknown, what: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value))
    throw invalid(`${what} must be a finite epoch-ms number.`);
  return value;
}

export function checkMetadata(value: unknown, what: string): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw invalid(`${what} metadata must be a plain object.`);
  return value as Record<string, unknown>;
}

/** `sha256:<hex>` of a revision's text (UTF-8): what its vector belongs to. */
export function textDigest(text: string): Promise<Sha256Digest> {
  return sha256Digest(text);
}

/** `sha256:<hex>` of a revision's canonical content: text, kind, origin, sources and links. */
export function recordDigest(
  record: Pick<VersionedMemoryRecord, 'text' | 'kind' | 'origin' | 'sources' | 'links'>,
): Promise<Sha256Digest> {
  return digestJson({
    text: record.text,
    kind: record.kind,
    origin: record.origin,
    sources: record.sources,
    ...(record.links !== undefined ? { links: record.links } : {}),
  });
}

/** A deep copy of plain JSON data: nothing a caller holds reaches stored state. */
export function copy<T>(value: T): T {
  return structuredClone(value);
}

/** Lower-case word tokens (letters and digits of any script). */
export function tokens(text: string): string[] {
  return text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

/**
 * A simple lexical relevance in 0..1: 1 when the record contains the whole
 * query, otherwise the share of distinct query words it contains.
 */
export function lexicalScore(query: string, text: string): number {
  const needle = query.trim().toLowerCase();
  if (!needle) return 0;
  const haystack = text.toLowerCase();
  if (haystack.includes(needle)) return 1;
  const wanted = [...new Set(tokens(needle))];
  if (wanted.length === 0) return 0;
  const have = new Set(tokens(haystack));
  return wanted.filter((word) => have.has(word)).length / wanted.length;
}

/** Runs async sections one at a time, in call order. */
export class Mutex {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(section: () => Promise<T>): Promise<T> {
    const result = this.tail.then(section, section);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

/** Throws the signal's reason when it was aborted. */
export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError');
}
