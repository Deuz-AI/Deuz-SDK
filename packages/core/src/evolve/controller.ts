/**
 * evolve/controller.ts — the standalone evolutionary search loop (2.2).
 *
 * Generational, not steady-state: every slot of a generation plans against the
 * population committed by the previous one, with counter-based seeded draws,
 * so selection replays identically regardless of concurrency or resume. A slot
 * whose deterministic ID (`g{gen}-i{island}-s{slot}`) is already stored is
 * replayed with zero model calls. Mutations are charged to a child execution
 * scope per candidate, the finished scopes are compacted after each
 * generation, and the generation commits with a compare-and-set.
 *
 * Edge-safe: time and IDs come from `deps`, randomness from `./random`.
 */
import { generateText } from '../generate';
import { isDeuzError } from '../errors';
import { embedMany } from '../inference/embed';
import { childScopeId, createExecutionContext } from '../execution-policy';
import { isFatalExecutionError } from '../internal/execution-error';
import { mapWithConcurrency } from '../internal/p-limit';
import { resolveDependencies } from '../internal/resolve-deps';
import { cosineSimilarity } from '../internal/vector';
import type { BudgetLedgerSnapshot, NativeExecutionContext } from '../types/execution';
import { applySearchReplace, EvolvePatchError, extractFullRewrite } from './patch';
import { buildMutationPrompt } from './prompt';
import { createRng } from './random';
import {
  chooseModel,
  pickInspirations,
  pickParent,
  pickPatchType,
  rankCandidates,
  updateArchive,
} from './selection';
import { EvolveLeaseError, evolveCandidateId, validateEvolveKey } from './store';
import type { Lease } from '../types/lease';
import type {
  EvolveArtifacts,
  EvolveCandidate,
  EvolveEvent,
  EvolveHandle,
  EvolveKey,
  EvolveMetrics,
  EvolveOptions,
  EvolvePatchType,
  EvolvePromptProgram,
  EvolveRejection,
  EvolveResult,
  EvolveRunRecord,
  EvolveSelection,
  EvolveStageOutput,
  EvolveStageResult,
  EvolveStatus,
  EvolveStopReason,
  ResumeEvolveOptions,
} from './types';

interface Config {
  readonly concurrency: number;
  readonly islandCount: number;
  readonly migrationEvery?: number;
  readonly migrationRate: number;
  readonly resetWeakestEvery?: number;
  readonly size: number;
  readonly archiveSize: number;
  readonly eliteRatio: number;
  readonly exploreRatio: number;
  readonly featureBins: number;
  readonly selection: EvolveSelection;
  readonly patch: { readonly diff: number; readonly full: number; readonly cross: number };
  readonly top: number;
  readonly diverse: number;
  readonly weights: readonly number[];
  readonly maxCosine: number;
}

const positiveInteger = (value: unknown) =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;
const ratio = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;

function fail(message: string): never {
  throw new TypeError(`evolve: ${message}`);
}

