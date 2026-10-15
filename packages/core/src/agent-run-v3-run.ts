/**
 * @internal The V3 native run's runtime (2.4, spec §2.3, §2.5, §4.1), loaded
 * on demand by the native executor when a run passes `checkpointVersion: 3`,
 * so a 2.3 run never pulls it in. The executor stays one: this module checks
 * a V3 run's configuration and builds what the executor hands its loop — the
 * context compiler's hook, the working memory and the memory tools — keeping
 * their state in the V3 run record. Edge-safe.
 */
import { assertAgentRunStoreV3 } from './agent-run-v3';
import { contextPackageBlob, readContextPackage } from './agent-run-v3-context';
import { createContextCompiler } from './context/compiler';
import { estimateRequestOverhead } from './context/count';
import { sha256DigestSync } from './context/sha256';
import type {
  ContextCompiler,
  ContextEstimator,
  ContextPackage,
  ContextStepInput,
  CreateContextCompilerOptions,
} from './context/types';
import { createWorkingMemory } from './context/working-memory';
import type { WorkingMemorySnapshot } from './context/working-memory/types';
import { getCapabilities } from './core/registry';
import type { ModelCapabilities } from './core/registry';
import type {
  LoopContextHook,
  LoopContextPlacement,
  LoopContextStep,
} from './inference/loop-context';
import { createTokenEstimator, type TokenEstimator } from './internal/estimate-tokens';
import { withTelemetryParent } from './internal/native-context';
import type { MemoryCallOptions } from './memory';
import type {
  AgentEventV3,
  AgentRunContextStepV3,
  AgentRunEnvelopeV3,
  AgentRunOptionsV3,
  AgentRunSessionV3,
  AgentRunStoreV3,
} from './types/agent-run-v3';
import type { Logger } from './types/deps';
import type { CallWarning } from './types/methods';
import type { Message } from './types/message';
import type { Usage } from './types/usage';
import type { AgentEvent } from './types/agent-run';

/** The events only a V3 run emits (2.4), beside every 2.3 one. */
export type AgentEventV3Only = Exclude<AgentEventV3, AgentEvent>;

/**
 * The configuration-time checks of a V3 run (spec §4.1), before anything is
 * read or written: a session is required, and its store must be an
 * `AgentRunStoreV3` (a Redis run store is refused with
 * `UnsupportedStoreError`, any other non-V3 store with a TypeError).
 */
export function assertV3Session(session: AgentRunSessionV3 | undefined): void {
  if (!session || typeof session !== 'object')
    throw new TypeError(
      'checkpointVersion 3 requires a session ({ store, runId, scope }) with an AgentRunStoreV3.',
    );
  assertAgentRunStoreV3(session.store);
}

/** Whether `value` is a built compiler rather than the options to build one. */
function isCompiler(value: unknown): value is ContextCompiler {
  return (
    value !== null &&
    typeof value === 'object' &&
    typeof (value as ContextCompiler).beforeModelCall === 'function' &&
    typeof (value as ContextCompiler).state === 'function'
  );
}

/**
 * The checks of a V3 run's 2.4 options (spec §2.3 "Kaynak ve devam etme
 * kuralları"), before anything is read or written. Memory placed by the
 * compiler and the legacy automatic recall would inject the same memories
 * twice: a compiler with a memory source and `memory` whose recall is on are
 * refused (`memory.recall: false` keeps the legacy extraction only).
 */
export function assertV3Options(options: AgentRunOptionsV3<unknown>): void {
  const context = options.context;
  if (context !== undefined) {
    if (context === null || typeof context !== 'object')
      throw new TypeError(
        'context must be a ContextCompiler or the options of createContextCompiler.',
      );
    const sources = isCompiler(context) ? context.sources : context.sources;
    if (!Array.isArray(sources))
      throw new TypeError('context needs its sources (a list of ContextSource).');
    const memory = options.memory as MemoryCallOptions | undefined;
    if (
      memory !== undefined &&
      memory.recall !== false &&
      sources.some((source: { kind?: unknown }) => source?.kind === 'memory')
    )
      throw new TypeError(
        'Memory would be injected twice: the context compiler has a memory source and memory.recall is on. ' +
          'Set memory.recall: false (or drop the memory source) so only the compiler places memory.',
      );
  }
  const working = options.workingMemory;
  if (working !== undefined) {
    if (working === null || typeof working !== 'object')
      throw new TypeError('workingMemory must be an object ({ snapshot?, create?, tools? }).');
    if (working.snapshot !== undefined && working.create !== undefined)
      throw new TypeError(
        'workingMemory takes a snapshot to continue or what to create, not both.',
      );
  }
}

