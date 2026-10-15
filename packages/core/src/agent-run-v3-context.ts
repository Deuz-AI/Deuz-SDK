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
 *   exception to "a resumed step uses the same context");
 * - the copies of a redacted package's retrieval block that a run stored
 *   (history, checkpoints, result messages) become content-free stand-ins
 *   that keep the block's marker (`redactRetrievalBlocks`), on the forget and
 *   on every later save of the run.
 *
 * The forget rule is here once: a record placed without a revision matches a
 * forget of any revision of its id, and a forget that names no revision
 * matches every revision. Edge-safe.
 */
import { decodeAgentRunEnvelopeV3, encodeAgentRunEnvelopeV3 } from './agent-run-v3';
import { messageText, RETRIEVAL_CLOSING } from './context/render';
import type { ContextBlock, ContextPackage } from './context/types';
import { canonicalJson, isSha256Digest, sha256Digest, type Sha256Digest } from './internal/digest';
import type { MemoryForgetEvent } from './memory/versioned/types';
import type {
  AgentRunContextStepV3,
  AgentRunEnvelopeV3,
  AgentRunStoreV3,
} from './types/agent-run-v3';
import type { Message } from './types/message';

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

/** The text of a redacted block's stand-in. */
const REDACTED_BLOCK_NOTE =
  'Removed: a memory record this reference data held was forgotten. Nothing of it is kept.';

/** The marker that opens the retrieval block of `pass` a package appended at model step `step`. */
export function retrievalBlockMarker(pass: number, step: number): string {
  return `<deuz_context pass="${pass}" step="${step}">`;
}

/** What stands in for a redacted retrieval block: its marker and closing, no record. */
export function redactedRetrievalBlock(marker: string): string {
  return `${marker}\n${REDACTED_BLOCK_NOTE}\n${RETRIEVAL_CLOSING}`;
}

/**
 * The markers of the retrieval blocks whose package a forget redacted: one
 * per step that appended its package's retrieval to the history
 * (`placement.append`) and whose blob is in `redacted`.
 */
export function redactedBlockMarkers(
  envelope: AgentRunEnvelopeV3,
  redacted: ReadonlySet<Sha256Digest>,
): string[] {
  const markers = new Set<string>();
  if (redacted.size === 0) return [];
  for (const step of envelope.context?.steps ?? [])
    if (step.manifest.placement?.append && redacted.has(step.blob.digest))
      markers.add(retrievalBlockMarker(step.manifest.pass, step.manifest.step));
  return [...markers];
}

/** Whether `message` is the retrieval block one of `markers` opens (a stand-in included). */
export function isBlockOf(message: Message, markers: readonly string[]): string | undefined {
  if (message.role !== 'user' || markers.length === 0) return undefined;
  const text = messageText(message).trimStart();
  return markers.find((marker) => text.startsWith(marker));
}

/**
 * Replaces, in place, every stored copy of a redacted retrieval block (spec
 * §4.4): in the run's history, in every checkpoint and in the stored
 * result's messages (a terminal run's `result.messages` included). Each copy
 * becomes `redactedRetrievalBlock(marker)`, the same message with no record
 * left in it: the history keeps its length, roles and order, and a resumed
 * run still finds the marker, drops the block and compiles the step again
 * (the one documented exception). Idempotent; returns whether anything
 * changed. The run's revision is the caller's to keep.
 *
 * Only blocks the compiler wrote are found. Text the model wrote from a
 * block (its answers, a compaction summary) and a memory tool's results are
 * not retrieval blocks and stay as they are.
 */
export function redactRetrievalBlocks(
  envelope: AgentRunEnvelopeV3,
  redacted: ReadonlySet<Sha256Digest>,
): boolean {
  const markers = redactedBlockMarkers(envelope, redacted);
  if (markers.length === 0) return false;
  let changed = false;
  const scrub = (messages: Message[]): Message[] =>
    messages.map((message) => {
      const marker = isBlockOf(message, markers);
      if (marker === undefined) return message;
      const standIn = redactedRetrievalBlock(marker);
      if (message.content === standIn) return message;
      changed = true;
      return { ...message, content: standIn } as Message;
    });
  envelope.messages = scrub(envelope.messages);
  for (const checkpoint of Object.values(envelope.checkpoints))
    if (Array.isArray(checkpoint?.messages)) checkpoint.messages = scrub(checkpoint.messages);
  if (envelope.result && Array.isArray(envelope.result.messages))
    envelope.result.messages = scrub(envelope.result.messages);
  return changed;
}

/**
 * The encoded envelope a store keeps (`payload`), with every retrieval block
 * of a package in `redacted` replaced (`redactRetrievalBlocks`); `payload`
 * itself when nothing changes. For a save after a forget and for the
 * rewrite of stored runs on `redactForgotten`.
 */
export function redactedPayload(payload: string, redacted: ReadonlySet<Sha256Digest>): string {
  if (redacted.size === 0) return payload;
  const envelope = decodeAgentRunEnvelopeV3(payload);
  return redactRetrievalBlocks(envelope, redacted) ? encodeAgentRunEnvelopeV3(envelope) : payload;
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
