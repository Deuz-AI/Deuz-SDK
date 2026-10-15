/**
 * @internal The V3 native run's runtime (2.4, spec §2.3, §2.5, §4.1), loaded
 * on demand by the native executor when a run passes `checkpointVersion: 3`,
 * so a 2.3 run never pulls it in. The executor stays one: this module checks
 * a V3 run's configuration and builds what the executor hands its loop — the
 * context compiler's hook, the working memory and the memory tools — keeping
 * their state in the V3 run record. Edge-safe.
 */
import { assertAgentRunStoreV3 } from './agent-run-v3-assert';
import { isBlockOf, retrievalBlockMarker } from './agent-run-v3-context';
import { contextPackageBlob, readContextPackage } from './agent-run-v3-package';
import { createContextCompiler } from './context/compiler';
import { estimateRequestOverhead } from './context/count';
import { isContextMessage } from './context/render';
import { sha256DigestSync } from './context/sha256';
import type {
  ContextCompiler,
  ContextEstimator,
  ContextPackage,
  ContextStepInput,
  CreateContextCompilerOptions,
} from './context/types';
import {
  applyWorkingMemoryPatch,
  createWorkingMemory,
  workingMemoryTools,
} from './context/working-memory';
import type { WorkingMemoryHandle, WorkingMemorySnapshot } from './context/working-memory/types';
import { getCapabilities } from './core/registry';
import type { ModelCapabilities } from './core/registry';
import type {
  LoopContextHook,
  LoopContextPlacement,
  LoopContextStep,
} from './inference/loop-context';
import { createTokenEstimator, type TokenEstimator } from './internal/estimate-tokens';
import { claimMemoryScopes, sourceScope } from './internal/memory-scope-claims';
import { withTelemetryParent } from './internal/native-context';
import { bindsThinkingToPrefix } from './internal/stable-prefix';
import type { MemoryCallOptions } from './memory';
import { createVersionedMemoryTools } from './memory/versioned/tools';
import type { MemoryExtractionInput, MemorySession } from './memory/versioned/types';
import type {
  AgentEventV3,
  AgentRunContextStepV3,
  AgentRunMemoryIntentV3,
  AgentRunEnvelopeV3,
  AgentRunOptionsV3,
  AgentRunSessionV3,
  AgentRunStoreV3,
} from './types/agent-run-v3';
import type { Clock, Logger, ResolvedDependencies } from './types/deps';
import type { CallWarning } from './types/methods';
import type { NativeExecutionContext } from './types/execution';
import type { Message } from './types/message';
import type { Usage } from './types/usage';
import type {
  AgentEvent,
  AgentRunTranscript,
  AgentToolReceipt,
  AgentToolSet,
} from './types/agent-run';

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
    // A run never reads or writes another tenant's working memory.
    const scope = working.snapshot?.scope ?? working.create?.scope;
    if (scope !== undefined && scope !== options.session.scope)
      throw new TypeError(
        `workingMemory belongs to scope ${JSON.stringify(scope)}, not this run's scope ${JSON.stringify(options.session.scope)}.`,
      );
  }
}

/**
 * Claims every memory scope a V3 run reads or writes for its execution (spec
 * §2.3 "child run yalnızca daraltabilecek", §4.5): the legacy `memory` scope,
 * the versioned memory session's, the compiler's pinned `scope` (when given
 * as options) and the scope each built-in context source was pinned to. A
 * nested run's scopes must each lie within one of its parent run's, by the
 * `claimMemoryScope` / `scopeWithin` rule (a widening throws a TypeError),
 * and its own claim bounds its children in turn. Returns the release, called
 * when the executor ends.
 */
export function claimV3MemoryScopes(
  execution: NativeExecutionContext,
  options: AgentRunOptionsV3<unknown>,
): () => void {
  const context = options.context;
  return claimMemoryScopes(execution, [
    (options.memory as MemoryCallOptions | undefined)?.scope,
    options.versionedMemory?.session?.scope,
    ...(context !== undefined && !isCompiler(context) ? [context.scope] : []),
    ...(context?.sources ?? []).map((source) => sourceScope(source)),
  ]);
}

