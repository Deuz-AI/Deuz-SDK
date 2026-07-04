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
  executeTools,
  toToolResultPart,
  toStepResult,
  hasClientTool,
  bumpErrorGuard,
  normalizeStop,
  shouldStop,
  sumUsage,
  findApprovalNeeded,
  resolveServerApprovals,
  settlePendingApprovals,
} from './loop-shared';

/**
 * The agentic loop: run a model step, execute any tool calls (parallel + capped,
 * self-healing on error), feed results back as a NEW immutable message array,
 * repeat until no tool calls (NOT finishReason — Gemini stop-bug guard) or a
 * stop condition / runaway guard fires.
 */
export async function runToolLoop(options: CommonCallOptions): Promise<GenerateTextResult> {
  const tools = options.tools!;
  const deps = resolveDependencies(options.deps);
  const fullWire = await buildWireTools(tools, options.toolChoice, options.maxToolConcurrency);
  const staticWire = filterWireTools(fullWire, options.activeTools, deps.logger);
  let messages: Message[] = [...options.messages];
  // Messages this call appends — returned as response.messages. Tracked as a
  // list (not a base-length slice) so prepareStep/compaction history rewrites
  // can never skew what the caller receives.
  const appended: Message[] = [];
  const steps: StepResult[] = [];
  const stopConditions = normalizeStop(options.stopWhen, options.maxSteps ?? 1);
  const errorCounters = new Map<string, number>();
  let totalUsage: Usage = EMPTY_USAGE;
  let lastStep: OneStep | undefined;
  let pendingApprovals: ToolApprovalRequest[] | undefined;

  // Resume: settle the previous break's pending approvals BEFORE the first
  // model call — the new tool message flows into response.messages.
  const settled = await settlePendingApprovals(messages, tools, options);
  if (settled) {
    messages = settled.messages;
    appended.push(settled.messages.at(-1)!);
    bumpErrorGuard(
      errorCounters,
      settled.results.filter((r) => !settled.deniedIds.has(r.toolCallId)),
    );
  }

  for (;;) {
    const prepared = await applyPrepareStep(
      options,
      { stepIndex: steps.length, messages, usage: totalUsage },
      fullWire,
      staticWire,
      deps.logger,
    );
    messages = prepared.messages;
    const step = await runOneStep({ ...prepared.options, messages }, { tools: prepared.wire });
    lastStep = step;
    totalUsage = sumUsage(totalUsage, step.usage);

    // *** GEMINI GUARD: continue on tool_use parts, NOT finishReason ***
    if (step.toolUseParts.length === 0) {
      steps.push(toStepResult(step, [], [], steps.length));
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
        pendingApprovals = pendingApproval.map((c) => ({
          approvalId: c.toolCallId,
          toolCallId: c.toolCallId,
          toolName: c.toolName,
          input: c.args,
        }));
      }
      const sr = toStepResult(step, toolCalls, [], steps.length);
      steps.push(sr);
      options.onStepFinish?.(sr);
      break;
    }

    const toolResults = await executeTools(toolCalls, tools, options, messages, denied);
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
    )
      break;
    if (await shouldStop(stopConditions, steps)) break;
  }

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
  };
}
