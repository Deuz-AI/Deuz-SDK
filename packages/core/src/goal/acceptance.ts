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

/**
 * Whether a `passed` verdict stands: reached by something other than the
 * working model, on at least one piece of evidence that is not the model's
 * own claim.
 */
export function supportsPass(
  result: Pick<GoalCriterionResult, 'source' | 'evidence'>,
  evidence: readonly GoalEvidence[],
): boolean {
  if (result.source === 'model') return false;
  const byId = new Map(evidence.map((item) => [item.id, item]));
  return result.evidence.some((id) => {
    const item = byId.get(id);
    return item !== undefined && item.source !== 'model';
  });
}

/**
 * Where a goal's acceptance stands (2.3): each criterion's latest verdict,
 * and overall `'passed'` once every required criterion passed on evidence,
 * `'failed'` while a required criterion failed, `'inconclusive'` otherwise.
 * A `passed` verdict that rests only on the model counts as inconclusive.
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
      result.verdict === 'passed' && !supportsPass(result, goal.evidence)
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
