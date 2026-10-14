/**
 * @internal Context package blobs of the V3 run record (2.4, spec §4.4),
 * shared by the three `AgentRunStoreV3` implementations and the V3 run path:
 *
 * - a compiled package is stored once, content-addressed: its content is the
 *   canonical JSON of its blocks and its digest the `sha256:` of that, so an
 *   unchanged package reused across steps is written once; the manifest stays
 *   in the run record;
 * - the blob is indexed by the memory records (and revisions) its blocks
 *   placed, so a `forget` finds every package that holds the forgotten text;
 * - a checkpointed step reads the identical package back, or learns that a
 *   forget redacted it (and compiles that step again: the one documented
 *   exception to "a resumed step uses the same context").
 *
 * The forget rule is here once: a record placed without a revision matches a
 * forget of any revision of its id, and a forget that names no revision
 * matches every revision. Edge-safe.
 */
import type { ContextBlock, ContextPackage } from './context/types';
import { canonicalJson, isSha256Digest, sha256Digest, type Sha256Digest } from './internal/digest';
import type { MemoryForgetEvent } from './memory/versioned/types';
import type {
  AgentRunContextStepV3,
  AgentRunEnvelopeV3,
  AgentRunStoreV3,
} from './types/agent-run-v3';

/** One memory record revision a blob holds; no `revision` when the source has none. */
export interface ContextBlobRecord {
  recordId: string;
  revision?: number;
}

/** What `AgentRunStoreV3.putBlob` takes, plus the byte size for the step's `ContextBlobRef`. */
export interface ContextPackageBlob {
  digest: Sha256Digest;
  content: string;
  bytes: number;
  records: ContextBlobRecord[];
}

/** A checkpointed step's package, read back. */
export type ContextPackageRead =
  | { status: 'found'; package: ContextPackage }
  /** A forget redacted it: compile the step again (refresh reason `'redacted'`). */
  | { status: 'redacted' }
  | { status: 'missing' };

const encoder = new TextEncoder();

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/**
 * The blob of a compiled package: the canonical JSON of its blocks, its
 * digest and byte size, and the memory records its blocks placed (each
 * revision once, in record order).
 */
export async function contextPackageBlob(pkg: ContextPackage): Promise<ContextPackageBlob> {
  const content = canonicalJson(pkg.blocks);
  const placed = new Set<number>(pkg.blocks.flatMap((block) => block.entries));
  const records = new Map<string, ContextBlobRecord>();
  pkg.manifest.entries.forEach((entry, index) => {
    if (entry.kind !== 'memory' || !(placed.has(index) || entry.selected)) return;
    const record: ContextBlobRecord =
      entry.revision === undefined
        ? { recordId: entry.recordId }
        : { recordId: entry.recordId, revision: entry.revision };
    records.set(JSON.stringify([record.recordId, record.revision ?? null]), record);
  });
  return {
    digest: await sha256Digest(content),
    content,
    bytes: encoder.encode(content).length,
    records: [...records.values()].sort(
      (left, right) =>
        (left.recordId < right.recordId ? -1 : left.recordId > right.recordId ? 1 : 0) ||
        (left.revision ?? -1) - (right.revision ?? -1),
    ),
  };
}

/**
 * Reads a checkpointed step's package back from the store: the blocks of its
 * blob with the step's manifest. Content that does not hash to the step's
 * digest throws: a store must never hand back another package.
 */
export async function readContextPackage(
  store: Pick<AgentRunStoreV3, 'getBlob'>,
  step: AgentRunContextStepV3,
): Promise<ContextPackageRead> {
  const read = await store.getBlob(step.blob.digest);
  if (read.status !== 'found') return { status: read.status };
  if ((await sha256Digest(read.content)) !== step.blob.digest)
    throw new Error(
      `The context package blob of step ${step.step} does not match its digest ${step.blob.digest}.`,
    );
  const blocks = JSON.parse(read.content) as ContextBlock[];
  return { status: 'found', package: { version: 1, blocks, manifest: step.manifest } };
}

/**
 * Checks what `putBlob` was given: a digest, string content that hashes to
 * it, and the record index. Throws a TypeError otherwise.
 */
export async function assertBlobInput(value: unknown): Promise<void> {
  if (!isObject(value) || !isSha256Digest(value.digest) || typeof value.content !== 'string')
    throw new TypeError('A context blob needs a sha256 digest and string content.');
  if (!Array.isArray(value.records))
    throw new TypeError('A context blob needs the list of memory records it holds.');
  for (const record of value.records)
    if (
      !isObject(record) ||
      typeof record.recordId !== 'string' ||
      !record.recordId ||
      (record.revision !== undefined && !isCount(record.revision))
    )
      throw new TypeError(
        'Every record of a context blob needs a recordId, and a revision that is a whole number.',
      );
  if ((await sha256Digest(value.content)) !== value.digest)
    throw new TypeError(`The context blob content does not match its digest ${value.digest}.`);
}

/** Checks a `MemoryForgetEvent` handed to `redactForgotten`. Throws a TypeError otherwise. */
export function assertForgetEvent(value: unknown): asserts value is MemoryForgetEvent {
  if (
    !isObject(value) ||
    typeof value.recordId !== 'string' ||
    !value.recordId ||
    !Array.isArray(value.revisions) ||
    !value.revisions.every(isCount)
  )
    throw new TypeError(
      'redactForgotten needs a forget event with a recordId and its revisions (whole numbers).',
    );
}

/** The tombstones of a forget: one per revision, or one for every revision when it names none. */
export function forgetTombstones(event: MemoryForgetEvent): ContextBlobRecord[] {
  if (event.revisions.length === 0) return [{ recordId: event.recordId }];
  return [...new Set(event.revisions)].map((revision) => ({ recordId: event.recordId, revision }));
}

/** Whether a blob's `record` is covered by a forget's `tombstone` (see the module rule). */
export function isForgotten(record: ContextBlobRecord, tombstone: ContextBlobRecord): boolean {
  return (
    record.recordId === tombstone.recordId &&
    (record.revision === undefined ||
      tombstone.revision === undefined ||
      record.revision === tombstone.revision)
  );
}

/**
 * Marks the manifest of every step whose package blob a forget redacted
 * (`redacted: true`), in place, as a store does when it loads a run. The mark
 * is read from the blobs at every load, never written by the redaction, so
 * it needs no save and never moves the run's revision.
 */
export function markRedactedSteps(
  envelope: AgentRunEnvelopeV3,
  redacted: ReadonlySet<Sha256Digest>,
): AgentRunEnvelopeV3 {
  if (redacted.size === 0) return envelope;
  for (const step of envelope.context?.steps ?? [])
    if (redacted.has(step.blob.digest)) step.manifest.redacted = true;
  return envelope;
}
