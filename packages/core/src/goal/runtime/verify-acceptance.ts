/**
 * Acceptance by evidence (2.4, spec §3.5): `verifyGoalAcceptance` runs the
 * host's verifiers and artifact resolvers and returns the `evaluate` command
 * that records their verdicts through `transitionGoal`. No parallel record:
 * the goal's own evidence and results stay the only truth. Edge-safe.
 */
import type { Sha256Digest } from '../../internal/digest';
import { notImplemented } from '../../internal/not-implemented';
import type {
  GoalCommand,
  GoalCriterion,
  GoalCriterionResultInput,
  GoalEvidenceInput,
  GoalRecord,
  GoalVerdict,
} from '../types';

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
  /** The run that produced the outputs. */
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
 */
export async function verifyGoalAcceptance(
  _input: VerifyGoalAcceptanceInput,
): Promise<GoalAcceptanceVerification> {
  return notImplemented('verifyGoalAcceptance');
}