/**
 * The working memory a new V3 run starts with (spec §2.5): the given
 * snapshot, the one `create` describes, or (tools only) an empty one for the
 * run's scope. None without `workingMemory`.
 */
export function initialWorkingMemory(
  options: AgentRunOptionsV3<unknown>,
  now: number,
): WorkingMemorySnapshot | undefined {
  const working = options.workingMemory;
  if (!working) return undefined;
  if (working.snapshot) return structuredClone(working.snapshot);
  if (working.create) return createWorkingMemory(working.create);
  return createWorkingMemory({ scope: options.session.scope, now });
}

/**
 * The run's working memory (spec §2.5): the snapshot in the V3 record. A
 * model tool's patch changes it in place; it becomes durable with the next
 * save, which is the save of that call's receipt, so the patch and its
 * receipt are in the same native checkpoint.
 */
export function workingMemoryHandle(
  envelope: () => AgentRunEnvelopeV3,
  clock: Clock,
  emit: (event: AgentEventV3Only) => void,
): WorkingMemoryHandle {
  const current = (): WorkingMemorySnapshot => {
    const snapshot = envelope().workingMemory;
    if (!snapshot) throw new TypeError('This V3 run has no working memory.');
    return snapshot;
  };
  return {
    current,
    apply(patch) {
      const result = applyWorkingMemoryPatch(current(), patch, { now: clock.now() });
      if (result.status === 'applied') {
        envelope().workingMemory = result.snapshot;
        emit({ type: 'working-memory', revision: result.snapshot.revision });
      }
      return result;
    },
  };
}

/** The tools a V3 run adds to the host's, and which of them write versioned memory. */
export interface V3ToolSet {
  tools: AgentToolSet;
  /** The versioned-memory write tools (remember, revise, retract), by name. */
  memoryWrites: ReadonlySet<string>;
}

/** The versioned-memory tools that write (recall only reads). */
const MEMORY_WRITES = ['remember', 'revise', 'retract'] as const;

/**
 * The tools a V3 run adds to the host's (spec §2.5, §4.1): the working
 * memory tools with `workingMemory.tools`, and the session's versioned
 * memory tools with `versionedMemory.tools`. A host tool with one of their
 * names is refused at configuration time.
 */
export function v3Tools(
  options: AgentRunOptionsV3<unknown>,
  memory: WorkingMemoryHandle,
): V3ToolSet {
  const tools: AgentToolSet = {};
  const memoryWrites = new Set<string>();
  if (options.workingMemory?.tools)
    Object.assign(tools, workingMemoryTools({ memory, agentPath: options.agentPath ?? [] }));
  const versioned = options.versionedMemory;
  if (versioned?.tools) {
    const memoryTools = createVersionedMemoryTools(versioned.session);
    for (const name of Object.keys(memoryTools)) {
      if (Object.hasOwn(tools, name))
        throw new TypeError(`The V3 run's tool name ${name} is offered twice.`);
      if (MEMORY_WRITES.some((write) => name.endsWith(`_${write}`))) memoryWrites.add(name);
    }
    Object.assign(tools, memoryTools);
  }
  for (const name of Object.keys(tools))
    if (options.tools && Object.hasOwn(options.tools, name))
      throw new TypeError(
        `The tool name ${name} belongs to this V3 run's own tools; rename the host tool.`,
      );
  return { tools, memoryWrites };
}

/**
 * The operation id a versioned memory tool commits under: its name, the
 * execution scope, the model step and the tool call id, as
 * `createVersionedMemoryTools` derives it, so a replayed call reads the same
 * receipt.
 */
export function memoryToolOperationId(
  toolName: string,
  scopeId: string | undefined,
  modelStep: number | undefined,
  toolCallId: string,
): string {
  return JSON.stringify(['memory-tool', toolName, scopeId ?? null, modelStep ?? null, toolCallId]);
}

