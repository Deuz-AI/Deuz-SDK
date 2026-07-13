import type { CommonCallOptions } from '../types/config';
import type { StreamChatResult } from '../types/methods';
import type { StreamPart } from '../types/stream';
import type { Message } from '../types/message';
import type { Usage, FinishReason } from '../types/usage';
import type { ToolCall, StepResult, ToolApprovalRequest } from '../types/tool';
import { runStream } from '../core/inference';
import { resolveDependencies } from '../internal/resolve-deps';
import {
  createObservationRuntime,
  counterFields,
  type ObservationRuntime,
} from '../internal/observe-runtime';
import { toObservedError } from '../internal/observe-error';
import { createBroadcaster, createDeferred, lazyAsyncIterable } from '../internal/async-iter';
import { assembleAssistant, type ToolArgMap, type EncryptedReasoning } from './run-step';
import { EMPTY_USAGE, withTotal, fireFinish } from '../core/metering';
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
  saveCheckpoint,
  durableUsage,
  toApprovalRequests,
  preserveClientContext,
  beginLoopObserve,
  endLoopObserve,
  emitStepStarted,
  emitStepCompleted,
  observeApprovalRequests,
  observeServerResolutions,
  SubAgentSuspension,
  type Denial,
  type DurableRunner,
  type ExecuteExtras,
  type LoopOutcome,
} from './loop-shared';

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
  resumeFrom?: { stepIndex: number; usage: Usage };
  resumeLoad?: (rt?: ObservationRuntime) => Promise<{
    messages: Message[];
    resumeFrom: { stepIndex: number; usage: Usage };
    /** Observation (1.6): checkpoint correlation for run.started. */
    observeResume?: { stepId: string; stepIndex: number; checkpointAgeMs?: number };
  }>;
  /** Observation (1.6): resume-leg correlation for run.started. */
  observeResume?: { stepId: string; stepIndex: number; checkpointAgeMs?: number };
  /** Observation (1.6): sub-agent — share the parent runtime, emit no run.* events. */
  observeInherited?: { runtime: ObservationRuntime; parentSpanId?: string };
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
  const fullSub = broadcaster.subscribe();
  const textSub = broadcaster.subscribe();

  let started = false;
  function ensureStarted(): void {
    if (started) return;
    started = true;
    void pump();
  }

  async function pump(): Promise<void> {
    const tools = options.tools ?? {};
    // Loop start timestamp for `durationExceeds` — pump start, when work
    // actually begins (the shell returns synchronously and lazily, G2).
    const startedAt = deps.clock.now();
    let messages: Message[] = [...options.messages];
    let resumeFrom = internal?.resumeFrom;
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
        observeResume = loaded.observeResume ?? observeResume;
      } catch (err) {
        broadcaster.push({ type: 'error', error: err });
        usageDeferred.reject(err);
        finishDeferred.reject(err);
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
        broadcaster.close();
        return;
      }
    }
    const durable: DurableRunner | undefined =
      options.session && runId !== undefined
        ? {
            store: options.session.store,
            runId,
            baseUsage: resumeFrom?.usage ?? EMPTY_USAGE,
            stepIndex: resumeFrom?.stepIndex ?? 0,
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
    const steps: StepResult[] = [];
    const stopConditions = normalizeStop(options.stopWhen, options.maxSteps ?? 1);
    const wantCost = needsCost(stopConditions);
    if (wantCost && !deps.priceProvider) {
      deps.logger.warn('costExceeds: no deps.priceProvider injected — the condition never fires');
    }
    const errorCounters = new Map<string, number>();
    const compactionRunner = setupCompaction(options, deps);
    let totalUsage: Usage = EMPTY_USAGE;
    let lastFinish: FinishReason = 'stop';
    let stoppedBy: string | undefined;
    let stepIndex = resumeFrom?.stepIndex ?? 0;
    let endReason: LoopOutcome['endReason'] = 'natural';
    let suspend: LoopOutcome['suspend'] | undefined;

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
      ...(durable ? { session: { store: durable.store, runId: durable.runId } } : {}),
      ...(options.approvalResponses ? { approvalResponses: options.approvalResponses } : {}),
      ...(observeCtx ? { observe: observeCtx } : {}),
    };

    const emitApprovalRequests = (requests: ToolApprovalRequest[]): void => {
      for (const r of requests) {
        broadcaster.push({
          type: 'tool-approval-request',
          approvalId: r.approvalId,
          toolCallId: r.toolCallId,
          toolName: r.toolName,
          input: r.input,
          ...(r.agentPath && r.agentPath.length > 0 ? { agentPath: r.agentPath } : {}),
        });
      }
    };

    try {
      const fullWire = await buildWireTools(tools, options.toolChoice, options.maxToolConcurrency);
      const staticWire = filterWireTools(fullWire, options.activeTools, deps.logger);

      // Resume: settle the previous break's pending approvals BEFORE step 1 —
      // their tool-result parts precede the first step-start. A durable
      // sub-agent that re-suspends here suspends THIS run again immediately.
      try {
        const settled = await settlePendingApprovals(messages, tools, options, extras);
        if (settled) {
          messages = settled.messages;
          for (const r of settled.results) {
            broadcaster.push({
              type: 'tool-result',
              toolCallId: r.toolCallId,
              toolName: r.toolName,
              output: r.result,
              ...(r.isError ? { isError: true } : {}),
            });
          }
          bumpErrorGuard(
            errorCounters,
            settled.results.filter((r) => !settled.deniedIds.has(r.toolCallId)),
          );
        }
      } catch (err) {
        if (!(err instanceof SubAgentSuspension)) throw err;
        emitApprovalRequests(err.approvals);
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
        const usage = withTotal(totalUsage);
        broadcaster.push({ type: 'finish', usage, finishReason: lastFinish });
        usageDeferred.resolve(usage);
        finishDeferred.resolve(lastFinish);
        fireFinish(options, deps, { model: options.model.modelId, finishReason: lastFinish });
        observeEnd();
        broadcaster.close();
        return;
      }

      for (;;) {
        broadcaster.push({ type: 'step-start', stepIndex });
        const stepSpan = lo?.rt.startSpan();
        if (observeCtx && stepSpan) {
          // Compaction + tool events of THIS iteration parent under the step span.
          observeCtx.parentSpanId = stepSpan.spanId;
          observeCtx.stepIndex = stepIndex;
        }
        // Compaction first — its parts precede the step's deltas; prepareStep
        // then sees the compacted history.
        if (compactionRunner) {
          messages = await runCompaction(
            compactionRunner,
            options,
            deps,
            messages,
            (u) => {
              totalUsage = sumUsage(totalUsage, u);
            },
            (e) =>
              broadcaster.push({
                type: 'compaction',
                layer: e.layer,
                tokensBefore: e.tokensBefore,
                tokensAfter: e.tokensAfter,
              }),
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
        const inner = runStream(preserveClientContext(options, { ...prepared.options, messages }), {
          tools: prepared.wire,
          ...(lo && stepSpan
            ? { observe: { runtime: lo.rt, parentSpanId: stepSpan.spanId, stepIndex } }
            : {}),
        });

        let text = '';
        let reasoningText = '';
        let reasoningSignature: string | undefined;
        const encryptedReasoning: EncryptedReasoning = [];
        const toolArgs: ToolArgMap = new Map();
        const toolOrder: string[] = [];
        let stepUsage: Usage = EMPTY_USAGE;
        let stepFinish: FinishReason = 'stop';
        let stepPhase: string | undefined;

        for await (const part of inner.fullStream) {
          switch (part.type) {
            case 'text-delta':
              text += part.text;
              broadcaster.push(part);
              break;
            case 'reasoning-delta':
              if (part.encrypted) {
                encryptedReasoning.push({ text: part.text, signature: part.signature });
                broadcaster.push(part);
                break;
              }
              reasoningText += part.text;
              if (part.signature) reasoningSignature = part.signature;
              broadcaster.push(part);
              break;
            case 'tool-call-delta': {
              let entry = toolArgs.get(part.id);
              if (!entry) {
                entry = { name: part.name, args: '' };
                toolArgs.set(part.id, entry);
                toolOrder.push(part.id);
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
              stepPhase = (part.providerMetadata?.openai as { phase?: string } | undefined)?.phase;
              break; // re-framed as step-finish below
            case 'error':
              // The inner pump already emitted model.failed — the loop reports
              // the run failure exactly once here.
              broadcaster.push(part);
              usageDeferred.reject(part.error);
              finishDeferred.reject(part.error);
              if (lo) {
                endLoopObserve(lo, deps, options, {
                  finishReason: 'error',
                  endReason,
                  stepCount: steps.length,
                  usage: withTotal(totalUsage),
                  error: part.error,
                });
              }
              broadcaster.close();
              return;
            default:
              break;
          }
        }

        totalUsage = sumUsage(totalUsage, stepUsage);
        calibrateCompaction(compactionRunner, estimatedAtCall, stepUsage);
        lastFinish = stepFinish;
        broadcaster.push({
          type: 'step-finish',
          stepIndex,
          finishReason: stepFinish,
          usage: stepUsage,
        });

        const { assistantMessage, toolUseParts } = assembleAssistant(
          text,
          reasoningText,
          reasoningSignature,
          toolArgs,
          toolOrder,
          encryptedReasoning,
        );
        if (stepPhase) assistantMessage.providerMetadata = { openai: { phase: stepPhase } };

        const stepData = {
          text,
          reasoningText,
          toolUseParts,
          usage: stepUsage,
          finishReason: stepFinish,
          assistantMessage,
        };

        if (options.signal?.aborted) {
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
          if (durable) {
            await saveCheckpoint(
              durable,
              deps,
              options,
              'completed',
              [...messages, assistantMessage],
              totalUsage,
            );
          }
          break;
        }

        const toolCalls: ToolCall[] = toolUseParts.map((p) => ({
          toolCallId: p.id,
          toolName: p.name,
          args: p.input,
        }));
        for (const c of toolCalls) {
          broadcaster.push({
            type: 'tool-call',
            toolCallId: c.toolCallId,
            toolName: c.toolName,
            input: c.args,
          });
        }
        messages = [...messages, assistantMessage];

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

        // Pending approvals and client tools break together: ONE break, nothing
        // from the batch executes; the resume call settles the deferred rest.
        if (pendingApproval.length > 0 || hasClientTool(toolCalls, tools)) {
          const requests = toApprovalRequests(pendingApproval, options.agentPath);
          emitApprovalRequests(requests);
          const sr = toStepResult(stepData, toolCalls, [], steps.length);
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
          suspend = {
            reason: pendingApproval.length > 0 ? 'approval' : 'client-tool',
            pendingApprovalCount: requests.length,
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
          // A durable sub-agent suspended: its tool_use stays unanswered; the
          // resume leg's settle re-executes it, which resumes the child.
          emitApprovalRequests(err.approvals);
          const sr = toStepResult(stepData, toolCalls, [], steps.length);
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
        for (const r of toolResults) {
          broadcaster.push({
            type: 'tool-result',
            toolCallId: r.toolCallId,
            toolName: r.toolName,
            output: r.result,
            ...(r.isError ? { isError: true } : {}),
          });
        }
        const toolResultMessage: Message = {
          role: 'tool',
          content: toolResults.map(toToolResultPart),
        };
        messages = [...messages, toolResultMessage];

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
        stepIndex++;
      }

      const usage = withTotal(totalUsage);
      broadcaster.push({
        type: 'finish',
        usage,
        finishReason: lastFinish,
        ...(stoppedBy ? { providerMetadata: { deuz: { stoppedBy } } } : {}),
      });
      usageDeferred.resolve(usage);
      finishDeferred.resolve(lastFinish);
      fireFinish(options, deps, { model: options.model.modelId, finishReason: lastFinish });
      observeEnd();
      broadcaster.close();
    } catch (err) {
      broadcaster.push({ type: 'error', error: err });
      usageDeferred.reject(err);
      finishDeferred.reject(err);
      if (lo) {
        endLoopObserve(lo, deps, options, {
          finishReason: 'error',
          endReason,
          stepCount: steps.length,
          usage: withTotal(totalUsage),
          error: err,
        });
      }
      broadcaster.close();
    }
  }

  const fullStream = lazyAsyncIterable<StreamPart>(() => fullSub, ensureStarted);
  const textStream = lazyAsyncIterable<string>(() => projectText(textSub), ensureStarted);

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
    ...(runId !== undefined ? { runId } : {}),
  };
}
