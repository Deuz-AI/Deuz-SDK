import type { CommonCallOptions, PrepareStepResult } from '../types/config';
import type { Message, Part } from '../types/message';
import type { Usage } from '../types/usage';
import type { Logger, ResolvedDependencies } from '../types/deps';
import type {
  Tool,
  ToolSet,
  ToolChoice,
  ToolCall,
  ToolResult,
  ToolExecuteContext,
  StepResult,
  StopCondition,
} from '../types/tool';
import type { StreamPart } from '../types/stream';
import type { WireTool, WireToolRequest } from '../adapters/types';
import { runOneStep, type OneStep } from './run-step';
import { stepCountIs, type NamedStopCondition } from './stop';
import {
  applyCompaction,
  normalizeCompaction,
  type ApplyCompactionCtx,
  type NormalizedCompaction,
  type CompactionEvent,
} from './compaction';
import { createTokenEstimator, type TokenEstimator } from '../internal/estimate-tokens';
import { getCapabilities } from '../core/registry';
import { toJSONSchema, validateOutput } from '../schema/bridge';
import { mapWithConcurrency } from '../internal/p-limit';
import { ToolExecutionError } from '../errors';

export const MAX_SAME_TOOL_ERRORS = 3;

/** Denial message fed back to the model as an is_error tool_result. */
export const TOOL_DENIED = 'Tool call denied.';

/**
 * Which of the step's calls require approval. `needsApproval` booleans are
 * read directly; predicate forms are awaited with the parsed args + execute
 * ctx. A THROWING predicate requires approval (safe side). Fast path: zero
 * overhead when no called tool declares `needsApproval`.
 */
export async function findApprovalNeeded(
  toolCalls: ToolCall[],
  tools: ToolSet,
  options: CommonCallOptions,
  messages: Message[],
): Promise<Set<string>> {
  const needed = new Set<string>();
  if (!toolCalls.some((c) => tools[c.toolName]?.needsApproval)) return needed;
  await Promise.all(
    toolCalls.map(async (call) => {
      const na = tools[call.toolName]?.needsApproval;
      if (na === undefined || na === false) return;
      if (na === true) {
        needed.add(call.toolCallId);
        return;
      }
      try {
        if (
          await na(call.args, { toolCallId: call.toolCallId, messages, signal: options.signal })
        ) {
          needed.add(call.toolCallId);
        }
      } catch {
        needed.add(call.toolCallId); // safe side: an exploding predicate gates the call
      }
    }),
  );
  return needed;
}

/**
 * Server mode: ask `approveToolCall` for each gated call. Returns the denied
 * ids (→ reason). A THROWING approver denies (safe side).
 */
export async function resolveServerApprovals(
  gated: Set<string>,
  toolCalls: ToolCall[],
  options: CommonCallOptions,
  messages: Message[],
): Promise<Map<string, string | undefined>> {
  const denied = new Map<string, string | undefined>();
  const approve = options.approveToolCall;
  if (!approve || gated.size === 0) return denied;
  await Promise.all(
    toolCalls
      .filter((c) => gated.has(c.toolCallId))
      .map(async (c) => {
        let ok = false;
        try {
          ok = await approve(c, { messages });
        } catch {
          ok = false;
        }
        if (!ok) denied.set(c.toolCallId, undefined);
      }),
  );
  return denied;
}