function normalize(options: EvolveOptions): Config {
  if (!options || typeof options !== 'object') fail('options are required');
  validateEvolveKey(options);
  if (typeof options.initial !== 'string') fail('initial must be a string');
  if (!Array.isArray(options.stages) || !options.stages.length)
    fail('stages must be a nonempty array');
  for (const stage of options.stages) {
    if (typeof stage?.evaluate !== 'function') fail('every stage needs an evaluate function');
    if (stage.threshold !== undefined && !Number.isFinite(stage.threshold))
      fail('stage thresholds must be finite');
    if (stage.timeoutMs !== undefined && !(stage.timeoutMs > 0))
      fail('stage timeoutMs must be positive');
  }
  if (!Array.isArray(options.models) || !options.models.length)
    fail('models must be a nonempty array');
  const weights = options.models.map((entry) => {
    if (!entry?.model) fail('every models entry needs a model');
    const weight = entry.weight ?? 1;
    if (!Number.isFinite(weight) || weight < 0) fail('model weights must be finite and >= 0');
    return weight;
  });
  if (!weights.some((weight) => weight > 0)) fail('models need a positive weight');
  if (!options.store || typeof options.store.createRun !== 'function')
    fail('store must be a PopulationStore');
  if (!Number.isSafeInteger(options.generations) || options.generations < 0)
    fail('generations must be a nonnegative integer');
  if (!positiveInteger(options.mutationsPerGeneration))
    fail('mutationsPerGeneration must be a positive integer');
  if (options.concurrency !== undefined && !positiveInteger(options.concurrency))
    fail('concurrency must be a positive integer');
  if (options.lease !== undefined) {
    if (typeof options.lease?.provider?.acquire !== 'function')
      fail('lease.provider must be a LeaseProvider');
    const ttl = options.lease.ttlMs ?? 30_000;
    if (!Number.isSafeInteger(ttl) || ttl < 3) fail('lease ttlMs must be an integer of at least 3');
  }
  const budget = options.budget;
  if (
    !budget ||
    typeof budget !== 'object' ||
    (budget.tokens === undefined && budget.usd === undefined)
  )
    fail('budget with tokens or usd is required');
  const islands = options.islands;
  if (islands) {
    if (!positiveInteger(islands.count)) fail('islands.count must be a positive integer');
    if (!positiveInteger(islands.migrationEvery))
      fail('islands.migrationEvery must be a positive integer');
    if (!ratio(islands.migrationRate)) fail('islands.migrationRate must be in [0, 1]');
    if (islands.resetWeakestEvery !== undefined && !positiveInteger(islands.resetWeakestEvery))
      fail('islands.resetWeakestEvery must be a positive integer');
  }
  const population = options.population ?? {};
  const size = population.size ?? 20;
  const archiveSize = population.archiveSize ?? 20;
  const eliteRatio = population.eliteRatio ?? 0.1;
  const exploreRatio = population.exploreRatio ?? 0.2;
  const featureBins = population.featureBins ?? 10;
  if (!positiveInteger(size) || !positiveInteger(archiveSize) || !positiveInteger(featureBins))
    fail('population sizes and featureBins must be positive integers');
  if (!ratio(eliteRatio) || !ratio(exploreRatio) || eliteRatio + exploreRatio > 1)
    fail('population eliteRatio and exploreRatio must be ratios summing to at most 1');
  const selection = options.selection ?? 'weighted';
  if (typeof selection === 'object') {
    if (!(Number.isFinite(selection?.boltzmann) && selection.boltzmann > 0))
      fail('selection.boltzmann must be a positive temperature');
  } else if (!['weighted', 'power-law', 'beam'].includes(selection))
    fail('selection must be weighted, power-law, beam or { boltzmann }');
  const patch = options.patch
    ? {
        diff: options.patch.diff ?? 0,
        full: options.patch.full ?? 0,
        cross: options.patch.cross ?? 0,
      }
    : { diff: 0.6, full: 0.3, cross: 0.1 };
  if (
    ![patch.diff, patch.full, patch.cross].every((value) => Number.isFinite(value) && value >= 0) ||
    patch.diff + patch.full + patch.cross <= 0
  )
    fail('patch probabilities must be >= 0 with a positive sum');
  const top = options.inspirations?.top ?? 3;
  const diverse = options.inspirations?.diverse ?? 2;
  if (![top, diverse].every((value) => Number.isSafeInteger(value) && value >= 0))
    fail('inspirations counts must be nonnegative integers');
  const maxCosine = options.novelty?.maxCosine ?? 0.99;
  if (options.novelty && !(maxCosine > 0 && maxCosine <= 1))
    fail('novelty.maxCosine must be in (0, 1]');
  const stop = options.stopWhen;
  if (stop?.targetScore !== undefined && !Number.isFinite(stop.targetScore))
    fail('stopWhen.targetScore must be finite');
  if (stop?.plateau !== undefined && !positiveInteger(stop.plateau))
    fail('stopWhen.plateau must be a positive integer');
  return {
    concurrency: options.concurrency ?? 4,
    islandCount: islands?.count ?? 1,
    migrationEvery: islands?.migrationEvery,
    migrationRate: islands?.migrationRate ?? 0,
    resetWeakestEvery: islands?.resetWeakestEvery,
    size,
    archiveSize,
    eliteRatio,
    exploreRatio,
    featureBins,
    selection,
    patch,
    top,
    diverse,
    weights,
    maxCosine,
  };
}

/** A budget stop, however deep the inference layer wrapped it. */
function isBudgetExceeded(error: unknown): boolean {
  for (let current = error, depth = 0; current && depth < 8; depth++) {
    const item = current as { name?: unknown; code?: unknown; cause?: unknown };
    if (item.name === 'BudgetLedgerError' && item.code === 'budget_exceeded') return true;
    current = item.cause;
  }
  return false;
}

/** Configuration errors: every later call to the model fails the same way. */
const CONFIGURATION_CODES = new Set([
  'authentication',
  'model_not_found',
  'unsupported_capability',
]);

/**
 * A model error that fails the run instead of one candidate: a policy refusal
 * (an elapsed deadline, a disallowed model), an admission or persistence
 * failure, or a configuration error. Errors a slot's own prompt may cause, and
 * transient ones, stay that candidate's rejection.
 */
function isFatalModelError(error: unknown): boolean {
  for (let current = error, depth = 0; current && depth < 8; depth++) {
    if (
      isFatalExecutionError(current) ||
      (isDeuzError(current) && CONFIGURATION_CODES.has(current.code))
    )
      return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

function metrics(value: unknown): EvolveMetrics | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const out: Record<string, number> = {};
  for (const [name, item] of Object.entries(value))
    if (typeof item === 'number' && Number.isFinite(item)) out[name] = item;
  return Object.keys(out).length ? out : undefined;
}

function artifacts(value: unknown): EvolveArtifacts | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const out: Record<string, string> = {};
  for (const [name, item] of Object.entries(value))
    if (item !== undefined && item !== null) out[name] = String(item);
  return Object.keys(out).length ? out : undefined;
}

