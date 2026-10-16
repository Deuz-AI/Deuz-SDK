/**
 * Acceptance by evidence (2.4, spec §3.5): `verifyGoalAcceptance` runs the
 * host's verifiers and artifact resolvers and returns the `evaluate` command
 * that records their verdicts through `transitionGoal`. No parallel record:
 * the goal's own evidence and results stay the only truth. Edge-safe.
 */
import { AbortError } from '../../errors';
import { canonicalJson, isSha256Digest, sha256Hex } from '../../internal/digest';
import type { Sha256Digest } from '../../internal/digest';
import { GoalError } from '../errors';
import type {
  GoalCommand,
  GoalCriterion,
  GoalCriterionResultInput,
  GoalEvidenceInput,
  GoalRecord,
  GoalVerdict,
} from '../types';
import { GoalChecker, VERDICTS, readGoal } from '../validate';

/** An artifact or workspace as a resolver finds it now. */
export interface ResolvedGoalArtifact {
  ref: string;
  kind: 'artifact' | 'workspace';
  /** Its current digest: `sha256:<hex>` (a workspace: the `deuz-workspace-v1` digest). */
  digest: Sha256Digest;
}

/** Resolves the refs a run recorded to what exists now. */
export interface GoalArtifactResolver {
  resolve(ref: string, signal?: AbortSignal): Promise<ResolvedGoalArtifact | undefined>;
}

/** A host verifier for one or more criteria; its id and version bind the evidence. */
export interface GoalVerifier {
  id: string;
  version: string;
  verify(input: {
    goal: GoalRecord;
    criterion: GoalCriterion;
    /** The resolved artifact or workspace the criterion is checked against. */
    artifact?: ResolvedGoalArtifact;
    runId?: string;
    signal?: AbortSignal;
  }): Promise<{ verdict: GoalVerdict; summary?: string }>;
}

/** Input of `verifyGoalAcceptance`. */
export interface VerifyGoalAcceptanceInput {
  goal: GoalRecord;
  /** The criteria to check; default every required one. */
  criteria?: readonly string[];
  /** The verifier per criterion id, or a function choosing one. */
  verifiers:
    | Readonly<Record<string, GoalVerifier>>
    | ((criterion: GoalCriterion) => GoalVerifier | undefined);
  /** The artifact or workspace ref each criterion is checked against. */
  artifacts?: Readonly<Record<string, { ref: string; expectedDigest?: Sha256Digest }>>;
  resolver?: GoalArtifactResolver;
  /** The run that produced the outputs; defaults to the goal's `runId`. */
  runId?: string;
  /** Evidence time, epoch ms (the injected clock). */
  now: number;
  signal?: AbortSignal;
}

/** What `verifyGoalAcceptance` found: apply `command` with `transitionGoal`. */
export interface GoalAcceptanceVerification {
  command: Extract<GoalCommand, { type: 'evaluate' }>;
  results: GoalCriterionResultInput[];
  evidence: GoalEvidenceInput[];
}

/**
 * Runs the verifiers (2.4). Each verdict's evidence is bound to the scope,
 * goal and criterion, the producing run, the artifact or workspace digest,
 * the verifier's id and version and the goal's `specGeneration`. A missing
 * verifier or artifact, an artifact that changed or whose digest differs from
 * `expectedDigest`, or a verifier that throws gives `'inconclusive'`, never
 * `'passed'`. Remembered facts, model claims and working-memory hypotheses
 * are never evidence by themselves.
 *
 * In detail, for each criterion in turn (`criteria`, deduplicated, or every
 * required one; a criterion the goal does not have throws `invalid_command`):
 *
 * - The producing run is `runId`, else the goal's `runId`. A criterion needs a
 *   verifier with a nonempty `id` and `version`, an `artifacts` entry and a
 *   `resolver`; without any of them the verdict is `'inconclusive'`.
 * - The artifact is resolved before the verifier runs and again after it. A
 *   ref that resolves to nothing or to a malformed digest, a resolver that
 *   throws, and a digest that differs between the two reads give
 *   `'inconclusive'`.
 * - The digest is checked against `expectedDigest`, else against the digest
 *   the producing run recorded for that ref in the goal's evidence (its latest
 *   non-model evidence naming the ref with a sha256 digest). A mismatch is a
 *   changed artifact and gives `'inconclusive'`.
 * - The verifier's verdict is recorded on evidence with `source: 'verifier'`,
 *   `artifactDigest` or `workspaceDigest` by the resolved kind (and `digest`,
 *   for 2.3 readers), `criterionId`, `runId`, `verifier`, `specGeneration`
 *   (when the goal has one) and its `summary`. The evidence id is
 *   `acceptance:` and the SHA-256 of what it binds and found, so verifying the
 *   same state again adds nothing.
 *
 * An `'inconclusive'` verdict for a missing or mismatched piece carries a note
 * saying which, and no evidence. Applying the command replaces the latest
 * verdict of each criterion checked. An aborted `signal` rejects with its
 * reason. Nothing is written: apply `command` with `transitionGoal` and save
 * the record. Malformed input throws: `GoalError` for the goal, `now` or
 * `criteria`, a TypeError for `verifiers` or an `expectedDigest`.
 */
