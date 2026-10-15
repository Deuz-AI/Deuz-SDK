/**
 * `@deuz-sdk/core/skills/learning` (2.4, experimental, spec §2.6): a skill
 * candidate from a verified run. `proposeSkillFromRun` turns a terminal,
 * completed and verified run into a sourced `SKILL.md` draft whose status is
 * always `'proposed'` and evaluation `'not-evaluated'`: the condition is about
 * the source task, never a claim that the skill works. It writes no file,
 * changes no registry, never evaluates or activates a skill; storing the
 * draft is the host's. A repeated call may cost again: there is no
 * exactly-once or single-candidate guarantee. Edge-safe.
 */
import type { Sha256Digest } from '../../internal/digest';
import type { SkillManifest } from '../../skills';
import type { AgentRunEnvelope } from '../../types/agent-run';
import type { AgentRunEnvelopeV3 } from '../../types/agent-run-v3';
import type { Dependencies } from '../../types/deps';
import type { BudgetLimits } from '../../types/execution';
import type { LanguageModel } from '../../types/model';
import type { Usage } from '../../types/usage';
import { DeuzError } from '../../errors';
import { resolveDependencies } from '../../internal/resolve-deps';
import { callProposalModel } from './call';
import { acceptDraft, InvalidDraftError, parseDraft, proposalMessages } from './draft';
import { projectRun } from './projection';

/** A reference into the source run that a method step rests on. */
export interface SkillSourceRef {
  runId: string;
  /** The model step the content came from. */
  modelStep?: number;
  /** The message (stable id) or tool call it came from. */
  messageId?: string;
  toolCallId?: string;
  /** `sha256:<hex>` of the projected content the step cites. */
  digest: Sha256Digest;
}

/** One step of the proposed method; every step cites a valid source reference. */
export interface SkillProposalStep {
  text: string;
  sources: SkillSourceRef[];
}

/** What the proposal call cost, apart from the source run's closed accounting. */
export interface SkillProposalCost {
  modelId: string;
  usage: Usage;
  /** Absent when the model has no price. */
  costUsd?: number;
}

/** A skill candidate (2.4, experimental). Plain JSON; inert until a host acts on it. */
export interface SkillProposal {
  kind: 'deuz-skill-proposal';
  version: 1;
  status: 'proposed';
  evaluation: 'not-evaluated';
  /**
   * The `SKILL.md` text. It passes `parseSkill`: a name matching
   * `^[a-z0-9-]{1,64}$` without "anthropic" or "claude", a description of at
   * most 1024 characters.
   */
  skillMd: string;
  manifest: SkillManifest;
  steps: SkillProposalStep[];
  limitations: string[];
  /**
   * Suggested `allowed-tools`: always a subset of the tools the source run
   * really used. The model can never add a tool permission.
   */
  allowedTools?: string[];
  /** The source run: its id, scope, revision at the time, and the projection's digest. */
  source: { runId: string; scope: string; revision: number; digest: Sha256Digest };
  cost: SkillProposalCost;
  createdAt: number;
}

/** Options of `proposeSkillFromRun`. */
export interface ProposeSkillFromRunOptions {
  /** The source run: terminal, completed, with `verification: 'verified'`. */
  run: AgentRunEnvelope | AgentRunEnvelopeV3;
  model: LanguageModel;
  /** Mandatory: the proposal's own budget, separate from the source run's. */
  budget: BudgetLimits;
  /**
   * Host summaries of chosen tool results, by tool call id. Raw tool results
   * never go to the model by default.
   */
  toolSummaries?: Readonly<Record<string, string>>;
  /** Output tokens at most. Default 2048. */
  maxOutputTokens?: number;
  /** Characters of source projection at most. Default 32 000; more is refused, never cut. */
  maxSourceChars?: number;
  /** Extra instructions for the proposal. */
  instructions?: string;
  signal?: AbortSignal;
  deps?: Dependencies;
}

/** Why a proposal was refused. */
export type SkillLearningErrorCode =
  /** The run is not terminal, completed and verified. */
  | 'source_not_eligible'
  /** The source projection exceeds `maxSourceChars`. */
  | 'source_too_large'
  /** The model's draft fails `parseSkill`, cites no valid source, or adds a tool. */
  | 'invalid_proposal';

