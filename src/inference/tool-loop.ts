import type { CommonCallOptions } from '../types/config';
import type { GenerateTextResult } from '../types/methods';
import type { Message } from '../types/message';
import type { Usage } from '../types/usage';
import type { ToolCall, StepResult, ToolApprovalRequest } from '../types/tool';
import { runOneStep, type OneStep } from './run-step';
import { EMPTY_USAGE, withTotal } from '../core/metering';
import { resolveDependencies } from '../internal/resolve-deps';
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
  durableUsage,
  toApprovalRequests,
  SubAgentSuspension,
  type ExecuteExtras,
} from './loop-shared';

/**
 * Internal-only knobs (NOT public surface): `resumeFrom` seeds the cross-leg
 * step/usage counters when `resumeFromCheckpoint` re-drives the loop.
 */
export interface ToolLoopInternal {
  resumeFrom?: { stepIndex: number; usage: Usage };
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
  const durable = setupDurable(options, deps, internal?.resumeFrom);
  // Cross-leg step offset: prepareStep must see the same continuing indices
  // the streaming loop reports on a resume leg (loop-symmetry invariant).
  const stepBase = internal?.resumeFrom?.stepIndex ?? 0;
  const fullWire = await buildWireTools(tools, options.toolChoice, options.maxToolConcurrency);
  const staticWire = filterWireTools(fullWire, options.activeTools, deps.logger);
  let messages: Message[] = [...options.messages];
  // Messages this call appends — returned as response.messages. Tracked as a
  // list (not a base-length slice) so prepareStep/compaction history rewrites
  // can never skew what the caller receives.
  const appended: Message[] = [];
  const steps: StepResult[] = [];
  const stopConditions = normalizeStop(options.stopWhen, options.maxSteps ?? 1);
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
      ...(stoppedBy ? { providerMetadata: { deuz: { stoppedBy } } } : {}),
      ...(durable ? { runId: durable.runId } : {}),
    };
  };

  // Resume: settle the previous break's pending approvals BEFORE the first
  // model call — the new tool message flows into response.messages. A durable
  // sub-agent that re-suspends here suspends THIS run again immediately.
  try {
    const settled = await settlePendingApprovals(messages, tools, options, extras);
    if (settled) {
      messages = settled.messages;
      appended.push(settled.messages.at(-1)!);
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
    return finish();
  }

  for (;;) {
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
      );
    }
    const prepared = await applyPrepareStep(
      options,
      { stepIndex: stepBase + steps.length, messages, usage: durableUsage(durable, totalUsage) },
      fullWire,
      staticWire,
      deps.logger,
    );
    messages = prepared.messages;
    const estimatedAtCall = compactionRunner?.estimator.estimate(messages) ?? 0;
    const step = await runOneStep({ ...prepared.options, messages }, { tools: prepared.wire });
    lastStep = step;
    totalUsage = sumUsage(totalUsage, step.usage);
    calibrateCompaction(compactionRunner, estimatedAtCall, step.usage);

    // *** GEMINI GUARD: continue on tool_use parts, NOT finishReason ***
    if (step.toolUseParts.length === 0) {
      steps.push(toStepResult(step, [], [], steps.length));
      if (durable) {
        // The final assistant turn belongs in the completed snapshot even
        // though the loop never rebased `messages` on it.
        await saveCheckpoint(
          durable,
          deps,
          options,
          'completed',
          [...messages, step.assistantMessage],
          totalUsage,
        );
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

    // Approval gate: server mode denies inline; without approveToolCall the
    // gated calls break the loop like client tools (client mode).
    const gated = await findApprovalNeeded(toolCalls, tools, options, messages);
    const denied = options.approveToolCall
      ? await resolveServerApprovals(gated, toolCalls, options, messages)
      : new Map<string, string | undefined>();
    const pendingApproval = options.approveToolCall
      ? []
      : toolCalls.filter((c) => gated.has(c.toolCallId));

    // Pending approvals and client tools (no execute) can't be auto-continued —
    // ONE break, executing nothing from the batch; the resume settles the rest.
    if (pendingApproval.length > 0 || hasClientTool(toolCalls, tools)) {
      if (pendingApproval.length > 0) {
        pendingApprovals = toApprovalRequests(pendingApproval, options.agentPath);
      }
      const sr = toStepResult(step, toolCalls, [], steps.length);
      steps.push(sr);
      options.onStepFinish?.(sr);
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
      break;
    }
    const toolResultMessage: Message = { role: 'tool', content: toolResults.map(toToolResultPart) };
    messages = [...messages, toolResultMessage]; // EVERY tool_use answered (Anthropic 400 guard)
    appended.push(toolResultMessage);

    const sr = toStepResult(step, toolCalls, toolResults, steps.length, toolResultMessage);
    steps.push(sr);
    options.onStepFinish?.(sr);

    // Denials are deliberate, not tool failures — exclude from the runaway guard.
    if (
      bumpErrorGuard(
        errorCounters,
        toolResults.filter((r) => !denied.has(r.toolCallId)),
      )
    ) {
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
    const stop = await shouldStop(stopConditions, steps, { usage: runUsage, costUSD });
    if (stop.stop) {
      stoppedBy = stop.stoppedBy;
      if (durable) {
        await saveCheckpoint(durable, deps, options, 'completed', messages, totalUsage);
      }
      break;
    }
    if (durable) {
      await saveCheckpoint(durable, deps, options, 'running', messages, totalUsage);
    }
  }

  return finish();
}
