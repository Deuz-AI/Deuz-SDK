/**
 * Acceptance (2.3): whether a goal is done is decided by its criteria and the
 * evidence their verdicts rest on, never by a model saying it is done.
 */
import type {
  GoalAcceptance,
  GoalCriterionAcceptance,
  GoalCriterionResult,
  GoalEvidence,
  GoalRecord,
} from './types';
import { readGoal } from './validate';

/** The note a `passed` verdict carries once it is recorded as inconclusive. */
export const UNSUPPORTED_PASS =
  'A passed verdict needs a source other than the model and evidence from outside the model.';

/** The note of a `passed` verdict whose outside evidence is all for other criteria (2.4). */
export const OTHER_CRITERION_PASS = 'A passed verdict needs evidence produced for its criterion.';

/** The note of a `passed` verdict whose outside evidence is all of older spec generations (2.4). */
export const STALE_PASS = 'A passed verdict needs evidence of the current spec generation.';

/**
 * Why a `passed` verdict does not stand, if it does not: it needs a source
 * other than the working model and at least one piece of evidence that is
 * not the model's own claim (2.3). That evidence must be for the verdict's
 * criterion when it names one, and on a goal with a `specGeneration`, of
 * the current generation (2.4).
 */
export function passProblem(
  result: Pick<GoalCriterionResult, 'criterionId' | 'source' | 'evidence'>,
  evidence: readonly GoalEvidence[],
  specGeneration?: number,
): string | undefined {
  if (result.source === 'model') return UNSUPPORTED_PASS;
  const byId = new Map(evidence.map((item) => [item.id, item]));
  const outside = result.evidence
    .map((id) => byId.get(id))
    .filter((item): item is GoalEvidence => item !== undefined && item.source !== 'model');
  if (outside.length === 0) return UNSUPPORTED_PASS;
  const own = outside.filter(
    (item) => item.criterionId === undefined || item.criterionId === result.criterionId,
  );
  if (own.length === 0) return OTHER_CRITERION_PASS;
  if (specGeneration !== undefined && !own.some((item) => item.specGeneration === specGeneration))
    return STALE_PASS;
  return undefined;
}

/** Whether a `passed` verdict stands; see `passProblem`. */
export function supportsPass(
  result: Pick<GoalCriterionResult, 'criterionId' | 'source' | 'evidence'>,
  evidence: readonly GoalEvidence[],
  specGeneration?: number,
): boolean {
  return passProblem(result, evidence, specGeneration) === undefined;
}

/**
 * Where a goal's acceptance stands (2.3): each criterion's latest verdict,
 * and overall `'passed'` once every required criterion passed on evidence,
 * `'failed'` while a required criterion failed, `'inconclusive'` otherwise.
 * A `passed` verdict that rests only on the model counts as inconclusive, and
 * so does one whose evidence is for another criterion or, on a goal with a
 * `specGeneration`, of another generation (2.4).
 */
export function assessGoal(record: GoalRecord): GoalAcceptance {
  const goal = readGoal(record);
  const latest = new Map(goal.results.map((result) => [result.criterionId, result]));
  const criteria = goal.criteria.map((criterion): GoalCriterionAcceptance => {
    const required = criterion.required !== false;
    const result = latest.get(criterion.id);
    if (!result)
      return { criterionId: criterion.id, required, verdict: 'inconclusive', evidence: [] };
    const verdict =
      result.verdict === 'passed' && !supportsPass(result, goal.evidence, goal.specGeneration)
        ? 'inconclusive'
        : result.verdict;
    return {
      criterionId: criterion.id,
      required,
      verdict,
      source: result.source,
      evidence: [...result.evidence],
      ...(result.note !== undefined ? { note: result.note } : {}),
    };
  });
  const required = criteria.filter((criterion) => criterion.required);
  const verdict = required.some((criterion) => criterion.verdict === 'failed')
    ? 'failed'
    : required.every((criterion) => criterion.verdict === 'passed')
      ? 'passed'
      : 'inconclusive';
  return { verdict, criteria };
}
