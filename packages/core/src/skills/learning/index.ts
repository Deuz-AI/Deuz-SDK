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
import { notImplemented } from '../../internal/not-implemented';

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
 */
export async function proposeSkillFromRun(
  _options: ProposeSkillFromRunOptions,
): Promise<SkillProposal> {
  return notImplemented('proposeSkillFromRun');
}
