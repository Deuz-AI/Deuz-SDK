import type { CommonCallOptions } from '../types/config';
import type { CallWarning, StopDetails, StreamChatResult } from '../types/methods';
import type { GuardrailPart, StreamPart, ToolRunState } from '../types/stream';
import type { Message } from '../types/message';
import type { Usage, FinishReason } from '../types/usage';
import type {
  ToolCall,
  ToolCallOutcome,
  ToolResult,
  ToolSet,
  StepResult,
  ToolApprovalRequest,
} from '../types/tool';
import type { ResolvedMcpRuntime } from '../mcp/resolve';
import type { WireToolRequest } from '../adapters/types';
import { runStream } from '../core/inference';
import { resolveDependencies } from '../internal/resolve-deps';
import { resolveSignal } from '../internal/resolve-call';
import { createStepTimeout, resolveTimeouts, type StepTimeoutHandle } from '../core/timeout';
import {
  createObservationRuntime,
  counterFields,
  type ObservationRuntime,
} from '../internal/observe-runtime';
import { toObservedError } from '../internal/observe-error';
import { createBroadcaster, createDeferred, lazyAsyncIterable } from '../internal/async-iter';
import { createWarningSink, type WarningSink } from '../internal/warnings';
import type { MemoryMutation } from '../memory';
import {
  blocksToolDispatch,
  createTurnContent,
  stopDetailsFrom,
  type ToolArgMap,
  type TurnContent,
} from './run-step';
import { EMPTY_USAGE, withTotal, fireFinish } from '../core/metering';
import {
  buildWireTools,
  filterWireTools,
  rootStaticWire,
  stabilizeStepWire,
  offeredTools,
  applyPrepareStep,
  setupMcp,
  mergeMcpTools,
  refreshMcpTools,
  catalogChangePolicy,
  legacyCatalogVerdict,
  MCP_CATALOG_CHANGED_STOPPED_BY,
  closeMcp,
  setupCompaction,
  runCompaction,
  retargetCompaction,
  calibrateCompaction,
  recoverFromOverflow,
  isContextOverflow,
  executeTools,
  toToolResultPart,
  toStepResult,
  isUnknownTool,
  bumpErrorGuard,
  normalizeStop,
  needsCost,
  shouldStop,
  sumUsage,
  planToolDispatch,
  policyRefusalOf,
  settlePendingApprovals,
  continueStoredRun,
  requestCountsOf,
  saveCheckpoint,
  prepareChatPersistence,
  persistChat,
  planRecall,
  withSystemBlock,
  startMemoryExtract,
  durableUsage,
  signApprovalRequests,
  preserveClientContext,
  beginLoopObserve,
  endLoopObserve,
  emitStepStarted,
  emitStepCompleted,
  evaluateVerifyStep,
  verifyFeedbackMessage,
  evaluateDoneWhen,
  falseFinishMessage,
  warnFalseFinishConfig,
  FALSE_FINISH_STOPPED_BY,
  evaluateInputGuardrails,
  evaluateOutputGuardrails,
  logGuardrailParts,
  rewriteAssistantText,
  isEmptyTurn,
  GUARDRAIL_INPUT_STOPPED_BY,
  GUARDRAIL_OUTPUT_STOPPED_BY,
  collectHandoffTools,
  hasHandoffTools,
  mergeResultsInCallOrder,
  applyHandoffSwap,
  resumeHandoffState,
  SubAgentSuspension,
  modelGate,
  setModelGate,
  type ActiveAgentState,
  type CatalogChangeVerdict,
  type CompactionTrigger,
  type Denial,
  type DurableResume,
  type DurableRunner,
  type ExecuteExtras,
  type GuardrailLogEntry,
  type HandoffLogEntry,
  type LoopOutcome,
  type ModelGate,
} from './loop-shared';
import type { CompactionEvent } from './compaction';
import type { UsageCostSnapshot } from '../internal/usage-cost';

async function* projectText(source: AsyncIterable<StreamPart>): AsyncGenerator<string> {
  for await (const part of source) {
    if (part.type === 'text-delta') yield part.text;
    else if (part.type === 'error') throw part.error;
  }
}

/**
 * Internal-only knobs (NOT public surface). `resumeFrom` seeds cross-leg
 * counters when the history is already at hand (agentTool child resume);
 * `resumeLoad` defers the checkpoint load into the lazy pump so
 * `resumeStreamFromCheckpoint` keeps the G2 contract (an unknown runId is an
 * `error` part, never a synchronous throw).
 */
export interface StreamToolLoopInternal {
  resumeCost?: UsageCostSnapshot;
  /** Internal native-runner readout. Available after consume() completes. */
  onSnapshot?: (snapshot: StreamToolLoopSnapshot) => void;
  /** Captures the loop outcome in the same native transaction as its checkpoint. */
  onCheckpoint?: (snapshot: StreamToolLoopSnapshot) => void;
  resumeFrom?: DurableResume;
  /**
   * Handoff (2.0): the checkpoint's active agent, re-applied before the first
   * step of a resume leg. Set directly when the history is already at hand; the
   * deferred `resumeLoad` path returns it instead (G2 — the load lives inside
   * the pump).
   */
  resumeHandoff?: { to: string; count: number };
  resumeLoad?: (rt?: ObservationRuntime) => Promise<{
    cost?: UsageCostSnapshot;
    messages: Message[];
    resumeFrom: DurableResume;
    /** Handoff (2.0): `AgentCheckpoint.handoff`, when the checkpoint carried one. */
    handoff?: { to: string; count: number };
    /** Observation (1.6): checkpoint correlation for run.started. */
    observeResume?: { stepId: string; stepIndex: number; checkpointAgeMs?: number };
  }>;
  /** Observation (1.6): resume-leg correlation for run.started. */
  observeResume?: { stepId: string; stepIndex: number; checkpointAgeMs?: number };
  /** Observation (1.6): sub-agent — share the parent runtime, emit no run.* events. */
  observeInherited?: { runtime: ObservationRuntime; parentSpanId?: string };
  /**
   * Native runs (2.3, F01): the MCP runtime the native runner resolved before it
   * admitted the run, because the servers' catalog is part of its resume
   * binding. The loop uses it in place of connecting `options.mcp`, and never
   * closes it: the runner does. Its tools already pass through the runner's
   * effect receipts, and so does every catalog a hot refresh brings.
   */
  mcp?: {
    runtime: ResolvedMcpRuntime;
    /**
     * Called after each hot refresh, before the refreshed catalog reaches the
     * wire. The runner applies its `onCatalogChange` (2.3): it records an
     * accepted catalog, or stops the run; its warnings go out as `warning` parts.
     */
    refreshed(): Promise<CatalogChangeVerdict>;
  };
  /**
   * The warning sink of a run this loop is one part of (2.3), in place of the
   * loop's own: a runner that drives several loops and model calls for one run
   * passes the same sink to each, so the run reports and streams every warning
   * once.
   */
  warnings?: WarningSink;
}

export interface StreamToolLoopSnapshot {
  messages: Message[];
  steps: StepResult[];
  usage: Usage;
  cumulativeUsage: Usage;
  finishReason: FinishReason;
  endReason: LoopOutcome['endReason'];
  stoppedBy?: string;
  pendingApprovals: ToolApprovalRequest[];
  pendingClientCalls: ToolCall[];
  verified?: boolean;
  /** The provider's stop explanation for the last step (2.3), e.g. a refusal's category. */
  stopDetails?: StopDetails;
  /**
   * The tool request the last model call carried (2.3). Native finalization
   * sends the same tools (with `tool_choice: 'none'`), so the conversation's
   * tool definitions stay byte-identical up to the final answer.
   */
  wire?: WireToolRequest;
  error?: unknown;
  handoff?: { to: string; count: number };
}

/**
 * Streaming agentic loop. Produces ONE canonical `fullStream` spanning N model
 * calls: each step's text/reasoning/tool deltas pass through, then `step-finish`,
 * `tool-call` (parsed), `tool-result` (after execution), then the next step —
 * until no tool calls (Gemini guard) or a stop/runaway condition fires. With
 * `session` it checkpoints every step boundary (1.5); `runId` is known
 * synchronously on the result.
 */
