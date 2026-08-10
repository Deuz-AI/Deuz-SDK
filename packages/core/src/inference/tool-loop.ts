import type { CommonCallOptions } from '../types/config';
import { createWarningSink } from '../internal/warnings';
import type { GenerateTextResult } from '../types/methods';
import type { Message } from '../types/message';
import type { Usage } from '../types/usage';
import type { ToolCall, ToolSet, StepResult, ToolApprovalRequest } from '../types/tool';
import type { ResolvedMcpRuntime } from '../mcp/resolve';
import { runOneStep, type OneStep } from './run-step';
import { EMPTY_USAGE, withTotal } from '../core/metering';
import { resolveDependencies } from '../internal/resolve-deps';
import { createStepTimeout, resolveTimeouts, type StepTimeoutHandle } from '../core/timeout';
import type { ObservationRuntime } from '../internal/observe-runtime';
import {
  buildWireTools,
  filterWireTools,
  applyPrepareStep,
  setupMcp,
  mergeMcpTools,
  refreshMcpTools,
  closeMcp,
  setupCompaction,
  runCompaction,
  calibrateCompaction,
  recoverFromOverflow,
  isContextOverflow,
  executeTools,
  toToolResultPart,
  toStepResult,
  hasClientTool,
  isClientTool,
  bumpErrorGuard,
  normalizeStop,
  needsCost,
  shouldStop,
  sumUsage,
  findApprovalNeeded,
  resolveServerApprovals,
  settlePendingApprovals,
  setupDurable,
  saveCheckpoint,
  prepareChatPersistence,
  persistChat,
  computeRecallBlock,
  withSystemBlock,
  startMemoryExtract,
  durableUsage,
  toApprovalRequests,
  signApprovalRequests,
  preserveClientContext,
  beginLoopObserve,
  endLoopObserve,
  emitStepStarted,
  emitStepCompleted,
  observeApprovalRequests,
  observeServerResolutions,
  evaluateVerifyStep,
  evaluateDoneWhen,
  falseFinishMessage,
  warnFalseFinishConfig,
  FALSE_FINISH_STOPPED_BY,
  verifyFeedbackMessage,
  evaluateInputGuardrails,
  evaluateOutputGuardrails,
  applyToolCallGuardrails,
  logGuardrailParts,
  rewriteAssistantText,
  GUARDRAIL_INPUT_STOPPED_BY,
  GUARDRAIL_OUTPUT_STOPPED_BY,
  collectHandoffTools,
  hasHandoffTools,
  splitHandoffCalls,
  decideHandoff,
  mergeResultsInCallOrder,
  applyHandoffSwap,
  resumeHandoffState,
  SubAgentSuspension,
  type ActiveAgentState,
  type CompactionTrigger,
  type Denial,
  type ExecuteExtras,
  type GuardrailLogEntry,
  type HandoffLogEntry,
  type LoopOutcome,
} from './loop-shared';
import type { CompactionEvent } from './compaction';

/**
 * Internal-only knobs (NOT public surface): `resumeFrom` seeds the cross-leg
 * step/usage counters when `resumeFromCheckpoint` re-drives the loop.
 */
export interface ToolLoopInternal {
  resumeFrom?: { stepIndex: number; usage: Usage };
  /**
   * Handoff (2.0): the checkpoint's active agent, re-applied before the first
   * step of a resume leg (`durable.ts` reads it off `AgentCheckpoint.handoff`).
   */
  resumeHandoff?: { to: string; count: number };
  /** Observation (1.6): resume-leg correlation for run.started. */
  observeResume?: { stepId: string; stepIndex: number; checkpointAgeMs?: number };
  /** Observation (1.6): pre-created runtime (checkpoint.loaded precedes run.started). */
  observeRuntime?: ObservationRuntime;
}

/**
 * The agentic loop: run a model step, execute any tool calls (parallel + capped,
 * self-healing on error), feed results back as a NEW immutable message array,
 * repeat until no tool calls (NOT finishReason — Gemini stop-bug guard) or a
 * stop condition / runaway guard fires. With `session` it checkpoints at every
 * step boundary (1.5): the result's usage stays THIS call's usage, while the
 * checkpoint carries the cumulative across all resume legs.
 */