interface Evaluation {
  readonly accepted: boolean;
  readonly score?: number;
  readonly metrics?: EvolveMetrics;
  readonly features?: EvolveMetrics;
  readonly artifacts?: EvolveArtifacts;
  readonly stages: EvolveStageResult[];
  readonly rejection?: EvolveRejection;
}

interface SlotPlan {
  readonly id: string;
  readonly island: number;
  readonly slot: number;
  readonly patchType: EvolvePatchType;
  readonly parent: EvolveCandidate;
  readonly secondParent?: EvolveCandidate;
  readonly inspirations: readonly EvolveCandidate[];
  readonly model: number;
  readonly failures: readonly EvolveCandidate[];
}

interface Integrated {
  readonly next: EvolveRunRecord;
  readonly notices: EvolveEvent[];
  readonly failures: EvolveCandidate[][];
}

type SlotOutcome = { candidate: EvolveCandidate } | { skipped: 'budget' | 'aborted' };

class StopSignal extends Error {}

const promptProgram = (candidate: EvolveCandidate): EvolvePromptProgram => ({
  id: candidate.id,
  program: candidate.program,
  score: candidate.score,
  metrics: candidate.metrics,
  artifacts: candidate.artifacts,
  rejection: candidate.rejection,
});

/** Start a new run. The run ID must not exist in the store. */
export function evolve(options: EvolveOptions): EvolveHandle {
  return start(options, 'create');
}

/** Continue a stored run; slots already stored replay with zero model calls. */
export function resumeEvolve(options: ResumeEvolveOptions): EvolveHandle {
  return start(options as EvolveOptions, 'resume');
}

