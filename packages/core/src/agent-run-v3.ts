/**
 * @internal The V3 native run record's rules (2.4, spec §4.1), shared by the
 * three `AgentRunStoreV3` implementations and the V3 run path:
 *
 * - a V3 envelope is `kind: 'deuz-agent-run'`, `version: 3`, always fenced
 *   (revision 1 and up), and is never encoded, decoded or saved as anything
 *   else: a V3 record is never written back as version 1 or 2;
 * - it is encoded as a 2.3 envelope is (JSON, `Uint8Array` kept), so what the
 *   memory store accepts the SQL stores accept too;
 * - a save must carry the stored revision plus one, else
 *   `RevisionConflictError` on the `'run'` subsystem.
 *
 * Edge-safe.
 */
import { RevisionConflictError } from './errors';
import { isSha256Digest, type Sha256Digest } from './internal/digest';
import { summarizeAgentRun } from './internal/agent-run-list';
import { decodeSwarm, encodeSwarm } from './swarm/store';
import type { AgentRunSummary } from './types/agent-run';
import type { AgentRunEnvelopeV3, AgentRunMemoryIntentV3 } from './types/agent-run-v3';

const PHASES: readonly string[] = ['running', 'finalizing', 'terminal'];
const INTENT_STATUSES: readonly AgentRunMemoryIntentV3['status'][] = [
  'intended',
  'planned',
  'committed',
  'acknowledged',
];
const EXTRACTION_STATUSES: readonly string[] = ['pending', 'completed', 'partial', 'failed'];

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function invalid(message: string): TypeError {
  return new TypeError(`Invalid V3 native run envelope: ${message}`);
}

function assertContext(context: unknown): void {
  if (!isObject(context) || !Array.isArray(context.steps))
    throw invalid('context must be an object with a steps list');
  for (const step of context.steps) {
    if (!isObject(step) || !isCount(step.step) || !isObject(step.manifest))
      throw invalid('every context step needs a step number and a manifest');
    const blob = step.blob;
    if (!isObject(blob) || !isSha256Digest(blob.digest) || !isCount(blob.bytes))
      throw invalid(`context step ${String(step.step)} needs a blob with a sha256 digest`);
  }
  if (context.compiler !== undefined) {
    const compiler = context.compiler;
    if (!isObject(compiler) || compiler.version !== 1 || !Array.isArray(compiler.placed))
      throw invalid('the context compiler state must be version 1');
  }
}

function assertWorkingMemory(snapshot: unknown): void {
  if (
    !isObject(snapshot) ||
    snapshot.kind !== 'deuz-working-memory' ||
    snapshot.version !== 1 ||
    !isCount(snapshot.revision) ||
    typeof snapshot.scope !== 'string'
  )
    throw invalid('the working memory must be a deuz-working-memory snapshot, version 1');
}

function assertMemoryIntents(intents: unknown): void {
  if (!Array.isArray(intents)) throw invalid('memoryIntents must be a list');
  for (const intent of intents)
    if (
      !isObject(intent) ||
      typeof intent.operationId !== 'string' ||
      !intent.operationId ||
      !INTENT_STATUSES.includes(intent.status as AgentRunMemoryIntentV3['status'])
    )
      throw invalid('every memory intent needs an operationId and a known status');
}

/**
 * Throws a TypeError unless `value` is a V3 envelope: the identity, the
 * revision fence and the V3 parts (context steps and their blobs, working
 * memory, memory intents, extraction status). The 2.3 parts are checked as
 * far as a store needs them; the executor checks the rest on resume.
 */