export async function verifyGoalAcceptance(
  input: VerifyGoalAcceptanceInput,
): Promise<GoalAcceptanceVerification> {
  const now = new GoalChecker('invalid_command', 'acceptance verification').time(input?.now, 'now');
  const goal = readGoal(input.goal);
  const { verifiers, artifacts, signal } = input;
  if (typeof verifiers !== 'function' && (typeof verifiers !== 'object' || verifiers === null))
    throw new TypeError('verifyGoalAcceptance needs verifiers: a record or a function');
  for (const [criterionId, target] of Object.entries(artifacts ?? {}))
    if (target?.expectedDigest !== undefined && !isSha256Digest(target.expectedDigest))
      throw new TypeError(
        `The expectedDigest of ${criterionId} must be sha256: and 64 lower-case hex digits`,
      );
  const criteria = selectCriteria(goal, input.criteria);
  const runId = input.runId ?? goal.runId;
  const results: GoalCriterionResultInput[] = [];
  const evidence: GoalEvidenceInput[] = [];
  for (const criterion of criteria) {
    throwIfAborted(signal);
    const found = await check(goal, criterion, input, runId);
    if (typeof found === 'string') {
      results.push({
        criterionId: criterion.id,
        verdict: 'inconclusive',
        source: 'verifier',
        evidence: [],
        note: found,
        at: now,
      });
      continue;
    }
    const { verifier, artifact, verdict, summary } = found;
    const bound = { id: verifier.id, version: verifier.version };
    const id = `acceptance:${await sha256Hex(
      canonicalJson({
        scope: goal.scope,
        goalId: goal.goalId,
        criterionId: criterion.id,
        runId,
        ref: artifact.ref,
        kind: artifact.kind,
        digest: artifact.digest,
        verifier: bound,
        specGeneration: goal.specGeneration,
        verdict,
        summary,
      }),
    )}`;
    evidence.push({
      id,
      source: 'verifier',
      ref: artifact.ref,
      digest: artifact.digest,
      ...(summary !== undefined ? { summary } : {}),
      runId,
      at: now,
      criterionId: criterion.id,
      verifier: bound,
      ...(goal.specGeneration !== undefined ? { specGeneration: goal.specGeneration } : {}),
      ...(artifact.kind === 'workspace'
        ? { workspaceDigest: artifact.digest }
        : { artifactDigest: artifact.digest }),
    });
    results.push({
      criterionId: criterion.id,
      verdict,
      source: 'verifier',
      evidence: [id],
      at: now,
    });
  }
  return { command: { type: 'evaluate', results, evidence }, results, evidence };
}

/** A verdict the verifier reached on a stable artifact, or why there is none. */
interface Verified {
  verifier: GoalVerifier;
  artifact: ResolvedGoalArtifact;
  verdict: GoalVerdict;
  summary?: string;
}

