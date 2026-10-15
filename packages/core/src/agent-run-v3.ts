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
import { RevisionConflictError, UnsupportedStoreError } from './errors';
import { isSha256Digest, type Sha256Digest } from './internal/digest';
import { summarizeAgentRun } from './internal/agent-run-list';
import { assertRetentionTime } from './internal/ops-retention';
import { decodeSwarm, encodeSwarm } from './swarm/store';
import type { AgentRunSummary } from './types/agent-run';
import type {
  AgentRunEnvelopeV3,
  AgentRunMemoryIntentV3,
  AgentRunStoreV3,
} from './types/agent-run-v3';

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
    const first = step.firstAttempt;
    if (
      first !== undefined &&
      (!isObject(first) ||
        !isObject(first.manifest) ||
        typeof first.input !== 'string' ||
        !isObject(first.blob) ||
        !isSha256Digest(first.blob.digest) ||
        !isCount(first.blob.bytes))
    )
      throw invalid(
        `the first attempt of context step ${String(step.step)} needs a manifest, its input and a blob with a sha256 digest`,
      );
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
  next: { runId: string; revision?: number },
): void {
  const current = stored?.revision ?? 0;
  if (next.revision === current + 1) return;
  throw new RevisionConflictError({
    subsystem: 'run',
    key: next.runId,
    ...(next.revision !== undefined ? { expectedRevision: next.revision - 1 } : {}),
    ...(stored !== undefined ? { actualRevision: stored.revision } : {}),
    message: `Agent run revision conflict for ${next.runId}: expected ${current + 1}, got ${String(next.revision)}.`,
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

/** The argument of `AgentRunStoreV3.prune`, checked: returns its finite `terminalBefore`. */
export function assertPruneOptions(options: unknown): number {
  if (options === null || typeof options !== 'object')
    throw new TypeError('prune needs { terminalBefore }: epoch ms on the store clock.');
  return assertRetentionTime(
    (options as { terminalBefore?: unknown }).terminalBefore,
    'terminalBefore',
  );
}

/**
 * Every context package blob the run points to: its steps' packages (a
 * step's first attempt included), their manifests' blobs and the compiler's
 * last package. Retention keeps a blob
 * while one kept run points to it.
 */
export function agentRunV3BlobDigests(envelope: AgentRunEnvelopeV3): Sha256Digest[] {
  const digests = new Set<Sha256Digest>();
  for (const step of envelope.context?.steps ?? [])
    for (const recorded of step.firstAttempt ? [step, step.firstAttempt] : [step]) {
      digests.add(recorded.blob.digest);
      if (recorded.manifest.blob) digests.add(recorded.manifest.blob.digest);
    }
  const last = envelope.context?.compiler?.lastPackage;
  if (last) digests.add(last.digest);
  return [...digests];
}

/**
 * Where a run store keeps its runs, when that decides what it may hold: the
 * Redis ops store sets `'redis'` on its `agentRuns`. Registered with
 * `Symbol.for`, so a second copy of the SDK in one process reads the same
 * brand. Not enumerable, so it never reaches a spread or JSON.
 */
export const AGENT_RUN_STORE_BACKEND: unique symbol = Symbol.for(
  '@deuz-sdk/core/AgentRunStoreBackend',
);

/** Brands `store` with the backend it runs on (idempotent) and returns it. */
export function markAgentRunStoreBackend<S extends object>(store: S, backend: string): S {
  Object.defineProperty(store, AGENT_RUN_STORE_BACKEND, {
    value: backend,
    enumerable: false,
    configurable: true,
    writable: false,
  });
  return store;
}

const STORE_V3_METHODS = [
  'load',
  'save',
  'list',
  'putBlob',
  'getBlob',
  'redactForgotten',
  'prune',
] as const;

/**
 * The configuration-time check of a `checkpointVersion: 3` session (spec
 * §4.1), before anything is read or written: a Redis run store is refused
 * with `UnsupportedStoreError` (2.4 has no Redis V3 store), any other store
 * that is not an `AgentRunStoreV3` (a 2.3 `AgentRunStore`) with a TypeError.
 */
export function assertAgentRunStoreV3(store: unknown): asserts store is AgentRunStoreV3 {
  const record =
    store !== null && (typeof store === 'object' || typeof store === 'function')
      ? (store as Record<string | symbol, unknown>)
      : undefined;
  if (record?.[AGENT_RUN_STORE_BACKEND] === 'redis')
    throw new UnsupportedStoreError({
      backend: 'redis',
      feature: 'agent-run-v3',
      message:
        'checkpointVersion 3 cannot run on a Redis AgentRunStore: Redis has no V3 run store in 2.4. ' +
        'Use createInMemoryAgentRunStoreV3, createSqliteAgentRunStoreV3 or createPostgresAgentRunStoreV3.',
    });
  if (
    record?.checkpointVersion !== 3 ||
    STORE_V3_METHODS.some((method) => typeof record[method] !== 'function')
  )
    throw new TypeError(
      'checkpointVersion 3 needs an AgentRunStoreV3 (createInMemoryAgentRunStoreV3, ' +
        'createSqliteAgentRunStoreV3 or createPostgresAgentRunStoreV3): a 2.3 AgentRunStore keeps ' +
        'version 1 and 2 runs only.',
    );
}