export function assertAgentRunEnvelopeV3(value: unknown): asserts value is AgentRunEnvelopeV3 {
  if (!isObject(value)) throw invalid('expected an object');
  if (value.kind !== 'deuz-agent-run')
    throw invalid(`kind must be 'deuz-agent-run', got ${JSON.stringify(value.kind)}`);
  if (value.version !== 3)
    throw invalid(
      `a V3 run record is version 3, got ${JSON.stringify(value.version)}; it is never written as version 1 or 2`,
    );
  if (typeof value.runId !== 'string' || !value.runId) throw invalid('runId must be non-empty');
  if (typeof value.scope !== 'string') throw invalid('scope must be a string');
  if (
    typeof value.revision !== 'number' ||
    !Number.isSafeInteger(value.revision) ||
    value.revision < 1
  )
    throw invalid('revision must be an integer of at least 1');
  if (!PHASES.includes(value.phase as string))
    throw invalid(`unknown phase ${JSON.stringify(value.phase)}`);
  if (!Array.isArray(value.messages)) throw invalid('messages must be a list');
  if (!isObject(value.checkpoints)) throw invalid('checkpoints must be an object');
  if (value.context !== undefined) assertContext(value.context);
  if (value.workingMemory !== undefined) assertWorkingMemory(value.workingMemory);
  if (value.memoryIntents !== undefined) assertMemoryIntents(value.memoryIntents);
  if (value.memory !== undefined) {
    if (!isObject(value.memory)) throw invalid('memory must be an object');
    const extraction = value.memory.extraction;
    if (
      extraction !== undefined &&
      (!isObject(extraction) || !EXTRACTION_STATUSES.includes(extraction.status as string))
    )
      throw invalid('unknown memory extraction status');
  }
}

/** Whether `value` is a V3 envelope (`assertAgentRunEnvelopeV3` passes). */
export function isAgentRunEnvelopeV3(value: unknown): value is AgentRunEnvelopeV3 {
  try {
    assertAgentRunEnvelopeV3(value);
    return true;
  } catch {
    return false;
  }
}

/**
 * The stored form of a V3 envelope: checked, then encoded as a 2.3 envelope
 * is. Throws for anything that is not a V3 envelope or that JSON would
 * change (a non-finite number, a class instance).
 */
export function encodeAgentRunEnvelopeV3(envelope: AgentRunEnvelopeV3): string {
  assertAgentRunEnvelopeV3(envelope);
  return encodeSwarm(envelope);
}

/** Reads a stored V3 envelope back; a payload that is not one throws. */
export function decodeAgentRunEnvelopeV3(payload: string): AgentRunEnvelopeV3 {
  const envelope = decodeSwarm<unknown>(payload);
  assertAgentRunEnvelopeV3(envelope);
  return envelope;
}

/**
 * The V3 fence: a new run is saved at revision 1, a stored one at its
 * revision plus one. Anything else is a `RevisionConflictError` on the run,
 * with the revision the writer expected to find (`revision - 1`) and the
 * stored one (absent for an unknown run).
 */
export function assertEnvelopeRevisionV3(
  stored: { revision: number } | undefined,
  next: { runId: string; revision: number },
): void {
  const current = stored?.revision ?? 0;
  if (next.revision === current + 1) return;
  throw new RevisionConflictError({
    subsystem: 'run',
    key: next.runId,
    expectedRevision: next.revision - 1,
    ...(stored !== undefined ? { actualRevision: stored.revision } : {}),
    message: `Agent run revision conflict for ${next.runId}: expected ${current + 1}, got ${next.revision}.`,
  });
}

/** A V3 run's listing summary, as `AgentRunStore.list` gives a 2.3 one. */
export function summarizeAgentRunEnvelopeV3(
  envelope: AgentRunEnvelopeV3,
  updatedAt: number,
): AgentRunSummary {
  return summarizeAgentRun({
    runId: envelope.runId,
    scope: envelope.scope,
    revision: envelope.revision,
    updatedAt,
    phase: envelope.phase,
    status: envelope.result?.status,
  });
}

/**
 * Every context package blob the run points to: its steps' packages, their
 * manifests' blobs and the compiler's last package. Retention keeps a blob
 * while one kept run points to it.
 */
export function agentRunV3BlobDigests(envelope: AgentRunEnvelopeV3): Sha256Digest[] {
  const digests = new Set<Sha256Digest>();
  for (const step of envelope.context?.steps ?? []) {
    digests.add(step.blob.digest);
    if (step.manifest.blob) digests.add(step.manifest.blob.digest);
  }
  const last = envelope.context?.compiler?.lastPackage;
  if (last) digests.add(last.digest);
  return [...digests];
}