/** A refused skill proposal (2.4, experimental). */
export class SkillLearningError extends DeuzError {
  readonly code: SkillLearningErrorCode;
  constructor(code: SkillLearningErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

/**
 * Proposes a skill from a verified run (2.4, experimental): one model call,
 * one draft, at most 2048 output tokens over at most 32 000 characters of
 * source projection, under the mandatory `budget`. The projection is built
 * from the run's transcript without reasoning, encrypted or redacted parts,
 * provider metadata or SDK-internal messages, and without raw tool results
 * (host `toolSummaries` instead). Refuses an ineligible run
 * (`source_not_eligible`), an oversized projection (`source_too_large`) and a
 * draft that fails `parseSkill`, lacks a valid source on a step or suggests a
 * tool the run never used (`invalid_proposal`).
 *
 * The one call is made without a transport retry, so a failed attempt
 * rejects with the provider's error and is the host's to repeat; a budget
 * that cannot admit it rejects with the ledger's `budget_exceeded` before
 * the request. A budget needs a `tokens` or `usd` bound (TypeError otherwise).
 */
export async function proposeSkillFromRun(
  options: ProposeSkillFromRunOptions,
): Promise<SkillProposal> {
  const { maxOutputTokens, maxSourceChars } = checkOptions(options);
  const { run } = options;
  assertEligible(run);
  const projection = await projectRun(run, {
    ...(options.toolSummaries ? { toolSummaries: options.toolSummaries } : {}),
  });
  if (projection.items.length === 0)
    throw new SkillLearningError('source_not_eligible', `run ${run.runId} has nothing to project`);
  // Spec §2.6: an oversized source is refused, never cut.
  if (projection.text.length > maxSourceChars)
    throw new SkillLearningError(
      'source_too_large',
      `the projection of run ${run.runId} has ${projection.text.length} characters; maxSourceChars is ${maxSourceChars}`,
    );

  const call = await callProposalModel({
    model: options.model,
    messages: proposalMessages(projection, options.instructions),
    maxOutputTokens,
    budget: options.budget,
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.deps ? { deps: options.deps } : {}),
  });
  const revision = run.revision ?? 0;
  let accepted: ReturnType<typeof acceptDraft>;
  try {
    if (call.finishReason === 'length')
      throw new InvalidDraftError('the draft was cut off at maxOutputTokens');
    if (call.finishReason === 'content_filter')
      throw new InvalidDraftError('the model refused to draft');
    accepted = acceptDraft(parseDraft(call.text), { runId: run.runId, revision, projection });
  } catch (error) {
    if (error instanceof InvalidDraftError)
      throw new SkillLearningError(
        'invalid_proposal',
        `the proposal for run ${run.runId} was refused: ${error.message}`,
      );
    throw error;
  }
  return {
    kind: 'deuz-skill-proposal',
    version: 1,
    status: 'proposed',
    evaluation: 'not-evaluated',
    skillMd: accepted.skillMd,
    manifest: accepted.manifest,
    steps: accepted.steps,
    limitations: accepted.limitations,
    ...(accepted.allowedTools ? { allowedTools: accepted.allowedTools } : {}),
    source: { runId: run.runId, scope: run.scope, revision, digest: projection.digest },
    cost: {
      modelId: options.model.modelId,
      usage: call.usage,
      ...(call.costUsd !== undefined ? { costUsd: call.costUsd } : {}),
    },
    createdAt: resolveDependencies(options.deps).clock.now(),
  };
}

/** Default output tokens of the proposal call. */
const DEFAULT_MAX_OUTPUT_TOKENS = 2048;
/** Default characters of source projection. */
const DEFAULT_MAX_SOURCE_CHARS = 32_000;

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1)
    throw new TypeError(`proposeSkillFromRun: ${name} must be a positive integer`);
  return value;
}

/** Malformed options are a caller error (TypeError), never a refusal of the run. */
function checkOptions(options: ProposeSkillFromRunOptions): {
  maxOutputTokens: number;
  maxSourceChars: number;
} {
  if (!options || typeof options !== 'object')
    throw new TypeError('proposeSkillFromRun: options are required');
  const run = options.run as Partial<AgentRunEnvelope> | undefined;
  if (
    !run ||
    run.kind !== 'deuz-agent-run' ||
    typeof run.runId !== 'string' ||
    typeof run.scope !== 'string' ||
    !Array.isArray(run.messages)
  )
    throw new TypeError('proposeSkillFromRun: run must be a native agent run envelope');
  if (!options.model || typeof options.model !== 'object')
    throw new TypeError('proposeSkillFromRun: model is required');
  const budget = options.budget;
  if (!budget || typeof budget !== 'object')
    throw new TypeError('proposeSkillFromRun: budget is required (spec §2.6)');
  if (budget.tokens === undefined && budget.usd === undefined)
    throw new TypeError('proposeSkillFromRun: budget needs a tokens or usd bound');
  for (const [name, value] of [
    ['tokens', budget.tokens],
    ['usd', budget.usd],
  ] as const)
    if (value !== undefined && (!Number.isFinite(value) || value < 0))
      throw new TypeError(`proposeSkillFromRun: budget.${name} must be a finite number >= 0`);
  return {
    maxOutputTokens: positiveInteger(
      options.maxOutputTokens,
      DEFAULT_MAX_OUTPUT_TOKENS,
      'maxOutputTokens',
    ),
    maxSourceChars: positiveInteger(
      options.maxSourceChars,
      DEFAULT_MAX_SOURCE_CHARS,
      'maxSourceChars',
    ),
  };
}

/**
 * The source condition (spec §2.6): terminal, completed, and verified by the
 * run's own verifier (`verification === 'verified'`). It speaks about the
 * source task, never about the skill drafted from it.
 */
function assertEligible(run: AgentRunEnvelope | AgentRunEnvelopeV3): void {
  if (run.phase !== 'terminal')
    throw new SkillLearningError('source_not_eligible', `run ${run.runId} is not terminal`);
  if (run.result?.status !== 'completed')
    throw new SkillLearningError('source_not_eligible', `run ${run.runId} did not complete`);
  if (run.verification !== 'verified')
    throw new SkillLearningError(
      'source_not_eligible',
      `run ${run.runId} is not verified (verification: ${run.verification ?? 'none'})`,
    );
}