/** The working memory a new V3 run starts with (spec §2.5), or none. */
export function initialWorkingMemory(
  options: AgentRunOptionsV3<unknown>,
): WorkingMemorySnapshot | undefined {
  const working = options.workingMemory;
  if (!working) return undefined;
  if (working.snapshot) return structuredClone(working.snapshot);
  if (working.create) return createWorkingMemory(working.create);
  return undefined;
}

/** What `createV3Compiler` built: the compiler, and the estimator the loop calibrates. */
export interface V3Compiler {
  compiler: ContextCompiler;
  /** The host's shared estimator, which the loop calibrates; absent otherwise. */
  shared?: TokenEstimator;
  estimatorKind?: ContextEstimator;
}

/**
 * The run's compiler (spec §2.3): the host's, built from its options with
 * the stored state of a resumed run (so a restart compiles the same), or a
 * source-less one when only working memory is configured (it places the
 * working memory tail). A host-built compiler continues a stored run only
 * when its state is the stored one. Undefined without either.
 */
export function createV3Compiler(
  options: AgentRunOptionsV3<unknown>,
  envelope: AgentRunEnvelopeV3,
  onWarning: (warning: CallWarning) => void,
): V3Compiler | undefined {
  const stored = envelope.context?.compiler;
  const context = options.context;
  if (isCompiler(context)) {
    if (stored && JSON.stringify(context.state()) !== JSON.stringify(stored))
      throw new TypeError(
        "This V3 run's compiler state is stored with the run: resume it with the compiler options " +
          '(the run restores the state), or a compiler built with that state.',
      );
    return { compiler: context };
  }
  if (context === undefined && options.workingMemory === undefined) return undefined;
  const given: CreateContextCompilerOptions = context ?? { sources: [] };
  const deps = given.deps ?? options.deps;
  const own = given.onWarning;
  return {
    compiler: createContextCompiler({
      ...given,
      ...(deps ? { deps } : {}),
      ...(stored ? { state: stored } : {}),
      onWarning: (warning) => {
        own?.(warning);
        onWarning(warning);
      },
    }),
    ...(given.estimator ? { shared: given.estimator } : {}),
    ...(given.estimatorKind ? { estimatorKind: given.estimatorKind } : {}),
  };
}

/** A stable digest of what a step was compiled for: its messages, bytes by their digest. */
function inputDigest(messages: readonly Message[]): string {
  return sha256DigestSync(
    JSON.stringify(messages, (_key, value: unknown) =>
      value instanceof Uint8Array ? { bytes: sha256DigestSync(value) } : value,
    ),
  );
}

/** The package's blocks as the loop places them. */
function placementOf(pkg: ContextPackage): LoopContextPlacement {
  return {
    append: pkg.blocks.filter((block) => block.placement === 'append').flatMap((b) => b.messages),
    tail: pkg.blocks
      .filter((block) => block.placement === 'ephemeral-tail')
      .flatMap((b) => b.messages),
  };
}

/** The share of the failed request's estimate an overflow retry is compiled for. */
const OVERFLOW_RETRY_RATIO = 0.8;

/** What the context hook needs from the executor. */
export interface ContextHookInput {
  compiler: V3Compiler;
  store: AgentRunStoreV3;
  runId: string;
  /** The live V3 record (the executor's envelope). */
  envelope: () => AgentRunEnvelopeV3;
  /** Saves the record (the executor's fenced `persist`). */
  persist: () => Promise<void>;
  emit: (event: AgentEventV3Only) => void;
  capabilities?: Partial<ModelCapabilities>;
  logger: Logger;
}

/**
 * The loop's context hook for a V3 run (spec §2.3 steps 4 to 8, §4.4). For
 * each model step it compiles the package (the compiler refreshes the sources
 * when due), writes the package as a content-addressed blob once (an unchanged
 * package is never written again) and the manifest with the run, then hands
 * the loop the append block and the working memory tail; all of it before
 * the model call.
 *
 * Step numbers count the run's compiled model calls. A step reopened after a
 * restart (the same messages as a recorded step, its answer never saved)
 * uses the stored package again, byte for byte, without asking the sources;
 * a package a `forget` redacted is compiled again (`redacted` in its
 * manifest), the one documented exception. An overflow retry compiles the
 * step again for `OVERFLOW_RETRY_RATIO` of the failed request's estimate.
 */
