/**
 * @internal Context package blobs of the V3 run record (2.4, spec §4.4),
 * shared by the three `AgentRunStoreV3` implementations and the V3 run path
 * (the run alone writes and reads packages: `agent-run-v3-package.ts`, which
 * only its lazy chunk loads):
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
import { isSha256Digest, sha256Digest, type Sha256Digest } from './internal/digest';
import type { MemoryForgetEvent } from './memory/versioned/types';
import type { AgentRunEnvelopeV3 } from './types/agent-run-v3';

/** One memory record revision a blob holds; no `revision` when the source has none. */
export interface ContextBlobRecord {
  recordId: string;
  revision?: number;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
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
  for (const step of envelope.context?.steps ?? []) {
    if (redacted.has(step.blob.digest)) step.manifest.redacted = true;
    if (step.firstAttempt && redacted.has(step.firstAttempt.blob.digest))
      step.firstAttempt.manifest.redacted = true;
  }
  return envelope;
}