/** The intent stage a memory tool call's receipt stage records. */
const INTENT_OF: Partial<Record<AgentToolReceipt['stage'], AgentRunMemoryIntentV3['status']>> = {
  executing: 'intended',
  executed: 'committed',
  completed: 'acknowledged',
  'validation-failed': 'acknowledged',
  'projection-failed': 'acknowledged',
};

/**
 * Records a versioned-memory tool write in the run's intents (spec §4.1)
 * as its receipt moves, before the save that persists the receipt, so each
 * stage is durable with it: the intent with the `executing` receipt, before
 * the memory call; `committed` with the `executed` receipt (the memory store
 * committed it and kept its receipt); `acknowledged` with the `completed`
 * receipt, the run's own record of the outcome. A call that threw wrote
 * nothing, and its intent is dropped.
 */
export function trackMemoryIntent(
  envelope: AgentRunEnvelopeV3,
  receipt: AgentToolReceipt,
  scopeId: string | undefined,
  memoryWrites: ReadonlySet<string>,
  emit: (event: AgentEventV3Only) => void,
): void {
  if (!memoryWrites.has(receipt.toolName)) return;
  const operationId = memoryToolOperationId(
    receipt.toolName,
    scopeId,
    receipt.modelStep,
    receipt.toolCallId,
  );
  const intents = envelope.memoryIntents ?? [];
  const index = intents.findIndex((intent) => intent.operationId === operationId);
  if (receipt.stage === 'failed') {
    if (index >= 0) envelope.memoryIntents = intents.filter((_, at) => at !== index);
    return;
  }
  const status = INTENT_OF[receipt.stage];
  if (!status || intents[index]?.status === status) return;
  const intent: AgentRunMemoryIntentV3 = {
    ...intents[index],
    operationId,
    status,
    ...(receipt.modelStep !== undefined ? { modelStep: receipt.modelStep } : {}),
    toolCallId: receipt.toolCallId,
  };
  envelope.memoryIntents =
    index >= 0 ? intents.map((other, at) => (at === index ? intent : other)) : [...intents, intent];
  emit({ type: 'memory-intent', operationId, status });
}

/** The extraction a V3 run's versioned memory asks for (`versionedMemory.extract`), or none. */
export function versionedExtraction(
  options: AgentRunOptionsV3<unknown>,
): Omit<MemoryExtractionInput, 'messages'> | undefined {
  const extract = options.versionedMemory?.extract;
  if (!extract) return undefined;
  return extract === true ? {} : extract;
}

/**
 * What a versioned extraction reads (spec §2.2): the input's last user turn
 * and the run's own turns; the SDK's turns and system messages are left out,
 * and the session's extraction policy decides which of the rest it may read.
 * Each message carries the id the chat projection gives its transcript
 * position (spec §2.4: `resolveSource` resolves a memory source to it):
 * `chatIds` (the run's chat state) where it has one, a stored chat's own id
 * for an input message included, else `<runId>:<index>`.
 */
export function extractionMessages(
  transcript: AgentRunTranscript,
  runId: string,
  chatIds: readonly string[] = [],
): MemoryExtractionInput['messages'] {
  const internal = new Set(transcript.internal);
  const entries: MemoryExtractionInput['messages'][number][] = [];
  let lastUser = -1;
  for (let index = 0; index < transcript.input; index++)
    if (transcript.messages[index]!.role === 'user') lastUser = index;
  const take = (index: number) =>
    entries.push({
      id: chatIds[index] ?? `${runId}:${index}`,
      message: transcript.messages[index]!,
      runId,
    });
  if (lastUser >= 0) take(lastUser);
  for (let index = transcript.input; index < transcript.messages.length; index++)
    if (!internal.has(index) && transcript.messages[index]!.role !== 'system') take(index);
  return entries;
}

