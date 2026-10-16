/**
 * What the process operation stores share (2.4): the state sets, record
 * copies and updates, the list order and its cursor, and the request digest.
 * The in-memory and SQLite stores apply the same rules, so they answer the
 * same contract.
 */
import { OperationConflictError } from '../../errors';
import { compareDigestPaths, isSha256Digest } from '../../internal/digest';
import type { ProcessOperationQuery, ProcessOperationRecord, ProcessState } from './types';

/** Every state a record can hold. */
export const PROCESS_STATES: readonly ProcessState[] = [
  'recorded',
  'created',
  'staged',
  'start-dispatched',
  'running',
  'exited',
  'cancel-requested',
  'cancelled',
  'needs-reconcile',
  'lost',
  'failed',
  'disposed',
];

/** The states nothing moves on from; only these are pruned. */
export const TERMINAL_PROCESS_STATES: ReadonlySet<ProcessState> = new Set<ProcessState>([
  'exited',
  'cancelled',
  'lost',
  'failed',
  'disposed',
]);

export type NewProcessOperationRecord = Omit<
  ProcessOperationRecord,
  'revision' | 'createdAt' | 'updatedAt'
>;

export type ProcessOperationChanges = Partial<
  Omit<ProcessOperationRecord, 'operationId' | 'scope' | 'revision'>
>;

/** A deep copy: records are plain JSON data. */
export function cloneRecord(record: ProcessOperationRecord): ProcessOperationRecord {
  return structuredClone(record);
}

/** Checks what `create` was given; a malformed record is a TypeError. */
export function assertNewRecord(record: NewProcessOperationRecord): void {
  if (typeof record.operationId !== 'string' || record.operationId === '')
    throw new TypeError('A process operation needs a non-empty operationId');
  if (typeof record.scope !== 'string' || record.scope === '')
    throw new TypeError('A process operation needs a non-empty scope');
  if (!PROCESS_STATES.includes(record.state))
    throw new TypeError(`Unknown process state ${JSON.stringify(record.state)}`);
  if (!isSha256Digest(record.requestDigest))
    throw new TypeError('A process operation needs a sha256:<hex> requestDigest');
  if (record.durableTimeout !== false) throw new TypeError('durableTimeout is always false');
  if (!record.request || !Array.isArray(record.request.command))
    throw new TypeError('A process operation needs its request summary');
}

/** The conflict a create answers when the id was used with another request. */
export function operationConflict(
  stored: ProcessOperationRecord,
  requestDigest: string,
): OperationConflictError {
  return new OperationConflictError({
    subsystem: 'process',
    operationId: stored.operationId,
    storedDigest: stored.requestDigest,
    requestDigest,
  });
}

/** A new stored record: revision 1, both timestamps `now`. */
export function initialRecord(
  record: NewProcessOperationRecord,
  now: number,
): ProcessOperationRecord {
  return structuredClone({ ...record, revision: 1, createdAt: now, updatedAt: now });
}

/**
 * `record` with `changes` applied, one revision on, `updatedAt` = `now`. An own
 * key set to `undefined` removes that field; the identity, the revision and
 * `createdAt` never change through an update.
 */
export function applyChanges(
  record: ProcessOperationRecord,
  changes: ProcessOperationChanges,
  now: number,
): ProcessOperationRecord {
  const next: Record<string, unknown> = { ...record };
  for (const [key, value] of Object.entries(changes)) {
    if (
      key === 'operationId' ||
      key === 'scope' ||
      key === 'revision' ||
      key === 'createdAt' ||
      key === 'updatedAt'
    )
      continue;
    if (value === undefined) delete next[key];
    else next[key] = value;
  }
  next.revision = record.revision + 1;
  next.updatedAt = now;
  return structuredClone(next) as unknown as ProcessOperationRecord;
}

/** The list order: oldest first, then scope, then id, both in UTF-8 byte order. */
export function compareRecords(
  left: Pick<ProcessOperationRecord, 'createdAt' | 'scope' | 'operationId'>,
  right: Pick<ProcessOperationRecord, 'createdAt' | 'scope' | 'operationId'>,
): number {
  return (
    left.createdAt - right.createdAt ||
    compareDigestPaths(left.scope, right.scope) ||
    compareDigestPaths(left.operationId, right.operationId)
  );
}

/** Where a page ends: the last record's sort key. */
export interface ProcessOperationCursor {
  createdAt: number;
  scope: string;
  operationId: string;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function base64url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function encodeCursor(record: ProcessOperationCursor): string {
  return base64url(
    encoder.encode(JSON.stringify([record.createdAt, record.scope, record.operationId])),
  );
}

export function decodeCursor(cursor: string): ProcessOperationCursor {
  const invalid = () => new TypeError('Invalid process operation cursor');
  if (typeof cursor !== 'string' || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw invalid();
  let value: unknown;
  try {
    const binary = atob(cursor.replace(/-/g, '+').replace(/_/g, '/'));
    value = JSON.parse(decoder.decode(Uint8Array.from(binary, (char) => char.charCodeAt(0))));
  } catch {
    throw invalid();
  }
  if (
    !Array.isArray(value) ||
    value.length !== 3 ||
    !Number.isSafeInteger(value[0]) ||
    typeof value[1] !== 'string' ||
    typeof value[2] !== 'string'
  )
    throw invalid();
  return { createdAt: value[0] as number, scope: value[1], operationId: value[2] };
}

/**
 * `prune`'s argument, checked before anything is deleted: returns its
 * `terminalBefore`, a finite epoch-ms time on the store clock. A TypeError
 * otherwise, as the other 2.4 stores' `prune({ terminalBefore })` throw.
 */
export function checkTerminalBefore(options: unknown): number {
  const value = (options as { terminalBefore?: unknown } | null | undefined)?.terminalBefore;
  if (typeof value !== 'number' || !Number.isFinite(value))
    throw new TypeError(
      'prune needs { terminalBefore }: a finite epoch-ms time on the store clock.',
    );
  return value;
}

/** A validated query: limit 1..1000 (default 100), states known, cursor decoded. */
export interface ResolvedProcessQuery {
  scope?: string;
  states?: readonly ProcessState[];
  limit: number;
  after?: ProcessOperationCursor;
}

export function resolveQuery(query: ProcessOperationQuery = {}): ResolvedProcessQuery {
  const limit = query.limit ?? 100;
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000)
    throw new RangeError(`A process operation list limit is 1..1000, got ${limit}`);
  for (const state of query.states ?? [])
    if (!PROCESS_STATES.includes(state))
      throw new TypeError(`Unknown process state ${JSON.stringify(state)}`);
  return {
    ...(query.scope !== undefined ? { scope: query.scope } : {}),
    ...(query.states !== undefined ? { states: query.states } : {}),
    limit,
    ...(query.cursor !== undefined ? { after: decodeCursor(query.cursor) } : {}),
  };
}

/** One page of `sorted` records past the cursor; the cursor is set only when more remain. */
export function pageRecords(
  sorted: readonly ProcessOperationRecord[],
  query: ResolvedProcessQuery,
): { records: ProcessOperationRecord[]; cursor?: string } {
  const matching = sorted.filter(
    (record) =>
      (query.scope === undefined || record.scope === query.scope) &&
      (query.states === undefined || query.states.includes(record.state)) &&
      (query.after === undefined || compareRecords(record, query.after) > 0),
  );
  const records = matching.slice(0, query.limit).map(cloneRecord);
  const last = records[records.length - 1];
  return matching.length > query.limit && last
    ? { records, cursor: encodeCursor(last) }
    : { records };
}