async function check(
  goal: GoalRecord,
  criterion: GoalCriterion,
  input: VerifyGoalAcceptanceInput,
  runId: string | undefined,
): Promise<Verified | string> {
  const { verifiers, artifacts, resolver, signal } = input;
  const verifier =
    typeof verifiers === 'function'
      ? verifiers(criterion)
      : Object.hasOwn(verifiers, criterion.id)
        ? verifiers[criterion.id]
        : undefined;
  if (!isVerifier(verifier))
    return `No verifier with an id and a version checks criterion ${criterion.id}.`;
  if (runId === undefined)
    return 'No producing run is known: pass runId, or link the run to the goal.';
  const target =
    artifacts && Object.hasOwn(artifacts, criterion.id) ? artifacts[criterion.id] : undefined;
  if (target === undefined)
    return `No artifact or workspace is named for criterion ${criterion.id}.`;
  if (resolver === undefined) return `No resolver can find ${target.ref}.`;
  const before = await resolve(resolver, target.ref, signal);
  if (typeof before === 'string') return before;
  const expected = target.expectedDigest ?? recordedDigest(goal, target.ref, runId);
  if (expected !== undefined && expected !== before.digest)
    return `${target.ref} changed: expected ${expected}, found ${before.digest}.`;
  const name = `${verifier.id}@${verifier.version}`;
  let outcome: { verdict: GoalVerdict; summary?: string };
  try {
    outcome = await verifier.verify({
      goal,
      criterion,
      artifact: before,
      runId,
      ...(signal ? { signal } : {}),
    });
  } catch (error) {
    throwIfAborted(signal);
    return `Verifier ${name} failed: ${error instanceof Error ? error.message : String(error)}`;
  }
  throwIfAborted(signal);
  if (!VERDICTS.includes(outcome?.verdict)) return `Verifier ${name} returned no verdict.`;
  const after = await resolve(resolver, target.ref, signal);
  if (typeof after === 'string' || after.digest !== before.digest)
    return `${target.ref} changed while it was verified.`;
  const summary =
    typeof outcome.summary === 'string' && outcome.summary !== '' ? outcome.summary : undefined;
  return {
    verifier,
    artifact: before,
    verdict: outcome.verdict,
    ...(summary !== undefined ? { summary } : {}),
  };
}

function selectCriteria(goal: GoalRecord, ids: readonly string[] | undefined): GoalCriterion[] {
  if (ids === undefined) return goal.criteria.filter((criterion) => criterion.required !== false);
  if (!Array.isArray(ids))
    throw new GoalError('invalid_command', 'criteria must be an array of criterion ids.');
  const selected: GoalCriterion[] = [];
  for (const id of new Set(ids)) {
    const criterion = goal.criteria.find((item) => item.id === id);
    if (!criterion)
      throw new GoalError(
        'invalid_command',
        `Goal ${goal.goalId} has no criterion ${String(id)} to verify.`,
      );
    selected.push(criterion);
  }
  return selected;
}

function isVerifier(value: GoalVerifier | undefined): value is GoalVerifier {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof value.verify === 'function' &&
    typeof value.id === 'string' &&
    value.id !== '' &&
    typeof value.version === 'string' &&
    value.version !== ''
  );
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw signal.reason ?? new AbortError();
}

/** The artifact as it is now, or why it cannot be checked. */
async function resolve(
  resolver: GoalArtifactResolver,
  ref: string,
  signal: AbortSignal | undefined,
): Promise<ResolvedGoalArtifact | string> {
  let found: ResolvedGoalArtifact | undefined;
  try {
    found = await resolver.resolve(ref, signal);
  } catch (error) {
    throwIfAborted(signal);
    return `${ref} could not be resolved: ${error instanceof Error ? error.message : String(error)}`;
  }
  throwIfAborted(signal);
  if (found === undefined || found === null) return `${ref} was not found.`;
  if (
    typeof found !== 'object' ||
    (found.kind !== 'artifact' && found.kind !== 'workspace') ||
    !isSha256Digest(found.digest)
  )
    return `${ref} resolved to a malformed artifact: it needs a kind and a sha256 digest.`;
  return { ref, kind: found.kind, digest: found.digest };
}

/**
 * The digest the producing run recorded for `ref`: its latest non-model
 * evidence naming the ref with a sha256 digest. A model's claim is never one.
 */
function recordedDigest(goal: GoalRecord, ref: string, runId: string): Sha256Digest | undefined {
  for (let index = goal.evidence.length - 1; index >= 0; index--) {
    const item = goal.evidence[index]!;
    if (item.ref !== ref || item.runId !== runId || item.source === 'model') continue;
    const digest = item.artifactDigest ?? item.workspaceDigest ?? item.digest;
    if (isSha256Digest(digest)) return digest;
  }
  return undefined;
}
