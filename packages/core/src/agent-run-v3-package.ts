/**
 * @internal The compiled context packages of a V3 run (2.4, spec §4.4): the
 * blob a package is stored as, and a checkpointed step's package read back.
 * Only the V3 run (`agent-run-v3-run.ts`, loaded on demand) writes and reads
 * packages, so this module stays out of the eager bundles that reach the V3
 * stores (`/edge`, `/agent`). The forget rule and the stores' checks are in
 * `agent-run-v3-context.ts`. Edge-safe.
 */
import type { ContextBlobRecord } from './agent-run-v3-context';
import type { ContextBlock, ContextPackage } from './context/types';
import { canonicalJson, sha256Digest, type Sha256Digest } from './internal/digest';
import type { AgentRunContextStepV3, AgentRunStoreV3 } from './types/agent-run-v3';

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
