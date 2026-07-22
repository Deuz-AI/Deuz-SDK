import type { CommonCallOptions } from '../types/config';
import type { GenerateTextResult } from '../types/methods';
import type { Message } from '../types/message';
import type { Usage } from '../types/usage';
import type { ToolCall, StepResult, ToolApprovalRequest } from '../types/tool';
import { runOneStep, type OneStep } from './run-step';
import { EMPTY_USAGE, withTotal } from '../core/metering';
import { resolveDependencies } from '../internal/resolve-deps';
import type { ObservationRuntime } from '../internal/observe-runtime';
import {
  buildWireTools,
  filterWireTools,
  applyPrepareStep,
  setupCompaction,
  runCompaction,
  calibrateCompaction,
  executeTools,
  toToolResultPart,
  toStepResult,
  hasClientTool,
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
  verifyFeedbackMessage,
  SubAgentSuspension,
  type Denial,
  type ExecuteExtras,
  type LoopOutcome,
} from './loop-shared';

/**
 * Internal-only knobs (NOT public surface): `resumeFrom` seeds the cross-leg
 * step/usage counters when `resumeFromCheckpoint` re-drives the loop.
 */
export interface ToolLoopInternal {
  resumeFrom?: { stepIndex: number; usage: Usage };
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
  const tools = options.tools ?? {};
  const deps = resolveDependencies(options.deps);
  // Loop start timestamp for `durationExceeds` (injected clock — never Date.now).
  const startedAt = deps.clock.now();
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
      text: lastStep?.text ?? '',
      usage: withTotal(totalUsage),
      finishReason: lastStep?.finishReason ?? 'stop',
      response: { messages: appended },
      steps,
      ...(lastToolStep
        ? { toolCalls: lastToolStep.toolCalls, toolResults: lastToolStep.toolResults }
        : {}),
      ...(pendingApprovals ? { pendingApprovals } : {}),
      ...(deuzMetadata() ? { providerMetadata: { deuz: deuzMetadata()! } } : {}),
      ...(durable ? { runId: durable.runId } : {}),
    };
  };

  /** SDK-level metadata (`stoppedBy`, `verified`) — undefined when empty. */
  const deuzMetadata = (): Record<string, unknown> | undefined => {
    const meta: Record<string, unknown> = {};
    if (stoppedBy) meta.stoppedBy = stoppedBy;
    if (verified !== undefined) meta.verified = verified;
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
    const memoryPromise = suspend
      ? options.memory && options.memory.extract !== false
        ? Promise.resolve([])
        : undefined
      : startMemoryExtract(options, deps, appended);
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
    const fullWire = await buildWireTools(tools, options.toolChoice, options.maxToolConcurrency);
    const staticWire = filterWireTools(fullWire, options.activeTools, deps.logger);

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
    const recallBlock = await computeRecallBlock(options, deps, messages);

    for (;;) {
      const stepIndex = stepBase + steps.length;
      const stepSpan = lo?.rt.startSpan();
      if (observeCtx && stepSpan) {
        // Compaction + tool events of THIS iteration parent under the step span.
        observeCtx.parentSpanId = stepSpan.spanId;
        observeCtx.stepIndex = stepIndex;
      }
      // Compaction first, so prepareStep sees (and has the last word on) the
      // compacted history.
      if (compactionRunner) {
        messages = await runCompaction(
          compactionRunner,
          options,
          deps,
          messages,
          (u) => {
            totalUsage = sumUsage(totalUsage, u);
          },
          (e) => deps.logger.info(`compaction: ${e.layer} ${e.tokensBefore}->${e.tokensAfter}`),
          observeCtx,
        );
      }
      const prepared = await applyPrepareStep(
        options,
        { stepIndex, messages, usage: durableUsage(durable, totalUsage) },
        fullWire,
        staticWire,
        deps.logger,
      );
      messages = prepared.messages;
      const estimatedAtCall = compactionRunner?.estimator.estimate(messages) ?? 0;
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
      const step = await runOneStep(
        preserveClientContext(options, {
          ...prepared.options,
          messages: withSystemBlock(messages, recallBlock),
        }),
        {
          tools: prepared.wire,
          ...(lo && stepSpan
            ? { observe: { runtime: lo.rt, parentSpanId: stepSpan.spanId, stepIndex } }
            : {}),
        },
      );
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
        if (durable) {
          await saveCheckpoint(durable, deps, options, 'completed', messages, totalUsage);
        }
        break;
      }

      const toolCalls: ToolCall[] = step.toolUseParts.map((p) => ({
        toolCallId: p.id,
        toolName: p.name,
        args: p.input,
      }));
      messages = [...messages, step.assistantMessage]; // assistant FIRST (OpenAI ordering)
      appended.push(step.assistantMessage);
      chatMessages = [...chatMessages, step.assistantMessage];

      // Approval gate: server mode denies inline; without approveToolCall the
      // gated calls break the loop like client tools (client mode).
      const gated = await findApprovalNeeded(toolCalls, tools, options, messages);
      const denied = options.approveToolCall
        ? await resolveServerApprovals(gated, toolCalls, options, messages)
        : new Map<string, Denial>();
      const pendingApproval = options.approveToolCall
        ? []
        : toolCalls.filter((c) => gated.has(c.toolCallId));
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
          pendingToolCount: toolCalls.filter(
            (c) => !tools[c.toolName]?.execute && tools[c.toolName]?.type !== 'provider',
          ).length,
          ...checkpointRef(),
        };
        break;
      }

      let toolResults;
      try {
        toolResults = await executeTools(toolCalls, tools, options, messages, denied, extras);
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
      const toolResultMessage: Message = {
        role: 'tool',
        content: toolResults.map(toToolResultPart),
      };
      messages = [...messages, toolResultMessage]; // EVERY tool_use answered (Anthropic 400 guard)
      appended.push(toolResultMessage);
      chatMessages = [...chatMessages, toolResultMessage];

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

      // Denials are deliberate, not tool failures — exclude from the runaway guard.
      if (
        bumpErrorGuard(
          errorCounters,
          toolResults.filter((r) => !denied.has(r.toolCallId)),
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
  }
}
