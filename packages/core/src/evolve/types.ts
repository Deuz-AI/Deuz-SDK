import type { Dependencies } from '../types/deps';
import type {
  BudgetLimits,
  BudgetTotals,
  ExecutionContextSnapshot,
  ExecutionPolicy,
} from '../types/execution';
import type { EmbeddingModel, LanguageModel } from '../types/model';

/** A run is addressed by a tenant scope and a caller-chosen run ID. */
export interface EvolveKey {
  readonly scope: string;
  readonly runId: string;
}

export type EvolvePatchType = 'diff' | 'full' | 'cross';

/** JSON-serializable metric and artifact bags. Values must be finite. */
export type EvolveMetrics = Readonly<Record<string, number>>;
export type EvolveArtifacts = Readonly<Record<string, string>>;

export interface EvolveStageResult {
  readonly name: string;
  readonly score?: number;
  readonly passed: boolean;
  readonly error?: string;
}

export type EvolveRejectionKind =
  | 'model'
  | 'patch'
  | 'duplicate'
  | 'novelty'
  | 'cascade'
  | 'evaluation';

export interface EvolveRejection {
  readonly kind: EvolveRejectionKind;
  readonly message: string;
  /** The cascade stage that stopped the candidate. */
  readonly stage?: string;
}

/**
 * One program in the population. The ID is deterministic, `g{generation}-i{island}-s{slot}`,
 * so a resumed run finds every slot it already paid for.
 */
export interface EvolveCandidate extends EvolveKey {
  readonly id: string;
  readonly generation: number;
  readonly island: number;
  readonly slot: number;
  readonly program: string;
  /** `'initial'` for the seed program of generation zero. */
  readonly patchType: EvolvePatchType | 'initial';
  readonly parentId?: string;
  /** The second parent of a crossover. */
  readonly secondParentId?: string;
  readonly inspirationIds: readonly string[];
  /** Index into `EvolveOptions.models` of the model that wrote the mutation. */
  readonly model?: number;
  /** Passed every cascade stage; only accepted candidates join the population. */
  readonly accepted: boolean;
  /** The last evaluated stage's score, higher is better. */
  readonly score?: number;
  readonly metrics?: EvolveMetrics;
  /** Behaviour descriptors in [0, 1] for the MAP-Elites archive grid. */
  readonly features?: EvolveMetrics;
  /** Evaluator side channel (stderr, failing test names...) fed into later prompts. */
  readonly artifacts?: EvolveArtifacts;
  readonly stages: readonly EvolveStageResult[];
  readonly rejection?: EvolveRejection;
  /** Novelty embedding, stored so a resumed run never re-embeds. */
  readonly embedding?: readonly number[];
  readonly createdAt: number;
}

export interface EvolveIslandState {
  /** Population member IDs, best first. */
  readonly members: readonly string[];
  readonly bestId?: string;
  readonly bestScore?: number;
}

/** UCB1 statistics per model, indexed like `EvolveOptions.models`. */
export interface EvolveBanditState {
  readonly pulls: readonly number[];
  readonly rewards: readonly number[];
}

export type EvolveStatus = 'running' | 'completed' | 'stopped' | 'failed';
export type EvolveStopReason =
  | 'generations'
  | 'target'
  | 'plateau'
  | 'budget'
  | 'cancelled'
  | 'drained'
  | 'error';