export function sumUsage(a: Usage, b: Usage): Usage {
  const audio = (a.audioTokens ?? 0) + (b.audioTokens ?? 0);
  const serverTools = (a.serverToolUses ?? 0) + (b.serverToolUses ?? 0);
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    reasoningTokens: a.reasoningTokens + b.reasoningTokens,
    cachedReadTokens: a.cachedReadTokens + b.cachedReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
    cacheWrite1hTokens: a.cacheWrite1hTokens + b.cacheWrite1hTokens,
    ...(audio > 0 ? { audioTokens: audio } : {}),
    ...(serverTools > 0 ? { serverToolUses: serverTools } : {}),
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

/**
 * Restrict the wire tool list to `names`. Unknown names warn and are ignored;
 * if NOTHING matches, fail OPEN (full list) — an empty tools array would
 * silently cripple the step, which is worse than an over-wide one.
 */
export function filterWireTools(
  wire: WireToolRequest,
  names: string[] | undefined,
  logger: Logger,
): WireToolRequest {
  if (!names) return wire;
  const allowed = new Set(names);
  const known = new Set(wire.tools.map((t) => t.name));
  for (const n of names) {
    if (!known.has(n)) logger.warn(`activeTools: unknown tool name '${n}' ignored`);
  }
  const tools = wire.tools.filter((t) => allowed.has(t.name));
  if (tools.length === 0 && wire.tools.length > 0) {
    logger.warn('activeTools: no known tool names matched — sending the full tool list');
    return wire;
  }
  return { ...wire, tools };
}

/**
 * Run the caller's `prepareStep` hook and resolve this step's effective
 * options/messages/wire. A throw propagates — it is caller code, never
 * swallowed. Per-step `activeTools` overrides the static filter (applies to
 * the FULL tool set, not the statically filtered one); a returned `messages`
 * array persists as the new base (the loop assigns it).
 */
export async function applyPrepareStep(
  options: CommonCallOptions,
  ctx: { stepIndex: number; messages: Message[]; usage: Usage },
  fullWire: WireToolRequest,
  staticWire: WireToolRequest,
  logger: Logger,
): Promise<{ options: CommonCallOptions; messages: Message[]; wire: WireToolRequest }> {
  let stepOptions = options;
  let messages = ctx.messages;
  let wire = staticWire;
  const ps: PrepareStepResult | undefined = options.prepareStep
    ? await options.prepareStep(ctx)
    : undefined;
  if (ps) {
    if (ps.messages) messages = ps.messages;
    if (ps.model) stepOptions = { ...stepOptions, model: ps.model };
    if (ps.activeTools) wire = filterWireTools(fullWire, ps.activeTools, logger);
    if (ps.toolChoice) wire = { ...wire, toolChoice: ps.toolChoice };
  }
  return { options: stepOptions, messages, wire };
}

const SUMMARY_PROMPT =
  'Summarize the conversation so far as concise notes: preserve key facts, decisions made, tool results that still matter, and any open task threads. Output only the summary.';

/** Per-loop compaction state: normalized policy + model context window + estimator. */
export interface CompactionRunner {
  policy: NormalizedCompaction;
  contextWindow: number;
  estimator: TokenEstimator;
}

/** Build a compaction runner when the caller opted in; otherwise undefined. */
export function setupCompaction(
  options: CommonCallOptions,
  deps: ResolvedDependencies,
): CompactionRunner | undefined {
  if (!options.compaction) return undefined;
  return {
    policy: normalizeCompaction(options.compaction),
    contextWindow: getCapabilities(options.model, deps.logger).contextWindow,
    estimator: createTokenEstimator(),
  };
}

/**
 * Run compaction before a model step. `addUsage` folds the summarize call's
 * usage into the loop total (so it counts toward budget stops); `onEvent`
 * surfaces each layer (stream part / log line). Returns the (possibly
 * compacted) history — same reference when nothing triggered.
 */
export async function runCompaction(
  runner: CompactionRunner,
  options: CommonCallOptions,
  deps: ResolvedDependencies,
  messages: Message[],
  addUsage: (u: Usage) => void,
  onEvent: (e: CompactionEvent) => void,
): Promise<Message[]> {
  const ctx: ApplyCompactionCtx = {
    estimate: (m) => runner.estimator.estimate(m),
    contextWindow: runner.contextWindow,
    summarize: async (slice) => {
      // Single-turn, tool-free, compaction-free side call — never recurses.
      const step = await runOneStep({
        ...options,
        model: runner.policy.summarizeModel ?? options.model,
        messages: [...slice, { role: 'user', content: SUMMARY_PROMPT }],
        tools: undefined,
        toolChoice: undefined,
        maxSteps: undefined,
        stopWhen: undefined,
        compaction: undefined,
        prepareStep: undefined,
        activeTools: undefined,
        onStepFinish: undefined,
        approveToolCall: undefined,
        approvalResponses: undefined,
      });
      addUsage(step.usage);
      return step.text;
    },
    onSkip: (layer, reason) => deps.logger.warn(`compaction: ${layer} skipped — ${reason}`),
  };
  const { messages: compacted, events } = await applyCompaction(messages, runner.policy, ctx);
  for (const e of events) onEvent(e);
  return compacted;
}

/** Calibrate the runner's estimator against a step's real input-token usage. */
export function calibrateCompaction(
  runner: CompactionRunner | undefined,
  estimatedAtCall: number,
  usage: Usage,
): void {
  if (runner) runner.estimator.calibrate(usage.inputTokens, estimatedAtCall);
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
  return toolCalls.some(
    (c) => !tools[c.toolName]?.execute && tools[c.toolName]?.type !== 'provider',
  );
}

/**
 * Settle the trailing assistant turn's un-answered tool_use ids on a resume
 * call (`approvalResponses` provided). Verdicts: approved → execute; denied →
 * is_error (+reason). No verdict: gated calls DENY by default (safe side),
 * client tools get an is_error placeholder, deferred non-gated server tools
 * execute. Results are appended as a NEW `{role:'tool'}` message — never
 * merged into a caller-supplied one (the `baseLength` slice contract and
 * immutable history both depend on it). Unknown approvalIds are ignored
 * (replay-safe). Returns null when there is nothing to settle.
 */
export async function settlePendingApprovals(
  messages: Message[],
  tools: ToolSet,
  options: CommonCallOptions,
): Promise<{ messages: Message[]; results: ToolResult[]; deniedIds: Set<string> } | null> {
  const responses = options.approvalResponses;
  if (!responses || responses.length === 0) return null;

  // Locate the last assistant turn; only tool messages may follow it.
  let assistantIndex = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    const role = messages[i]!.role;
    if (role === 'assistant') {
      assistantIndex = i;
      break;
    }
    if (role !== 'tool') return null;
  }
  if (assistantIndex < 0) return null;
  const content = messages[assistantIndex]!.content;
  if (!Array.isArray(content)) return null;

  const answered = new Set<string>();
  for (let i = assistantIndex + 1; i < messages.length; i++) {
    const parts = messages[i]!.content;
    if (!Array.isArray(parts)) continue;
    for (const p of parts) if (p.type === 'tool_result') answered.add(p.toolUseId);
  }
  const unanswered = content.filter(
    (p): p is Extract<Part, { type: 'tool_use' }> => p.type === 'tool_use' && !answered.has(p.id),
  );
  if (unanswered.length === 0) return null;

  const calls: ToolCall[] = unanswered.map((p) => ({
    toolCallId: p.id,
    toolName: p.name,
    args: p.input,
  }));
  const byId = new Map(responses.map((r) => [r.approvalId, r]));
  const noVerdict = calls.filter((c) => !byId.has(c.toolCallId));
  const gated = await findApprovalNeeded(noVerdict, tools, options, messages);

  const denied = new Map<string, string | undefined>();
  for (const c of calls) {
    const verdict = byId.get(c.toolCallId);
    if (verdict) {
      if (!verdict.approved) denied.set(c.toolCallId, verdict.reason);
    } else if (!tools[c.toolName]?.execute && tools[c.toolName]?.type !== 'provider') {
      denied.set(c.toolCallId, 'No result provided for this client tool.');
    } else if (gated.has(c.toolCallId)) {
      denied.set(c.toolCallId, 'No approval response.');
    }
  }

  const results = await executeTools(calls, tools, options, messages, denied);
  const toolMessage: Message = { role: 'tool', content: results.map(toToolResultPart) };
  return { messages: [...messages, toolMessage], results, deniedIds: new Set(denied.keys()) };
}