export async function runToolLoop(
  options: CommonCallOptions,
  internal?: ToolLoopInternal,
): Promise<GenerateTextResult> {
  // `let`, because zero-config MCP (2.0) merges the connected servers' tools in
  // before the first step and can REPLACE the set mid-run when a server sends
  // `tools/list_changed`.
  let tools: ToolSet = options.tools ?? {};
  /**
   * The LOCAL half of `tools` (everything that is not an MCP catalog): the
   * caller's `tools` until a handoff (2.0) swaps in the active agent's set. Every
   * later merge re-derives `tools` from THIS, so an MCP hot-refresh cannot undo a
   * transfer.
   */
  let ownTools: ToolSet = options.tools ?? {};
  const deps = resolveDependencies(options.deps);
  /**
   * The run's MCP connections (2.0), resolved inside the try below so a failure
   * still reports run.failed. Declared out here because the `finally` has to
   * close whatever was opened, on EVERY exit path.
   */
  let mcp: ResolvedMcpRuntime | undefined;
  // Loop start timestamp for `durationExceeds` (injected clock — never Date.now).
  const startedAt = deps.clock.now();
  // 1.9: the timeout layers resolve ONCE, exactly as the streaming twin does —
  // the same `timeout` input must mean the same thing in both loops. Only
  // `stepMs` is the loop's business: ttft/total belong to each model call (the
  // inner runStream resolves them from the same `options.timeout`), `toolMs` to
  // loop-shared's executeTools.
  const timeouts = resolveTimeouts(options.timeout);
  /** The CURRENT step's deadline — undefined (zero cost) when stepMs is unset. */
  let stepTimeout: StepTimeoutHandle | undefined;
  /**
   * A deadline that fires while the step's TOOLS run cannot abort them (that is
   * `timeout.toolMs` / `Tool.timeoutMs`, in loop-shared), so the loop checks it
   * at its own step boundaries. An expiry is a FAILURE — the throw rejects this
   * call with a `TimeoutError`, never a 'aborted' finish (the G2 distinction).
   */
  const assertStepDeadline = (): void => {
    if (stepTimeout?.expired()) throw stepTimeout.error;
  };
  const durable = setupDurable(options, deps, internal?.resumeFrom);
  // Observation (1.6): the loop owns the run — inner runStream calls emit only
  // model.* events. `lo` is undefined without an observer (fast path).
  const lo = beginLoopObserve(deps, options, {
    operation: 'generate-text',
    runId: durable?.runId,
    resumed: internal?.resumeFrom !== undefined,
    resumeFromStepId: internal?.observeResume?.stepId,
    resumeFromStepIndex: internal?.observeResume?.stepIndex,
    runtime: internal?.observeRuntime,
  });
  if (durable && lo) durable.observe = { rt: lo.rt, runSpanId: lo.runSpanId };
  // Cross-leg step offset: prepareStep must see the same continuing indices
  // the streaming loop reports on a resume leg (loop-symmetry invariant).
  const stepBase = internal?.resumeFrom?.stepIndex ?? 0;
  let messages: Message[] = [...options.messages];
  const chatPersistence = await prepareChatPersistence(
    options,
    deps,
    messages,
    internal?.resumeFrom !== undefined,
  );
  let chatMessages = chatPersistence.messages;
  // Messages this call appends — returned as response.messages. Tracked as a
  // list (not a base-length slice) so prepareStep/compaction history rewrites
  // can never skew what the caller receives.
  const appended: Message[] = [];
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
  let lastStep: OneStep | undefined;
  let pendingApprovals: ToolApprovalRequest[] | undefined;
  let stoppedBy: string | undefined;
  let endReason: LoopOutcome['endReason'] = 'natural';
  let suspend: LoopOutcome['suspend'] | undefined;
  // Verified generation (1.8): attempt counter + final verdict for metadata.
  let verifyAttempts = 0;
  let verified: boolean | undefined;
  // ONE sink per RUN (1.9): the loop re-derives capabilities every step, so a
  // per-step sink would report a single stripped setting once per step. The
  // sink's own dedupe only works if every step shares it.
  const warnings = createWarningSink(deps.logger);
  let falseFinishRetries = 0;
  let falseFinishAccepted = false;
  // Guardrails (2.0): the buffered loop has no stream, so every non-pass verdict
  // is recorded HERE and surfaces in bulk on `providerMetadata.deuz.guardrails`
  // (the streaming twin records the same list AND emits live `guardrail` parts).
  const guardrailLog: GuardrailLogEntry[] = [];
  // Handoff (2.0): `undefined` = the ROOT agent is driving. Every accepted
  // transfer REPLACES this snapshot (model + local tools + budget counter); the
  // streaming twin keeps the identical state under the same name.
  let active: ActiveAgentState | undefined;
  /** Every `transfer_to_*` tool of the run, captured once from the ROOT set. */
  let handoffTools: ToolSet = {};
  /** One entry per accepted transfer — surfaces on `providerMetadata.deuz.handoffs`. */
  const handoffLog: HandoffLogEntry[] = [];
  /** Set by an `onOutput` rewrite/block — what `finish()` returns instead of the model's text. */
  let guardrailText: string | undefined;
  /** True once `onInput` refused the run: no model call, and no memory write. */
  let inputBlocked = false;

  // Mutated per iteration so tool events parent under the current step span;
  // settle-phase executions run step-less under the run span.
  const observeCtx = lo
    ? {
        rt: lo.rt,
        parentSpanId: lo.runSpanId as string | undefined,
        stepIndex: undefined as number | undefined,
        counters: errorCounters,
        approvalWaitMs: internal?.observeResume?.checkpointAgeMs,
      }
    : undefined;

  const extras: ExecuteExtras = {
    // Inject the EFFECTIVE onUsage (call-level wins over deps-level, G10) so a
    // sub-agent can forward its usage to the same callback the caller set.
    deps: { ...deps, onUsage: options.onUsage ?? deps.onUsage },
    // Sub-agent usage counts toward the parent total (result + budget stops).
    reportUsage: (u) => {
      totalUsage = sumUsage(totalUsage, u);
    },
    // Durable seam (1.5): lets an agentTool checkpoint a child run and settle
    // its suspended approvals on a resume leg.
    ...(durable ? { session: { store: durable.store, runId: durable.runId } } : {}),
    ...(options.approvalResponses ? { approvalResponses: options.approvalResponses } : {}),
    ...(observeCtx ? { observe: observeCtx } : {}),
  };

  const finish = (): GenerateTextResult => {
    const lastToolStep = [...steps].reverse().find((s) => s.toolCalls.length > 0);
    return {
      // An `onOutput` verdict (2.0) is authoritative: the same text is also
      // written into the appended assistant message, the checkpoint and the
      // chat record, so nothing the caller can reach disagrees with it.
      text: guardrailText ?? lastStep?.text ?? '',
      usage: withTotal(totalUsage),
      finishReason: lastStep?.finishReason ?? 'stop',
      response: { messages: appended },
      steps,
      ...(warnings.list().length ? { warnings: warnings.list() } : {}),
      ...(lastToolStep
        ? { toolCalls: lastToolStep.toolCalls, toolResults: lastToolStep.toolResults }
        : {}),
      ...(pendingApprovals ? { pendingApprovals } : {}),
      ...(deuzMetadata() ? { providerMetadata: { deuz: deuzMetadata()! } } : {}),
      ...(durable ? { runId: durable.runId } : {}),
    };
  };

  /** SDK-level metadata (`stoppedBy`, `verified`, `guardrails`, `handoffs`) — undefined when empty. */
  const deuzMetadata = (): Record<string, unknown> | undefined => {
    const meta: Record<string, unknown> = {};
    if (stoppedBy) meta.stoppedBy = stoppedBy;
    if (verified !== undefined) meta.verified = verified;
    if (guardrailLog.length > 0) meta.guardrails = guardrailLog;
    if (handoffLog.length > 0) meta.handoffs = handoffLog;
    return Object.keys(meta).length > 0 ? meta : undefined;
  };

  /** Terminal observe event + chat persist + result — the single exit for every path. */
  const done = async (): Promise<GenerateTextResult> => {
    if (lo) {
      endLoopObserve(lo, deps, options, {
        finishReason: lastStep?.finishReason ?? 'stop',
        endReason,
        stoppedBy,
        stepCount: steps.length,
        usage: withTotal(totalUsage),
        ...(durable ? { cumulativeUsage: withTotal(durableUsage(durable, totalUsage)) } : {}),
        suspend,
      });
    }
    await persistChat(options, deps, chatMessages, chatPersistence.writable);
    const result = finish();
    // Memory extraction (1.7, D1): non-blocking. Suspended runs skip the
    // incomplete turn but retain a settled empty promise for stream parity.
    // A run an input guardrail REFUSED is incomplete in the same sense — and
    // writing the refused turn to long-term memory would be the one thing the
    // guardrail was installed to prevent.
    const incomplete = suspend !== undefined || inputBlocked;
    const memoryPromise = incomplete
      ? options.memory && options.memory.extract !== false
        ? Promise.resolve([])
        : undefined
      : // Memory operations parent under the RUN span, not the last step's: the
        // extraction covers the whole turn and outlives every step boundary.
        startMemoryExtract(
          options,
          deps,
          appended,
          lo ? { rt: lo.rt, parentSpanId: lo.runSpanId } : undefined,
        );
    if (memoryPromise) result.memory = memoryPromise;
    // Settlement (1.6.1): the cost enrichment was registered synchronously
    // inside endLoopObserve above — settled() drains it.
    if (lo) result.observation = { settled: lo.rt.settled() };
    return result;
  };

  /** Checkpoint correlation for run.suspended (stepIndex bumped inside saveCheckpoint). */
  const checkpointRef = (): { checkpointStepId?: string; checkpointStepIndex?: number } =>
    durable
      ? {
          checkpointStepId: `${durable.runId}#${durable.stepIndex}`,
          checkpointStepIndex: durable.stepIndex,
        }
      : {};

  try {
    // Zero-config MCP (2.0): connect BEFORE the wire is built, so the servers'
    // tools are part of the very first model call. Explicit `tools` are merged
    // LAST and always win a name collision.
    mcp = await setupMcp(options, deps);
    tools = mergeMcpTools(mcp, ownTools);
    // Handoff (2.0): the transfer catalog is read from the ROOT set, ONCE — an
    // agent's own set never carries a transfer to itself, so re-deriving it
    // later would lose targets one by one.
    handoffTools = collectHandoffTools(tools);
    // A resume leg re-applies the checkpoint's overlay BEFORE the wires are
    // built and before the pending approvals settle: those settled calls belong
    // to the agent that issued them, and it is no longer the root one. The
    // system message needs nothing — it rode in with the checkpointed history.
    if (internal?.resumeHandoff) {
      active = resumeHandoffState(
        internal.resumeHandoff,
        ownTools,
        handoffTools,
        options.model,
        deps.logger,
      );
      ownTools = active.tools;
      tools = mergeMcpTools(mcp, ownTools);
      if (durable) durable.handoff = internal.resumeHandoff;
    }
    let fullWire = await buildWireTools(tools, options.toolChoice, options.maxToolConcurrency);
    let staticWire = filterWireTools(fullWire, options.activeTools, deps.logger);

    // Resume: settle the previous break's pending approvals BEFORE the first
    // model call — the new tool message flows into response.messages. A durable
    // sub-agent that re-suspends here suspends THIS run again immediately.
    try {
      const settled = await settlePendingApprovals(messages, tools, options, extras);
      if (settled) {
        messages = settled.messages;
        const toolMessage = settled.messages.at(-1)!;
        appended.push(toolMessage);
        chatMessages = [...chatMessages, toolMessage];
        bumpErrorGuard(
          errorCounters,
          settled.results.filter((r) => !settled.deniedIds.has(r.toolCallId)),
        );
      }
    } catch (err) {
      if (!(err instanceof SubAgentSuspension)) throw err;
      pendingApprovals = err.approvals;
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
      suspend = {
        reason: 'sub-agent-approval',
        pendingApprovalCount: err.approvals.length,
        pendingToolCount: 0,
        ...checkpointRef(),
      };
      return done();
    }

    // Memory recall (1.7, D1): computed once, spliced in at the model-call
    // site only — canonical history/checkpoints/persistence stay recall-free.
    // Its observation parents under the RUN span (no step is open yet).
    const recallBlock = await computeRecallBlock(options, deps, messages, observeCtx);
    // Recall overhead (2.0): the block never enters `messages`, but the provider
    // counts it. Both the compaction threshold and the EMA calibration have to
    // see the same total, or every step's estimate is short by one block.
    const recallOverheadTokens =
      recallBlock && compactionRunner
        ? compactionRunner.estimator.estimate([{ role: 'system', content: recallBlock }])
        : 0;

    // Input guardrails (2.0): ONCE per run leg — after the resume settle and the
    // recall computation, before the first model call. A BLOCK is a graceful
    // stop, not a throw: no request ever reaches the provider, the answer is
    // empty, and `stoppedBy` says why. A rewrite replaces the history the run
    // starts from.
    {
      const guarded = await evaluateInputGuardrails(options, messages);
      logGuardrailParts(guardrailLog, guarded.parts);
      if (guarded.outcome === 'block') {
        inputBlocked = true;
        stoppedBy = GUARDRAIL_INPUT_STOPPED_BY;
        endReason = 'stop-condition';
        if (durable) {
          // 'completed', not 'suspended': nothing is pending and there is
          // nothing to resume — the run reached a deliberate end.
          await saveCheckpoint(durable, deps, options, 'completed', messages, totalUsage);
        }
        return done();
      }
      messages = guarded.messages;
    }

    for (;;) {
      // Previous step overran its budget? Fail before starting another one.
      assertStepDeadline();
      stepTimeout?.clear();
      stepTimeout = createStepTimeout(deps.clock, timeouts.stepMs);
      const stepIndex = stepBase + steps.length;
      const stepSpan = lo?.rt.startSpan();
      if (observeCtx && stepSpan) {
        // Compaction + tool events of THIS iteration parent under the step span.
        observeCtx.parentSpanId = stepSpan.spanId;
        observeCtx.stepIndex = stepIndex;
      }
      const addCompactionUsage = (u: Usage): void => {
        totalUsage = sumUsage(totalUsage, u);
      };
      const logCompaction = (e: CompactionEvent, trigger: CompactionTrigger): void => {
        deps.logger.info(`compaction[${trigger}]: ${e.layer} ${e.tokensBefore}->${e.tokensAfter}`);
      };
      // Compaction first, so prepareStep sees (and has the last word on) the
      // compacted history.
      if (compactionRunner) {
        messages = await runCompaction(
          compactionRunner,
          options,
          deps,
          messages,
          addCompactionUsage,
          logCompaction,
          observeCtx,
          recallOverheadTokens,
        );
      }
      // MCP hot-swap (2.0): a server that announced `tools/list_changed` since
      // the last step gets re-read HERE, so the new catalog is on the wire from
      // the very next call. Rebuilding both wires (not just the full one) keeps
      // `activeTools` applied to the refreshed set, and `prepareStep` below
      // still has the last word.
      if (mcp?.changed()) {
        // `ownTools`, not `options.tools`: after a handoff the local half of the
        // set belongs to the ACTIVE agent, and re-merging the caller's would
        // silently undo the transfer.
        tools = await refreshMcpTools(mcp, ownTools, deps);
        fullWire = await buildWireTools(tools, options.toolChoice, options.maxToolConcurrency);
        staticWire = filterWireTools(fullWire, options.activeTools, deps.logger);
      }
      const prepared = await applyPrepareStep(
        // Handoff (2.0): the active agent's model drives every step after the
        // transfer — and `prepareStep` still has the LAST word, because it runs
        // inside this call and overrides whatever it is handed.
        active ? { ...options, model: active.model } : options,
        { stepIndex, messages, usage: durableUsage(durable, totalUsage) },
        fullWire,
        staticWire,
        deps.logger,
      );
      messages = prepared.messages;
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
      // Overflow auto-recovery (2.0): ONE retry per step. The provider rejected
      // the request as too long, so force a compaction pass and re-run the same
      // step against the shrunk history — recall block included, exactly as the
      // first attempt spliced it. A SECOND overflow in the same step propagates
      // verbatim: compaction already gave what it could, and looping on it would
      // only burn summarize calls.
      let overflowRetried = false;
      let step: OneStep;
      for (;;) {
        try {
          step = await runOneStep(
            preserveClientContext(options, {
              ...prepared.options,
              messages: withSystemBlock(messages, recallBlock),
            }),
            {
              tools: prepared.wire,
              warnings,
              // stepMs rides in as a FAILURE signal, never as the user's cancel
              // signal: the inner pump reports a TimeoutError instead of resolving
              // 'aborted' (see InternalRunOptions.failSignal).
              ...(stepTimeout ? { failSignal: stepTimeout.signal } : {}),
              ...(lo && stepSpan
                ? { observe: { runtime: lo.rt, parentSpanId: stepSpan.spanId, stepIndex } }
                : {}),
            },
          );
          break;
        } catch (err) {
          if (overflowRetried || !isContextOverflow(err)) throw err;
          overflowRetried = true;
          const recovered = await recoverFromOverflow(
            compactionRunner,
            options,
            deps,
            messages,
            addCompactionUsage,
            logCompaction,
            observeCtx,
          );
          if (!recovered) throw err;
          messages = recovered;
          // Re-measure: calibrating the EMA against the PRE-compaction estimate
          // would teach it that the history is far bigger than what was sent.
          estimatedAtCall = estimateAtCall();
        }
      }
      lastStep = step;
      totalUsage = sumUsage(totalUsage, step.usage);
      calibrateCompaction(compactionRunner, estimatedAtCall, step.usage);

      // *** GEMINI GUARD: continue on tool_use parts, NOT finishReason ***
      if (step.toolUseParts.length === 0) {
        const sr = toStepResult(step, [], [], steps.length);
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
        // raw ChatStore history and response delta are tracked separately.
        messages = [...messages, step.assistantMessage];
        appended.push(step.assistantMessage);
        chatMessages = [...chatMessages, step.assistantMessage];

        // False-finish guard (1.9, N2): consulted BEFORE verifyStep at this same
        // natural-completion boundary — the cheaper, narrower question — and a
        // rejection that re-drives SHORT-CIRCUITS verification for this round
        // (nothing worth verifying in an answer the caller calls incomplete).
        // The two retry budgets never mix. Mirrors the streaming loop exactly;
        // the buffered path has no stream, so there is no `false-finish` part.
        const completion = await evaluateDoneWhen(options, {
          stepIndex,
          attempt: falseFinishRetries,
          text: step.text,
          messages,
          usage: durableUsage(durable, totalUsage),
        });
        if (completion) {
          if (completion.done) {
            // A later round genuinely finished: an earlier give-up must not mark
            // THIS answer as accepted-over-an-objection.
            falseFinishAccepted = false;
          } else if (completion.retry) {
            falseFinishRetries += 1;
            const nudge = falseFinishMessage();
            messages = [...messages, nudge];
            appended.push(nudge);
            chatMessages = [...chatMessages, nudge];
            if (durable) {
              await saveCheckpoint(durable, deps, options, 'running', messages, totalUsage);
            }
            // No stepIndex bump: unlike the streaming loop's mutable counter,
            // here `stepIndex` derives from `steps.length` each iteration, so a
            // re-drive advances it exactly the way the verify retry does.
            continue;
          } else {
            // Budget spent: the answer stands as final, but the run records WHY.
            falseFinishAccepted = true;
          }
        }

        // Verified generation (1.8): a rejected verdict feeds feedback back as
        // a user turn and re-drives the loop (bounded by maxVerifyAttempts).
        const verification = await evaluateVerifyStep(options, {
          stepIndex,
          attempt: verifyAttempts,
          text: step.text,
          messages,
          usage: durableUsage(durable, totalUsage),
        });
        if (verification) {
          verified = verification.verdict.ok;
          if (verification.retry) {
            verifyAttempts += 1;
            const feedback = verifyFeedbackMessage(verification.verdict);
            messages = [...messages, feedback];
            appended.push(feedback);
            chatMessages = [...chatMessages, feedback];
            if (durable) {
              await saveCheckpoint(durable, deps, options, 'running', messages, totalUsage);
            }
            continue;
          }
        }
        if (falseFinishAccepted) stoppedBy = FALSE_FINISH_STOPPED_BY;

        // Output guardrails (2.0): the LAST word at a natural completion, run
        // only once `doneWhen` AND `verifyStep` have both accepted — a re-driven
        // round `continue`s above, so the text a guardrail sees is the one the
        // run is about to return. A verdict rewrites the appended assistant
        // message too, BEFORE the checkpoint below, so the caller's `text`, the
        // durable state and the chat record can never disagree.
        const outputVerdict = await evaluateOutputGuardrails(options, {
          text: step.text,
          messages,
          stepIndex,
        });
        logGuardrailParts(guardrailLog, outputVerdict.parts);
        if (outputVerdict.outcome === 'block') {
          guardrailText = outputVerdict.replacement ?? '';
          stoppedBy = GUARDRAIL_OUTPUT_STOPPED_BY;
        } else if (outputVerdict.text !== step.text) {
          guardrailText = outputVerdict.text;
        }
        if (guardrailText !== undefined) {
          const rewritten = rewriteAssistantText(step.assistantMessage, guardrailText);
          messages = [...messages.slice(0, -1), rewritten];
          appended[appended.length - 1] = rewritten;
          chatMessages = [...chatMessages.slice(0, -1), rewritten];
        }

        if (durable) {
          await saveCheckpoint(durable, deps, options, 'completed', messages, totalUsage);
        }
        break;
      }

      let toolCalls: ToolCall[] = step.toolUseParts.map((p) => ({
        toolCallId: p.id,
        toolName: p.name,
        args: p.input,
      }));
      messages = [...messages, step.assistantMessage]; // assistant FIRST (OpenAI ordering)
      appended.push(step.assistantMessage);
      chatMessages = [...chatMessages, step.assistantMessage];

      // Handoff (2.0): the DETERMINISTIC interception — before guardrails, the
      // approval gate and `executeTools`. A transfer is decided by looking at
      // the call, never by an exception thrown out of an `execute`. Everything
      // ELSE in the batch runs completely normally: a model that calls `search`
      // and `transfer_to_billing` in one step gets both honored.
      const { handoffCalls, normalCalls } = hasHandoffTools(handoffTools)
        ? splitHandoffCalls(toolCalls, tools)
        : { handoffCalls: [], normalCalls: toolCalls };

      // Tool-call guardrails (2.0): evaluated IMMEDIATELY before the approval
      // gate, so a rewrite reaches the `needsApproval` predicate, the approval
      // request a human sees, and `execute` — while the assistant turn appended
      // just above keeps the arguments the MODEL issued.
      const guardedCalls = await applyToolCallGuardrails(options, normalCalls, messages, stepIndex);
      logGuardrailParts(guardrailLog, guardedCalls.parts);
      /** What actually reaches the gate + `executeTools` (transfers excluded). */
      const execCalls = guardedCalls.calls;
      // The REPORTED calls stay in the model's own order and include the
      // transfers, so `StepResult.toolCalls` describes the step the model took —
      // with any guardrail rewrite applied, exactly as before.
      toolCalls =
        handoffCalls.length === 0
          ? execCalls
          : (() => {
              const rewritten = new Map(execCalls.map((c) => [c.toolCallId, c]));
              return toolCalls.map((c) => rewritten.get(c.toolCallId) ?? c);
            })();
      // A blocked call never reaches the approval gate: it already has a
      // verdict, and gating it would suspend the run on a call that is not
      // going to run either way.
      const gateCandidates =
        guardedCalls.blocked.size > 0
          ? execCalls.filter((c) => !guardedCalls.blocked.has(c.toolCallId))
          : execCalls;

      // Approval gate: server mode denies inline; without approveToolCall the
      // gated calls break the loop like client tools (client mode).
      const gated = await findApprovalNeeded(gateCandidates, tools, options, messages);
      const denied = options.approveToolCall
        ? await resolveServerApprovals(gated, gateCandidates, options, messages)
        : new Map<string, Denial>();
      // Guardrail blocks JOIN the approval flow's denial map — one machinery for
      // every "this call does not run" verdict.
      for (const [id, denial] of guardedCalls.blocked) denied.set(id, denial);
      const pendingApproval = options.approveToolCall
        ? []
        : gateCandidates.filter((c) => gated.has(c.toolCallId));
      if (observeCtx && gated.size > 0) {
        const gatedCalls = toolCalls.filter((c) => gated.has(c.toolCallId));
        observeApprovalRequests(
          observeCtx,
          options,
          gatedCalls,
          options.approveToolCall ? 'server' : 'client',
        );
        if (options.approveToolCall) {
          observeServerResolutions(observeCtx, options, gatedCalls, denied);
        }
      }

      // Pending approvals and client tools (no execute) can't be auto-continued —
      // ONE break, executing nothing from the batch; the resume settles the rest.
      if (pendingApproval.length > 0 || hasClientTool(toolCalls, tools)) {
        if (pendingApproval.length > 0) {
          pendingApprovals = await signApprovalRequests(
            toApprovalRequests(pendingApproval, options.agentPath),
            options,
            deps,
            durable?.runId,
          );
        }
        const sr = toStepResult(step, toolCalls, [], steps.length);
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
            pendingApprovals,
          );
        }
        suspend = {
          reason: pendingApproval.length > 0 ? 'approval' : 'client-tool',
          pendingApprovalCount: pendingApprovals?.length ?? 0,
          // Only REAL client tools are pending on the caller (1.9) — a
          // hallucinated name self-healed inside the step instead.
          pendingToolCount: toolCalls.filter((c) => isClientTool(tools, c.toolName)).length,
          ...checkpointRef(),
        };
        break;
      }

      let toolResults;
      try {
        toolResults = await executeTools(execCalls, tools, options, messages, denied, extras);
      } catch (err) {
        if (!(err instanceof SubAgentSuspension)) throw err;
        // A durable sub-agent suspended: no tool message is appended — its
        // tool_use stays unanswered and the resume leg's settle re-executes it,
        // which resumes the child checkpoint.
        pendingApprovals = err.approvals;
        const sr = toStepResult(step, toolCalls, [], steps.length);
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
        suspend = {
          reason: 'sub-agent-approval',
          pendingApprovalCount: err.approvals.length,
          pendingToolCount: 0,
          ...checkpointRef(),
        };
        break;
      }
      // The step's own budget covers its tool executions (1.9): if it expired
      // while they ran, the step is over — fail here rather than feeding results
      // back into a model call that can no longer be paid for.
      assertStepDeadline();
      // Handoff (2.0): every transfer `tool_use_id` is answered HERE — the first
      // with the transfer confirmation, its siblings (and everything, once the
      // budget is spent) with a self-healing is_error. Merged back into the
      // model's own call order so the turn reads the way it was issued.
      const handoffDecision =
        handoffCalls.length > 0 ? decideHandoff(handoffCalls, active) : undefined;
      if (handoffDecision) {
        toolResults = mergeResultsInCallOrder(toolCalls, toolResults, handoffDecision.results);
      }
      const toolResultMessage: Message = {
        role: 'tool',
        content: toolResults.map(toToolResultPart),
      };
      messages = [...messages, toolResultMessage]; // EVERY tool_use answered (Anthropic 400 guard)
      appended.push(toolResultMessage);
      chatMessages = [...chatMessages, toolResultMessage];

      // The SWAP, once the turn is complete: from here the run is a different
      // agent. `messages` is REWRITTEN (new system turn) rather than appended to
      // — `appended`/`chatMessages` must not grow a turn the caller never sent —
      // and both wires are rebuilt so the next call carries the new catalog.
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
        ownTools = active.tools;
        tools = mergeMcpTools(mcp, ownTools);
        fullWire = await buildWireTools(tools, options.toolChoice, options.maxToolConcurrency);
        staticWire = filterWireTools(fullWire, options.activeTools, deps.logger);
        if (durable) durable.handoff = { to: active.name!, count: active.handoffCount };
      }

      const sr = toStepResult(step, toolCalls, toolResults, steps.length, toolResultMessage);
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
      const handoffIds =
        handoffCalls.length > 0 ? new Set(handoffCalls.map((h) => h.call.toolCallId)) : undefined;
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
      const costUSD =
        wantCost && deps.priceProvider
          ? ((await deps.priceProvider.priceUsage(options.model.modelId, runUsage)) ?? undefined)
          : undefined;
      const stop = await shouldStop(stopConditions, steps, {
        usage: runUsage,
        costUSD,
        elapsedMs: deps.clock.now() - startedAt,
      });
      if (stop.stop) {
        stoppedBy = stop.stoppedBy;
        endReason = stop.stoppedBy !== undefined ? 'stop-condition' : 'max-steps';
        if (durable) {
          await saveCheckpoint(durable, deps, options, 'completed', messages, totalUsage);
        }
        break;
      }
      if (durable) {
        await saveCheckpoint(durable, deps, options, 'running', messages, totalUsage);
      }
    }

    return done();
  } catch (err) {
    if (lo) {
      endLoopObserve(lo, deps, options, {
        finishReason: 'error',
        endReason,
        stepCount: steps.length,
        usage: withTotal(totalUsage),
        error: err,
      });
    }
    throw err;
  } finally {
    // Release the step deadline on EVERY exit (break, return, throw): an
    // un-cancelled host timer keeps a Node process (and a test run) alive.
    stepTimeout?.clear();
    // Same reason, one layer up (2.0): every exit — completion, suspension,
    // throw — releases the connections THIS run opened. Borrowed and pooled
    // clients are never touched, and a failing teardown only logs.
    await closeMcp(mcp, deps);
  }
}