function start(options: EvolveOptions, mode: 'create' | 'resume'): EvolveHandle {
  const config = normalize(options);
  const deps = resolveDependencies(options.deps);
  const store = options.store;
  const key: EvolveKey = { scope: options.scope, runId: options.runId };
  const controller = new AbortController();
  let draining = false;
  let stopReason: EvolveStopReason | undefined;
  const events: EvolveEvent[] = [];
  const waiters = new Set<() => void>();
  let finished = false;
  const wake = () => {
    for (const resolve of waiters) resolve();
    waiters.clear();
  };
  const emit = (event: EvolveEvent) => {
    events.push(event);
    wake();
  };
  const onAbort = () => {
    stopReason ??= 'cancelled';
    controller.abort(options.signal?.reason ?? new Error('Evolve cancelled'));
  };
  options.signal?.addEventListener('abort', onAbort, { once: true });
  if (options.signal?.aborted) onAbort();

  const result = execute().finally(() => {
    finished = true;
    options.signal?.removeEventListener('abort', onAbort);
    wake();
  });

  async function execute(): Promise<EvolveResult> {
    let run: EvolveRunRecord;
    let owned = false;
    let modelCalls = 0;
    const cache = new Map<string, EvolveCandidate>();
    const embeddings = new Map<string, readonly number[]>();
    let failures: EvolveCandidate[][] = [];
    let queue: Promise<void> = Promise.resolve();
    let writeFailure: unknown;
    let execution!: NativeExecutionContext;

    /** Serialized run writes: ledger persistence, status saves and commits never interleave. */
    const write = (operation: () => Promise<void>): Promise<void> => {
      const pending = queue.then(() => {
        if (writeFailure) throw writeFailure;
        return operation();
      });
      queue = pending.catch((error) => {
        writeFailure ??= error;
        controller.abort(error);
      });
      return pending;
    };
    const withState = (ledger?: BudgetLedgerSnapshot): EvolveRunRecord => ({
      ...run,
      executionState: execution
        ? ledger
          ? { ...execution.snapshot(), ledger }
          : execution.snapshot()
        : run.executionState,
      updatedAt: deps.clock.now(),
    });
    const saveRun = () => write(() => store.saveRun(withState()));

    // Cross-process liveness (2.2): one lease per run, renewed every ttl / 3.
    // Losing it fails every later write, so the run is left for the next
    // executor as it stands; saveRun's generation check fences the rest.
    const leasing = options.lease;
    const leaseTtl = leasing?.ttlMs ?? 30_000;
    let held: Lease | undefined;
    let leaseLost = false;
    let beating = true;
    let stopBeat: (() => void) | undefined;
    const lose = () => {
      leaseLost = true;
      writeFailure ??= new EvolveLeaseError('lost');
      controller.abort(writeFailure);
    };
    const renewLease = async (): Promise<void> => {
      if (!beating || !held) return;
      try {
        const renewal = await leasing!.provider.renew(held, leaseTtl);
        if (!beating) return;
        if (!renewal.held) return lose();
        held = renewal.lease;
        for (const signal of renewal.signals) {
          if (signal === 'drain') draining = true;
          else if (signal === 'cancel') {
            stopReason ??= 'cancelled';
            controller.abort(new Error('Evolve cancelled'));
          }
        }
      } catch {
        // A provider outage is survivable until the lease could have lapsed.
        if (!beating) return;
        if (deps.clock.now() >= held.expiresAt) return lose();
      }
      beat();
    };
    const beat = () => {
      if (beating && held)
        stopBeat = deps.clock.setTimeout(
          () => void renewLease(),
          Math.max(1, Math.floor(leaseTtl / 3)),
        );
    };

    const load = async (ids: readonly string[]) => {
      const missing = [...new Set(ids)].filter((id) => !cache.has(id));
      if (missing.length)
        for (const item of await store.listCandidates(key, { ids: missing }))
          cache.set(item.id, item);
      for (const id of ids)
        if (!cache.has(id)) throw new Error(`Evolve candidate ${id} is missing`);
    };
    const get = (id: string) => cache.get(id)!;

    const finish = async (
      status: EvolveStatus,
      reason: EvolveStopReason,
    ): Promise<EvolveResult> => {
      run = { ...run, status, reason };
      await saveRun();
      emit({ type: 'run.finished', status, reason });
      if (run.bestId) await load([run.bestId]);
      return {
        ...key,
        status,
        reason,
        seed: run.seed,
        generation: run.generation,
        best: run.bestId ? get(run.bestId) : undefined,
        run: withState(),
        totals: execution.ledger.totals(),
        modelCalls,
      };
    };

    /** `stopWhen` over the committed run: the target score first, then the plateau. */
    const stopReached = (): 'target' | 'plateau' | undefined => {
      const target = options.stopWhen?.targetScore;
      if (target !== undefined && run.bestScore !== undefined && run.bestScore >= target)
        return 'target';
      const plateau = options.stopWhen?.plateau;
      return plateau !== undefined && run.stale >= plateau ? 'plateau' : undefined;
    };

    const embed = async (texts: string[]): Promise<number[][]> => {
      const embedder = options.novelty!.embed;
      if (typeof embedder === 'function') return embedder(texts);
      const { embeddings: vectors } = await embedMany({
        model: embedder,
        values: texts,
        deps: options.deps,
        signal: controller.signal,
      });
      return vectors;
    };
    const embeddingOf = async (candidate: EvolveCandidate): Promise<readonly number[]> => {
      const known = candidate.embedding ?? embeddings.get(candidate.id);
      if (known) return known;
      const [vector] = await embed([candidate.program]);
      if (!vector) throw new Error('The novelty embedder returned no vector');
      embeddings.set(candidate.id, vector);
      return vector;
    };

    const evaluate = async (
      program: string,
      meta: { id: string; generation: number; island: number },
    ): Promise<Evaluation> => {
      const stages: EvolveStageResult[] = [];
      const previous: EvolveStageOutput[] = [];
      let merged: {
        metrics?: EvolveMetrics;
        features?: EvolveMetrics;
        artifacts?: EvolveArtifacts;
      } = {};
      let score: number | undefined;
      for (let index = 0; index < options.stages.length; index++) {
        const stage = options.stages[index]!;
        const name = stage.name ?? `stage-${index}`;
        const local = new AbortController();
        const relay = () => local.abort(controller.signal.reason);
        controller.signal.addEventListener('abort', relay, { once: true });
        let cancelTimer: (() => void) | undefined;
        let output: EvolveStageOutput;
        try {
          output = await new Promise<EvolveStageOutput>((resolve, reject) => {
            if (controller.signal.aborted) return reject(controller.signal.reason);
            local.signal.addEventListener('abort', () => reject(local.signal.reason), {
              once: true,
            });
            if (stage.timeoutMs !== undefined)
              cancelTimer = deps.clock.setTimeout(
                () => local.abort(new Error(`Stage ${name} timed out after ${stage.timeoutMs}ms`)),
                stage.timeoutMs,
              );
            Promise.resolve()
              .then(() =>
                stage.evaluate(program, {
                  ...key,
                  candidateId: meta.id,
                  generation: meta.generation,
                  island: meta.island,
                  stage: index,
                  signal: local.signal,
                  previous: [...previous],
                }),
              )
              .then(resolve, reject);
          });
          if (!output || typeof output.score !== 'number' || !Number.isFinite(output.score))
            throw new Error(`Stage ${name} must return a finite score`);
        } catch (error) {
          if (controller.signal.aborted) throw new StopSignal();
          const text = message(error);
          stages.push({ name, passed: false, error: text });
          return {
            accepted: false,
            score,
            ...merged,
            artifacts: { ...merged.artifacts, error: text },
            stages,
            rejection: { kind: 'evaluation', stage: name, message: text },
          };
        } finally {
          cancelTimer?.();
          controller.signal.removeEventListener('abort', relay);
        }
        score = output.score;
        const outputMetrics = metrics(output.metrics);
        const outputFeatures = metrics(output.features);
        const outputArtifacts = artifacts(output.artifacts);
        merged = {
          metrics:
            outputMetrics || merged.metrics ? { ...merged.metrics, ...outputMetrics } : undefined,
          features: outputFeatures ?? merged.features,
          artifacts:
            outputArtifacts || merged.artifacts
              ? { ...merged.artifacts, ...outputArtifacts }
              : undefined,
        };
        const passed =
          output.passed !== false && (stage.threshold === undefined || score >= stage.threshold);
        stages.push({ name, score, passed });
        if (!passed)
          return {
            accepted: false,
            score,
            ...merged,
            stages,
            rejection: {
              kind: 'cascade',
              stage: name,
              message:
                output.passed === false
                  ? `Stage ${name} reported failure`
                  : `Score ${score} is below the ${name} threshold ${stage.threshold}`,
            },
          };
        previous.push(output);
      }
      return { accepted: true, score, ...merged, stages };
    };

    const makeCandidate = (
      plan: Pick<SlotPlan, 'id' | 'island' | 'slot'> & Partial<SlotPlan>,
      generation: number,
      program: string,
      evaluation: Evaluation,
      embedding?: readonly number[],
    ): EvolveCandidate => ({
      ...key,
      id: plan.id,
      generation,
      island: plan.island,
      slot: plan.slot,
      program,
      patchType: plan.patchType ?? 'initial',
      ...(plan.parent ? { parentId: plan.parent.id } : {}),
      ...(plan.secondParent ? { secondParentId: plan.secondParent.id } : {}),
      inspirationIds: (plan.inspirations ?? []).map((item) => item.id),
      ...(plan.model !== undefined ? { model: plan.model } : {}),
      accepted: evaluation.accepted,
      ...(evaluation.score !== undefined ? { score: evaluation.score } : {}),
      ...(evaluation.metrics ? { metrics: evaluation.metrics } : {}),
      ...(evaluation.features ? { features: evaluation.features } : {}),
      ...(evaluation.artifacts ? { artifacts: evaluation.artifacts } : {}),
      stages: evaluation.stages,
      ...(evaluation.rejection ? { rejection: evaluation.rejection } : {}),
      ...(embedding ? { embedding: [...embedding] } : {}),
      createdAt: deps.clock.now(),
    });

    const rejected = (kind: EvolveRejection['kind'], text: string): Evaluation => ({
      accepted: false,
      stages: [],
      rejection: { kind, message: text },
    });

    const plan = (generation: number): SlotPlan[] => {
      const pending = options.models.map(() => 0);
      const archive = run.archive.map(get);
      const plans: SlotPlan[] = [];
      for (let k = 0; k < options.mutationsPerGeneration; k++) {
        const island = k % config.islandCount;
        const slot = Math.floor(k / config.islandCount);
        const rng = createRng(run.seed, generation, island, slot);
        const members = run.islands[island]!.members.map(get);
        const parent = pickParent(members, archive, {
          rng,
          selection: config.selection,
          eliteRatio: config.eliteRatio,
          exploreRatio: config.exploreRatio,
        });
        const partners = (
          config.islandCount > 1
            ? run.islands.flatMap((state, index) => (index === island ? [] : state.members))
            : run.islands[island]!.members
        )
          .filter((id, index, all) => id !== parent.id && all.indexOf(id) === index)
          .map(get);
        const patchType = pickPatchType(rng, config.patch, partners.length > 0);
        const secondParent =
          patchType === 'cross'
            ? pickParent(partners, [], {
                rng,
                selection: config.selection,
                eliteRatio: 0,
                exploreRatio: 0,
              })
            : undefined;
        const inspirations = pickInspirations(
          [...members, ...archive],
          secondParent ? [parent.id, secondParent.id] : [parent.id],
          { rng, top: config.top, diverse: config.diverse },
        );
        const model =
          options.models.length === 1 ? 0 : chooseModel(run.bandit, config.weights, pending);
        pending[model]!++;
        plans.push({
          id: evolveCandidateId(generation, island, slot),
          island,
          slot,
          patchType,
          parent,
          secondParent,
          inspirations,
          model,
          failures: failures[island] ?? [],
        });
      }
      return plans;
    };

    let budgetHit = false;
    const runSlot = async (
      slot: SlotPlan,
      generation: number,
      stored: ReadonlyMap<string, EvolveCandidate>,
    ): Promise<SlotOutcome> => {
      const existing = stored.get(slot.id);
      if (existing) {
        cache.set(existing.id, existing);
        emit({ type: 'candidate', candidate: existing, replayed: true });
        return { candidate: existing };
      }
      if (budgetHit) return { skipped: 'budget' };
      if (controller.signal.aborted) return { skipped: 'aborted' };
      const context = {
        instructions: options.instructions,
        patchType: slot.patchType,
        generation,
        parent: promptProgram(slot.parent),
        ...(slot.secondParent ? { secondParent: promptProgram(slot.secondParent) } : {}),
        inspirations: slot.inspirations.map(promptProgram),
        failures: slot.failures.map(promptProgram),
      };
      const prompt = (options.buildPrompt ?? buildMutationPrompt)(context);
      let evaluation: Evaluation | undefined;
      let program = slot.parent.program;
      let embedding: readonly number[] | undefined;
      let text: string | undefined;
      try {
        const response = await generateText({
          model: options.models[slot.model]!.model,
          instructions: prompt.system,
          prompt: prompt.prompt,
          execution: execution.child({ scopeId: slot.id }),
          signal: controller.signal,
          ...(options.maxOutputTokens !== undefined
            ? { maxOutputTokens: options.maxOutputTokens }
            : {}),
          ...(options.deps ? { deps: options.deps } : {}),
        });
        modelCalls++;
        text = response.text;
      } catch (error) {
        if (isBudgetExceeded(error)) {
          budgetHit = true;
          return { skipped: 'budget' };
        }
        if (controller.signal.aborted) return { skipped: 'aborted' };
        if (writeFailure) throw writeFailure;
        // The run fails once the slots already in flight finish, keeping their paid work.
        if (isFatalModelError(error)) throw error;
        // An open circuit breaker fails fast without sending a request.
        if (!(isDeuzError(error) && error.code === 'breaker_open')) modelCalls++;
        evaluation = rejected('model', message(error));
      }
      if (text !== undefined) {
        try {
          program =
            slot.patchType === 'diff'
              ? applySearchReplace(slot.parent.program, text)
              : extractFullRewrite(slot.parent.program, text);
        } catch (error) {
          if (!(error instanceof EvolvePatchError)) throw error;
          evaluation = rejected('patch', `${error.code}: ${error.message}`);
        }
      }
      const members = run.islands[slot.island]!.members.map(get);
      if (!evaluation && members.some((member) => member.program === program))
        evaluation = rejected('duplicate', 'The program is identical to a population member');
      if (!evaluation && options.novelty) {
        embedding = (await embed([program]))[0];
        if (!embedding) throw new Error('The novelty embedder returned no vector');
        let closest: { member: EvolveCandidate; cosine: number } | undefined;
        for (const member of members) {
          const cosine = cosineSimilarity([...embedding], [...(await embeddingOf(member))]);
          if (!closest || cosine > closest.cosine) closest = { member, cosine };
        }
        if (closest && closest.cosine >= config.maxCosine) {
          const keep = options.novelty.judge
            ? await options.novelty.judge({
                program,
                similar: {
                  id: closest.member.id,
                  program: closest.member.program,
                  cosine: closest.cosine,
                },
              })
            : false;
          if (!keep)
            evaluation = rejected(
              'novelty',
              `Cosine ${closest.cosine.toFixed(4)} to ${closest.member.id} is at or above ${config.maxCosine}`,
            );
        }
      }
      try {
        evaluation ??= await evaluate(program, { id: slot.id, generation, island: slot.island });
      } catch (error) {
        if (error instanceof StopSignal) return { skipped: 'aborted' };
        throw error;
      }
      const candidate = makeCandidate(slot, generation, program, evaluation, embedding);
      await store.putCandidate(candidate);
      cache.set(candidate.id, candidate);
      emit({ type: 'candidate', candidate, replayed: false });
      return { candidate };
    };

    /**
     * Fold a generation into the population, archive, bandit and best score.
     * Pure: `run` stays the committed state until the commit lands, because
     * ledger saves in between write `run` under the old generation number.
     */
    const integrate = (generation: number, produced: EvolveCandidate[]): Integrated => {
      const notices: EvolveEvent[] = [];
      const accepted = produced.filter((item) => item.accepted);
      let islands = run.islands.map((state, index) => {
        // Slot order decides which of two identical siblings joins, so replays agree.
        const programs = new Set(state.members.map((id) => get(id).program));
        const joined = [...state.members];
        for (const item of accepted) {
          if (item.island !== index || programs.has(item.program)) continue;
          programs.add(item.program);
          joined.push(item.id);
        }
        return [...new Set(joined)];
      });
      const truncate = (ids: string[]) =>
        rankCandidates(ids.map(get))
          .slice(0, config.size)
          .map((item) => item.id);
      islands = islands.map(truncate);
      if (
        config.islandCount > 1 &&
        config.migrationEvery !== undefined &&
        generation % config.migrationEvery === 0 &&
        config.migrationRate > 0
      ) {
        const before = islands.map((ids) => [...ids]);
        islands = islands.map((ids, to) => {
          const from = (to + config.islandCount - 1) % config.islandCount;
          const source = before[from]!;
          const migrants = source
            .slice(0, Math.max(1, Math.ceil(source.length * config.migrationRate)))
            .filter((id) => !ids.includes(id));
          if (migrants.length)
            notices.push({ type: 'migration', generation, from, to, ids: migrants });
          return truncate([...ids, ...migrants]);
        });
      }
      const pulls = [...run.bandit.pulls];
      const rewards = [...run.bandit.rewards];
      for (const item of produced) {
        if (item.model === undefined) continue;
        pulls[item.model] = (pulls[item.model] ?? 0) + 1;
        const parent = item.parentId ? cache.get(item.parentId) : undefined;
        const improved =
          item.accepted &&
          item.score !== undefined &&
          (!parent?.accepted || parent.score === undefined || item.score > parent.score);
        if (improved) rewards[item.model] = (rewards[item.model] ?? 0) + 1;
      }
      let bestId = run.bestId;
      let bestScore = run.bestScore;
      const top = rankCandidates(accepted)[0];
      if (top?.score !== undefined && (bestScore === undefined || top.score > bestScore)) {
        bestId = top.id;
        bestScore = top.score;
      }
      const improved = bestId !== run.bestId;
      if (improved)
        notices.push({ type: 'improvement', generation, candidateId: bestId!, score: bestScore! });
      if (
        config.islandCount > 1 &&
        config.resetWeakestEvery !== undefined &&
        generation % config.resetWeakestEvery === 0 &&
        bestId
      ) {
        const top = islands.map((ids) => {
          const first = ids.length ? get(ids[0]!) : undefined;
          return first?.accepted
            ? (first.score ?? Number.NEGATIVE_INFINITY)
            : Number.NEGATIVE_INFINITY;
        });
        const worst = Math.min(...top);
        const island = top.lastIndexOf(worst);
        if (!islands[island]!.includes(bestId) && worst < bestScore!) {
          islands[island] = [bestId];
          notices.push({ type: 'island.reset', generation, island, seedId: bestId });
        }
      }
      const next: EvolveRunRecord = {
        ...run,
        generation,
        islands: islands.map((ids) => {
          const first = ids.length ? get(ids[0]!) : undefined;
          return {
            members: ids,
            ...(first?.accepted ? { bestId: first.id } : {}),
            ...(first?.accepted && first.score !== undefined ? { bestScore: first.score } : {}),
          };
        }),
        archive: updateArchive(
          run.archive,
          accepted.map((item) => item.id),
          cache,
          { archiveSize: config.archiveSize, featureBins: config.featureBins },
        ),
        bandit: { pulls, rewards },
        ...(bestId ? { bestId } : {}),
        ...(bestScore !== undefined ? { bestScore } : {}),
        stale: improved || generation === 0 ? 0 : run.stale + 1,
      };
      return {
        next,
        notices,
        failures: run.islands.map((_, index) =>
          produced.filter((item) => !item.accepted && item.island === index).slice(-2),
        ),
      };
    };

    const commit = async ({ next, notices, failures: failed }: Integrated) => {
      await write(() =>
        store.commitGeneration({
          ...key,
          expectedGeneration: next.generation - 1,
          run: { ...next, executionState: execution.snapshot(), updatedAt: deps.clock.now() },
        }),
      );
      run = next;
      failures = failed;
      for (const notice of notices) emit(notice);
      emit({ type: 'generation.committed', generation: next.generation, bestScore: run.bestScore });
      // Keep only what later generations can reference.
      const keep = new Set([
        ...run.islands.flatMap((state) => state.members),
        ...run.archive,
        ...(run.bestId ? [run.bestId] : []),
      ]);
      for (const id of [...cache.keys()]) if (!keep.has(id)) cache.delete(id);
    };

    try {
      if (leasing) {
        held = await leasing.provider.acquire({
          key: `evolve:${JSON.stringify([key.scope, key.runId])}`,
          owner: leasing.owner ?? deps.generateId(),
          ttlMs: leaseTtl,
        });
        if (!held) throw new EvolveLeaseError('held');
        beat();
      }
      if (mode === 'create') {
        const seed = options.seed !== undefined ? String(options.seed) : deps.generateId();
        const now = deps.clock.now();
        run = {
          ...key,
          kind: 'deuz-evolve',
          version: 1,
          seed,
          status: 'running',
          generation: -1,
          islandCount: config.islandCount,
          mutationsPerGeneration: options.mutationsPerGeneration,
          modelCount: options.models.length,
          islands: Array.from({ length: config.islandCount }, () => ({ members: [] })),
          archive: [],
          bandit: {
            pulls: options.models.map(() => 0),
            rewards: options.models.map(() => 0),
          },
          stale: 0,
          createdAt: now,
          updatedAt: now,
        };
        await store.createRun(run);
      } else {
        const loaded = await store.loadRun(key);
        if (!loaded) throw new Error('Evolve run not found');
        if (
          loaded.islandCount !== config.islandCount ||
          loaded.mutationsPerGeneration !== options.mutationsPerGeneration ||
          loaded.modelCount !== options.models.length
        )
          throw new Error(
            'The resumed run has a different shape (islands, mutationsPerGeneration or models)',
          );
        if (options.seed !== undefined && String(options.seed) !== loaded.seed)
          throw new Error('The resumed run was recorded with a different seed');
        run = loaded;
      }
      owned = true;
      const persist = (ledger: BudgetLedgerSnapshot) =>
        write(() => store.saveRun(withState(ledger)));
      execution = run.executionState
        ? createExecutionContext({
            snapshot: run.executionState,
            budget: options.budget,
            policy: options.policy,
            persist,
          })
        : createExecutionContext({
            scopeId: JSON.stringify(['evolve', key.scope, key.runId]),
            budget: options.budget,
            policy: options.policy,
            persist,
          });

      const seedId = evolveCandidateId(0, 0, 0);
      if (run.generation >= 0) {
        await load([seedId]);
        if (get(seedId).program !== options.initial)
          throw new Error('The resumed run was started from a different initial program');
        if (
          run.status === 'completed' &&
          !(run.reason === 'generations' && options.generations > run.generation)
        )
          return await finish('completed', run.reason ?? 'generations');
        await load([
          ...run.islands.flatMap((state) => state.members),
          ...run.archive,
          ...(run.bestId ? [run.bestId] : []),
        ]);
        const last = await store.listCandidates(key, { generation: run.generation });
        failures = run.islands.map((_, index) =>
          last.filter((item) => !item.accepted && item.island === index).slice(-2),
        );
      }
      run = { ...run, status: 'running' };
      delete (run as { reason?: unknown }).reason;
      delete (run as { error?: unknown }).error;
      await saveRun();

      if (run.generation < 0) {
        emit({ type: 'generation.started', generation: 0 });
        const [stored] = await store.listCandidates(key, { ids: [seedId] });
        let seed = stored;
        if (seed) {
          if (seed.program !== options.initial)
            throw new Error('The resumed run was started from a different initial program');
          emit({ type: 'candidate', candidate: seed, replayed: true });
        } else {
          let evaluation: Evaluation;
          try {
            evaluation = await evaluate(options.initial, { id: seedId, generation: 0, island: 0 });
          } catch (error) {
            if (error instanceof StopSignal)
              return await finish('stopped', stopReason ?? 'cancelled');
            throw error;
          }
          const embedding = options.novelty ? (await embed([options.initial]))[0] : undefined;
          seed = makeCandidate(
            { id: seedId, island: 0, slot: 0 },
            0,
            options.initial,
            evaluation,
            embedding,
          );
          await store.putCandidate(seed);
          emit({ type: 'candidate', candidate: seed, replayed: false });
        }
        cache.set(seed.id, seed);
        run = {
          ...run,
          islands: run.islands.map(() => ({ members: [seedId] })),
        };
        await commit(integrate(0, [seed]));
      }
      // The seed, or the run being resumed, may already meet `stopWhen`.
      const reached = stopReached();
      if (reached) return await finish('completed', reached);

      for (let generation = run.generation + 1; generation <= options.generations; generation++) {
        if (controller.signal.aborted) return await finish('stopped', stopReason ?? 'cancelled');
        if (draining) return await finish('stopped', 'drained');
        emit({ type: 'generation.started', generation });
        const plans = plan(generation);
        const stored = new Map(
          (await store.listCandidates(key, { generation })).map((item) => [item.id, item]),
        );
        const outcomes = await mapWithConcurrency(
          plans,
          config.concurrency,
          (slot) => runSlot(slot, generation, stored),
          { drainOnError: true },
        );
        if (writeFailure) throw writeFailure;
        if (controller.signal.aborted) return await finish('stopped', stopReason ?? 'cancelled');
        const produced = outcomes.flatMap((outcome) =>
          'candidate' in outcome ? [outcome.candidate] : [],
        );
        if (budgetHit && !produced.length) return await finish('stopped', 'budget');
        const integrated = integrate(generation, produced);
        for (const slot of plans)
          await execution.ledger.compact(childScopeId(execution.scopeId, slot.id));
        await commit(integrated);
        if (budgetHit) return await finish('stopped', 'budget');
        const stop = stopReached();
        if (stop) return await finish('completed', stop);
      }
      return await finish('completed', 'generations');
    } catch (error) {
      const cause = writeFailure ?? error;
      // After losing the lease the run belongs to the next executor.
      if (owned && !leaseLost) {
        await queue;
        try {
          await store.saveRun({
            ...withState(),
            status: 'failed',
            reason: 'error',
            error: message(cause),
          });
        } catch {
          /* A newer writer owns the run; its state wins. */
        }
      }
      emit({ type: 'run.finished', status: 'failed', reason: 'error' });
      throw cause;
    } finally {
      beating = false;
      stopBeat?.();
      if (held && !leaseLost) await leasing!.provider.release(held).catch(() => {});
    }
  }

  return {
    result,
    events() {
      return {
        async *[Symbol.asyncIterator]() {
          let index = 0;
          for (;;) {
            while (index < events.length) yield events[index++]!;
            if (finished) return;
            await new Promise<void>((resolve) => waiters.add(resolve));
          }
        },
      };
    },
    async cancel() {
      stopReason ??= 'cancelled';
      controller.abort(new Error('Evolve cancelled'));
      await result.catch(() => {});
    },
    async drain() {
      draining = true;
      await result.catch(() => {});
    },
  };
}