/**
 * Extra per-step wiring for `execute`'s context: the sub-agent seam. `deps` and
 * `reportUsage` let an `agentTool` reuse the parent transport and fold its usage
 * into the loop total; `emitPart` (streaming parent only) forwards its stream.
 */
export interface ExecuteExtras {
  deps?: ResolvedDependencies;
  emitPart?: (part: StreamPart) => void;
  reportUsage?: (usage: Usage) => void;
}

/**
 * Execute the step's tool calls in parallel (capped); errors self-heal as
 * is_error results. Calls listed in `denied` short-circuit to an is_error
 * denial BEFORE validation (a denied call must not leak a validation message).
 */
export async function executeTools(
  toolCalls: ToolCall[],
  tools: ToolSet,
  options: CommonCallOptions,
  messages: Message[],
  denied?: Map<string, string | undefined>,
  extras?: ExecuteExtras,
): Promise<ToolResult[]> {
  const cap = options.maxToolConcurrency ?? 5;
  return mapWithConcurrency(toolCalls, cap, async (call): Promise<ToolResult> => {
    if (denied?.has(call.toolCallId)) {
      const reason = denied.get(call.toolCallId);
      return {
        toolCallId: call.toolCallId,
        toolName: call.toolName,
        result: reason ? `${TOOL_DENIED} Reason: ${reason}` : TOOL_DENIED,
        isError: true,
      };
    }
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
      const ctx: ToolExecuteContext = {
        toolCallId: call.toolCallId,
        messages,
        signal: options.signal,
        ...(options.agentPath ? { agentPath: options.agentPath } : {}),
        ...(options.approveToolCall ? { approveToolCall: options.approveToolCall } : {}),
        ...(extras?.deps ? { deps: extras.deps } : {}),
        ...(extras?.emitPart ? { emitPart: extras.emitPart } : {}),
        ...(extras?.reportUsage ? { reportUsage: extras.reportUsage } : {}),
      };
      const out = await tool.execute(validation.value, ctx);
      return { toolCallId: call.toolCallId, toolName: call.toolName, result: out };
    } catch (cause) {
      // Surface the thrown message to the model (self-heal feedback): a tool
      // that throws `new Error('File not found')` should tell the model that,
      // not an opaque "threw during execution".
      const err = new ToolExecutionError(call.toolName, {
        toolCallId: call.toolCallId,
        cause,
        ...(cause instanceof Error && cause.message ? { message: cause.message } : {}),
      });
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
  // The maxSteps bound is the loop's own guard — flagged so it never surfaces
  // as a `stoppedBy` marker (that would change every bounded run's output).
  const implicit = Object.assign(stepCountIs(maxSteps), { implicitMaxSteps: true });
  const conditions: StopCondition[] = [implicit];
  if (stopWhen) conditions.push(...(Array.isArray(stopWhen) ? stopWhen : [stopWhen]));
  return conditions;
}

/** True when any condition carries `requiresCost` (→ compute costUSD per step). */
export function needsCost(conditions: StopCondition[]): boolean {
  return conditions.some((c) => (c as NamedStopCondition).requiresCost === true);
}

export async function shouldStop(
  conditions: StopCondition[],
  steps: StepResult[],
  extras?: { usage?: Usage; costUSD?: number },
): Promise<{ stop: boolean; stoppedBy?: string }> {
  const info = { steps, stepCount: steps.length, ...extras };
  for (const c of conditions) {
    if (await c(info)) {
      const meta = c as NamedStopCondition;
      if (meta.implicitMaxSteps) return { stop: true };
      return { stop: true, stoppedBy: meta.conditionName ?? 'custom' };
    }
  }
  return { stop: false };
}