/**
 * Runs a run's versioned extraction under its intent (spec §4.1): the run
 * first saves its claim on the intent (`planned`, with the ids of the
 * messages it cites; no plan), then the session prepares the plan and
 * commits it atomically with its receipt under the intent's operation id, in
 * one call, and the
 * acknowledgment copies the receipt into the intent (`acknowledged`, with the
 * mutation count and the request digest). A session that already holds the
 * operation (its acknowledgment was lost) answers from its receipt and
 * applies nothing again, whatever plan a new LLM call would give. Returns
 * false when a save failed (the intent stays where it was, for
 * `reconcileAgentRun`); throws when the session does.
 */
export async function runVersionedExtraction(
  session: MemorySession,
  intent: AgentRunMemoryIntentV3,
  input: MemoryExtractionInput,
  save: () => Promise<boolean>,
  emit?: (event: AgentEventV3Only) => void,
): Promise<boolean> {
  if (intent.status === 'intended') {
    intent.status = 'planned';
    intent.messageIds = input.messages.map((entry) => entry.id);
    if (!(await save())) return false;
    emit?.({ type: 'memory-intent', operationId: intent.operationId, status: 'planned' });
  }
  const result = await session.extract(input, { operationId: intent.operationId });
  intent.status = 'acknowledged';
  intent.requestDigest = result.receipt.requestDigest;
  intent.planned = result.receipt.entries.length;
  intent.receipt = {
    scopeRevision: result.receipt.scopeRevision,
    committedAt: result.receipt.committedAt,
  };
  if (!(await save())) return false;
  emit?.({ type: 'memory-intent', operationId: intent.operationId, status: 'acknowledged' });
  return true;
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

/**
 * The package's blocks as the loop places them. On a model that binds
 * preserved thinking to the transcript prefix (`kept`, Claude 5.x) the
 * working memory block joins the history with the retrieval block once the
 * call succeeded, after it: the step's thinking was generated right after
 * it, so every later request must carry it there byte for byte (spec §2.3:
 * the provider's prefix rules are kept). Each step places the current working
 * memory again at the end; the block reads as replacing every earlier copy.
 * On every other model it is the request's tail only, never history.
 */
function placementOf(pkg: ContextPackage, kept: boolean): LoopContextPlacement {
  const append = pkg.blocks
    .filter((block) => block.placement === 'append')
    .flatMap((b) => b.messages);
  const tail = pkg.blocks
    .filter((block) => block.placement === 'ephemeral-tail')
    .flatMap((b) => b.messages);
  return kept ? { append: [...append, ...tail], tail: [] } : { append, tail };
}

/**
 * The package with its manifest recording that the working memory block
 * joins the history (`placement.tailKept`), on a model that binds thinking to
 * the prefix and when the package has that block.
 */
function withKeptTail(pkg: ContextPackage, kept: boolean): ContextPackage {
  if (!kept || !pkg.manifest.placement.tail) return pkg;
  return {
    ...pkg,
    manifest: { ...pkg.manifest, placement: { ...pkg.manifest.placement, tailKept: true } },
  };
}

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
  /** The history lost redacted retrieval blocks on resume: the next compile is a `redacted` refresh. */
  redacted?: boolean;
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
 * step again for just under the failed request's estimate (a package that
 * placed nothing, with no compaction, leaves the provider's overflow); its
 * package replaces the step's, which stays as the step's `firstAttempt`. A
 * crash during the retry reopens the step from its first attempt's messages
 * (the compaction was never checkpointed): it sends that package again, and
 * its retry the recorded one when the compaction gives the same messages.
 */
export function createContextHook(input: ContextHookInput): LoopContextHook {
  const { compiler, store, runId } = input;
  const estimator = compiler.shared ?? createTokenEstimator();
  let calibrated = false;
  let pendingRedaction = input.redacted === true;
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
          {
            tools,
            provider: step.model.provider,
            ...(step.outputSchema !== undefined ? { outputSchema: step.outputSchema } : {}),
          },
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

  /**
   * Writes the package once by digest and the manifest with the run, then
   * saves. An overflow retry's package (`retry`) replaces the step's, which
   * stays as its `firstAttempt` (the first one only): the compaction during
   * the step is never checkpointed, so a reopened step starts from there.
   */
  const record = async (
    step: number,
    digest: string,
    pkg: ContextPackage,
    retry = false,
  ): Promise<void> => {
    const envelope = input.envelope();
    const steps = envelope.context?.steps ?? [];
    const blob = await contextPackageBlob(pkg);
    const ref = { digest: blob.digest, bytes: blob.bytes };
    if (
      !steps.some(
        (entry) =>
          entry.blob.digest === blob.digest || entry.firstAttempt?.blob.digest === blob.digest,
      )
    )
      await store.putBlob({ digest: blob.digest, content: blob.content, records: blob.records });
    const previous = retry ? steps.find((other) => other.step === step) : undefined;
    const firstAttempt =
      previous?.firstAttempt ??
      (previous?.input !== undefined && previous.input !== digest
        ? { manifest: previous.manifest, blob: previous.blob, input: previous.input }
        : undefined);
    const entry: AgentRunContextStepV3 = {
      step,
      manifest: { ...pkg.manifest, blob: ref },
      blob: ref,
      input: digest,
      ...(firstAttempt ? { firstAttempt } : {}),
    };
    envelope.context = {
      compiler: compiler.compiler.state(),
      steps: [...steps.filter((other) => other.step !== step), entry],
    };
    await input.persist();
    input.emit({ type: 'context', step, manifest: entry.manifest });
  };

  const begin = (
    step: LoopContextStep,
    number: number,
    digest: string,
    pkg: ContextPackage,
    overheadTokens: number,
  ) => {
    const placement = placementOf(pkg, bindsThinkingToPrefix(step.model));
    const request = [...step.messages, ...placement.append, ...placement.tail];
    current = {
      step: number,
      input: digest,
      pkg,
      estimate: estimator.estimate(request) + overheadTokens,
    };
    return placement;
  };

  return {
    async beforeModelCall(step) {
      const digest = inputDigest(step.messages);
      const last = input.envelope().context?.steps.at(-1);
      let number = last ? last.step + 1 : 0;
      // Redacted blocks left the history on resume: the next compile retrieves anew.
      let redacted = pendingRedaction;
      pendingRedaction = false;
      // A reopened step: its messages are the ones its package was compiled
      // for, or those of its first attempt when a crash came during its
      // overflow retry (the compaction in between was never checkpointed).
      const first = last?.firstAttempt;
      const reopened =
        redacted || !last
          ? undefined
          : last.input === digest
            ? last
            : first?.input === digest
              ? { ...first, step: last.step }
              : undefined;
      if (reopened) {
        // The same context, unless a forget redacted it.
        const read = await readContextPackage(store, reopened);
        if (read.status === 'found')
          return begin(
            step,
            reopened.step,
            digest,
            read.package,
            stepInput(step, reopened.step).overheadTokens,
          );
        number = reopened.step;
        redacted = read.status === 'redacted';
      }
      const request = stepInput(step, number, redacted ? { redacted: true } : {});
      const pkg = withKeptTail(
        await compiler.compiler.beforeModelCall(request),
        bindsThinkingToPrefix(step.model),
      );
      await record(number, digest, pkg);
      return begin(step, number, digest, pkg, request.overheadTokens);
    },

    async onOverflow(step) {
      if (!current) return undefined;
      const failed = current.pkg.manifest.budget;
      // The package placed nothing and the history did not shrink: the
      // provider's overflow stands, as in 2.3.
      if (failed.selectedTokens === 0 && !step.compacted) return undefined;
      const digest = inputDigest(step.messages);
      // A step reopened from its first attempt overflowed again and the
      // compaction gave the messages its recorded retry was compiled for: the
      // retry sends that package again (a compiler restored after a restart
      // could not place its optional entries again).
      const recorded = input
        .envelope()
        .context?.steps.find((entry) => entry.step === current!.step);
      if (recorded?.firstAttempt && recorded.input === digest && current.input !== digest) {
        const read = await readContextPackage(store, recorded);
        if (read.status === 'found')
          return begin(
            step,
            recorded.step,
            digest,
            read.package,
            stepInput(step, recorded.step).overheadTokens,
          );
      }
      // The request that overflowed (as estimated) did not fit: the retry is
      // compiled for less than that, so optional context shrinks to what the
      // added-context share of the gap allows and mandatory content must fit.
      const budget = Math.max(
        0,
        Math.min(failed.inputTokens, failed.usedTokens + failed.selectedTokens) - 1,
      );
      // Assigned onto the step input, so the span parent it carries stays.
      const request = Object.assign(stepInput(step, current.step), { inputTokens: budget });
      const pkg = withKeptTail(
        await compiler.compiler.onOverflow(request),
        bindsThinkingToPrefix(step.model),
      );
      // Nothing shrank: the retry would be refused again.
      if (!step.compacted && pkg.manifest.budget.selectedTokens >= failed.selectedTokens)
        return undefined;
      await record(current.step, digest, pkg, true);
      return begin(step, current.step, digest, pkg, request.overheadTokens);
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

/**
 * Drops from a resumed V3 run's history the retrieval blocks of packages a
 * `forget` redacted (spec §4.4), before the run makes its next request, so a
 * forgotten record is never sent again. A block is found by the marker its
 * package wrote (`<deuz_context pass="P" step="S">`), in the run's messages
 * and in every checkpoint. The prompt cache prefix changes there, as a
 * compaction boundary changes it: forget is the documented exception.
 * Returns whether a block was dropped (the next compile then retrieves anew).
 */
export async function dropRedactedContext(
  envelope: AgentRunEnvelopeV3,
  store: AgentRunStoreV3,
): Promise<boolean> {
  const markers: string[] = [];
  const seen = new Map<string, boolean>();
  // A step's first attempt too: a step reopened from it after a crash sent it.
  const packages = (envelope.context?.steps ?? []).flatMap((step) =>
    step.firstAttempt ? [step, step.firstAttempt] : [step],
  );
  for (const { manifest, blob } of packages) {
    if (!manifest.placement.append) continue;
    let redacted = seen.get(blob.digest);
    if (redacted === undefined) {
      redacted = (await store.getBlob(blob.digest)).status === 'redacted';
      seen.set(blob.digest, redacted);
    }
    if (redacted) markers.push(retrievalBlockMarker(manifest.pass, manifest.step));
  }
  if (markers.length === 0) return false;
  let dropped = false;
  const keep = (messages: Message[]): Message[] => {
    // A stand-in a forget left in the stored record carries the marker too.
    const kept = messages.filter((message) => isBlockOf(message, markers) === undefined);
    if (kept.length !== messages.length) dropped = true;
    return kept;
  };
  envelope.messages = keep(envelope.messages);
  for (const checkpoint of Object.values(envelope.checkpoints))
    checkpoint.messages = keep(checkpoint.messages);
  return dropped;
}

/** What a V3 leg needs from the executor before its first save. */
export interface V3LegInput {
  options: AgentRunOptionsV3<unknown>;
  /** The live record (the executor's envelope). */
  envelope: () => AgentRunEnvelopeV3;
  resume: boolean;
  persist: () => Promise<void>;
  emit: (event: AgentEventV3Only) => void;
  /** The run's warnings (a compiler's `context-source-failed`). */
  warn: (warning: CallWarning) => void;
  deps: ResolvedDependencies;
}

/**
 * Prepares a V3 leg right before its first save (spec §2.3, §2.5, §4.4): a
 * new run starts its working memory; a resumed run keeps the stored one and
 * drops the retrieval blocks of packages a `forget` redacted while it was
 * down; the compiler continues from its stored state and the loop gets its
 * context hook. `redacted` says whether the history lost blocks.
 */
export async function prepareV3Leg(
  input: V3LegInput,
): Promise<{ hook?: LoopContextHook; redacted: boolean }> {
  const { options, deps } = input;
  const record = input.envelope();
  if (!input.resume) {
    const snapshot = initialWorkingMemory(options, deps.clock.now());
    if (snapshot) record.workingMemory = snapshot;
  }
  const redacted = input.resume && (await dropRedactedContext(record, options.session.store));
  const compiler = createV3Compiler(options, record, input.warn);
  if (!compiler) return { redacted };
  return {
    redacted,
    hook: createContextHook({
      compiler,
      store: options.session.store,
      runId: record.runId,
      envelope: input.envelope,
      persist: input.persist,
      emit: input.emit,
      ...(options.capabilities ? { capabilities: options.capabilities } : {}),
      logger: deps.logger,
      ...(redacted ? { redacted } : {}),
    }),
  };
}

/**
 * The extraction an intent asks the session for: its options and the run's
 * messages, cited by the ids its claim saved, else by the chat projection's.
 */
function extractionInput(
  envelope: AgentRunEnvelopeV3,
  transcript: AgentRunTranscript,
  intent: AgentRunMemoryIntentV3,
): MemoryExtractionInput {
  const messages = extractionMessages(transcript, envelope.runId, envelope.chat?.messageIds);
  const claimed = intent.messageIds;
  if (claimed && claimed.length === messages.length)
    messages.forEach((entry, index) => (entry.id = claimed[index]!));
  return { ...intent.extraction, messages };
}

/** The extraction intent a V3 run has not acknowledged yet, if any. */
function pendingExtraction(envelope: AgentRunEnvelopeV3): AgentRunMemoryIntentV3 | undefined {
  return envelope.memoryIntents?.find(
    (intent) => intent.extraction !== undefined && intent.status !== 'acknowledged',
  );
}

/**
 * Runs a completed V3 run's versioned extraction after its outcome (spec
 * §4.1), under the intent its terminal commit recorded. Never throws: a
 * failure is reported through `fail`, and the intent stays where it was for
 * `reconcileAgentRun`.
 */
export async function settleVersionedExtraction(
  envelope: AgentRunEnvelopeV3,
  session: MemorySession,
  save: () => Promise<boolean>,
  emit: (event: AgentEventV3Only) => void,
  fail: (message: string, error: unknown) => void,
): Promise<void> {
  const intent = pendingExtraction(envelope);
  if (!intent || !envelope.transcript) return;
  try {
    await runVersionedExtraction(
      session,
      intent,
      extractionInput(envelope, envelope.transcript, intent),
      save,
      emit,
    );
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    fail(
      `The versioned memory extraction of run ${envelope.runId} failed (${reason}); the run's outcome stands, and reconcileAgentRun settles it.`,
      error,
    );
  }
}

/**
 * Settles a V3 run's versioned extractions whose acknowledgment was lost, or
 * that never ran (spec §4.1, `reconcileAgentRun`): the session answers an
 * operation it holds from its receipt and applies nothing again; one it does
 * not hold, it commits now. Returns the settled operation ids.
 */
export async function reconcileVersionedIntents(
  envelope: AgentRunEnvelopeV3,
  session: MemorySession,
  save: () => Promise<void>,
  assertHeld: () => void,
): Promise<string[]> {
  const settled: string[] = [];
  if (!envelope.transcript) return settled;
  for (const intent of envelope.memoryIntents ?? []) {
    if (intent.extraction === undefined || intent.status === 'acknowledged') continue;
    assertHeld();
    await runVersionedExtraction(
      session,
      intent,
      extractionInput(envelope, envelope.transcript, intent),
      async () => {
        await save();
        return true;
      },
    );
    settled.push(intent.operationId);
  }
  return settled;
}

/** A history without the compiler's blocks: what the run's transcript reads (spec §2.3). */
export function withoutContext(messages: Message[]): Message[] {
  return messages.some(isContextMessage)
    ? messages.filter((message) => !isContextMessage(message))
    : messages;
}