export function createContextHook(input: ContextHookInput): LoopContextHook {
  const { compiler, store, runId } = input;
  const estimator = compiler.shared ?? createTokenEstimator();
  let calibrated = false;
  /** The step in flight: its number, input digest, package and request estimate. */
  let current: { step: number; input: string; pkg: ContextPackage; estimate: number } | undefined;

  const stepInput = (
    step: LoopContextStep,
    number: number,
    extra: Partial<ContextStepInput> = {},
  ): ContextStepInput => {
    const caps = getCapabilities(step.model, input.logger, input.capabilities);
    const tools = (step.wire?.tools ?? []).map((tool) => ({
      name: tool.name,
      ...(tool.description !== undefined ? { description: tool.description } : {}),
      parameters: tool.parameters,
    }));
    const workingMemory = input.envelope().workingMemory;
    const kind = compiler.estimatorKind ?? { kind: 'heuristic' as const, calibrated: false };
    return withTelemetryParent(
      {
        runId,
        step: number,
        messages: step.messages,
        model: {
          provider: step.model.provider,
          modelId: step.model.modelId,
          contextWindow: caps.contextWindow,
          maxOutputTokens: caps.maxOutput,
        },
        overheadTokens: estimateRequestOverhead(
          { tools, provider: step.model.provider },
          estimator,
        ),
        ...(workingMemory ? { workingMemory } : {}),
        ...(compiler.shared ? { estimatorKind: { kind: kind.kind, calibrated } } : {}),
        ...(step.signal ? { signal: step.signal } : {}),
        ...extra,
      },
      step.telemetry,
    );
  };

  /** Writes the package once by digest and the manifest with the run, then saves. */
  const record = async (step: number, digest: string, pkg: ContextPackage): Promise<void> => {
    const envelope = input.envelope();
    const steps = envelope.context?.steps ?? [];
    const blob = await contextPackageBlob(pkg);
    const ref = { digest: blob.digest, bytes: blob.bytes };
    if (!steps.some((entry) => entry.blob.digest === blob.digest))
      await store.putBlob({ digest: blob.digest, content: blob.content, records: blob.records });
    const entry: AgentRunContextStepV3 = {
      step,
      manifest: { ...pkg.manifest, blob: ref },
      blob: ref,
      input: digest,
    };
    envelope.context = {
      compiler: compiler.compiler.state(),
      steps: [...steps.filter((other) => other.step !== step), entry],
    };
    await input.persist();
    input.emit({ type: 'context', step, manifest: entry.manifest });
  };

  const begin = (step: LoopContextStep, number: number, digest: string, pkg: ContextPackage) => {
    const placement = placementOf(pkg);
    const request = [...step.messages, ...placement.append, ...placement.tail];
    current = {
      step: number,
      input: digest,
      pkg,
      estimate: estimator.estimate(request) + stepInput(step, number).overheadTokens,
    };
    return placement;
  };

  return {
    async beforeModelCall(step) {
      const digest = inputDigest(step.messages);
      const last = input.envelope().context?.steps.at(-1);
      let number = last ? last.step + 1 : 0;
      let redacted = false;
      if (last && last.input === digest) {
        // A reopened step: the same context, unless a forget redacted it.
        const read = await readContextPackage(store, last);
        if (read.status === 'found') return begin(step, last.step, digest, read.package);
        number = last.step;
        redacted = read.status === 'redacted';
      }
      const pkg = await compiler.compiler.beforeModelCall(
        stepInput(step, number, redacted ? { redacted: true } : {}),
      );
      await record(number, digest, pkg);
      return begin(step, number, digest, pkg);
    },

    async onOverflow(step) {
      if (!current) return undefined;
      const failed = current.pkg.manifest.budget;
      const budget = Math.floor(
        Math.min(failed.inputTokens, failed.usedTokens + failed.selectedTokens) *
          OVERFLOW_RETRY_RATIO,
      );
      const pkg = await compiler.compiler.onOverflow({
        ...stepInput(step, current.step),
        inputTokens: budget,
      });
      // Nothing shrank: the retry would be refused again.
      if (!step.compacted && pkg.manifest.budget.selectedTokens >= failed.selectedTokens)
        return undefined;
      const digest = inputDigest(step.messages);
      await record(current.step, digest, pkg);
      return begin(step, current.step, digest, pkg);
    },

    afterModelCall(usage: Usage) {
      if (!compiler.shared || !current) return;
      const actual =
        usage.inputTokens +
        usage.cachedReadTokens +
        usage.cacheWriteTokens +
        usage.cacheWrite1hTokens;
      compiler.shared.calibrate(actual, current.estimate);
      calibrated = true;
    },
  };
}
