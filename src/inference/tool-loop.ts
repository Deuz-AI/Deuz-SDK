import type { CommonCallOptions } from '../types/config';
import type { GenerateTextResult } from '../types/methods';
import type { Message } from '../types/message';
import type { Usage } from '../types/usage';
import type { ToolCall, StepResult, ToolApprovalRequest } from '../types/tool';
import { runOneStep, type OneStep } from './run-step';
import { EMPTY_USAGE, withTotal } from '../core/metering';
import {
  buildWireTools,
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
} from './loop-shared';

/**
 * The agentic loop: run a model step, execute any tool calls (parallel + capped,
 * self-healing on error), feed results back as a NEW immutable message array,
 * repeat until no tool calls (NOT finishReason — Gemini stop-bug guard) or a
 * stop condition / runaway guard fires.
 */
export async function runToolLoop(options: CommonCallOptions): Promise<GenerateTextResult> {
  const tools = options.tools!;
  const wireTools = await buildWireTools(tools, options.toolChoice, options.maxToolConcurrency);
  const baseLength = options.messages.length;
  let messages: Message[] = [...options.messages];
  const steps: StepResult[] = [];
  const stopConditions = normalizeStop(options.stopWhen, options.maxSteps ?? 1);
  const errorCounters = new Map<string, number>();
  let totalUsage: Usage = EMPTY_USAGE;
  let lastStep: OneStep | undefined;
  let pendingApprovals: ToolApprovalRequest[] | undefined;

  for (;;) {
    const step = await runOneStep({ ...options, messages }, { tools: wireTools });
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
    response: { messages: messages.slice(baseLength) },
    steps,
    ...(lastToolStep
      ? { toolCalls: lastToolStep.toolCalls, toolResults: lastToolStep.toolResults }
      : {}),
    ...(pendingApprovals ? { pendingApprovals } : {}),
  };
}