export interface EvolveRunRecord extends EvolveKey {
  readonly kind: 'deuz-evolve';
  readonly version: 1;
  /** The PRNG seed every selection derives from; recorded so replays match. */
  readonly seed: string;
  readonly status: EvolveStatus;
  readonly reason?: EvolveStopReason;
  readonly error?: string;
  /** The last committed generation; -1 before the seed program is evaluated. */
  readonly generation: number;
  /** Shape a resumed run must match. */
  readonly islandCount: number;
  readonly mutationsPerGeneration: number;
  readonly modelCount: number;
  readonly islands: readonly EvolveIslandState[];
  /** MAP-Elites cells (`features` binned) or, without features, the global top list. */
  readonly archive: readonly string[];
  readonly bandit: EvolveBanditState;
  readonly bestId?: string;
  readonly bestScore?: number;
  /** Generations since the best score last improved. */
  readonly stale: number;
  readonly executionState?: ExecutionContextSnapshot;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface EvolveCandidateQuery {
  readonly generation?: number;
  readonly ids?: readonly string[];
}

export interface EvolveGenerationCommit extends EvolveKey {
  /** Compare-and-set: the stored run must be at this generation. */
  readonly expectedGeneration: number;
  /** The new state; its generation must be `expectedGeneration + 1`. */
  readonly run: EvolveRunRecord;
}

/**
 * Durable population. Candidate puts are idempotent by ID (an identical repeat
 * is a no-op, a conflicting one rejects) and generations commit with a CAS, so
 * two controllers can never both advance the same run.
 */
export interface PopulationStore {
  createRun(run: EvolveRunRecord): Promise<void>;
  loadRun(key: EvolveKey): Promise<EvolveRunRecord | undefined>;
  /** Resolves `true` when inserted, `false` for an identical repeat. */
  putCandidate(candidate: EvolveCandidate): Promise<boolean>;
  /** Ordered by generation, island, slot. */
  listCandidates(key: EvolveKey, query?: EvolveCandidateQuery): Promise<EvolveCandidate[]>;
  commitGeneration(commit: EvolveGenerationCommit): Promise<void>;
  /** Save state within the stored generation (status, ledger); a generation change rejects. */
  saveRun(run: EvolveRunRecord): Promise<void>;
}

export interface EvolveStageOutput {
  /** Higher is better. */
  readonly score: number;
  readonly metrics?: EvolveMetrics;
  readonly features?: EvolveMetrics;
  readonly artifacts?: EvolveArtifacts;
  /** `false` fails the stage regardless of its threshold. */
  readonly passed?: boolean;
}

export interface EvolveStageContext extends EvolveKey {
  readonly candidateId: string;
  readonly generation: number;
  readonly island: number;
  readonly stage: number;
  /** Aborted on stage timeout, cancel, or the caller's signal. */
  readonly signal: AbortSignal;
  /** Outputs of the stages this candidate already passed. */
  readonly previous: readonly EvolveStageOutput[];
}

export interface EvolveStage {
  readonly name?: string;
  evaluate(
    program: string,
    context: EvolveStageContext,
  ): EvolveStageOutput | Promise<EvolveStageOutput>;
  /** The cascade stops at the first stage scoring below its threshold. */
  readonly threshold?: number;
  readonly timeoutMs?: number;
}

export interface EvolveModel {
  readonly model: LanguageModel;
  /** Scales the model's UCB1 score; 0 never picks it. Default 1. */
  readonly weight?: number;
}

export interface EvolveIslandOptions {
  readonly count: number;
  /** Ring migration every N generations. */
  readonly migrationEvery: number;
  /** Share of each island's population copied to the next island. */
  readonly migrationRate: number;
  /** Every N generations the island with the worst best score restarts from the global best. */
  readonly resetWeakestEvery?: number;
}

export interface EvolvePopulationOptions {
  /** Members kept per island. Default 20. */
  readonly size?: number;
  /** Elite archive size (global top list without features). Default 20. */
  readonly archiveSize?: number;
  /** Parent drawn from the elite archive. Default 0.1. */
  readonly eliteRatio?: number;
  /** Parent drawn uniformly from the island. Default 0.2. The rest exploits `selection`. */
  readonly exploreRatio?: number;
  /** MAP-Elites bins per feature dimension. Default 10. */
  readonly featureBins?: number;
}

export type EvolveSelection = 'weighted' | 'power-law' | 'beam' | { readonly boltzmann: number };

export interface EvolveNoveltyJudgeInput {
  readonly program: string;
  readonly similar: { readonly id: string; readonly program: string; readonly cosine: number };
}

export interface EvolveNoveltyOptions {
  /** An embedding model, or any batch embedder such as a RAG `Embedder.embed`. */
  readonly embed: EmbeddingModel | ((texts: string[]) => Promise<number[][]>);
  /** Reject at or above this cosine similarity to an island member. Default 0.99. */
  readonly maxCosine?: number;
  /** Second opinion for a near-duplicate: resolve `true` to keep it. */
  readonly judge?: (input: EvolveNoveltyJudgeInput) => boolean | Promise<boolean>;
}

export interface EvolvePromptContext {
  readonly instructions?: string;
  readonly patchType: EvolvePatchType;
  readonly generation: number;
  readonly parent: EvolvePromptProgram;
  readonly secondParent?: EvolvePromptProgram;
  readonly inspirations: readonly EvolvePromptProgram[];
  /** Recent rejected attempts on this island, with their evaluator artifacts. */
  readonly failures?: readonly EvolvePromptProgram[];
}

export interface EvolvePromptProgram {
  readonly id?: string;
  readonly program: string;
  readonly score?: number;
  readonly metrics?: EvolveMetrics;
  readonly artifacts?: EvolveArtifacts;
  readonly rejection?: EvolveRejection;
}

export interface EvolveMutationPrompt {
  readonly system: string;
  readonly prompt: string;
}

export interface EvolveOptions extends EvolveKey {
  /** The seed program; evolvable code sits between EVOLVE-BLOCK markers. */
  readonly initial: string;
  readonly stages: readonly EvolveStage[];
  readonly models: readonly EvolveModel[];
  readonly store: PopulationStore;
  /** Generations after the seed evaluation. */
  readonly generations: number;
  /** Mutations per generation, dealt round-robin over the islands. */
  readonly mutationsPerGeneration: number;
  /** Concurrent mutations. Default 4. */
  readonly concurrency?: number;
  readonly islands?: EvolveIslandOptions;
  readonly population?: EvolvePopulationOptions;
  readonly selection?: EvolveSelection;
  readonly novelty?: EvolveNoveltyOptions;
  /** Patch-type probabilities. Default 0.6 / 0.3 / 0.1. */
  readonly patch?: { readonly diff?: number; readonly full?: number; readonly cross?: number };
  /** Inspirations in the prompt: best programs and random diverse ones. Default 3 + 2. */
  readonly inspirations?: { readonly top?: number; readonly diverse?: number };
  /** Required: every mutation is charged to a child scope of this budget. */
  readonly budget: BudgetLimits;
  readonly policy?: ExecutionPolicy;
  readonly stopWhen?: { readonly targetScore?: number; readonly plateau?: number };
  /** PRNG seed; derived from `deps.generateId()` when omitted, and recorded in the run. */
  readonly seed?: string | number;
  /** The task description placed in every mutation prompt. */
  readonly instructions?: string;
  /** Replace the built-in prompt. */
  readonly buildPrompt?: (context: EvolvePromptContext) => EvolveMutationPrompt;
  readonly maxOutputTokens?: number;
  readonly signal?: AbortSignal;
  readonly deps?: Dependencies;
}

/** Resume a stored run. `seed` and the population shape come from the store. */
export type ResumeEvolveOptions = Omit<EvolveOptions, 'seed'> & { readonly seed?: string | number };

export type EvolveEvent =
  | { readonly type: 'generation.started'; readonly generation: number }
  | { readonly type: 'candidate'; readonly candidate: EvolveCandidate; readonly replayed: boolean }
  | {
      readonly type: 'improvement';
      readonly generation: number;
      readonly candidateId: string;
      readonly score: number;
    }
  | {
      readonly type: 'migration';
      readonly generation: number;
      readonly from: number;
      readonly to: number;
      readonly ids: readonly string[];
    }
  | {
      readonly type: 'island.reset';
      readonly generation: number;
      readonly island: number;
      readonly seedId: string;
    }
  | {
      readonly type: 'generation.committed';
      readonly generation: number;
      readonly bestScore?: number;
    }
  | {
      readonly type: 'run.finished';
      readonly status: EvolveStatus;
      readonly reason?: EvolveStopReason;
    };

export interface EvolveResult extends EvolveKey {
  readonly status: EvolveStatus;
  readonly reason?: EvolveStopReason;
  readonly seed: string;
  readonly generation: number;
  readonly best?: EvolveCandidate;
  readonly run: EvolveRunRecord;
  readonly totals: BudgetTotals;
  /** Model calls this handle made (zero for slots replayed from the store). */
  readonly modelCalls: number;
}

export interface EvolveHandle {
  readonly result: Promise<EvolveResult>;
  /** Every event of this handle, replayed from the start for each iterator. */
  events(): AsyncIterable<EvolveEvent>;
  /** Abort in-flight work and stop; stored slots replay on resume. */
  cancel(): Promise<void>;
  /** Finish the current generation, then stop. */
  drain(): Promise<void>;
}