export function runStreamToolLoop(
  options: CommonCallOptions,
  internal?: StreamToolLoopInternal,
): StreamChatResult {
  const deps = resolveDependencies(options.deps);
  // Durable identity is synchronous (result.runId) even though the pump is lazy.
  const runId = options.session ? (options.session.runId ?? deps.generateId()) : undefined;
  const broadcaster = createBroadcaster<StreamPart>();
  const usageDeferred = createDeferred<Usage>();
  const finishDeferred = createDeferred<FinishReason>();
  // The last step's stop explanation (2.3): settles with `finishReason`.
  const stopDetailsDeferred = createDeferred<StopDetails | undefined>();
  const fullSub = broadcaster.subscribe();
  const textSub = broadcaster.subscribe();
  // Memory extraction settlement (1.7, D1) — synchronous field, resolved by
  // the pump at the terminal boundary (empty on suspension/error).
  const memoryDeferred =
    options.memory && options.memory.extract !== false
      ? createDeferred<MemoryMutation[]>()
      : undefined;
  // Warnings (1.9): ONE sink for the whole run, so a per-step decision repeated
  // every iteration is reported once. It ALWAYS mirrors to `deps.logger.warn`
  // (internal/warnings.ts), which is why log-only callers see no change — the
  // readout is additive. Unconditional, like `fallback.ts`'s twin: `warnings` is
  // a declared always-present readout, never an opt-in. A runner that owns
  // the whole run may hand in its own sink (2.3).
  const warningSink = internal?.warnings ?? createWarningSink(deps.logger);
  /** MCP name collisions (2.3) reach the same sink. */
  const warn = (warning: CallWarning): void => {
    warningSink.add(warning);
  };
  const warningsDeferred = createDeferred<CallWarning[]>();

  let started = false;
  // Observation settlement (1.6.1) — see runStream's twin.
  const observationDeferred = createDeferred<void>();
  let observationHandle: { settled: Promise<void> } | undefined;
  let rtRef: ObservationRuntime | undefined;
  // 1.9 (consume): the pump promise. The loop's terminal bookkeeping (chat
  // persistence, the last checkpoint) is awaited INSIDE pump AFTER the stream
  // closes, so a drain that stops at the last part would return too early.
  let pumpDone: Promise<void> | undefined;
  function ensureStarted(): void {
    if (started) return;
    started = true;
    pumpDone = pump()
      // pump() catches everything internally; belt-and-braces so awaiting this
      // in consume() can never reject (G2 never-throw).
      .catch(() => {})
      .finally(() => {
        // ONE settlement site for every exit the pump has (finish, suspension,
        // mid-stream error, resume-load failure): `warnings` NEVER rejects and a
        // failed run still resolves with whatever was collected.
        warningsDeferred.resolve(warningSink.list());
        void (async () => {
          try {
            await rtRef?.settled();
          } catch {
            // settlement must never throw
          }
          observationDeferred.resolve();
        })();
      });
  }

  async function pump(): Promise<void> {
    // `let`, because zero-config MCP (2.0) merges the connected servers' tools
    // in before the first step and can REPLACE the set mid-run on a
    // `tools/list_changed` notification.
    let tools: ToolSet = options.tools ?? {};
    /**
     * The LOCAL half of `tools` (everything that is not an MCP catalog): the
     * caller's `tools` until a handoff (2.0) swaps in the active agent's set.
     * Every later merge re-derives `tools` from THIS, so an MCP hot-refresh
     * cannot undo a transfer.
     */
    let ownTools: ToolSet = options.tools ?? {};
    /**
     * The run's MCP connections (2.0). Resolved INSIDE the try below — a
     * connect failure has to become an `error` part, never a throw out of the
     * pump (G2) — and closed in the `finally`, which every exit passes through.
     */
    let mcp: ResolvedMcpRuntime | undefined;
    // Loop start timestamp for `durationExceeds` — pump start, when work
    // actually begins (the shell returns synchronously and lazily, G2).
    const startedAt = deps.clock.now();
    // 1.9: the two cancellation aliases collapse once (`signal` wins), and the
    // timeout layers resolve once. Only `stepMs` is the loop's business —
    // ttft/total belong to each model call (the inner runStream resolves them
    // from the same `options.timeout`), `toolMs` to loop-shared's executeTools.
    const userSignal = resolveSignal(options);
    const timeouts = resolveTimeouts(options.timeout);
    /** The CURRENT step's deadline — undefined (zero cost) when stepMs is unset. */
    let stepTimeout: StepTimeoutHandle | undefined;
    /**
     * A deadline that fires while the step's TOOLS run cannot abort them (that
     * is `timeout.toolMs` / `Tool.timeoutMs`, in loop-shared), so the loop
     * checks it at its own step boundaries. An expiry is a FAILURE — the throw
     * lands in the pump's catch as an `error` part with rejected promises,
     * never a 'aborted' finish (G2).
     */
    const assertStepDeadline = (): void => {
      if (stepTimeout?.expired()) throw stepTimeout.error;
    };
    let messages: Message[] = [...options.messages];
    // Turns THIS call appends (memory extraction input) — tracked as a list so
    // prepareStep/compaction history rewrites can never skew it.
    const appended: Message[] = [];
    // Memory extraction settlement (1.7, D1): resolve the shell's deferred
    // exactly once at every pump exit. `extract=false` on incomplete turns.
    /**
     * Memory observation context (2.0). Assigned once `beginLoopObserve` has
     * run — memory operations parent under the RUN span, not a step's, because
     * the extraction covers the whole turn and outlives every step boundary.
     * Stays undefined on the resume-load failure path, which settles memory
     * before the run span exists.
     */
    let memoryObserve: ExecuteExtras['observe'] | undefined;
    const settleMemory = (extract: boolean): void => {
      if (!memoryDeferred) return;
      const extraction = extract
        ? startMemoryExtract(options, deps, appended, memoryObserve)
        : undefined;
      if (extraction) void extraction.then((mutations) => memoryDeferred.resolve(mutations));
      else memoryDeferred.resolve([]);
    };
    let resumeFrom = internal?.resumeFrom;
    let resumeCost = internal?.resumeCost;
    let resumeHandoff = internal?.resumeHandoff;
    let observeResume = internal?.observeResume;
    // Resume legs pre-create the ROOT runtime so the closure's
    // checkpoint.loaded/failed events share the leg's sequence and precede
    // run.started (§26). Non-resume runs create it in beginLoopObserve.
    const preRt = internal?.resumeLoad ? createObservationRuntime(deps, { runId }) : undefined;
    if (internal?.resumeLoad) {
      try {
        const loaded = await internal.resumeLoad(preRt);
        messages = loaded.messages;
        resumeFrom = loaded.resumeFrom;
        resumeCost = loaded.cost;
        resumeHandoff = loaded.handoff ?? resumeHandoff;
        observeResume = loaded.observeResume ?? observeResume;
      } catch (err) {
        internal.onSnapshot?.({
          messages,
          steps: [],
          usage: EMPTY_USAGE,
          cumulativeUsage: EMPTY_USAGE,
          finishReason: 'error',
          endReason: 'natural',
          pendingApprovals: [],
          pendingClientCalls: [],
          error: err,
        });
        broadcaster.push({ type: 'error', error: err });
        usageDeferred.reject(err);
        finishDeferred.reject(err);
        stopDetailsDeferred.reject(err);
        if (preRt) {
          // run.started never fired — the leg dies at load (checkpoint.failed
          // was emitted by the closure); report the run failure once.
          const span = preRt.startSpan();
          preRt.emit({
            type: 'run.failed',
            spanId: span.spanId,
            status: 'failed',
            durationMs: 0,
            error: toObservedError(err, preRt.capture.errorMessages),
            stepCount: 0,
            ...counterFields(preRt),
          });
        }
        settleMemory(false);
        broadcaster.close();
        return;
      }
    }
    const chatPersistence = await prepareChatPersistence(
      options,
      deps,
      messages,
      internal?.resumeFrom !== undefined || internal?.resumeLoad !== undefined,
    );
    let chatMessages = chatPersistence.messages;
    // A USD budget needs the accumulator even without a price provider (2.3):
    // every model is then unpriced, and `budget.unknownPrice` decides.
    const usageCost =
      !options.execution && (deps.priceProvider || resumeCost || options.budget?.usd !== undefined)
        ? (await import('../internal/usage-cost')).createUsageCostAccumulator({
            priceProvider: deps.priceProvider,
            snapshot: resumeCost,
            unpricedBaseUsage: !resumeCost && (resumeFrom?.usage.totalTokens ?? 0) > 0,
            budget: options.budget,
            warnings: warningSink,
          })
        : undefined;
    if (usageCost)
      options = preserveClientContext(options, {
        ...options,
        onUsage: usageCost.wrap(options.onUsage ?? deps.onUsage),
      });
    // Decision 4 (2.3): every model this run calls, compaction summaries
    // included, passes its own unknown-price gate and that of the loop whose
    // `agentTool` started it. Kept on `deps`, so the tools' copy carries it on.
    const parentGate = modelGate(deps);
    const admitModel: ModelGate | undefined =
      usageCost || parentGate
        ? async (modelId) => {
            await usageCost?.admit(modelId);
            await parentGate?.(modelId);
          }
        : undefined;
    setModelGate(deps, admitModel);
    const durable: DurableRunner | undefined =
      options.session && runId !== undefined
        ? {
            store: options.session.store,
            runId,
            baseUsage: resumeFrom?.usage ?? EMPTY_USAGE,
            stepIndex: resumeFrom?.stepIndex ?? 0,
            approvalRequestCounts: requestCountsOf(resumeFrom?.approvalRequestCounts),
            cost: usageCost,
          }
        : undefined;
    // Observation (1.6): the loop owns the run — inner runStream calls emit
    // only model.* events. Emitted AFTER resumeLoad (checkpoint.loaded first
    // on resume legs); undefined without an observer (fast path).
    const lo = beginLoopObserve(deps, options, {
      operation: 'stream-chat',
      runId,
      resumed: internal?.resumeFrom !== undefined || internal?.resumeLoad !== undefined,
      resumeFromStepId: observeResume?.stepId,
      resumeFromStepIndex: observeResume?.stepIndex,
      runtime: preRt,
      inherited: internal?.observeInherited,
    });
    if (durable && lo) durable.observe = { rt: lo.rt, runSpanId: lo.runSpanId };
    if (lo) {
      rtRef = lo.rt;
      observationHandle = { settled: observationDeferred.promise };
      memoryObserve = { rt: lo.rt, parentSpanId: lo.runSpanId };
    }
    const steps: StepResult[] = [];
    const stopConditions = normalizeStop(options.stopWhen, options.maxSteps ?? 1, options.budget);
    const wantCost = needsCost(stopConditions);
    if (wantCost && !deps.priceProvider) {
      deps.logger.warn('costExceeds: no deps.priceProvider injected — the condition never fires');
    }
    warnFalseFinishConfig(options, deps.logger);
    const errorCounters = new Map<string, number>();
    const compactionRunner = setupCompaction(options, deps);
    let totalUsage: Usage = EMPTY_USAGE;
    let terminalError: unknown;
    let snapshotApprovals: ToolApprovalRequest[] = [];
    let snapshotClientCalls: ToolCall[] = [];
    let lastFinish: FinishReason = 'stop';
    /**
     * The last step's provider finish detail (2.3) — carried onto the loop's
     * `finish` part exactly as a single-turn stream carries it, so a refusal's
     * `stop_details` survives the loop.
     */
    let lastFinishMeta: Record<string, unknown> | undefined;
    /** The tool request of the last model call (2.3), for native finalization. */
    let lastWire: WireToolRequest | undefined;
    let stoppedBy: string | undefined;
    let prevCostUsd = 0;
    let stepIndex = resumeFrom?.stepIndex ?? 0;
    let endReason: LoopOutcome['endReason'] = 'natural';
    let suspend: LoopOutcome['suspend'] | undefined;
    // Verified generation (1.8): attempt counter + final verdict for metadata.
    let verifyAttempts = 0;
    let verified: boolean | undefined;
    // False-finish guard (1.9, N2): its OWN re-drive counter — never shared with
    // verifyAttempts, the two budgets are independent — plus whether the loop is
    // about to accept a finish `doneWhen` rejected (folded into `stoppedBy` at
    // the terminal break, never before it).
    let falseFinishRetries = 0;
    let falseFinishAccepted = false;
    // Guardrails (2.0): the same bulk readout the buffered loop exposes on
    // `providerMetadata.deuz.guardrails`, carried here on the `finish` part — the
    // live `guardrail` parts below are ADDITIONAL, not a replacement, so a
    // consumer that only reads the finish metadata sees the identical list.
    const guardrailLog: GuardrailLogEntry[] = [];
    /** Record a hook's verdicts in the bulk log, then publish one live part each. */
    const emitGuardrails = (parts: GuardrailPart[]): void => {
      logGuardrailParts(guardrailLog, parts);
      for (const part of parts) broadcaster.push(part);
    };
    /** Set by an `onOutput` rewrite/block — rewrites the appended assistant turn. */
    let guardrailText: string | undefined;
    // Handoff (2.0): `undefined` = the ROOT agent is driving. Every accepted
    // transfer REPLACES this snapshot (model + local tools + budget counter);
    // the buffered twin keeps the identical state under the same name.
    let active: ActiveAgentState | undefined;
    /** Every `transfer_to_*` tool of the run, captured once from the ROOT set. */
    let handoffTools: ToolSet = {};
    /**
     * One entry per accepted transfer. It rides on the `finish` part's
     * `deuz.handoffs` — the live `handoff` parts below are ADDITIONAL, so a
     * consumer that only reads the finish metadata sees the identical list.
     */
    const handoffLog: HandoffLogEntry[] = [];
    if (durable && internal?.onCheckpoint) {
      durable.beforeSave = (checkpoint) => {
        const stopDetails = stopDetailsFrom(lastFinishMeta);
        internal.onCheckpoint!({
          messages: checkpoint.messages,
          steps: [...steps],
          usage: withTotal(totalUsage),
          cumulativeUsage: checkpoint.usage,
          finishReason: lastFinish,
          endReason,
          stoppedBy,
          pendingApprovals: checkpoint.pendingApprovals ?? [],
          pendingClientCalls: snapshotClientCalls,
          verified,
          ...(stopDetails ? { stopDetails } : {}),
          ...(checkpoint.handoff ? { handoff: checkpoint.handoff } : {}),
        });
      };
    }

    // Mutated per iteration so tool events parent under the current step span;
    // settle-phase executions run step-less under the run span.
    const observeCtx = lo
      ? {
          rt: lo.rt,
          parentSpanId: lo.runSpanId as string | undefined,
          stepIndex: undefined as number | undefined,
          counters: errorCounters,
          approvalWaitMs: observeResume?.checkpointAgeMs,
        }
      : undefined;

    /** Checkpoint correlation for run.suspended (stepIndex bumped inside saveCheckpoint). */
    const checkpointRef = (): { checkpointStepId?: string; checkpointStepIndex?: number } =>
      durable
        ? {
            checkpointStepId: `${durable.runId}#${durable.stepIndex}`,
            checkpointStepIndex: durable.stepIndex,
          }
        : {};

    /** Terminal observe event — exactly one per leg (guarded by the runtime too). */
    const observeEnd = (): void => {
      if (!lo) return;
      endLoopObserve(lo, deps, options, {
        finishReason: lastFinish,
        endReason,
        stoppedBy,
        stepCount: steps.length,
        usage: withTotal(totalUsage),
        ...(durable ? { cumulativeUsage: withTotal(durableUsage(durable, totalUsage)) } : {}),
        suspend,
      });
    };

    /**
     * SDK-level metadata for the `finish` part (`stoppedBy`, `verified`,
     * `guardrails`, `handoffs`) — the streaming twin of the buffered loop's
     * `deuzMetadata()`. ONE builder for every terminal path, so a run that ends
     * early (an input guardrail refusing it) reports the same shape as one that
     * ran to the end.
     */
    const finishMeta = (): Record<string, unknown> | undefined => {
      const meta: Record<string, unknown> = {};
      if (stoppedBy) meta.stoppedBy = stoppedBy;
      if (verified !== undefined) meta.verified = verified;
      if (guardrailLog.length > 0) meta.guardrails = guardrailLog;
      if (handoffLog.length > 0) meta.handoffs = handoffLog;
      return Object.keys(meta).length > 0 ? meta : undefined;
    };

    /**
     * The pump's terminal FAILURE path, in ONE place: error part, rejected
     * promises, run.failed, close, then the post-terminal bookkeeping every
     * other exit also performs. Both the inner-stream error case and the pump's
     * outer catch route through it so the two can never drift apart.
     */
    const failRun = async (error: unknown): Promise<void> => {
      terminalError = error;
      // What the run collected still reaches the stream (2.3).
      flushWarnings();
      // A call the execution policy refused ends the run; the stream still says
      // which call it was, and why (2.3), before the error.
      const refused = policyRefusalOf(error);
      if (refused !== undefined) {
        toolState(refused, toolNames.get(refused), 'error', undefined, 'permission-denied');
      }
      broadcaster.push({ type: 'error', error });
      usageDeferred.reject(error);
      finishDeferred.reject(error);
      stopDetailsDeferred.reject(error);
      if (lo) {
        endLoopObserve(lo, deps, options, {
          finishReason: 'error',
          endReason,
          stepCount: steps.length,
          usage: withTotal(totalUsage),
          error,
        });
      }
      broadcaster.close();
      settleMemory(false);
      // Completed turns up to the failure still persist (best-effort).
      await persistChat(options, deps, chatMessages, chatPersistence.writable);
    };

    const extras: ExecuteExtras = {
      // Effective onUsage (call-level wins, G10) so a sub-agent's usage
      // reaches the same callback the caller set.
      deps: { ...deps, onUsage: options.onUsage ?? deps.onUsage },
      reportUsage: (u) => {
        totalUsage = sumUsage(totalUsage, u);
      },
      // Live sink: an agentTool forwards its stream, already wrapped as sub-agent parts.
      emitPart: (part) => broadcaster.push(part),
      // Durable seam (1.5): child checkpoints + suspended-approval settlement.
      ...(durable
        ? {
            session: {
              store: durable.store,
              runId: durable.runId,
              durability: options.session?.durability,
            },
          }
        : {}),
      ...(options.approvalResponses ? { approvalResponses: options.approvalResponses } : {}),
      ...(observeCtx ? { observe: observeCtx } : {}),
      // onToolResult verdicts (2.2) stream and log like every other hook's.
      onGuardrail: (parts) => emitGuardrails(parts),
    };

    /**
     * Push what the sink recorded and no stream carried yet as live `warning`
     * parts (1.9). The sink stays the single owner of dedup, of the 50-entry
     * cap and of what was carried (`take`, 2.3): a warning a step's own stream
     * already carried, and this loop forwarded, never goes out twice.
     */
    const flushWarnings = (): void => {
      for (const warning of warningSink.take()) broadcaster.push({ type: 'warning', warning });
    };

    const emitApprovalRequests = (requests: ToolApprovalRequest[]): void => {
      snapshotApprovals = requests;
      for (const r of requests) {
        broadcaster.push({
          type: 'tool-approval-request',
          approvalId: r.approvalId,
          toolCallId: r.toolCallId,
          toolName: r.toolName,
          input: r.input,
          ...(r.agentPath && r.agentPath.length > 0 ? { agentPath: r.agentPath } : {}),
          ...(r.token ? { token: r.token } : {}),
        });
      }
    };

    // Tool state machine (1.7): one part per lifecycle transition.
    //
    // `denial` (1.9) qualifies a TERMINAL 'error' whose cause was an approval
    // verdict rather than a thrown tool: without it the last frame of the
    // approval flow reads "getWeather failed", which is the wrong story for a
    // call a human refused. It changes ONLY what the UI is told — the model
    // still receives the same is_error tool_result it always did, and the
    // reason is the one the denier supplied (never invented here).
    //
    // `outcome` (2.3) names what the dispatch contract decided — set with a
    // terminal 'error' and with 'awaiting-approval'.
    const toolState = (
      toolCallId: string,
      toolName: string | undefined,
      state: ToolRunState,
      denial?: Denial,
      outcome?: ToolCallOutcome,
    ): void => {
      broadcaster.push({
        type: 'tool-state',
        toolCallId,
        ...(toolName ? { toolName } : {}),
        state,
        ...(denial
          ? { denied: true, ...(denial.reason ? { deniedReason: denial.reason } : {}) }
          : {}),
        ...(outcome ? { outcome } : {}),
      });
    };
    /** The tool name behind each streamed `tool-call` id (a policy refusal names only the id). */
    const toolNames = new Map<string, string>();
    /** The `tool-result` part and terminal `tool-state` part for one settled call. */
    const publishResult = (r: ToolResult, denial?: Denial): void => {
      broadcaster.push({
        type: 'tool-result',
        toolCallId: r.toolCallId,
        toolName: r.toolName,
        output: r.result,
        ...(r.isError ? { isError: true } : {}),
        ...(r.outcome ? { outcome: r.outcome } : {}),
      });
      toolState(r.toolCallId, r.toolName, r.isError ? 'error' : 'complete', denial, r.outcome);
    };

    try {
      // A plain leg of a stored durable run continues its step counter (2.3), so
      // no approval is bound to a step the run already used. Inside the try: a
      // strict read failure ends the run as an `error` part (G2).
      const suspendedAt =
        durable && resumeFrom === undefined
          ? await continueStoredRun(durable, options, deps)
          : undefined;
      // What a mid-run MCP catalog change does (2.3); an unknown value fails the run.
      const catalogPolicy = catalogChangePolicy(options);
      // Zero-config MCP (2.0): connect BEFORE the wire is built so the servers'
      // tools ride the very first model call. Inside the try on purpose — an
      // unreachable server rejects here, and the pump's catch turns that into an
      // `error` part with rejected promises, which is what keeps G2 intact.
      mcp = internal?.mcp ? internal.mcp.runtime : await setupMcp(options, deps, warn);
      tools = mergeMcpTools(mcp, ownTools, warn);
      // Handoff (2.0): the transfer catalog is read from the ROOT set, ONCE — an
      // agent's own set never carries a transfer to itself, so re-deriving it
      // later would lose targets one by one.
      handoffTools = collectHandoffTools(tools);
      // A resume leg re-applies the checkpoint's overlay BEFORE the wires are
      // built and before the pending approvals settle: those settled calls
      // belong to the agent that issued them, and it is no longer the root one.
      // The system message needs nothing — it rode in with the checkpointed
      // history.
      if (resumeHandoff) {
        active = resumeHandoffState(
          resumeHandoff,
          ownTools,
          handoffTools,
          options.model,
          deps.logger,
        );
        ownTools = active.tools;
        tools = mergeMcpTools(mcp, ownTools, warn);
        if (durable) durable.handoff = resumeHandoff;
        retargetCompaction(compactionRunner, options, deps, active.model);
      }
      let fullWire = await buildWireTools(tools, options.toolChoice, options.maxToolConcurrency);
      let staticWire = filterWireTools(fullWire, options.activeTools, deps.logger, warningSink);
      flushWarnings();
      // The tools array a request to a model that binds thinking to the prefix
      // carries on every step of the leg (2.3, F22): the ROOT agent's static
      // wire, also on a leg that resumes as a handoff target.
      const declaredWire = active ? await rootStaticWire(options, mcp) : staticWire;

      // Resume: settle the previous break's pending approvals BEFORE step 1 —
      // their tool-result parts precede the first step-start. A durable
      // sub-agent that re-suspends here suspends THIS run again immediately.
      try {
        const settled = await settlePendingApprovals(
          messages,
          // The pending calls were issued BEFORE the transfer, by an agent whose
          // tools the overlay above has already replaced. Settling them against
          // the active set alone would report a human-APPROVED call as a
          // hallucinated name, so the settle — and only the settle — also sees
          // the set the call came in with.
          active ? mergeMcpTools(mcp, { ...(options.tools ?? {}), ...active.tools }) : tools,
          options,
          extras,
          {
            beforeExecute: (calls, deniedIds) => {
              for (const call of calls) {
                // Unknown names never execute either (1.9) — no 'executing' state.
                if (!deniedIds.has(call.toolCallId) && !isUnknownTool(tools, call.toolName)) {
                  toolState(call.toolCallId, call.toolName, 'executing');
                }
              }
            },
          },
          { ...(active ? { active } : {}), tools: handoffTools },
          // The identity the suspended leg bound its approvals to (2.3).
          {
            runId: durable?.runId,
            step: resumeFrom?.stepIndex ?? suspendedAt,
            approvalRequestCounts: durable?.approvalRequestCounts,
          },
        );
        if (settled) {
          const settledMessages = settled.messages.slice(messages.length);
          appended.push(...settledMessages);
          chatMessages = [...chatMessages, ...settledMessages];
          messages = settled.messages;
          emitGuardrails(settled.guardrails);
          for (const r of settled.results) {
            // The resume leg's verdicts (explicit `approvalResponses` denial,
            // default-deny, an unverifiable signed approval, a client tool the
            // caller never answered) carry the reason the CLIENT supplied — it
            // reaches the UI here or nowhere.
            publishResult(r, settled.denied.get(r.toolCallId));
          }
          // A transfer left unanswered by an earlier leg is applied HERE: from
          // this point the resume leg is the target agent.
          if (settled.handoff?.accepted) {
            const swap = applyHandoffSwap(
              settled.handoff.accepted,
              active,
              handoffTools,
              messages,
              stepIndex,
            );
            active = swap.active;
            messages = swap.messages;
            handoffLog.push(swap.entry);
            broadcaster.push({ type: 'handoff', ...swap.entry });
            ownTools = active.tools;
            tools = mergeMcpTools(mcp, ownTools, warn);
            fullWire = await buildWireTools(tools, options.toolChoice, options.maxToolConcurrency);
            staticWire = filterWireTools(fullWire, options.activeTools, deps.logger, warningSink);
            flushWarnings();
            retargetCompaction(compactionRunner, options, deps, active.model);
            if (durable) durable.handoff = { to: active.name!, count: active.handoffCount };
          }
          // A synthesized transfer answer is a verdict, not a tool failure — the
          // same exclusion the in-step path applies.
          const handoffIds = new Set(settled.handoff?.results.map((r) => r.toolCallId) ?? []);
          bumpErrorGuard(
            errorCounters,
            settled.results.filter(
              (r) => !settled.deniedIds.has(r.toolCallId) && !handoffIds.has(r.toolCallId),
            ),
          );
        }
      } catch (err) {
        if (!(err instanceof SubAgentSuspension)) throw err;
        if (options.session?.durability !== 'strict') emitApprovalRequests(err.approvals);
        if (durable) {
          await saveCheckpoint(
            durable,
            deps,
            options,
            'suspended',
            messages,
            totalUsage,
            err.approvals,
          );
        }
        if (options.session?.durability === 'strict') emitApprovalRequests(err.approvals);
        suspend = {
          reason: 'sub-agent-approval',
          pendingApprovalCount: err.approvals.length,
          pendingToolCount: 0,
          ...checkpointRef(),
        };
        const usage = withTotal(totalUsage);
        flushWarnings();
        broadcaster.push({ type: 'finish', usage, finishReason: lastFinish });
        usageDeferred.resolve(usage);
        finishDeferred.resolve(lastFinish);
        stopDetailsDeferred.resolve(stopDetailsFrom(lastFinishMeta));
        fireFinish(options, deps, { model: options.model.modelId, finishReason: lastFinish });
        observeEnd();
        broadcaster.close();
        // Post-terminal bookkeeping: consumers are already unblocked; the pump
        // (and observation.settled) still awaits the best-effort persist.
        settleMemory(false); // suspended — the turn is incomplete
        await persistChat(options, deps, chatMessages, chatPersistence.writable);
        return;
      }

      // Memory recall (1.7, D1): computed once per leg. On a model that binds
      // thinking to the prefix (2.3, F22) it is one appended system message
      // (see `planRecall`); elsewhere it is spliced into the system context AT
      // THE CALL SITE only — the canonical history (and so checkpoints + chat
      // persistence) never bakes the block in, and resume legs cannot
      // double-inject it.
      // Its observation parents under the RUN span (no step is open yet).
      const recall = await planRecall(
        options,
        deps,
        messages,
        active?.model ?? options.model,
        observeCtx,
        resumeFrom !== undefined,
      );
      const recallBlock = recall.splice;
      // Recall overhead (2.0): a spliced block never enters `messages`, but the
      // provider counts it. Both the compaction threshold and the EMA
      // calibration have to see the same total.
      const recallOverheadTokens =
        recallBlock && compactionRunner
          ? compactionRunner.estimator.estimate([{ role: 'system', content: recallBlock }])
          : 0;

      // Input guardrails (2.0): ONCE per run leg — after the resume settle and
      // the recall computation, before the first model call. A BLOCK is a
      // graceful stop, never an `error` part: the guardrail parts go out first,
      // then a normal `finish`, so a UI can render the refusal and close the
      // turn exactly as it closes any other completed one.
      {
        const guarded = await evaluateInputGuardrails(options, messages);
        emitGuardrails(guarded.parts);
        if (guarded.outcome === 'block') {
          stoppedBy = GUARDRAIL_INPUT_STOPPED_BY;
          endReason = 'stop-condition';
          if (durable) {
            // 'completed', not 'suspended': nothing is pending and there is
            // nothing to resume — the run reached a deliberate end.
            await saveCheckpoint(durable, deps, options, 'completed', messages, totalUsage);
          }
          const usage = withTotal(totalUsage);
          const deuzMeta = finishMeta();
          flushWarnings();
          broadcaster.push({
            type: 'finish',
            usage,
            finishReason: lastFinish,
            ...(deuzMeta ? { providerMetadata: { deuz: deuzMeta } } : {}),
          });
          usageDeferred.resolve(usage);
          finishDeferred.resolve(lastFinish);
          stopDetailsDeferred.resolve(stopDetailsFrom(lastFinishMeta));
          fireFinish(options, deps, { model: options.model.modelId, finishReason: lastFinish });
          observeEnd();
          broadcaster.close();
          // The refused turn is NOT written to long-term memory — that is the
          // one thing the guardrail was installed to prevent.
          settleMemory(false);
          await persistChat(options, deps, chatMessages, chatPersistence.writable);
          return;
        }
        messages = guarded.messages;
      }
      // The stable-prefix recall message (2.3): after the guardrails, which
      // judge the caller's input, and before the first model call.
      if (recall.message) {
        messages = [...messages, recall.message];
        appended.push(recall.message);
        chatMessages = [...chatMessages, recall.message];
      }

      // Cost continuity (1.7, D2): resume legs seed prevCostUsd with the prior
      // legs' cost so the first cost part's deltaUsd reports THIS step's
      // increment, not the whole run's cumulative.
      if (options.execution) {
        prevCostUsd = options.execution.ledger.totals(options.execution.scopeId).spent.usd;
      } else if (usageCost) prevCostUsd = (await usageCost.flush()).pricedUsd;

      for (;;) {
        // Previous step overran its budget? Fail before starting another one.
        assertStepDeadline();
        stepTimeout?.clear();
        stepTimeout = createStepTimeout(deps.clock, timeouts.stepMs);
        // MCP hot-swap (2.0): a server that announced `tools/list_changed` since
        // the last step is re-read HERE, before the step starts, so the new
        // catalog is on the wire from the very next call. Both wires are rebuilt
        // so `activeTools` still applies to the refreshed set; `prepareStep`
        // below keeps the last word. A catalog that really changed is reported,
        // or ends the run before any model sees it (2.3, `onCatalogChange`): a
        // native run decides that itself and records the catalog it accepts.
        if (mcp?.changed()) {
          const before = mcp.tools;
          // `ownTools`, not `options.tools`: after a handoff the local half of
          // the set belongs to the ACTIVE agent, and re-merging the caller's
          // would silently undo the transfer.
          tools = await refreshMcpTools(mcp, ownTools, deps, warn);
          const verdict = internal?.mcp
            ? await internal.mcp.refreshed()
            : legacyCatalogVerdict(before, mcp.tools, catalogPolicy);
          for (const warning of verdict.warnings) warningSink.add(warning);
          if (verdict.stop) {
            stoppedBy = MCP_CATALOG_CHANGED_STOPPED_BY;
            endReason = 'stop-condition';
            if (durable) {
              await saveCheckpoint(durable, deps, options, 'completed', messages, totalUsage);
            }
            break;
          }
          fullWire = await buildWireTools(tools, options.toolChoice, options.maxToolConcurrency);
          staticWire = filterWireTools(fullWire, options.activeTools, deps.logger, warningSink);
          flushWarnings();
        }
        broadcaster.push({ type: 'step-start', stepIndex });
        const stepSpan = lo?.rt.startSpan();
        if (observeCtx && stepSpan) {
          // Compaction + tool events of THIS iteration parent under the step span.
          observeCtx.parentSpanId = stepSpan.spanId;
          observeCtx.stepIndex = stepIndex;
        }
        // onToolResult guardrails (2.2) report the step their tools ran in.
        extras.stepIndex = stepIndex;
        const addCompactionUsage = (u: Usage): void => {
          totalUsage = sumUsage(totalUsage, u);
        };
        const emitCompaction = (e: CompactionEvent, trigger: CompactionTrigger): void => {
          broadcaster.push({
            type: 'compaction',
            layer: e.layer,
            tokensBefore: e.tokensBefore,
            tokensAfter: e.tokensAfter,
            trigger,
          });
        };
        // Compaction first — its parts precede the step's deltas; prepareStep
        // then sees the compacted history.
        if (compactionRunner) {
          messages = await runCompaction(
            compactionRunner,
            options,
            deps,
            messages,
            addCompactionUsage,
            emitCompaction,
            observeCtx,
            recallOverheadTokens,
          );
        }
        const prepared = await applyPrepareStep(
          // Handoff (2.0): the active agent's model drives every step after the
          // transfer — and `prepareStep` still has the LAST word, because it
          // runs inside this call and overrides whatever it is handed.
          active ? { ...options, model: active.model } : options,
          { stepIndex, messages, usage: durableUsage(durable, totalUsage) },
          fullWire,
          staticWire,
          deps.logger,
          warningSink,
        );
        flushWarnings();
        messages = prepared.messages;
        // A step that offers another tool set than the one in effect appends
        // the change instead of sending another tools array (2.3, F22); its
        // calls resolve against the set it offered.
        const stepWire = stabilizeStepWire(
          prepared.options.model,
          declaredWire,
          prepared.wire,
          messages,
        );
        if (stepWire.change) {
          // Conversation content, like the recall message: the next call replays
          // it where the model saw it.
          messages = [...messages, stepWire.change];
          appended.push(stepWire.change);
          chatMessages = [...chatMessages, stepWire.change];
        }
        const stepTools = offeredTools(tools, stepWire.offered);
        lastWire = stepWire.wire;
        const estimateAtCall = (): number =>
          (compactionRunner?.estimator.estimate(messages) ?? 0) + recallOverheadTokens;
        let estimatedAtCall = estimateAtCall();
        if (lo && stepSpan) {
          emitStepStarted(
            lo,
            options,
            stepSpan,
            stepIndex,
            prepared.options.model.modelId,
            messages.length,
            compactionRunner ? estimatedAtCall : undefined,
            prepared.wire.tools.length,
            durableUsage(durable, totalUsage),
          );
        }
        let text = '';
        // Every reasoning block, text run and tool call in arrival order (2.3, F21).
        let turn: TurnContent = createTurnContent();
        let toolArgs: ToolArgMap = new Map();
        let toolOrder: string[] = [];
        let stepUsage: Usage = EMPTY_USAGE;
        let stepFinish: FinishReason = 'stop';
        let stepPhase: string | undefined;
        /** The provider's finish detail for this step (2.3), e.g. refusal `stop_details`. */
        let stepFinishMeta: Record<string, unknown> | undefined;
        // Overflow auto-recovery (2.0): ONE retry per step. G2 turns the
        // provider's rejection into an `error` PART, not a throw, so the retry
        // gate lives inside the consumption loop rather than around a try.
        // A ContextOverflowError is always pre-first-byte, so nothing of this
        // step has reached the consumer yet and the attempt restarts cleanly.
        let overflowRetried = false;
        // A model with no price under a USD budget (2.3): reported once, ahead
        // of the step's output, or refused before the call with
        // `budget.unknownPrice: 'reject'`.
        await admitModel?.(prepared.options.model.modelId);
        flushWarnings();

        attempts: for (;;) {
          const inner = runStream(
            preserveClientContext(options, {
              ...prepared.options,
              messages: withSystemBlock(messages, recallBlock),
            }),
            {
              tools: stepWire.wire,
              warnings: warningSink,
              // stepMs rides in as a FAILURE signal, never as the user's cancel
              // signal: the inner pump reports a TimeoutError instead of
              // resolving 'aborted' (see InternalRunOptions.failSignal).
              ...(stepTimeout ? { failSignal: stepTimeout.signal } : {}),
              ...(lo && stepSpan
                ? { observe: { runtime: lo.rt, parentSpanId: stepSpan.spanId, stepIndex } }
                : {}),
            },
          );
          text = '';
          turn = createTurnContent();
          toolArgs = new Map();
          toolOrder = [];
          stepUsage = EMPTY_USAGE;
          stepFinish = 'stop';
          stepPhase = undefined;
          stepFinishMeta = undefined;
          /** Set instead of failing when the rejection is a recoverable overflow. */
          let overflow: unknown;

          for await (const part of inner.fullStream) {
            switch (part.type) {
              case 'text-delta':
                text += part.text;
                turn.text(part);
                broadcaster.push(part);
                break;
              case 'reasoning-delta':
                turn.reasoning(part);
                broadcaster.push(part);
                break;
              case 'tool-call-delta': {
                let entry = toolArgs.get(part.id);
                if (!entry) {
                  entry = { name: part.name, args: '' };
                  toolArgs.set(part.id, entry);
                  toolOrder.push(part.id);
                  turn.tool(part.id);
                  toolState(part.id, part.name, 'input-streaming');
                }
                if (part.name && !entry.name) entry.name = part.name;
                if (part.providerMetadata) entry.meta = part.providerMetadata;
                entry.args += part.argsTextDelta;
                broadcaster.push(part); // forward raw for live UI input-streaming
                break;
              }
              case 'source':
                broadcaster.push(part);
                break;
              case 'finish':
                stepUsage = part.usage;
                stepFinish = part.finishReason;
                stepPhase = (part.providerMetadata?.openai as { phase?: string } | undefined)
                  ?.phase;
                stepFinishMeta = part.providerMetadata;
                break; // re-framed as step-finish below
              case 'error':
                // Recoverable overflow: hold the error instead of publishing it —
                // the decision needs the compaction pass, which cannot run inside
                // the iteration. Nothing is pushed, so a successful retry leaves
                // no trace of the rejected attempt on the stream.
                if (!overflowRetried && isContextOverflow(part.error)) {
                  overflow = part.error;
                  break;
                }
                // The inner pump already emitted model.failed — the loop reports
                // the run failure exactly once here.
                await failRun(part.error);
                return;
              // Forward the inner pump's non-fatal notices (1.9). Without this
              // case they die at the loop boundary and only the bulk `warnings`
              // promise ever sees them — the exact silent gap Sprint 1 had to fix
              // for `verify`.
              case 'warning': {
                // The step's pump records every warning in the run's sink (2.3:
                // a wire's own notice, such as Anthropic's input_transformations,
                // included) and streams it from there, so a warning the sink
                // already holds is forwarded as is. One it has not seen is
                // recorded and streamed from the sink, once; anything the sink
                // has nothing new for (past its cap) is forwarded as before.
                const fresh = warningSink.add(part.warning) ? warningSink.take() : [];
                if (fresh.length === 0) broadcaster.push(part);
                for (const warning of fresh) broadcaster.push({ type: 'warning', warning });
                break;
              }
              default:
                break;
            }
          }

          if (overflow === undefined) break attempts;
          overflowRetried = true;
          const recovered = await recoverFromOverflow(
            compactionRunner,
            options,
            deps,
            messages,
            addCompactionUsage,
            emitCompaction,
            observeCtx,
            active?.model ?? options.model,
          );
          if (!recovered) {
            // Nothing could be shrunk — the original rejection stands.
            await failRun(overflow);
            return;
          }
          messages = recovered;
          // Re-measure: calibrating the EMA against the PRE-compaction estimate
          // would teach it that the history is far bigger than what was sent.
          estimatedAtCall = estimateAtCall();
        }

        totalUsage = sumUsage(totalUsage, stepUsage);
        calibrateCompaction(compactionRunner, estimatedAtCall, stepUsage);
        lastFinish = stepFinish;
        lastFinishMeta = stepFinishMeta;
        broadcaster.push({
          type: 'step-finish',
          stepIndex,
          finishReason: stepFinish,
          usage: stepUsage,
          ...(stepFinishMeta ? { providerMetadata: stepFinishMeta } : {}),
        });
        // Live cumulative cost (1.7, D2): one part per step whenever a
        // priceProvider is injected — cross-leg cumulative on durable resumes.
        if (deps.priceProvider || options.execution) {
          try {
            const accounting = options.execution?.ledger.totals(options.execution.scopeId);
            const priced = await usageCost?.flush();
            // A model the provider has no price for adds nothing (2.3): the cost
            // is the priced sum. Only a failed lookup or an unknown settlement
            // hides it. Without a provider nothing is priced, so the cost is
            // unknown and no part is streamed, as in 2.2.
            const costUsd = accounting
              ? accounting.unknownUsd === 0 ||
                (deps.priceProvider !== undefined &&
                  accounting.unknownUsd === (accounting.unpriced ?? 0))
                ? accounting.spent.usd
                : undefined
              : priced?.costUsd;
            if (costUsd === undefined && priced && priced.unknownCalls > 0)
              deps.logger.warn('cost part skipped — per-call pricing unavailable');
            if (typeof costUsd === 'number') {
              const savings = priced?.cacheSavingsUsd;
              broadcaster.push({
                type: 'cost',
                costUsd,
                deltaUsd: Math.max(0, Math.round((costUsd - prevCostUsd) * 1e6) / 1e6),
                ...(typeof savings === 'number' && savings > 0 ? { cacheSavingsUsd: savings } : {}),
                stepIndex,
              });
              prevCostUsd = costUsd;
            }
          } catch {
            deps.logger.warn('cost part skipped — priceProvider threw');
          }
        }

        // Finish-reason gate (2.3, F16): a refused or cut-off turn keeps its text
        // and reasoning, never its tool calls — their arguments may be truncated.
        const cutOff = blocksToolDispatch(stepFinish);
        const { assistantMessage, toolUseParts } = turn.assemble(toolArgs, cutOff ? [] : toolOrder);
        if (stepPhase) assistantMessage.providerMetadata = { openai: { phase: stepPhase } };
        // A UI already shows these calls as `input-streaming`; close each one,
        // since no `tool-call` or `tool-result` will ever follow.
        if (cutOff) for (const id of toolOrder) toolState(id, toolArgs.get(id)?.name, 'error');

        const stepStopDetails = stopDetailsFrom(stepFinishMeta);
        const stepData = {
          text,
          reasoningText: turn.reasoningText,
          toolUseParts,
          usage: stepUsage,
          finishReason: stepFinish,
          ...(stepStopDetails ? { stopDetails: stepStopDetails } : {}),
          assistantMessage,
        };

        if (userSignal?.aborted) {
          // No checkpoint here: the abort cut mid-step, and a checkpoint is
          // only honest at a completed boundary. The cut step still gets a
          // step.completed (finishReason 'aborted') — unlike onStepFinish,
          // observation covers every step.
          lastFinish = 'aborted';
          if (lo && stepSpan) {
            emitStepCompleted(
              lo,
              options,
              stepSpan,
              stepIndex,
              toStepResult({ ...stepData, finishReason: 'aborted' }, [], [], steps.length),
              undefined,
              durableUsage(durable, totalUsage),
            );
          }
          break;
        }

        // *** GEMINI GUARD: continue on tool_use parts, NOT finishReason ***
        if (toolUseParts.length === 0) {
          const sr = toStepResult(stepData, [], [], steps.length);
          steps.push(sr);
          if (lo && stepSpan) {
            emitStepCompleted(
              lo,
              options,
              stepSpan,
              stepIndex,
              sr,
              undefined,
              durableUsage(durable, totalUsage),
            );
          }
          // Rebase effective model history for the completed checkpoint; the
          // raw ChatStore history is tracked separately. An empty turn is not
          // recorded: no provider accepts `content: []` back.
          const stored = !isEmptyTurn(assistantMessage);
          if (stored) {
            messages = [...messages, assistantMessage];
            appended.push(assistantMessage);
            chatMessages = [...chatMessages, assistantMessage];
          }

          // False-finish guard (1.9, N2): consulted BEFORE verifyStep at this
          // same natural-completion boundary — it is the cheaper, narrower
          // question, and a rejection that re-drives SHORT-CIRCUITS verification
          // for this round (nothing worth verifying in an answer the caller
          // already calls incomplete). The two retry budgets never mix.
          // Neither hook re-drives a refused or cut-off turn (2.3).
          const completion = cutOff
            ? undefined
            : await evaluateDoneWhen(options, {
                stepIndex,
                attempt: falseFinishRetries,
                text,
                messages,
                usage: durableUsage(durable, totalUsage),
              });
          if (completion) {
            if (completion.done) {
              // A later round genuinely finished: an earlier give-up must not
              // mark THIS answer as accepted-over-an-objection.
              falseFinishAccepted = false;
            } else {
              broadcaster.push({
                type: 'false-finish',
                stepIndex,
                attempt: falseFinishRetries,
                willRetry: completion.retry,
              });
              if (completion.retry) {
                falseFinishRetries += 1;
                const nudge = falseFinishMessage();
                messages = [...messages, nudge];
                appended.push(nudge);
                chatMessages = [...chatMessages, nudge];
                if (durable) {
                  await saveCheckpoint(durable, deps, options, 'running', messages, totalUsage);
                }
                stepIndex++;
                continue;
              }
              // Budget spent: the answer is accepted as final, but the run
              // records WHY it stands (folded into stoppedBy at the break).
              falseFinishAccepted = true;
            }
          }

          // Verified generation (1.8): emit a verify part; on a rejected
          // verdict, feed feedback back as a user turn and re-drive the loop.
          const verification = cutOff
            ? undefined
            : await evaluateVerifyStep(options, {
                stepIndex,
                attempt: verifyAttempts,
                text,
                messages,
                usage: durableUsage(durable, totalUsage),
              });
          if (verification) {
            verified = verification.verdict.ok;
            broadcaster.push({
              type: 'verify',
              stepIndex,
              attempt: verifyAttempts,
              ok: verification.verdict.ok,
              willRetry: verification.retry,
              ...(verification.verdict.feedback ? { feedback: verification.verdict.feedback } : {}),
            });
            if (verification.retry) {
              verifyAttempts += 1;
              const feedback = verifyFeedbackMessage(verification.verdict);
              messages = [...messages, feedback];
              appended.push(feedback);
              chatMessages = [...chatMessages, feedback];
              if (durable) {
                await saveCheckpoint(durable, deps, options, 'running', messages, totalUsage);
              }
              stepIndex++;
              continue;
            }
          }
          // Recorded only on the path that actually terminates: a verify retry
          // above `continue`s, and every other break carries its own reason.
          if (falseFinishAccepted) stoppedBy = FALSE_FINISH_STOPPED_BY;

          // Output guardrails (2.0): the LAST word at a natural completion, run
          // only once `doneWhen` AND `verifyStep` have accepted. The text deltas
          // are already out on the wire — that is what the live `guardrail` part
          // is FOR — but the appended assistant turn, the checkpoint below and
          // the chat record all carry the verdict's text, so nothing that is
          // read back later disagrees with the rule.
          const outputVerdict = await evaluateOutputGuardrails(options, {
            text,
            messages,
            stepIndex,
          });
          emitGuardrails(outputVerdict.parts);
          if (outputVerdict.outcome === 'block') {
            guardrailText = outputVerdict.replacement ?? '';
            stoppedBy = GUARDRAIL_OUTPUT_STOPPED_BY;
          } else if (outputVerdict.text !== text) {
            guardrailText = outputVerdict.text;
          }
          if (guardrailText !== undefined) {
            const rewritten = rewriteAssistantText(assistantMessage, guardrailText);
            // A block with nothing left to say empties the turn, and an empty
            // content array is not a message any wire accepts (see isEmptyTurn)
            // — so the turn is DROPPED rather than persisted unsendable.
            const drop = isEmptyTurn(rewritten);
            if (stored) {
              messages = drop ? messages.slice(0, -1) : [...messages.slice(0, -1), rewritten];
              chatMessages = drop
                ? chatMessages.slice(0, -1)
                : [...chatMessages.slice(0, -1), rewritten];
              if (drop) appended.pop();
              else appended[appended.length - 1] = rewritten;
            } else if (!drop) {
              // A replacement gives an empty turn something to say: record it now.
              messages = [...messages, rewritten];
              appended.push(rewritten);
              chatMessages = [...chatMessages, rewritten];
            }
            // The SAME step must agree — `stopWhen` conditions read `steps[]`.
            steps[steps.length - 1] = {
              ...sr,
              text: guardrailText,
              response: { messages: drop ? [] : [rewritten] },
            };
          }

          if (durable) {
            await saveCheckpoint(durable, deps, options, 'completed', messages, totalUsage);
          }
          break;
        }

        let toolCalls: ToolCall[] = toolUseParts.map((p) => ({
          toolCallId: p.id,
          toolName: p.name,
          args: p.input,
        }));
        // `tool-call` parts carry the MODEL's arguments: a guardrail rewrite is
        // an execution-side substitution, and it announces itself with its own
        // `guardrail` part a moment later rather than by silently editing the
        // call a UI already rendered.
        for (const [index, c] of toolCalls.entries()) {
          // The call's round-trip data rides with it (2.3): a chat client that
          // sends the turn back must echo it (a Gemini function call's signature).
          const providerMetadata = toolUseParts[index]!.providerMetadata;
          broadcaster.push({
            type: 'tool-call',
            toolCallId: c.toolCallId,
            toolName: c.toolName,
            input: c.args,
            ...(providerMetadata ? { providerMetadata } : {}),
          });
          toolState(c.toolCallId, c.toolName, 'input-complete');
          toolNames.set(c.toolCallId, c.toolName);
        }
        messages = [...messages, assistantMessage];
        appended.push(assistantMessage);
        chatMessages = [...chatMessages, assistantMessage];

        // The dispatch contract (2.3): ONE plan for the batch, shared with the
        // buffered loop and the resume settle — the execution policy, the
        // `onToolCall` guardrails and the approval gate for every call, then the
        // transfer decision (made by looking at the call, never by an exception out
        // of an `execute`). Everything ELSE in the batch runs completely normally: a
        // model that calls `search` and `transfer_to_billing` in one step gets both
        // honored.
        const plan = await planToolDispatch({
          calls: toolCalls,
          tools: stepTools,
          options,
          messages,
          stepIndex,
          ...(hasHandoffTools(handoffTools)
            ? { handoff: { tools: handoffTools, ...(active ? { active } : {}) } }
            : {}),
          // An approval is bound to the run and to the checkpoint its suspension
          // writes next (2.3); a call without a session binds neither.
          approval: { runId: durable?.runId, step: durable ? durable.stepIndex + 1 : undefined },
          clock: deps.clock,
          ...(observeCtx ? { observe: observeCtx } : {}),
        });
        emitGuardrails(plan.guardrails);
        /** What actually reaches `executeTools` (transfers excluded). */
        const execCalls = plan.execCalls;
        // The REPORTED calls stay in the model's own order and include the
        // transfers, so `StepResult.toolCalls` describes the step the model
        // took — with any guardrail rewrite applied.
        toolCalls = plan.calls;

        // The transfer verdict is part of the plan — made before the approval
        // gate and `executeTools` can leave the step early. A break that left a
        // transfer's `tool_use` id unanswered would hand the provider an
        // unanswerable turn on the next request AND silently drop the routing
        // decision, so it is decided once and committed on every exit.
        const handoffDecision = plan.handoff;
        /**
         * Apply the transfer on a path that executes NOTHING else. Publishes the
         * same `tool-result`/`tool-state`/`handoff` parts the completed path
         * does — a UI must not be able to tell the two apart — and returns the
         * `{role:'tool'}` turn so the caller can report it on the step.
         */
        const commitHandoffOnBreak = (): Message | undefined => {
          if (!handoffDecision) return undefined;
          for (const r of handoffDecision.results) publishResult(r);
          const message: Message = {
            role: 'tool',
            content: handoffDecision.results.map(toToolResultPart),
          };
          messages = [...messages, message];
          appended.push(message);
          chatMessages = [...chatMessages, message];
          if (handoffDecision.accepted) {
            const swap = applyHandoffSwap(
              handoffDecision.accepted,
              active,
              handoffTools,
              messages,
              stepIndex,
            );
            active = swap.active;
            // The rewritten system turn has to be in `messages` BEFORE the
            // checkpoint below, or the resume leg would carry on as the target
            // agent while still reading the outgoing agent's instructions.
            messages = swap.messages;
            handoffLog.push(swap.entry);
            broadcaster.push({ type: 'handoff', ...swap.entry });
            ownTools = active.tools;
            if (durable) durable.handoff = { to: active.name!, count: active.handoffCount };
          }
          return message;
        };

        // Guardrail blocks and approval denials share ONE denial map — one
        // machinery for every "this call does not run" verdict.
        const denied = plan.denied;
        const pendingApproval = plan.pendingApproval;
        const clientCalls = plan.clientCalls;
        snapshotClientCalls = clientCalls;

        // Pending approvals and client tools break together: ONE break, nothing
        // from the batch executes; the resume call settles the deferred rest.
        if (pendingApproval.length > 0 || clientCalls.length > 0) {
          const requests = await signApprovalRequests(plan.requests, options, deps, durable?.runId);
          const handoffMessage = commitHandoffOnBreak();
          for (const c of pendingApproval) {
            toolState(c.toolCallId, c.toolName, 'awaiting-approval', undefined, 'approval-pending');
          }
          if (options.session?.durability !== 'strict') emitApprovalRequests(requests);
          const sr = toStepResult(
            stepData,
            toolCalls,
            handoffDecision?.results ?? [],
            steps.length,
            handoffMessage,
          );
          steps.push(sr);
          options.onStepFinish?.(sr);
          if (lo && stepSpan) {
            emitStepCompleted(
              lo,
              options,
              stepSpan,
              stepIndex,
              sr,
              denied,
              durableUsage(durable, totalUsage),
            );
          }
          if (durable) {
            await saveCheckpoint(
              durable,
              deps,
              options,
              'suspended',
              messages,
              totalUsage,
              requests,
            );
          }
          if (options.session?.durability === 'strict') emitApprovalRequests(requests);
          suspend = {
            reason: pendingApproval.length > 0 ? 'approval' : 'client-tool',
            pendingApprovalCount: requests.length,
            // Only REAL client tools are pending on the caller (1.9) — a
            // hallucinated name self-healed inside the step instead, and a
            // blocked one never became the caller's problem (2.0).
            pendingToolCount: clientCalls.length,
            ...checkpointRef(),
          };
          break;
        }

        for (const c of execCalls) {
          // Denied calls never execute — they surface straight as error results.
          // Same for a hallucinated name (1.9): nothing runs, so the sequence
          // goes input-complete → error with no 'executing' in between (the
          // resume-settle path reports missing/denied results the same way).
          // A TRANSFER never executes either — it is not in `execCalls` at all.
          if (!denied.has(c.toolCallId) && !isUnknownTool(stepTools, c.toolName)) {
            toolState(c.toolCallId, c.toolName, 'executing');
          }
        }
        let toolResults;
        try {
          toolResults = await executeTools(execCalls, stepTools, options, messages, denied, extras);
        } catch (err) {
          if (!(err instanceof SubAgentSuspension)) throw err;
          // A durable sub-agent suspended: the EXECUTED calls' tool_use stays
          // unanswered and the resume leg's settle re-runs them, which resumes
          // the child. The transfer is not one of them: it never executes, so
          // its answer (and the swap) is committed here rather than deferred to
          // a leg that would find no producer for it.
          if (options.session?.durability !== 'strict') emitApprovalRequests(err.approvals);
          const handoffMessage = commitHandoffOnBreak();
          const sr = toStepResult(
            stepData,
            toolCalls,
            handoffDecision?.results ?? [],
            steps.length,
            handoffMessage,
          );
          steps.push(sr);
          options.onStepFinish?.(sr);
          if (lo && stepSpan) {
            emitStepCompleted(
              lo,
              options,
              stepSpan,
              stepIndex,
              sr,
              denied,
              durableUsage(durable, totalUsage),
            );
          }
          if (durable) {
            await saveCheckpoint(
              durable,
              deps,
              options,
              'suspended',
              messages,
              totalUsage,
              err.approvals,
            );
          }
          if (options.session?.durability === 'strict') emitApprovalRequests(err.approvals);
          suspend = {
            reason: 'sub-agent-approval',
            pendingApprovalCount: err.approvals.length,
            pendingToolCount: 0,
            ...checkpointRef(),
          };
          break;
        }
        // The step's own budget covers its tool executions (1.9): if it expired
        // while they ran, the step is over — fail here rather than feeding
        // results back into a model call that can no longer be paid for.
        assertStepDeadline();
        // Handoff (2.0): every transfer `tool_use_id` is answered from the
        // decision taken above — the first with the transfer confirmation, its
        // siblings (and everything, once the budget is spent) with a
        // self-healing is_error. Merged back into the model's own call order so
        // the turn reads the way it was issued, and emitted as ordinary
        // `tool-result`/`tool-state` parts: a UI renders a transfer exactly like
        // any other completed call.
        if (handoffDecision) {
          toolResults = mergeResultsInCallOrder(toolCalls, toolResults, handoffDecision.results);
        }
        for (const r of toolResults) {
          // Server mode: `approveToolCall` said no (or threw). The verdict is a
          // boolean, so there is no reason string to relay — `denied: true` and
          // the outcome are what separate "refused" from "failed".
          publishResult(r, denied.get(r.toolCallId));
        }
        const toolResultMessage: Message = {
          role: 'tool',
          content: toolResults.map(toToolResultPart),
        };
        messages = [...messages, toolResultMessage];
        appended.push(toolResultMessage);
        chatMessages = [...chatMessages, toolResultMessage];

        // The SWAP, once the turn is complete: from here the run is a different
        // agent. `messages` is REWRITTEN (new system turn) rather than appended
        // to — `appended`/`chatMessages` must not grow a turn the caller never
        // sent — and both wires are rebuilt so the next call carries the new
        // catalog. The `handoff` part goes out before the next `step-start`.
        if (handoffDecision?.accepted) {
          const swap = applyHandoffSwap(
            handoffDecision.accepted,
            active,
            handoffTools,
            messages,
            stepIndex,
          );
          active = swap.active;
          messages = swap.messages;
          handoffLog.push(swap.entry);
          broadcaster.push({ type: 'handoff', ...swap.entry });
          ownTools = active.tools;
          tools = mergeMcpTools(mcp, ownTools, warn);
          fullWire = await buildWireTools(tools, options.toolChoice, options.maxToolConcurrency);
          staticWire = filterWireTools(fullWire, options.activeTools, deps.logger, warningSink);
          flushWarnings();
          // Compaction is measured against — and summarized by — whoever is
          // driving: the target's context window is not the outgoing agent's.
          retargetCompaction(compactionRunner, options, deps, active.model);
          if (durable) durable.handoff = { to: active.name!, count: active.handoffCount };
        }

        const sr = toStepResult(stepData, toolCalls, toolResults, steps.length, toolResultMessage);
        steps.push(sr);
        options.onStepFinish?.(sr);
        if (lo && stepSpan) {
          emitStepCompleted(
            lo,
            options,
            stepSpan,
            stepIndex,
            sr,
            denied,
            durableUsage(durable, totalUsage),
          );
        }

        // Denials are deliberate, not tool failures — exclude from the runaway
        // guard. A refused HANDOFF (budget spent, or a sibling transfer in the
        // same batch) is the same kind of verdict, so it is excluded too: the
        // model is being told to carry on, not failing at anything.
        const handoffIds = handoffDecision
          ? new Set(handoffDecision.results.map((r) => r.toolCallId))
          : undefined;
        if (
          bumpErrorGuard(
            errorCounters,
            toolResults.filter((r) => !denied.has(r.toolCallId) && !handoffIds?.has(r.toolCallId)),
          )
        ) {
          endReason = 'runaway-tool-errors';
          if (durable) {
            await saveCheckpoint(durable, deps, options, 'completed', messages, totalUsage);
          }
          break;
        }
        const runUsage = durableUsage(durable, totalUsage);
        const costUSD = options.execution
          ? options.execution.ledger.totals().committed.usd
          : wantCost && usageCost
            ? (await usageCost.flush()).costUsd
            : undefined;
        const stop = await shouldStop(stopConditions, steps, {
          usage: runUsage,
          costUSD,
          elapsedMs: deps.clock.now() - startedAt,
        });
        if (stop.stop) {
          stoppedBy = stop.stoppedBy;
          endReason = stop.stoppedBy !== undefined ? 'stop-condition' : 'max-steps';
          // Budget guardrail (1.7, D3): a typed part precedes the finish so
          // UIs can render a continue-confirmation without parsing metadata.
          if (stop.stoppedBy === 'budget.usd' || stop.stoppedBy === 'budget.tokens') {
            const kind = stop.stoppedBy === 'budget.usd' ? ('usd' as const) : ('tokens' as const);
            broadcaster.push({
              type: 'budget-exceeded',
              kind,
              limit: (kind === 'usd' ? options.budget?.usd : options.budget?.tokens) ?? 0,
              value: kind === 'usd' ? (costUSD ?? 0) : runUsage.totalTokens,
            });
          }
          if (durable) {
            await saveCheckpoint(durable, deps, options, 'completed', messages, totalUsage);
          }
          break;
        }
        if (durable) {
          await saveCheckpoint(durable, deps, options, 'running', messages, totalUsage);
        }
        stepIndex++;
      }

      const usage = withTotal(totalUsage);
      const deuzMeta = finishMeta();
      const providerMetadata: Record<string, unknown> = {
        ...lastFinishMeta,
        ...(deuzMeta ? { deuz: deuzMeta } : {}),
      };
      // Whatever the run recorded since the last step's flush goes out before it ends.
      flushWarnings();
      broadcaster.push({
        type: 'finish',
        usage,
        finishReason: lastFinish,
        ...(Object.keys(providerMetadata).length > 0 ? { providerMetadata } : {}),
      });
      usageDeferred.resolve(usage);
      finishDeferred.resolve(lastFinish);
      stopDetailsDeferred.resolve(stopDetailsFrom(lastFinishMeta));
      fireFinish(options, deps, { model: options.model.modelId, finishReason: lastFinish });
      observeEnd();
      broadcaster.close();
      // Post-terminal bookkeeping — see the suspension path note above.
      settleMemory(suspend === undefined); // extract only for COMPLETED turns
      await persistChat(options, deps, chatMessages, chatPersistence.writable);
    } catch (err) {
      await failRun(err);
    } finally {
      // Release the step deadline on EVERY exit (break, return, throw): an
      // un-cancelled host timer keeps a Node process (and a test run) alive.
      stepTimeout?.clear();
      // Same discipline for the run's MCP connections (2.0). This is the ONE
      // site that covers every pump exit — the finish path, the suspension
      // `return`s, the mid-stream `failRun` return and the outer catch — so it
      // lands right after the same post-terminal bookkeeping (settleMemory /
      // persistChat) each of those paths already performed. Never throws. A
      // runtime a native runner handed in is the runner's to close (2.3).
      if (!internal?.mcp) await closeMcp(mcp, deps);
      const stopDetails = stopDetailsFrom(lastFinishMeta);
      internal?.onSnapshot?.({
        messages,
        steps,
        usage: withTotal(totalUsage),
        cumulativeUsage: withTotal(durableUsage(durable, totalUsage)),
        finishReason: terminalError !== undefined ? 'error' : lastFinish,
        endReason,
        stoppedBy,
        pendingApprovals: snapshotApprovals,
        pendingClientCalls: snapshotClientCalls,
        verified,
        ...(stopDetails ? { stopDetails } : {}),
        ...(lastWire ? { wire: lastWire } : {}),
        ...(terminalError !== undefined ? { error: terminalError } : {}),
        ...(durable?.handoff ? { handoff: durable.handoff } : {}),
      });
    }
  }

  const fullStream = lazyAsyncIterable<StreamPart>(() => fullSub, ensureStarted);
  const textStream = lazyAsyncIterable<string>(() => projectText(textSub), ensureStarted);

  /**
   * `consume()` (1.9) — see the twin in `core/inference.ts`. It matters MOST
   * here: without a consumer the lazy pump (G2) never reaches a step boundary,
   * so chat persistence, durable checkpoints, `onFinish` and memory extraction
   * never run. Drains through its OWN broadcaster subscription (iteration by
   * the caller loses nothing), awaits the pump's post-terminal bookkeeping and
   * the memory extraction, is memoized (terminal effects fire once) and NEVER
   * rejects — failures go to `onError`.
   */
  let drain: Promise<{ error: unknown } | undefined> | undefined;
  function consume(consumeOptions?: { onError?: (error: unknown) => void }): Promise<void> {
    drain ??= (async () => {
      const sub = broadcaster.subscribe();
      ensureStarted();
      let failure: { error: unknown } | undefined;
      try {
        for await (const part of sub) {
          // Mid-stream failures are error PARTS here, never thrown iterations.
          if (part.type === 'error') failure ??= { error: part.error };
        }
      } catch (err) {
        failure ??= { error: err };
      }
      try {
        await pumpDone;
      } catch {
        // unreachable (pump never rejects) — the contract holds regardless
      }
      // Memory extraction is STARTED inside the pump but settles later; a
      // serverless `waitUntil(res.consume())` must cover it too. It never
      // rejects (startMemoryExtract swallows) and always settles.
      if (memoryDeferred) {
        try {
          await memoryDeferred.promise;
        } catch {
          /* never rejects — defensive */
        }
      }
      if (!failure) {
        // A late consume() subscribes after the broadcaster closed and sees no
        // parts; the terminal failure is still on `usage`.
        try {
          await usageDeferred.promise;
        } catch (err) {
          failure = { error: err };
        }
      }
      return failure;
    })();
    return drain.then((failure) => {
      if (!failure) return;
      try {
        consumeOptions?.onError?.(failure.error);
      } catch {
        // an onError that throws must not break the never-reject contract
      }
    });
  }

  return {
    get textStream() {
      return textStream;
    },
    get fullStream() {
      return fullStream;
    },
    get usage() {
      ensureStarted();
      return usageDeferred.promise;
    },
    get finishReason() {
      ensureStarted();
      return finishDeferred.promise;
    },
    get stopDetails() {
      ensureStarted();
      return stopDetailsDeferred.promise;
    },
    // Unconditional (1.9), like `usage`/`finishReason`: the readout is declared
    // as always present on a full StreamChatResult, and it resolves with the
    // run's collected notices — empty when the run had none.
    get warnings() {
      ensureStarted();
      return warningsDeferred.promise;
    },
    get observation() {
      ensureStarted();
      return observationHandle;
    },
    // A DIRECT getter, never a spread-in one: object spread [[Get]]s the
    // source's properties, which would fire ensureStarted() at construction
    // and break the lazy-start contract (G2).
    get memory() {
      if (!memoryDeferred) return undefined;
      ensureStarted();
      return memoryDeferred.promise;
    },
    // A plain method, never a getter (see the `memory` note above): reading
    // `result.consume` must not start the pump.
    consume,
    ...(runId !== undefined ? { runId } : {}),
  };
}
