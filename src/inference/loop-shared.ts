import type { CommonCallOptions } from '../types/config';
import type { Message, Part } from '../types/message';
import type { Usage } from '../types/usage';
import type {
  Tool,
  ToolSet,
  ToolChoice,
  ToolCall,
  ToolResult,
  StepResult,
  StopCondition,
} from '../types/tool';
import type { WireTool, WireToolRequest } from '../adapters/types';
import type { OneStep } from './run-step';
import { stepCountIs } from './stop';
import { toJSONSchema, validateOutput } from '../schema/bridge';
import { mapWithConcurrency } from '../internal/p-limit';
import { ToolExecutionError } from '../errors';

export const MAX_SAME_TOOL_ERRORS = 3;

export function sumUsage(a: Usage, b: Usage): Usage {
  const audio = (a.audioTokens ?? 0) + (b.audioTokens ?? 0);
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    reasoningTokens: a.reasoningTokens + b.reasoningTokens,
    cachedReadTokens: a.cachedReadTokens + b.cachedReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
    cacheWrite1hTokens: a.cacheWrite1hTokens + b.cacheWrite1hTokens,
    ...(audio > 0 ? { audioTokens: audio } : {}),
    totalTokens: a.totalTokens + b.totalTokens,
  };
}

/** Resolve every tool's schema to JSON Schema ONCE (before the pure buildRequest). */
export async function buildWireTools(
  tools: ToolSet,
  toolChoice: ToolChoice | undefined,
  maxConcurrency: number | undefined,
): Promise<WireToolRequest> {
  const wire: WireTool[] = [];
  for (const [name, tool] of Object.entries(tools)) {
    if (tool.type === 'provider') {
      // Provider-executed: the raw native definition rides through verbatim.
      wire.push({ name, parameters: {}, provider: tool.providerTool ?? {} });
      continue;
    }
    wire.push({
      name,
      ...(tool.description ? { description: tool.description } : {}),
      parameters: await toJSONSchema(tool.parameters),
    });
  }
  return { tools: wire, toolChoice, allowParallel: (maxConcurrency ?? 5) > 1 };
}

export function toToolResultPart(r: ToolResult): Part {
  return { type: 'tool_result', toolUseId: r.toolCallId, result: r.result, isError: r.isError };
}

export function toStepResult(
  step: OneStep,
  toolCalls: ToolCall[],
  toolResults: ToolResult[],
  index: number,
  toolResultMessage?: Message,
): StepResult {
  const messages: Message[] = [step.assistantMessage];
  if (toolResultMessage) messages.push(toolResultMessage);
  return {
    stepType: index === 0 ? 'initial' : 'tool-result',
    text: step.text,
    ...(step.reasoningText ? { reasoningText: step.reasoningText } : {}),
    toolCalls,
    toolResults,
    finishReason: step.finishReason,
    usage: step.usage,
    response: { messages },
  };
}

/** True if any tool call targets a tool with no server-side `execute` (a client tool). */
export function hasClientTool(toolCalls: ToolCall[], tools: ToolSet): boolean {
  // Provider-executed tools are run by the provider — never a client round-trip.
  return toolCalls.some((c) => !tools[c.toolName]?.execute && tools[c.toolName]?.type !== 'provider');
}

/** Execute the step's tool calls in parallel (capped); errors self-heal as is_error results. */
export async function executeTools(
  toolCalls: ToolCall[],
  tools: ToolSet,
  options: CommonCallOptions,
  messages: Message[],
): Promise<ToolResult[]> {
  const cap = options.maxToolConcurrency ?? 5;
  return mapWithConcurrency(toolCalls, cap, async (call): Promise<ToolResult> => {
    const tool: Tool | undefined = tools[call.toolName];
    if (!tool?.execute) {
      return {
        toolCallId: call.toolCallId,
        toolName: call.toolName,
        result: 'No server-side executor.',
        isError: true,
      };
    }
    const validation = await validateOutput(tool.parameters, call.args);
    if (!validation.ok) {
      return {
        toolCallId: call.toolCallId,
        toolName: call.toolName,
        result: `Invalid arguments: ${validation.issues}`,
        isError: true,
      };
    }
    try {
      const out = await tool.execute(validation.value, {
        toolCallId: call.toolCallId,
        messages,
        signal: options.signal,
      });
      return { toolCallId: call.toolCallId, toolName: call.toolName, result: out };
    } catch (cause) {
      const err = new ToolExecutionError(call.toolName, { toolCallId: call.toolCallId, cause });
      return {
        toolCallId: call.toolCallId,
        toolName: call.toolName,
        result: err.message,
        isError: true,
      };
    }
  });
}

/** Bump the same-tool error counter; returns true if any tool hit the hard limit. */
export function bumpErrorGuard(counters: Map<string, number>, results: ToolResult[]): boolean {
  let hardStop = false;
  for (const r of results) {
    if (r.isError) {
      const c = (counters.get(r.toolName) ?? 0) + 1;
      counters.set(r.toolName, c);
      if (c >= MAX_SAME_TOOL_ERRORS) hardStop = true;
    } else {
      counters.set(r.toolName, 0);
    }
  }
  return hardStop;
}

export function normalizeStop(
  stopWhen: CommonCallOptions['stopWhen'],
  maxSteps: number,
): StopCondition[] {
  const conditions: StopCondition[] = [stepCountIs(maxSteps)];
  if (stopWhen) conditions.push(...(Array.isArray(stopWhen) ? stopWhen : [stopWhen]));
  return conditions;
}

export async function shouldStop(
  conditions: StopCondition[],
  steps: StepResult[],
): Promise<boolean> {
  const info = { steps, stepCount: steps.length };
  for (const c of conditions) {
    if (await c(info)) return true;
  }
  return false;
}
