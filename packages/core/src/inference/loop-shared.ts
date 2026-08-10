import type { CommonCallOptions, PrepareStepResult, VerifyStepResult } from '../types/config';
import type { Message, Part } from '../types/message';
import type { Usage } from '../types/usage';
import type { Clock, Logger, ResolvedDependencies } from '../types/deps';
import type {
  Tool,
  ToolSet,
  ToolChoice,
  ToolCall,
  ToolResult,
  ToolExecuteContext,
  ToolApprovalRequest,
  ToolApprovalResponse,
  StepResult,
  StopCondition,
} from '../types/tool';
import type { LanguageModel } from '../types/model';
import type { AgentCheckpoint, CheckpointStatus, SessionStore } from '../types/session';
import type { GuardrailPart, HandoffPart, StreamPart } from '../types/stream';
import type {
  InputGuardrail,
  InputGuardrailContext,
  OutputGuardrail,
  ToolCallGuardrail,
} from '../types/guardrails';
import type { WireTool, WireToolRequest } from '../adapters/types';
import { runOneStep, type OneStep } from './run-step';
import { stepCountIs, budgetConditions, type NamedStopCondition } from './stop';
// Static import: the handoff marker + its reader are a handful of bytes with no
// module graph of their own, and BOTH loops have to be able to recognize a
// transfer tool. A dynamic import would make the recognition asynchronous inside
// the hot per-step path for no bundle saving worth having.
import {
  readHandoffTarget,
  handoffToolName,
  DEFAULT_MAX_HANDOFFS,
  type HandoffTargetMeta,
} from './handoff';
// Static NAMED imports on purpose: tree-shaking keeps only the pipeline
// functions in the bundle (a dynamic import would drag the whole module in).
import {
  recall,
  remember,
  sweepExpired,
  formatMemoriesForPrompt,
  defaultMemoryScorer,
  type MemoryMutation,
  type MemoryScorer,
} from '../memory';
import { EMPTY_USAGE, withTotal } from '../core/metering';
import {
  applyCompaction,
  normalizeCompaction,
  type ApplyCompactionCtx,
  type NormalizedCompaction,
  type CompactionEvent,
} from './compaction';
import { createTokenEstimator, type TokenEstimator } from '../internal/estimate-tokens';
import { attachClientContext, readClientContext } from '../internal/client-context';
// Type-only: the sink itself is created by the loop (or not at all), so nothing
// from internal/warnings.ts is pulled into a bundle that never collects one.
import type { WarningSink } from '../internal/warnings';
// Type-only for the same reason as `mcp/shared` in types/config.ts: the MCP
// runtime is reached through a LITERAL dynamic import in `setupMcp` below, so a
// call without `options.mcp` pulls none of that module graph into the bundle.
import type { ResolvedMcpRuntime } from '../mcp/resolve';
import { getCapabilities } from '../core/registry';
import { toJSONSchema, validateOutput } from '../schema/bridge';
import { mapWithConcurrency } from '../internal/p-limit';
// `resolveTimeouts` is the SINGLE resolution point for every timeout layer
// (core/timeout.ts); this module is the documented CONSUMER of `toolMs` — it is
// the only place tools actually run.
import { combineSignals, resolveTimeouts } from '../core/timeout';
import { ContextOverflowError, TimeoutError, ToolExecutionError } from '../errors';
import {
  createObservationRuntime,
  observeCost,
  counterFields,
  attachInheritedObserve,
  type ObservationRuntime,
} from '../internal/observe-runtime';
import { toObservedError } from '../internal/observe-error';
import type { ToolCompletedEvent, ToolDeniedEvent } from '../types/observe';

/**
 * Runaway guard: N consecutive is_error results for the SAME tool name hard-stop
 * the loop. Approval denials are excluded (deliberate verdicts, not failures);
 * unknown-tool errors and per-execution TIMEOUTS are NOT excluded — see the
 * rationale at both sites in `executeTools`.
 */
export const MAX_SAME_TOOL_ERRORS = 3;

/**
 * Object spread copies only ENUMERABLE props, so the hidden `createClient`
 * context Symbol (the G1 lowest-precedence apiKeys/baseUrls source) silently
 * drops off every per-step `{ ...options }` re-spread. Re-attach it from the
 * loop's root options so client-level keys survive the agentic loop.
 */
export function preserveClientContext<O extends object>(source: object, cloned: O): O {
  const ctx = readClientContext(source);
  if (ctx) attachClientContext(cloned, ctx);
  return cloned;
}

/** Denial message fed back to the model as an is_error tool_result. */
export const TOOL_DENIED = 'Tool call denied.';

/**
 * A denial verdict for one tool call. `reason` is the free-text fed back to
 * the model (unchanged strings); `cause` is the machine-readable origin for
 * tool.denied observe events — it cannot be parsed from the strings.
 */
export interface Denial {
  cause: ToolDeniedEvent['cause'];
  reason?: string;
}
export type DenialMap = Map<string, Denial>;

/**
 * Control-flow signal (1.5): a durable sub-agent (`agentTool`) hit a
 * client-mode approval and checkpointed itself as suspended. Thrown from the
 * tool's `execute`, re-thrown VERBATIM by `executeTools` (never self-healed
 * into an is_error), and caught by both loops, which break with the carried
 * `agentPath`-tagged approvals and a suspended checkpoint of their own.
 */
export class SubAgentSuspension extends Error {
  readonly approvals: ToolApprovalRequest[];
  constructor(approvals: ToolApprovalRequest[]) {
    super('A durable sub-agent suspended on a client-mode approval.');
    this.name = 'SubAgentSuspension';
    this.approvals = approvals;
  }
}

// --- Durable checkpoints (1.5): step-boundary saves shared by both loops. ---

/** Per-run durable state: the store/runId plus cross-leg counters. */
export interface DurableRunner {
  store: SessionStore;
  runId: string;
  /** Cumulative usage from PRIOR legs (EMPTY on a fresh run). */
  baseUsage: Usage;
  /** Step boundaries saved so far across ALL legs (monotonic). */
  stepIndex: number;
  /**
   * Active-agent transfer state (2.0), set by the loop the moment a handoff is
   * accepted and carried onto EVERY later checkpoint. Held here rather than
   * threaded through `saveCheckpoint`'s argument list because the two loops save
   * at seventeen sites between them: one assignment at the swap cannot drift,
   * seventeen extra arguments would.
   */
  handoff?: { to: string; count: number };
  /** Observation (1.6): set by the loop so saveCheckpoint can emit checkpoint events. */
  observe?: { rt: ObservationRuntime; runSpanId: string };
}

/**
 * Build the durable runner when the call carries `session`; otherwise
 * undefined (zero overhead). `resumeFrom` seeds the cross-leg counters on a
 * `resumeFromCheckpoint` leg.
 */
export function setupDurable(
  options: CommonCallOptions,
  deps: ResolvedDependencies,
  resumeFrom?: { stepIndex: number; usage: Usage },
): DurableRunner | undefined {
  if (!options.session) return undefined;
  return {
    store: options.session.store,
    runId: options.session.runId ?? deps.generateId(),
    baseUsage: resumeFrom?.usage ?? EMPTY_USAGE,
    stepIndex: resumeFrom?.stepIndex ?? 0,
  };
}

/** Cumulative run usage (prior legs + this leg) for checkpoints and stop conditions. */
export function durableUsage(runner: DurableRunner | undefined, legUsage: Usage): Usage {
  if (!runner || runner.baseUsage === EMPTY_USAGE) return legUsage;
  return sumUsage(runner.baseUsage, legUsage);
}

/**
 * Save one step-boundary checkpoint. Best-effort durability: a throwing store
 * logs `deps.logger.error` and the run continues — persistence must never be
 * a run-killer.
 */
export async function saveCheckpoint(
  runner: DurableRunner,
  deps: ResolvedDependencies,
  options: CommonCallOptions,
  status: CheckpointStatus,
  messages: Message[],
  legUsage: Usage,
  pendingApprovals?: ToolApprovalRequest[],
): Promise<void> {
  runner.stepIndex += 1;
  const checkpoint: AgentCheckpoint = {
    version: 1,
    runId: runner.runId,
    stepId: `${runner.runId}#${runner.stepIndex}`,
    stepIndex: runner.stepIndex,
    status,
    messages,
    usage: withTotal(durableUsage(runner, legUsage)),
    ...(pendingApprovals && pendingApprovals.length > 0 ? { pendingApprovals } : {}),
    // Handoff (2.0): absent until a transfer happens, then on every checkpoint
    // of the run — the resume leg re-applies the overlay from it.
    ...(runner.handoff ? { handoff: runner.handoff } : {}),
    ...(options.agentPath && options.agentPath.length > 0 ? { agentPath: options.agentPath } : {}),
    createdAt: deps.clock.now(),
  };
  const ob = runner.observe;
  const span = ob?.rt.startSpan();
  try {
    await runner.store.save(checkpoint);
    if (ob && span) {
      ob.rt.emit({
        type: 'checkpoint.saved',
        spanId: span.spanId,
        parentSpanId: ob.runSpanId,
        agentPath: options.agentPath,
        checkpointRunId: checkpoint.runId,
        stepId: checkpoint.stepId,
        checkpointStepIndex: checkpoint.stepIndex,
        checkpointStatus: status,
        durationMs: ob.rt.durationSince(span.startedAt),
        messageCount: checkpoint.messages.length,
        pendingApprovalCount: checkpoint.pendingApprovals?.length ?? 0,
        usage: checkpoint.usage,
      });
    }
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    deps.logger.error(`durable: checkpoint save failed for '${checkpoint.stepId}' — ${detail}`);
    if (ob && span) {
      // Best-effort durability: the event mirrors the never-fatal contract.
      ob.rt.emit({
        type: 'checkpoint.failed',
        spanId: span.spanId,
        parentSpanId: ob.runSpanId,
        agentPath: options.agentPath,
        operation: 'save',
        checkpointRunId: checkpoint.runId,
        stepId: checkpoint.stepId,
        durationMs: ob.rt.durationSince(span.startedAt),
        error: toObservedError(cause, ob.rt.capture.errorMessages),
        runContinued: true,
      });
    }
  }
}

/** Tag pending approvals with the loop's sub-agent path (root loops pass undefined). */
export function toApprovalRequests(
  calls: ToolCall[],
  agentPath: string[] | undefined,
): ToolApprovalRequest[] {
  return calls.map((c) => ({
    approvalId: c.toolCallId,
    toolCallId: c.toolCallId,
    toolName: c.toolName,
    input: c.args,
    ...(agentPath && agentPath.length > 0 ? { agentPath } : {}),
  }));
}

/**
 * Cryptographic approval trail (1.7, D4): attach an HMAC token to every
 * pending approval when the call carries `approvalSigner`. Best-effort — a
 * throwing signer logs and the requests go out unsigned (verification on
 * resume will then default-deny approvals, the safe side).
 */
export async function signApprovalRequests(
  requests: ToolApprovalRequest[],
  options: CommonCallOptions,
  deps: ResolvedDependencies,
  runId: string | undefined,
): Promise<ToolApprovalRequest[]> {
  const signer = options.approvalSigner;
  if (!signer || requests.length === 0) return requests;
  try {
    return await Promise.all(
      requests.map(async (request) => ({
        ...request,
        token: await signer.sign(request, runId !== undefined ? { runId } : undefined),
      })),
    );
  } catch (error) {
    deps.logger.error('approval signing failed — requests go out unsigned', { error });
    return requests;
  }
}

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
): Promise<DenialMap> {
  const denied: DenialMap = new Map();
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
        if (!ok) denied.set(c.toolCallId, { cause: 'server-denied' });
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
 *
 * Both notices also reach `warnings` (1.9) when a sink is threaded in. That is
 * the whole point: the DEFAULT logger is a no-op, so a single typo'd name used
 * to send every tool with nothing visible anywhere. FAIL-OPEN is unchanged — a
 * warning never drops a tool.
 */
export function filterWireTools(
  wire: WireToolRequest,
  names: string[] | undefined,
  logger: Logger,
  warnings?: WarningSink,
): WireToolRequest {
  if (!names) return wire;
  const allowed = new Set(names);
  const known = new Set(wire.tools.map((t) => t.name));
  // The sink ALWAYS mirrors to the same logger (internal/warnings.ts), so it
  // REPLACES the direct log line instead of adding a second one — a log-only
  // caller (no sink) keeps exactly the pre-1.9 output.
  const warn = (message: string): void => {
    if (warnings) warnings.add({ type: 'unsupported-tool', setting: 'activeTools', message });
    else logger.warn(message);
  };
  for (const n of names) {
    if (!known.has(n)) warn(`activeTools: unknown tool name '${n}' ignored`);
  }
  const tools = wire.tools.filter((t) => allowed.has(t.name));
  if (tools.length === 0 && wire.tools.length > 0) {
    warn('activeTools: no known tool names matched — sending the full tool list');
    return wire;
  }
  return { ...wire, tools };
}

// --- Zero-config MCP (2.0): `CommonCallOptions.mcp` -------------------------

/**
 * Connect the call's `mcp` entries and hand back the run's MCP runtime —
 * `undefined` when the call asked for none, which is the zero-cost path.
 *
 * The specifier is a LITERAL on purpose: that is what lets the bundler give
 * `mcp/resolve` its own chunk. The MCP surface (the SDK wrapper, the OAuth
 * adaptor, the sampling bridge) must never land in the measured core/edge bundle
 * merely because the loop is ABLE to use it. A computed specifier would defeat
 * the split and silently re-inline all of it.
 *
 * It REJECTS when a server cannot be reached (fail fast — see
 * `resolveMcpForLoop`). The buffered loop lets that become the call's rejection;
 * the streaming loop calls this INSIDE the pump, where a rejection becomes an
 * `error` part instead of a synchronous throw (G2).
 */
export async function setupMcp(
  options: CommonCallOptions,
  deps: ResolvedDependencies,
): Promise<ResolvedMcpRuntime | undefined> {
  const entries = options.mcp;
  if (!entries || entries.length === 0) return undefined;
  const { resolveMcpForLoop } = await import('../mcp/resolve');
  return resolveMcpForLoop(entries, {
    logger: deps.logger,
    // Reconnect backoff and keepalive run on the INJECTED clock (edge-safety):
    // an MCP connection opened by the loop must not schedule ambient timers.
    clock: deps.clock,
    ...(deps.mcpPool ? { mcpPool: deps.mcpPool } : {}),
  });
}

/**
 * The run's effective tool set: MCP tools first, the caller's `tools` LAST.
 * Explicit tools always win a name collision — they were written by hand at the
 * call site, and a remote server must never be able to shadow a local tool by
 * exporting the same name.
 */
export function mergeMcpTools(
  mcp: ResolvedMcpRuntime | undefined,
  tools: ToolSet | undefined,
): ToolSet {
  const own = tools ?? {};
  return mcp ? { ...mcp.tools, ...own } : own;
}

/**
 * Re-read the catalogs of servers that announced `tools/list_changed`, and
 * return the run's effective tool set.
 *
 * `own` is the LOOP's current local tool set — `options.tools` normally, but the
 * ACTIVE AGENT's set once a handoff (2.0) has swapped it. Reading `options.tools`
 * here instead would silently undo a transfer the moment any MCP server
 * announced a catalog change.
 *
 * A FAILED refresh is deliberately NOT fatal — unlike a failed SETUP, which
 * rejects the call. By this point the run has a working catalog and a task in
 * flight, so one transient `tools/list` is answered the way the rest of the loop
 * answers transient trouble (`filterWireTools`, chat persistence, memory recall):
 * warn, keep the last good value, carry on. The runtime re-arms its dirty flag
 * on failure, so the next step boundary tries again by itself.
 */
export async function refreshMcpTools(
  mcp: ResolvedMcpRuntime,
  own: ToolSet,
  deps: ResolvedDependencies,
): Promise<ToolSet> {
  try {
    await mcp.refresh();
  } catch (error) {
    deps.logger.warn('mcp: tool-list refresh failed — keeping the previous catalog', { error });
  }
  return mergeMcpTools(mcp, own);
}

/**
 * Release the run's MCP connections at a terminal boundary. NEVER throws:
 * teardown failing must not turn a finished run into a failed one (the
 * `persistChat`/checkpoint discipline), so the detail goes to
 * `deps.logger.error` and the exit continues. Borrowed and pooled clients are
 * untouched — `closeOwned` decides that, not this helper.
 */
export async function closeMcp(
  mcp: ResolvedMcpRuntime | undefined,
  deps: ResolvedDependencies,
): Promise<void> {
  if (!mcp) return;
  try {
    await mcp.closeOwned();
  } catch (error) {
    deps.logger.error('mcp: closing run-owned connections failed', { error });
  }
}

/**
 * Spread-in for the `runtimeContext` (2.0) every loop hook receives. It is
 * OMITTED, not set to `undefined`, when the call carries none: a hook that
 * checks `'runtimeContext' in ctx` must be able to tell "not supplied" from
 * "supplied as undefined", and an absent key keeps the pre-2.0 ctx shape
 * byte-identical for snapshot-style assertions.
 */
function runtimeContextOf(options: CommonCallOptions): { runtimeContext?: unknown } {
  return options.runtimeContext !== undefined ? { runtimeContext: options.runtimeContext } : {};
}

/**
 * Run the caller's `prepareStep` hook and resolve this step's effective
 * options/messages/wire. A throw propagates — it is caller code, never
 * swallowed. Per-step `activeTools` overrides the static filter (applies to
 * the FULL tool set, not the statically filtered one); a returned `messages`
 * array persists as the new base (the loop assigns it).
 *
 * The call's `runtimeContext` (2.0) is folded into the hook ctx HERE rather
 * than at the two call sites, so the buffered and streaming loops cannot drift
 * apart on what a hook sees (the loop-symmetry invariant).
 */
export async function applyPrepareStep(
  options: CommonCallOptions,
  ctx: { stepIndex: number; messages: Message[]; usage: Usage },
  fullWire: WireToolRequest,
  staticWire: WireToolRequest,
  logger: Logger,
  warnings?: WarningSink,
): Promise<{ options: CommonCallOptions; messages: Message[]; wire: WireToolRequest }> {
  let stepOptions = options;
  let messages = ctx.messages;
  let wire = staticWire;
  const ps: PrepareStepResult | undefined = options.prepareStep
    ? await options.prepareStep({ ...ctx, ...runtimeContextOf(options) })
    : undefined;
  if (ps) {
    if (ps.messages) messages = ps.messages;
    if (ps.model) stepOptions = { ...stepOptions, model: ps.model };
    // A per-step typo warns like the static list does — deduped by the sink, so
    // a hook that returns the same bad name every step reports it once.
    if (ps.activeTools) wire = filterWireTools(fullWire, ps.activeTools, logger, warnings);
    if (ps.toolChoice) wire = { ...wire, toolChoice: ps.toolChoice };
  }
  return { options: stepOptions, messages, wire };
}

/** Default cap for `verifyStep` attempts (initial + retries). */
export const DEFAULT_MAX_VERIFY_ATTEMPTS = 3;

/**
 * Evaluate the caller's `verifyStep` hook at a natural completion (1.8). Shared
 * by both loops. Returns `undefined` when there is no hook or it passed
 * silently; otherwise the verdict plus whether the loop should RETRY (reject +
 * `retry !== false` + attempt budget remaining). A retry injects the feedback
 * as a user turn and re-drives the loop; the attempt budget is `maxVerifyAttempts`.
 */
export async function evaluateVerifyStep(
  options: CommonCallOptions,
  ctx: { stepIndex: number; attempt: number; text: string; messages: Message[]; usage: Usage },
): Promise<{ verdict: VerifyStepResult; retry: boolean } | undefined> {
  if (!options.verifyStep) return undefined;
  const verdict = await options.verifyStep({ ...ctx, ...runtimeContextOf(options) });
  if (!verdict) return undefined;
  const cap = options.maxVerifyAttempts ?? DEFAULT_MAX_VERIFY_ATTEMPTS;
  const retry = !verdict.ok && verdict.retry !== false && ctx.attempt + 1 < cap;
  return { verdict, retry };
}

/** The user turn injected when a `verifyStep` rejection re-drives the loop. */
export function verifyFeedbackMessage(verdict: VerifyStepResult): Message {
  return {
    role: 'user',
    content:
      verdict.feedback ??
      'The previous answer did not pass verification. Review it and produce a corrected answer.',
  };
}

/**
 * Default re-drive budget for the false-finish guard (1.9, N2): at most TWO
 * re-drives, i.e. three answers per run. Matched to `verifyStep`'s effective
 * budget (`DEFAULT_MAX_VERIFY_ATTEMPTS` = 3 attempts = 2 retries) — the two hooks
 * sit on the SAME boundary and should not cost wildly different amounts by
 * default — and deliberately small: every re-drive is a full extra model call,
 * and a predicate that never accepts would otherwise burn the caller's budget on
 * nudges. Note the unit difference: `maxVerifyAttempts` counts ATTEMPTS,
 * `falseFinishGuard.maxRetries` counts RETRIES.
 */
export const DEFAULT_FALSE_FINISH_RETRIES = 2;

/**
 * `providerMetadata.deuz.stoppedBy` marker recorded when the guard runs out of
 * re-drives and the loop accepts a finish `doneWhen` rejected. Kebab-case like
 * the `budget.*` markers, and deliberately NOT a `conditionName`: no `stopWhen`
 * condition fired — the loop ended naturally, over an objection.
 */
export const FALSE_FINISH_STOPPED_BY = 'false-finish';

/** Resolve the guard's re-drive budget (`false` / `{ maxRetries: 0 }` = observation-only). */
export function resolveFalseFinishRetries(guard: CommonCallOptions['falseFinishGuard']): number {
  if (guard === false) return 0;
  if (guard === undefined || guard === true) return DEFAULT_FALSE_FINISH_RETRIES;
  const max = guard.maxRetries;
  // A non-finite budget would make every `attempt < max` comparison false, i.e.
  // silently disable the guard — fall back to the documented default instead.
  if (max === undefined || !Number.isFinite(max)) return DEFAULT_FALSE_FINISH_RETRIES;
  return Math.max(0, Math.floor(max));
}

/**
 * Evaluate `doneWhen` at a natural completion (1.9, N2) — the TWIN of
 * `evaluateVerifyStep`: same seam, same boundary, same shape (`undefined` with no
 * hook, otherwise the verdict plus whether the loop should RETRY: rejected and
 * budget remaining). `attempt` is the number of re-drives ALREADY spent, so the
 * first rejection is attempt 0 and `maxRetries` is a retry count.
 *
 * Callers consult this FIRST and skip verification when it asks for a retry (see
 * `doneWhen` in types/config.ts): it is the cheaper, narrower question, and
 * verifying an answer the caller already called incomplete buys nothing but a
 * model call. A THROW PROPAGATES — caller code, like `prepareStep`/`verifyStep`.
 */
export async function evaluateDoneWhen(
  options: CommonCallOptions,
  ctx: { stepIndex: number; attempt: number; text: string; messages: Message[]; usage: Usage },
): Promise<{ done: boolean; retry: boolean } | undefined> {
  if (!options.doneWhen) return undefined;
  const done = await options.doneWhen({
    text: ctx.text,
    messages: ctx.messages,
    usage: ctx.usage,
    stepIndex: ctx.stepIndex,
    ...runtimeContextOf(options),
  });
  if (done) return { done: true, retry: false };
  return { done: false, retry: ctx.attempt < resolveFalseFinishRetries(options.falseFinishGuard) };
}

/**
 * The user turn injected when the false-finish guard re-drives the loop. Kept
 * short and task-agnostic: `doneWhen` returns a boolean, so there is no
 * caller-supplied feedback to relay (that is `verifyStep`'s job) — this only has
 * to stop the model from re-emitting the same premature "done".
 */
export function falseFinishMessage(): Message {
  return {
    role: 'user',
    content:
      'That is not finished yet. Do not stop here: keep working on the parts of the request that are still incomplete, and give a final answer only once everything asked for is actually done.',
  };
}

/**
 * Config sanity (1.9): `falseFinishGuard` on its own does nothing — the guard is
 * ARMED by `doneWhen`. Warn once per loop rather than fail: an inert option is
 * not worth killing a run over, but it must not be silent either, because the
 * name reads like a guard the SDK could arm by itself. It cannot — only the
 * caller knows what "done" means for the task.
 */
export function warnFalseFinishConfig(options: CommonCallOptions, logger: Logger): void {
  if (options.falseFinishGuard !== undefined && !options.doneWhen) {
    logger.warn('falseFinishGuard: no doneWhen provided — the false-finish guard never fires');
  }
}

// --- Guardrails (2.0): the three hooks, shared by both loops ---------------

/**
 * `providerMetadata.deuz.guardrails` entry — a `GuardrailPart` minus its `type`
 * discriminant, so the buffered readout and the streaming part can never
 * describe the same verdict differently (both are produced from ONE part).
 */
export type GuardrailLogEntry = Omit<GuardrailPart, 'type'>;

/** Append the parts a hook produced to the run's `deuz.guardrails` log. */
export function logGuardrailParts(log: GuardrailLogEntry[], parts: GuardrailPart[]): void {
  for (const p of parts) {
    log.push({
      hook: p.hook,
      action: p.action,
      ...(p.name !== undefined ? { name: p.name } : {}),
      ...(p.reason !== undefined ? { reason: p.reason } : {}),
      ...(p.toolCallId !== undefined ? { toolCallId: p.toolCallId } : {}),
      ...(p.stepIndex !== undefined ? { stepIndex: p.stepIndex } : {}),
    });
  }
}

/** `stoppedBy` marker for a run the INPUT hook refused (no model call happened). */
export const GUARDRAIL_INPUT_STOPPED_BY = 'guardrail:input';
/** `stoppedBy` marker for a final answer the OUTPUT hook refused. */
export const GUARDRAIL_OUTPUT_STOPPED_BY = 'guardrail:output';

/** Normalize a hook's `one | many | undefined` form into an ordered array. */
function guardrailList<T>(entry: T | T[] | undefined): T[] {
  if (entry === undefined) return [];
  return Array.isArray(entry) ? entry : [entry];
}

/**
 * A guardrail's reportable name. Deliberately read off the FUNCTION (the type is
 * `{ name?: string } & fn`), so the common shapes label themselves for free via
 * JS name inference: `const noSecrets: InputGuardrail = …` reports
 * `'noSecrets'`, an arrow written straight into `{ onOutput: … }` reports
 * `'onOutput'`, and an element of an ARRAY literal gets no inferred name and so
 * reports nothing. Set one explicitly with `Object.defineProperty(fn, 'name', …)`
 * — a plain `fn.name = …` throws in strict mode (see `src/guardrails.ts`).
 */
function guardrailName(guard: { name?: string }): string | undefined {
  return guard.name ? guard.name : undefined;
}

function guardrailPart(
  hook: GuardrailPart['hook'],
  action: GuardrailPart['action'],
  guard: { name?: string },
  extra: { reason?: string; toolCallId?: string; stepIndex?: number },
): GuardrailPart {
  const name = guardrailName(guard);
  return {
    type: 'guardrail',
    hook,
    action,
    ...(name !== undefined ? { name } : {}),
    ...(extra.reason !== undefined ? { reason: extra.reason } : {}),
    ...(extra.toolCallId !== undefined ? { toolCallId: extra.toolCallId } : {}),
    ...(extra.stepIndex !== undefined ? { stepIndex: extra.stepIndex } : {}),
  };
}

/** Base ctx every hook receives (runtimeContext + agentPath, both optional). */
function guardrailBase(options: CommonCallOptions): {
  runtimeContext?: unknown;
  agentPath?: string[];
} {
  return {
    ...runtimeContextOf(options),
    ...(options.agentPath && options.agentPath.length > 0 ? { agentPath: options.agentPath } : {}),
  };
}

/** Verdict of the pre-run INPUT hook. */
export type InputGuardrailOutcome =
  | { outcome: 'pass'; messages: Message[]; parts: GuardrailPart[] }
  | { outcome: 'block'; reason?: string; parts: GuardrailPart[] };

/**
 * Evaluate `guardrails.onInput` ONCE per run leg, before the first model call.
 *
 * Ordering rules (identical for all three hooks): the array runs IN ORDER,
 * `rewrite`s CHAIN (the next guardrail sees what the previous one wrote), the
 * first `block` short-circuits the rest, and `undefined` / `{ action: 'pass' }`
 * is SILENT — no part, no metadata entry. A THROW propagates: like
 * `prepareStep`/`verifyStep`/`doneWhen` this is caller code, and swallowing it
 * would leave the caller believing a defense is armed while it is inert.
 *
 * A block is a GRACEFUL stop, never a throw — the loop returns an empty answer
 * with `stoppedBy: 'guardrail:input'` (see {@link GUARDRAIL_INPUT_STOPPED_BY}).
 */
export async function evaluateInputGuardrails(
  options: CommonCallOptions,
  messages: Message[],
): Promise<InputGuardrailOutcome> {
  const list: InputGuardrail[] = guardrailList(options.guardrails?.onInput);
  if (list.length === 0) return { outcome: 'pass', messages, parts: [] };
  const parts: GuardrailPart[] = [];
  let current = messages;
  for (const guard of list) {
    const ctx: InputGuardrailContext = { messages: current, ...guardrailBase(options) };
    const verdict = await guard(ctx);
    if (!verdict || verdict.action === 'pass') continue;
    if (verdict.action === 'block') {
      parts.push(guardrailPart('input', 'block', guard, { reason: verdict.reason }));
      return {
        outcome: 'block',
        ...(verdict.reason !== undefined ? { reason: verdict.reason } : {}),
        parts,
      };
    }
    current = verdict.messages;
    parts.push(guardrailPart('input', 'rewrite', guard, {}));
  }
  return { outcome: 'pass', messages: current, parts };
}

/** Verdict of the natural-completion OUTPUT hook. */
export type OutputGuardrailOutcome =
  | { outcome: 'pass'; text: string; parts: GuardrailPart[] }
  | { outcome: 'block'; reason?: string; replacement?: string; parts: GuardrailPart[] };

/**
 * Evaluate `guardrails.onOutput` at a natural completion — AFTER `doneWhen` and
 * `verifyStep` have both accepted the answer, so the text that reaches a
 * guardrail is the one the run is actually about to return (a re-driven round
 * never reaches here). Same ordering rules as {@link evaluateInputGuardrails}.
 *
 * The caller is responsible for making the REST of the run agree with the
 * verdict: a rewrite (or a block's `replacement ?? ''`) also rewrites the
 * appended assistant message in `messages`/`appended`/`chatMessages` (see
 * {@link rewriteAssistantText}), so the checkpoint and the chat record never
 * disagree with what the caller was handed.
 */
export async function evaluateOutputGuardrails(
  options: CommonCallOptions,
  ctx: { text: string; messages: Message[]; stepIndex: number },
): Promise<OutputGuardrailOutcome> {
  const list: OutputGuardrail[] = guardrailList(options.guardrails?.onOutput);
  if (list.length === 0) return { outcome: 'pass', text: ctx.text, parts: [] };
  const parts: GuardrailPart[] = [];
  let text = ctx.text;
  for (const guard of list) {
    const verdict = await guard({
      text,
      messages: ctx.messages,
      stepIndex: ctx.stepIndex,
      ...guardrailBase(options),
    });
    if (!verdict || verdict.action === 'pass') continue;
    if (verdict.action === 'block') {
      parts.push(
        guardrailPart('output', 'block', guard, {
          reason: verdict.reason,
          stepIndex: ctx.stepIndex,
        }),
      );
      return {
        outcome: 'block',
        ...(verdict.reason !== undefined ? { reason: verdict.reason } : {}),
        ...(verdict.replacement !== undefined ? { replacement: verdict.replacement } : {}),
        parts,
      };
    }
    text = verdict.text;
    parts.push(guardrailPart('output', 'rewrite', guard, { stepIndex: ctx.stepIndex }));
  }
  return { outcome: 'pass', text, parts };
}

/**
 * The denial reason a blocked tool call feeds back to the model. Deliberately
 * says WHICH rule refused: the model's next turn can only route around a block
 * it can read.
 */
export function guardrailDenialReason(
  name: string | undefined,
  reason: string | undefined,
): string {
  const who = name ? ` '${name}'` : '';
  return reason ? `Blocked by guardrail${who}: ${reason}` : `Blocked by guardrail${who}.`;
}

/**
 * Evaluate `guardrails.onToolCall` for every call of a step, IMMEDIATELY before
 * the approval gate. Same ordering rules as {@link evaluateInputGuardrails},
 * applied per call (one call's block never short-circuits another's).
 *
 * `rewrite` is an EXECUTION-SIDE substitution: the returned `calls` carry the
 * new `args`, so the approval gate (`needsApproval` predicates, the approval
 * request a human sees) and `execute` all work on them — but the assistant
 * message already in the history keeps the arguments the MODEL issued. That
 * asymmetry is deliberate: rewriting history would make the transcript lie
 * about what the model asked for (and would break prompt-cache reuse), while a
 * model that is told it called `rm -rf /` when the loop ran `rm -rf ./tmp`
 * cannot reason about the next step.
 *
 * `block` joins the loop's EXISTING denial machinery — the returned map merges
 * into the step's `DenialMap`, which already produces an `is_error` tool_result,
 * a `denied` tool-state part, and (crucially) EXCLUSION from the runaway-error
 * guard. The run CONTINUES: a blocked call is a verdict, never a run-killer.
 */
export async function applyToolCallGuardrails(
  options: CommonCallOptions,
  toolCalls: ToolCall[],
  messages: Message[],
  stepIndex?: number,
): Promise<{ calls: ToolCall[]; blocked: DenialMap; parts: GuardrailPart[] }> {
  const list: ToolCallGuardrail[] = guardrailList(options.guardrails?.onToolCall);
  const blocked: DenialMap = new Map();
  if (list.length === 0) return { calls: toolCalls, blocked, parts: [] };
  const parts: GuardrailPart[] = [];
  const base = guardrailBase(options);
  const calls: ToolCall[] = [];
  for (const original of toolCalls) {
    let call = original;
    let denied = false;
    for (const guard of list) {
      const verdict = await guard({
        toolCall: call,
        messages,
        ...(stepIndex !== undefined ? { stepIndex } : {}),
        ...base,
      });
      if (!verdict || verdict.action === 'pass') continue;
      if (verdict.action === 'block') {
        parts.push(
          guardrailPart('tool-call', 'block', guard, {
            reason: verdict.reason,
            toolCallId: call.toolCallId,
            ...(stepIndex !== undefined ? { stepIndex } : {}),
          }),
        );
        blocked.set(call.toolCallId, {
          // The observe union (`ToolDeniedEvent.cause`) is a locked 1.6 surface
          // with no 'guardrail' member; a guardrail IS a server-side verdict, so
          // it reports as 'server-denied' and the reason string carries the rest.
          cause: 'server-denied',
          reason: guardrailDenialReason(guardrailName(guard), verdict.reason),
        });
        denied = true;
        break;
      }
      call = { ...call, args: verdict.args };
      parts.push(
        guardrailPart('tool-call', 'rewrite', guard, {
          toolCallId: call.toolCallId,
          ...(stepIndex !== undefined ? { stepIndex } : {}),
        }),
      );
    }
    // A blocked call still rides through the batch: every `tool_use_id` MUST be
    // answered (the Anthropic 400 guard), and `executeTools` is what turns the
    // denial into that answer.
    calls.push(denied ? original : call);
  }
  return { calls, blocked, parts };
}

/**
 * Return a COPY of an assistant turn whose text is `text` — the shape
 * `assembleAssistant` would have produced had the model said that. Reasoning and
 * `tool_use` parts survive untouched and stay in canonical order; an EMPTY
 * `text` removes the text part entirely, exactly as `assembleAssistant` omits
 * one for an empty answer.
 *
 * Never mutates: the immutable-history invariant means the loop replaces the
 * last element of each array with this copy rather than editing in place.
 */
export function rewriteAssistantText(message: Message, text: string): Message {
  if (typeof message.content === 'string') return { ...message, content: text };
  const content: Part[] = [];
  let placed = false;
  for (const part of message.content) {
    if (part.type === 'text') {
      if (!placed && text) {
        content.push({ type: 'text', text });
        placed = true;
      }
      continue; // the model's original text never survives a rewrite
    }
    if (!placed && text && part.type === 'tool_use') {
      content.push({ type: 'text', text });
      placed = true;
    }
    content.push(part);
  }
  if (!placed && text) content.push({ type: 'text', text });
  return { ...message, content };
}

// --- Handoff (2.0): the shared half of agent-to-agent transfer --------------
//
// `inference/handoff.ts` mints the `transfer_to_<name>` tools; everything below
// is what the two loops DO with one. It lives here for the same reason the
// guardrail helpers do: a transfer must mean the identical thing buffered and
// streaming, and the only way to guarantee that is one implementation.

/**
 * Who is driving the run right now. `undefined` in the loops means "the ROOT
 * agent" — the caller's own `model`/`tools`/system message, untouched. Every
 * field is re-derived at the swap, never patched in place: the loops treat this
 * as an immutable snapshot they replace wholesale.
 */
export interface ActiveAgentState {
  /** The target's record key; absent only for the root agent. */
  name?: string;
  /** Drives every step from now on (a `prepareStep` `model` still outranks it). */
  model: LanguageModel;
  /** The agent's LOCAL tool set (before MCP tools are merged in). */
  tools: ToolSet;
  /** Transfers accepted so far in this RUN — checked against `maxHandoffs`. */
  handoffCount: number;
}

/**
 * `providerMetadata.deuz.handoffs` entry — a {@link HandoffPart} minus its
 * `type` discriminant, so the buffered readout and the streaming part can never
 * describe the same transfer differently (both are built from ONE object).
 */
export type HandoffLogEntry = Omit<HandoffPart, 'type'>;

/** A tool call the loop resolved to a transfer tool, with the target it names. */
export interface HandoffCall {
  call: ToolCall;
  meta: HandoffTargetMeta;
}

const NO_HANDOFF_CALLS: HandoffCall[] = [];

/**
 * Every transfer tool in a set, captured ONCE from the run's ROOT tool set.
 *
 * It has to be the root set, not the currently active one: after A → B the
 * active set no longer contains `transfer_to_B` (an agent never gets a tool that
 * transfers to itself), so deriving the list from it again would make B → C the
 * step where "back to B" quietly stops existing.
 */
export function collectHandoffTools(tools: ToolSet): ToolSet {
  const found: ToolSet = {};
  for (const [name, tool] of Object.entries(tools)) {
    if (readHandoffTarget(tool)) found[name] = tool;
  }
  return found;
}

/** True when the run has any transfer tool at all (the zero-overhead gate). */
export function hasHandoffTools(handoffTools: ToolSet): boolean {
  return Object.keys(handoffTools).length > 0;
}

/**
 * Split a step's calls into transfers and everything else — the DETERMINISTIC
 * interception, performed before guardrails, the approval gate and
 * `executeTools`. A transfer is not an exception thrown out of an `execute`; it
 * is a decision the loop makes by looking at the call.
 *
 * Fast path: with no transfer among the calls the ORIGINAL array rides through
 * by reference, so a run without handoffs allocates nothing.
 */
export function splitHandoffCalls(
  toolCalls: ToolCall[],
  tools: ToolSet,
): { handoffCalls: HandoffCall[]; normalCalls: ToolCall[] } {
  let handoffCalls: HandoffCall[] | undefined;
  for (const call of toolCalls) {
    const tool = lookupTool(tools, call.toolName);
    const meta = tool ? readHandoffTarget(tool) : undefined;
    if (meta) (handoffCalls ??= []).push({ call, meta });
  }
  if (!handoffCalls) return { handoffCalls: NO_HANDOFF_CALLS, normalCalls: toolCalls };
  const transferred = new Set(handoffCalls.map((h) => h.call.toolCallId));
  return { handoffCalls, normalCalls: toolCalls.filter((c) => !transferred.has(c.toolCallId)) };
}

/** The accepted transfer of a step, if any, plus the results answering EVERY transfer id. */
export interface HandoffDecision {
  /** One `tool_result` per transfer call — the Anthropic 400 guard has no exceptions. */
  results: ToolResult[];
  /** Absent when the budget refused the transfer (self-healed, run unchanged). */
  accepted?: { meta: HandoffTargetMeta; toolCallId: string; reason?: string };
}

/** The model's stated `reason`, when it supplied a usable one. */
function handoffReason(args: unknown): string | undefined {
  if (typeof args !== 'object' || args === null) return undefined;
  const reason = (args as { reason?: unknown }).reason;
  return typeof reason === 'string' && reason.trim() !== '' ? reason : undefined;
}

/**
 * Decide what a step's transfer calls do. Pure — the caller performs the swap.
 *
 * - ONE transfer per step: the FIRST call in the model's own emission order
 *   wins, and any sibling transfer is answered with an `is_error` saying so.
 *   Applying two would mean the second agent never saw the first exist.
 * - Over `maxHandoffs`: NOTHING is transferred and every transfer call comes
 *   back as an `is_error` telling the model to continue itself. Self-healing by
 *   design, and — like an approval denial — excluded from the runaway-error
 *   guard by the loops, because it is a policy verdict, not a tool failure.
 */
export function decideHandoff(
  handoffCalls: HandoffCall[],
  active: ActiveAgentState | undefined,
): HandoffDecision {
  const first = handoffCalls[0]!;
  const max = first.meta.options.maxHandoffs ?? DEFAULT_MAX_HANDOFFS;
  const results: ToolResult[] = [];
  if ((active?.handoffCount ?? 0) + 1 > max) {
    for (const { call } of handoffCalls) {
      results.push({
        toolCallId: call.toolCallId,
        toolName: call.toolName,
        result: `Handoff limit (${max}) reached; continue yourself.`,
        isError: true,
      });
    }
    return { results };
  }
  const reason = handoffReason(first.call.args);
  const to = first.meta.name;
  results.push({
    toolCallId: first.call.toolCallId,
    toolName: first.call.toolName,
    result: reason ? `Transferred to '${to}'. ${reason}` : `Transferred to '${to}'.`,
  });
  for (let i = 1; i < handoffCalls.length; i++) {
    const { call } = handoffCalls[i]!;
    results.push({
      toolCallId: call.toolCallId,
      toolName: call.toolName,
      result: `Ignored: already transferred to '${to}' this step.`,
      isError: true,
    });
  }
  return {
    results,
    accepted: {
      meta: first.meta,
      toolCallId: first.call.toolCallId,
      ...(reason ? { reason } : {}),
    },
  };
}

/**
 * Re-order a step's results to the MODEL's call order, merging the executed
 * results with the synthesized transfer ones. Nothing is dropped: a result whose
 * id is not in `calls` (impossible today) still rides along at the end, because
 * an unanswered `tool_use_id` is a 400 and a duplicated one is not.
 */
export function mergeResultsInCallOrder(
  calls: ToolCall[],
  executed: ToolResult[],
  synthesized: ToolResult[],
): ToolResult[] {
  const byId = new Map<string, ToolResult>();
  for (const r of executed) byId.set(r.toolCallId, r);
  for (const r of synthesized) byId.set(r.toolCallId, r);
  const ordered: ToolResult[] = [];
  for (const call of calls) {
    const result = byId.get(call.toolCallId);
    if (result) {
      ordered.push(result);
      byId.delete(call.toolCallId);
    }
  }
  for (const leftover of byId.values()) ordered.push(leftover);
  return ordered;
}

/**
 * The target's effective LOCAL tool set: its own tools plus every transfer tool
 * EXCEPT its own (an agent that can transfer to itself is a loop with extra
 * steps). The outgoing agent's non-transfer tools are deliberately gone — that
 * is the difference between a handoff and a delegation.
 *
 * The target's own tools are applied LAST, so an agent that deliberately defines
 * a name colliding with a transfer tool wins on its own turf.
 */
export function agentToolSet(handoffTools: ToolSet, target: HandoffTargetMeta): ToolSet {
  const next: ToolSet = {};
  for (const [name, tool] of Object.entries(handoffTools)) {
    if (readHandoffTarget(tool)?.name === target.name) continue;
    next[name] = tool;
  }
  return { ...next, ...(target.def.tools ?? {}) };
}

/**
 * Replace the run's leading system turn with the incoming agent's instructions
 * (inserting one when the history had none, removing it when the target
 * declares none).
 *
 * A REWRITE, never an append — the same discipline compaction follows: the new
 * turn must not enter `appended`/`chatMessages`, or the caller's response delta
 * and the chat transcript would grow a system message they never sent. It lives
 * in the effective model history (and therefore in checkpoints), which is
 * exactly where a resume leg needs to find it.
 */
export function withAgentInstructions(
  messages: Message[],
  instructions: string | undefined,
): Message[] {
  const first = messages[0];
  const hasSystem = first !== undefined && first.role === 'system';
  if (instructions === undefined) return hasSystem ? messages.slice(1) : messages;
  const system: Message = { role: 'system', content: instructions };
  return hasSystem ? [system, ...messages.slice(1)] : [system, ...messages];
}

/** Find a target by NAME among the run's transfer tools (resume + lookup path). */
export function findHandoffTarget(
  handoffTools: ToolSet,
  name: string,
): HandoffTargetMeta | undefined {
  const conventional = lookupTool(handoffTools, handoffToolName(name));
  const direct = conventional ? readHandoffTarget(conventional) : undefined;
  if (direct) return direct;
  // A caller may have re-keyed the tool; the marker is the authority, not the key.
  for (const tool of Object.values(handoffTools)) {
    const meta = readHandoffTarget(tool);
    if (meta?.name === name) return meta;
  }
  return undefined;
}

/** What a swap produces: the new active agent, the rewritten history, the log entry. */
export interface HandoffSwap {
  active: ActiveAgentState;
  messages: Message[];
  entry: HandoffLogEntry;
}

/**
 * Perform an accepted transfer: derive the new active agent, rewrite the system
 * turn, build the metadata/stream entry, and notify `onHandoff`.
 *
 * The caller still owns what only it can do — rebuilding the wire tool lists,
 * emitting the part / recording the entry, and stamping the durable runner —
 * but every DECISION is made here so the two loops cannot diverge.
 */
export function applyHandoffSwap(
  accepted: NonNullable<HandoffDecision['accepted']>,
  previous: ActiveAgentState | undefined,
  handoffTools: ToolSet,
  messages: Message[],
  stepIndex: number,
): HandoffSwap {
  const { meta } = accepted;
  const from = previous?.name;
  const active: ActiveAgentState = {
    name: meta.name,
    model: meta.def.model,
    tools: agentToolSet(handoffTools, meta),
    handoffCount: (previous?.handoffCount ?? 0) + 1,
  };
  const entry: HandoffLogEntry = {
    ...(from !== undefined ? { from } : {}),
    to: meta.name,
    toolCallId: accepted.toolCallId,
    ...(accepted.reason !== undefined ? { reason: accepted.reason } : {}),
    stepIndex,
  };
  // Caller code, so a throw PROPAGATES — the `onStepFinish`/`prepareStep`
  // contract. A notification that silently swallowed its own failure would let a
  // routing audit log go missing without a trace.
  meta.options.onHandoff?.({
    ...(from !== undefined ? { from } : {}),
    to: meta.name,
    ...(accepted.reason !== undefined ? { reason: accepted.reason } : {}),
  });
  return { active, messages: withAgentInstructions(messages, meta.def.instructions), entry };
}

/**
 * Re-apply a checkpointed handoff at the start of a RESUME leg. The system
 * message needs nothing — it already lives in the restored history — but the
 * model and the tool set do, or the run would silently snap back to the root
 * agent while still carrying the target's system prompt.
 *
 * A missing transfer tool (the resume call passed different `tools`) is DEGRADED,
 * not fatal: warn, keep the identity and the spent budget so `maxHandoffs` still
 * bounds the run, and continue with the root model/tools. Refusing to resume
 * would strand a durable run over a call-site detail.
 */
export function resumeHandoffState(
  saved: { to: string; count: number },
  rootTools: ToolSet,
  handoffTools: ToolSet,
  rootModel: LanguageModel,
  logger: Logger,
): ActiveAgentState {
  const meta = findHandoffTarget(handoffTools, saved.to);
  if (!meta) {
    logger.warn(
      `handoff: the checkpoint was handed off to '${saved.to}', but this call registers no ` +
        `transfer tool for it — continuing with the root agent's model and tools.`,
    );
    return { name: saved.to, model: rootModel, tools: rootTools, handoffCount: saved.count };
  }
  return {
    name: meta.name,
    model: meta.def.model,
    tools: agentToolSet(handoffTools, meta),
    handoffCount: saved.count,
  };
}

const SUMMARY_PROMPT =
  'Summarize the conversation transcript above as concise notes: preserve key facts, decisions made, tool results that still matter, and any open task threads. Output only the summary.';

/**
 * The ROLLING half of the summarizer (2.0). Used instead of {@link SUMMARY_PROMPT}
 * whenever the history already carries a summary: the side call is asked to FOLD
 * the new slice into the existing notes rather than to summarize a summary,
 * which is how a long run keeps one bounded summary instead of a lossy chain of
 * summaries-of-summaries.
 */
const FOLD_PROMPT =
  'Update the running summary with the new transcript: merge new facts and decisions in, keep still-relevant earlier notes, drop threads now resolved or superseded. Output only the updated summary.';

/** Stringify without ever throwing (circular/BigInt). */
function safeText(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return '';
  }
}

/**
 * Flatten a slice of history into a plain-text transcript for the summarizer.
 * The summarize side-call sends this as a SINGLE user message — never the raw
 * turns, which could begin with an assistant role and 400 on Anthropic.
 */
function renderTranscript(messages: Message[]): string {
  const lines: string[] = [];
  for (const m of messages) {
    const role = m.role.toUpperCase();
    if (typeof m.content === 'string') {
      lines.push(`${role}: ${m.content}`);
      continue;
    }
    const parts: string[] = [];
    for (const p of m.content) {
      if (p.type === 'text') parts.push(p.text);
      else if (p.type === 'reasoning') parts.push(`(thinking) ${p.text}`);
      else if (p.type === 'tool_use') parts.push(`[calls ${p.name}(${safeText(p.input)})]`);
      else if (p.type === 'tool_result') parts.push(`[tool result: ${safeText(p.result)}]`);
      else if (p.type === 'image') parts.push('[image]');
      else parts.push('[content]');
    }
    lines.push(`${role}: ${parts.join(' ')}`);
  }
  return lines.join('\n');
}

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
  const policy = normalizeCompaction(options.compaction);
  return {
    policy,
    // 1.9: the per-call `capabilities` override is threaded EXPLICITLY here (this
    // site holds the options object). Idempotent with the descriptor-clone route
    // the call boundary uses — same merge site, same precedence — but it means a
    // caller who corrects `contextWindow` for an unknown slug gets the right
    // compaction threshold even on a path that never went through `generate.ts`.
    contextWindow: getCapabilities(options.model, deps.logger, options.capabilities).contextWindow,
    // 2.0: a REAL tokenizer (`policy.countTokens`) replaces the char heuristic as
    // the BASE count; the EMA calibration keeps running on top of it, because no
    // tokenizer knows the provider's request framing (see estimate-tokens.ts).
    estimator: createTokenEstimator(
      policy.countTokens ? { countTokens: policy.countTokens } : undefined,
    ),
  };
}

/** What a compaction pass carries into its events (stream part + observation). */
export type CompactionTrigger = 'threshold' | 'overflow';

/**
 * Run compaction before a model step. `addUsage` folds the summarize call's
 * usage into the loop total (so it counts toward budget stops); `onEvent`
 * surfaces each layer (stream part / log line) together with the `trigger` that
 * asked for the pass. Returns the (possibly compacted) history — same reference
 * when nothing triggered.
 *
 * `overheadTokens` is added to EVERY estimate (2.0): the memory recall block is
 * spliced in at the model-call site only, so it is invisible to `messages` yet
 * very much visible to the provider. Counting it here is what keeps the
 * threshold honest — and adding the same number to `estimatedAtCall` is what
 * keeps the EMA calibration comparing like with like.
 *
 * `mode: 'force'` skips the fill gate entirely and `trigger: 'overflow'` labels
 * the events: that is the overflow-recovery pass (see {@link recoverFromOverflow}),
 * where the provider has already answered the fill question with a rejection.
 */
export async function runCompaction(
  runner: CompactionRunner,
  options: CommonCallOptions,
  deps: ResolvedDependencies,
  messages: Message[],
  addUsage: (u: Usage) => void,
  onEvent: (e: CompactionEvent, trigger: CompactionTrigger) => void,
  ob?: ExecuteExtras['observe'],
  overheadTokens = 0,
  mode: 'threshold' | 'force' = 'threshold',
  trigger: CompactionTrigger = 'threshold',
): Promise<Message[]> {
  const ctx: ApplyCompactionCtx = {
    estimate: (m) => runner.estimator.estimate(m) + overheadTokens,
    contextWindow: runner.contextWindow,
    mode,
    ...(ob ? { now: () => deps.clock.now() } : {}),
    summarize: async (slice, previousSummary) => {
      // Single-turn, tool-free, compaction-free side call — never recurses.
      // The slice is rendered to a transcript inside ONE user message so the
      // request is user-first (valid on every wire, incl. Anthropic). With a
      // previous summary in hand the call FOLDS instead of re-summarizing.
      const step = await runOneStep(
        preserveClientContext(options, {
          ...options,
          model: runner.policy.summarizeModel ?? options.model,
          messages: [
            {
              role: 'user',
              content: previousSummary
                ? `RUNNING SUMMARY OF EARLIER CONVERSATION:\n${previousSummary}\n\nNEW TRANSCRIPT:\n${renderTranscript(slice)}\n\n${FOLD_PROMPT}`
                : `${renderTranscript(slice)}\n\n${SUMMARY_PROMPT}`,
            },
          ],
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
        }),
        // Loop-internal side call: its usage is already folded into the loop
        // total via addUsage. Observation: a tagged model call under the step
        // ('compaction-summary'), never a second run — and no span of its own
        // (the bridge only spans run/step/tool events).
        {
          ...(ob
            ? {
                observe: {
                  runtime: ob.rt,
                  parentSpanId: ob.parentSpanId,
                  stepIndex: ob.stepIndex,
                  purpose: 'compaction-summary' as const,
                },
              }
            : {}),
        },
      );
      addUsage(step.usage);
      return step.text;
    },
    onSkip: (layer, reason) => {
      deps.logger.warn(`compaction: ${layer} skipped — ${reason}`);
      ob?.rt.emit({
        type: 'compaction.skipped',
        spanId: ob.rt.startSpan().spanId,
        parentSpanId: ob.parentSpanId,
        stepIndex: ob.stepIndex,
        agentPath: options.agentPath,
        layer,
        reason,
      });
    },
  };
  const { messages: compacted, events } = await applyCompaction(messages, runner.policy, ctx);
  for (const e of events) {
    onEvent(e, trigger);
    ob?.rt.emit({
      type: 'compaction',
      spanId: ob.rt.startSpan().spanId,
      parentSpanId: ob.parentSpanId,
      stepIndex: ob.stepIndex,
      agentPath: options.agentPath,
      layer: e.layer,
      trigger,
      threshold: runner.policy.threshold,
      contextWindow: runner.contextWindow,
      tokensBefore: e.tokensBefore,
      tokensAfter: e.tokensAfter,
      messageCountBefore: e.messagesBefore,
      messageCountAfter: e.messagesAfter,
      durationMs: e.durationMs,
    });
  }
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

/**
 * True for the one error class an agentic step can recover from by itself: the
 * provider said the request no longer fits. Both loops test with this so the
 * two paths can never drift apart.
 */
export function isContextOverflow(error: unknown): boolean {
  return error instanceof ContextOverflowError;
}

/**
 * Overflow auto-recovery (2.0): the step's request was rejected as too long, so
 * FORCE a compaction pass and hand the shrunk history back for one retry.
 *
 * Works even when the caller never opted into compaction — that is the point.
 * A run with no `compaction` option would otherwise die on the first overflow,
 * so a throwaway `'auto'` runner is built for this single pass (it is NOT
 * retained: nothing else in the run starts compacting behind the caller's back).
 *
 * Returns `undefined` when nothing could be recovered — no runner could be
 * built, or the forced pass returned the input array by REFERENCE, i.e. every
 * layer declined. The caller must then rethrow the original error: retrying an
 * identical request would only earn an identical rejection.
 */
export async function recoverFromOverflow(
  runner: CompactionRunner | undefined,
  options: CommonCallOptions,
  deps: ResolvedDependencies,
  messages: Message[],
  addUsage: (u: Usage) => void,
  onEvent: (e: CompactionEvent, trigger: CompactionTrigger) => void,
  ob?: ExecuteExtras['observe'],
): Promise<Message[] | undefined> {
  const effective = runner ?? setupCompaction({ ...options, compaction: 'auto' }, deps);
  if (!effective) return undefined;
  const compacted = await runCompaction(
    effective,
    options,
    deps,
    messages,
    addUsage,
    onEvent,
    ob,
    // The recall block's overhead is deliberately NOT added here: force mode has
    // no threshold to clear, and the recovery target is measured against the
    // history the loop actually owns.
    0,
    'force',
    'overflow',
  );
  return compacted === messages ? undefined : compacted;
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

/**
 * Look a called name up in the tool set. OWN keys only: a hallucinated name
 * like `toString`/`constructor` resolves on `Object.prototype`, and treating
 * that inherited function as a registered tool is exactly the misclassification
 * this trio exists to prevent.
 */
function lookupTool(tools: ToolSet, name: string): Tool | undefined {
  return Object.prototype.hasOwnProperty.call(tools, name) ? tools[name] : undefined;
}

/**
 * A LEGITIMATE client tool: a key PRESENT in `tools` with no server-side
 * `execute`. The caller owns its round-trip, so it breaks the loop.
 * Provider-executed tools run upstream — never a client round-trip.
 */
export function isClientTool(tools: ToolSet, name: string): boolean {
  const tool = lookupTool(tools, name);
  return tool !== undefined && !tool.execute && tool.type !== 'provider';
}

/** True when the model invented a name that is not in the tool set at all. */
export function isUnknownTool(tools: ToolSet, name: string): boolean {
  return lookupTool(tools, name) === undefined;
}

/**
 * Self-heal feedback for a hallucinated tool name. Listing the real names is
 * what makes it actionable — the model's next turn can pick a valid one.
 */
export function unknownToolMessage(tools: ToolSet, name: string): string {
  const available = Object.keys(tools);
  return available.length > 0
    ? `No such tool: "${name}". Available tools: ${available.join(', ')}.`
    : `No such tool: "${name}". No tools are available.`;
}

/**
 * True if any tool call targets a real client tool (a key present in `tools`
 * with no `execute`). An UNKNOWN name is deliberately NOT a client tool (1.9):
 * it used to satisfy the old `!tools[name]?.execute` test, so a hallucinated
 * name broke the loop and the caller waited forever for a tool_result nobody
 * could produce. Unknown names now fall through to `executeTools`, which
 * self-heals them into an is_error tool_result in the SAME turn.
 */
export function hasClientTool(toolCalls: ToolCall[], tools: ToolSet): boolean {
  return toolCalls.some((c) => isClientTool(tools, c.toolName));
}

/**
 * Settle the trailing assistant turn's un-answered tool_use ids on a resume
 * call (`approvalResponses` provided). Verdicts: approved → execute; denied →
 * is_error (+reason). No verdict: gated calls DENY by default (safe side),
 * client tools get an is_error placeholder, deferred non-gated server tools
 * execute. Results are appended as a NEW `{role:'tool'}` message — never
 * merged into a caller-supplied one (the `baseLength` slice contract and
 * immutable history both depend on it). Unknown approvalIds are ignored
 * (replay-safe — and exactly how verdicts for a SUSPENDED SUB-AGENT pass
 * through the parent's settle untouched: the parent re-executes the sub-agent
 * call, which resumes its own checkpoint and consumes them). Returns null
 * when there is nothing to settle.
 *
 * The verdict map rides out alongside `deniedIds` (1.9): the ids alone are
 * enough to keep denials out of the runaway guard, but not to tell a UI WHY a
 * call ended — the client-supplied `reason` lives on the map, and dropping it
 * here is what made `ToolStatePart.denied`/`deniedReason` unreachable.
 */
export async function settlePendingApprovals(
  messages: Message[],
  tools: ToolSet,
  options: CommonCallOptions,
  extras?: ExecuteExtras,
  lifecycle?: {
    /** Called after denials are known but before approved/server calls execute. */
    beforeExecute?: (calls: ToolCall[], deniedIds: ReadonlySet<string>) => void;
  },
): Promise<{
  messages: Message[];
  results: ToolResult[];
  deniedIds: Set<string>;
  denied: DenialMap;
} | null> {
  // An EMPTY array still settles (default-deny the gated rest) — that is how a
  // durable resume without verdicts answers pending calls on the safe side.
  const responses = options.approvalResponses;
  if (!responses) return null;

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

  const denied: DenialMap = new Map();
  const signer = options.approvalSigner;
  const expectedRunId = options.session?.runId;
  for (const c of calls) {
    const verdict = byId.get(c.toolCallId);
    if (verdict) {
      if (!verdict.approved) {
        denied.set(c.toolCallId, { cause: 'response-denied', reason: verdict.reason });
      } else if (signer) {
        // Signed-approval enforcement (1.7, D4): an APPROVAL must echo a token
        // that verifies, matches this approvalId, and — on durable runs —
        // binds to this runId. Anything else is a forgery/mismatch: DENY.
        const payload = verdict.token
          ? await signer.verify(
              verdict.token,
              options.approvalMaxAgeMs !== undefined
                ? { maxAgeMs: options.approvalMaxAgeMs }
                : undefined,
            )
          : null;
        const valid =
          payload !== null &&
          payload.approvalId === c.toolCallId &&
          (expectedRunId === undefined ||
            payload.runId === undefined ||
            payload.runId === expectedRunId);
        if (!valid) {
          denied.set(c.toolCallId, {
            cause: 'response-denied',
            reason: 'Approval token missing, invalid, expired, or bound to another run.',
          });
        }
      }
    } else if (isClientTool(tools, c.toolName)) {
      denied.set(c.toolCallId, {
        cause: 'client-tool-no-result',
        reason: 'No result provided for this client tool.',
      });
      // A HALLUCINATED name is not a client tool (1.9): no denial is recorded so
      // it reaches executeTools and gets the actionable unknown-tool is_error.
    } else if (gated.has(c.toolCallId)) {
      denied.set(c.toolCallId, { cause: 'no-response', reason: 'No approval response.' });
    }
  }

  // Observation (1.6): resume-leg approval resolutions. Explicit verdicts
  // resolve as 'client-response'; verdict-less gated calls as 'default-deny'.
  // Client tools without a result are not approvals (tool.denied covers them).
  const ob = extras?.observe;
  if (ob) {
    for (const c of calls) {
      const verdict = byId.get(c.toolCallId);
      const defaultDenied = !verdict && gated.has(c.toolCallId);
      if (!verdict && !defaultDenied) continue;
      ob.rt.emit({
        type: 'approval.resolved',
        spanId: ob.rt.startSpan().spanId,
        parentSpanId: ob.parentSpanId,
        agentPath: options.agentPath,
        approvalId: c.toolCallId,
        toolCallId: c.toolCallId,
        toolName: c.toolName,
        approved: verdict?.approved === true,
        source: verdict ? 'client-response' : 'default-deny',
        ...(ob.approvalWaitMs !== undefined ? { waitDurationMs: ob.approvalWaitMs } : {}),
      });
    }
  }

  const deniedIds = new Set(denied.keys());
  lifecycle?.beforeExecute?.(calls, deniedIds);
  const results = await executeTools(calls, tools, options, messages, denied, extras);
  const toolMessage: Message = { role: 'tool', content: results.map(toToolResultPart) };
  return { messages: [...messages, toolMessage], results, deniedIds, denied };
}

/**
 * Extra per-step wiring for `execute`'s context: the sub-agent seam. `deps` and
 * `reportUsage` let an `agentTool` reuse the parent transport and fold its usage
 * into the loop total; `emitPart` (streaming parent only) forwards its stream.
 * `session` + `approvalResponses` (1.5) let a durable sub-agent checkpoint
 * itself and settle its own suspended approvals on a resume leg.
 */
export interface ExecuteExtras {
  deps?: ResolvedDependencies;
  emitPart?: (part: StreamPart) => void;
  reportUsage?: (usage: Usage) => void;
  session?: { store: SessionStore; runId: string };
  approvalResponses?: ToolApprovalResponse[];
  /**
   * Observation (1.6): loop-owned correlation for tool events. The loop
   * MUTATES parentSpanId/stepIndex per iteration (settle-phase executions run
   * step-less under the run span). `counters` is the loop's same-tool error
   * map — read for consecutiveFailureCount (approximate within one parallel
   * batch; exact across steps).
   */
  observe?: {
    rt: ObservationRuntime;
    parentSpanId?: string;
    stepIndex?: number;
    counters?: Map<string, number>;
    /** Resume legs: clock.now() - checkpoint.createdAt (≈ approval wait). */
    approvalWaitMs?: number;
  };
}

/** approval.requested for every gated call of a step (both modes). */
export function observeApprovalRequests(
  ob: NonNullable<ExecuteExtras['observe']>,
  options: CommonCallOptions,
  gatedCalls: ToolCall[],
  mode: 'server' | 'client',
): void {
  for (const call of gatedCalls) {
    ob.rt.emit({
      type: 'approval.requested',
      spanId: ob.rt.startSpan().spanId,
      parentSpanId: ob.parentSpanId,
      stepIndex: ob.stepIndex,
      agentPath: options.agentPath,
      approvalId: call.toolCallId, // === toolCallId today (toApprovalRequests contract)
      toolCallId: call.toolCallId,
      toolName: call.toolName,
      mode,
      ...(ob.rt.capture.toolInputs ? { capturedInput: call.args } : {}),
    });
  }
}

/** approval.resolved for server-mode verdicts (throwing approvers already denied). */
export function observeServerResolutions(
  ob: NonNullable<ExecuteExtras['observe']>,
  options: CommonCallOptions,
  gatedCalls: ToolCall[],
  denied: DenialMap,
): void {
  for (const call of gatedCalls) {
    ob.rt.emit({
      type: 'approval.resolved',
      spanId: ob.rt.startSpan().spanId,
      parentSpanId: ob.parentSpanId,
      stepIndex: ob.stepIndex,
      agentPath: options.agentPath,
      approvalId: call.toolCallId,
      toolCallId: call.toolCallId,
      toolName: call.toolName,
      approved: !denied.has(call.toolCallId),
      source: 'server',
    });
  }
}

/** Outcome of one per-execution-capped tool run. */
type ToolExecOutcome = { timedOut: true } | { timedOut: false; value: unknown };

/**
 * Race one tool execution against its per-execution cap (1.9). The timer comes
 * from the injected `deps.clock` — never `setTimeout`/`AbortSignal.timeout` —
 * so fake-clock tests are deterministic (edge-safe purity invariant), and it is
 * cleared on EVERY exit path (resolve, reject, expiry) so a long agentic run
 * cannot accumulate armed timers.
 *
 * On expiry the execution is ABANDONED, not killed — JS cannot kill a running
 * promise. Two things happen instead: the tool's own signal is aborted (a
 * well-behaved tool passing it to `fetch` / an MCP client / a sandbox stops
 * working), and the orphaned promise gets a no-op catch, because nobody awaits it
 * anymore and an unhandled rejection would take a Node process down.
 */
async function runWithToolTimeout(
  clock: Clock,
  ms: number,
  expiry: AbortController,
  invoke: () => Promise<unknown>,
): Promise<ToolExecOutcome> {
  let cancelTimer: (() => void) | undefined;
  const deadline = new Promise<ToolExecOutcome>((resolve) => {
    cancelTimer = clock.setTimeout(() => resolve({ timedOut: true }), ms);
  });
  // A tool that throws SYNCHRONOUSLY still becomes a rejected promise here, so
  // the caller's catch self-heals it exactly as it did before 1.9.
  const work = invoke().then((value): ToolExecOutcome => ({ timedOut: false, value }));
  try {
    const outcome = await Promise.race([work, deadline]);
    if (outcome.timedOut) {
      expiry.abort(new TimeoutError('total', `Tool execution exceeded ${ms}ms.`));
      void work.catch(() => {});
    }
    return outcome;
  } finally {
    cancelTimer?.();
  }
}

/** JSON-ish runtime type label for tool.completed. */
function outputTypeOf(value: unknown): ToolCompletedEvent['outputType'] {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (Array.isArray(value)) return 'array';
  const t = typeof value;
  if (t === 'string' || t === 'number' || t === 'boolean') return t;
  return 'object';
}

/**
 * Execute the step's tool calls in parallel (capped); errors self-heal as
 * is_error results. Calls listed in `denied` short-circuit to an is_error
 * denial BEFORE validation (a denied call must not leak a validation message).
 * With `trace`, each call gets its own `execute_tool` span (parallel calls
 * included) carrying tool NAME and CALL ID only — never arguments or results
 * (content capture off by design; redaction P0).
 */
export async function executeTools(
  toolCalls: ToolCall[],
  tools: ToolSet,
  options: CommonCallOptions,
  messages: Message[],
  denied?: DenialMap,
  extras?: ExecuteExtras,
): Promise<ToolResult[]> {
  const cap = options.maxToolConcurrency ?? 5;
  const parallel = toolCalls.length > 1;
  // Call-level per-tool cap (1.9), resolved ONCE per step. The `undefined` guard
  // keeps the pre-1.9 path allocation-free: no `timeout` → no object, no timer.
  const callToolMs =
    options.timeout === undefined ? undefined : resolveTimeouts(options.timeout).toolMs;
  return mapWithConcurrency(toolCalls, cap, async (call): Promise<ToolResult> => {
    // OWN-key lookup (see lookupTool): an inherited `Object.prototype` member
    // must classify as UNKNOWN, not as an executor-less client tool.
    const tool: Tool | undefined = lookupTool(tools, call.toolName);

    // Observation (1.6): one tool span per call, emitted INSIDE the worker so
    // parallel events interleave in real completion order. Provider tools
    // never reach here — they emit no tool events by design.
    const ob = extras?.observe;
    const obSpan = ob?.rt.startSpan();
    const obBase = ob
      ? {
          spanId: obSpan!.spanId,
          parentSpanId: ob.parentSpanId,
          stepIndex: ob.stepIndex,
          agentPath: options.agentPath,
          toolCallId: call.toolCallId,
          toolName: call.toolName,
        }
      : undefined;
    if (ob) {
      ob.rt.emit({
        type: 'tool.started',
        ...obBase!,
        needsApproval: tool?.needsApproval !== undefined && tool.needsApproval !== false,
        // An UNKNOWN name has no mode; it reports 'client' rather than widening
        // this locked union (append-only surface) — the tool.failed event that
        // follows immediately carries the real story.
        executionMode: tool?.execute ? 'server' : 'client',
        parallel,
        ...(ob.rt.capture.toolInputs ? { capturedInput: call.args } : {}),
      });
    }
    /** tool.failed with the ORIGINAL cause — nothing downstream retains it. */
    const emitToolFailed = (cause: unknown, selfHealed: boolean): void => {
      if (!ob) return;
      ob.rt.emit({
        type: 'tool.failed',
        ...obBase!,
        durationMs: ob.rt.durationSince(obSpan!.startedAt),
        selfHealed,
        consecutiveFailureCount: (ob.counters?.get(call.toolName) ?? 0) + 1,
        error: toObservedError(cause, ob.rt.capture.errorMessages),
      });
    };

    // Spans settle in the tracer bridge (tool.completed/failed/denied events).
    const settle = (result: ToolResult): ToolResult => result;
    try {
      if (denied?.has(call.toolCallId)) {
        const denial = denied.get(call.toolCallId)!;
        if (ob) {
          ob.rt.emit({
            type: 'tool.denied',
            ...obBase!,
            cause: denial.cause,
            ...(denial.reason ? { reason: denial.reason } : {}),
          });
        }
        return settle({
          toolCallId: call.toolCallId,
          toolName: call.toolName,
          result: denial.reason ? `${TOOL_DENIED} Reason: ${denial.reason}` : TOOL_DENIED,
          isError: true,
        });
      }
      if (!tool) {
        // Hallucinated tool name (1.9): self-heal like every other tool failure —
        // an is_error tool_result naming the REAL tools, produced in this same
        // turn so every tool_use_id stays answered (Anthropic 400 guard). It
        // deliberately DOES count toward MAX_SAME_TOOL_ERRORS: unlike an
        // approval denial (a human/policy verdict the model cannot fix, hence
        // excluded), an invented name is a model-side defect it is expected to
        // correct from this feedback — and a model re-calling the SAME invented
        // name forever is precisely the runaway the guard exists for. The
        // counter keys on toolName, so the invented name gets its own budget
        // and never poisons a real tool's.
        const message = unknownToolMessage(tools, call.toolName);
        emitToolFailed(new Error(message), true);
        return settle({
          toolCallId: call.toolCallId,
          toolName: call.toolName,
          result: message,
          isError: true,
        });
      }
      if (!tool.execute) {
        emitToolFailed(new Error('No server-side executor.'), true);
        return settle({
          toolCallId: call.toolCallId,
          toolName: call.toolName,
          result: 'No server-side executor.',
          isError: true,
        });
      }
      const validation = await validateOutput(tool.parameters, call.args);
      if (!validation.ok) {
        emitToolFailed(new Error(`Invalid arguments: ${validation.issues}`), true);
        return settle({
          toolCallId: call.toolCallId,
          toolName: call.toolName,
          result: `Invalid arguments: ${validation.issues}`,
          isError: true,
        });
      }
      // Per-execution cap (1.9): the tool's OWN `timeoutMs` outranks the call's
      // `timeout.toolMs`; neither set = no cap, i.e. the pre-1.9 behaviour where a
      // hung MCP server or a selector-less browser click held the agent forever.
      // A cap needs the injected clock to schedule it — with no `extras.deps`
      // (only reachable from a direct `executeTools` call, never from a loop)
      // there is nothing to schedule on, so the call stays uncapped rather than
      // reaching for an ambient timer.
      const capMs = tool.timeoutMs ?? callToolMs;
      const clock: Clock | undefined = extras?.deps?.clock;
      const timed = capMs !== undefined && capMs > 0 && clock !== undefined;
      const expiry = timed ? new AbortController() : undefined;
      try {
        // Sub-agent inheritance: a per-call deps clone carries the runtime +
        // this tool call's span via a non-enumerable symbol (parallel-safe).
        const ctxDeps =
          extras?.deps && ob
            ? attachInheritedObserve(
                { ...extras.deps },
                { runtime: ob.rt, parentSpanId: obSpan!.spanId },
              )
            : extras?.deps;
        const ctx: ToolExecuteContext = {
          toolCallId: call.toolCallId,
          messages,
          // The expiry signal is MERGED with the caller's, never replacing it: a
          // user abort and a tool timeout must both reach the tool.
          signal: expiry ? combineSignals([options.signal, expiry.signal]) : options.signal,
          // Request-scoped context (2.0), forwarded UNTOUCHED — the same value
          // prepareStep/verifyStep/doneWhen and the guardrails see. Omitted (not
          // `undefined`) when the call carries none. This is also the settle
          // path's route: `settlePendingApprovals` executes through here.
          ...runtimeContextOf(options),
          ...(options.agentPath ? { agentPath: options.agentPath } : {}),
          ...(options.approveToolCall ? { approveToolCall: options.approveToolCall } : {}),
          ...(ctxDeps ? { deps: ctxDeps } : {}),
          ...(extras?.emitPart ? { emitPart: extras.emitPart } : {}),
          ...(extras?.reportUsage ? { reportUsage: extras.reportUsage } : {}),
          ...(extras?.session ? { session: extras.session } : {}),
          ...(extras?.approvalResponses ? { approvalResponses: extras.approvalResponses } : {}),
        };
        const invoke = (): Promise<unknown> =>
          Promise.resolve(tool.execute!(validation.value, ctx));
        const outcome: ToolExecOutcome = timed
          ? await runWithToolTimeout(clock, capMs, expiry!, invoke)
          : { timedOut: false, value: await invoke() };
        if (outcome.timedOut) {
          // SELF-HEALING, never fatal: the abandoned call still gets a
          // tool_result, so every tool_use_id stays answered (Anthropic 400
          // guard) and the model can react — retry with a narrower input, or
          // pick another tool.
          //
          // It DOES count toward MAX_SAME_TOOL_ERRORS. An approval denial is
          // excluded because it is a human/policy verdict the model cannot fix,
          // and re-asking is the correct behaviour; a timeout is the opposite —
          // a tool that hangs three times in a row is precisely the runaway the
          // guard exists for, and each repetition costs the FULL cap in wall
          // clock (3 × 30s on a serverless budget of 25s). If the model recovers,
          // one success resets the counter (`bumpErrorGuard`), so a flaky-but-
          // usable tool is never permanently disqualified.
          const message = `Tool '${call.toolName}' timed out after ${capMs}ms and was abandoned.`;
          emitToolFailed(new TimeoutError('total', message), true);
          return settle({
            toolCallId: call.toolCallId,
            toolName: call.toolName,
            result: message,
            isError: true,
          });
        }
        const out = outcome.value;
        if (ob) {
          ob.rt.emit({
            type: 'tool.completed',
            ...obBase!,
            durationMs: ob.rt.durationSince(obSpan!.startedAt),
            outputType: outputTypeOf(out),
            ...(typeof out === 'string' ? { outputSize: out.length } : {}),
            ...(ob.rt.capture.toolOutputs ? { capturedOutput: out } : {}),
          });
        }
        return settle({ toolCallId: call.toolCallId, toolName: call.toolName, result: out });
      } catch (cause) {
        // A durable sub-agent suspension is control flow, not a tool failure —
        // it must reach the loop verbatim so the parent suspends too.
        if (cause instanceof SubAgentSuspension) throw cause;
        emitToolFailed(cause, true);
        // Surface the thrown message to the model (self-heal feedback): a tool
        // that throws `new Error('File not found')` should tell the model that,
        // not an opaque "threw during execution".
        const err = new ToolExecutionError(call.toolName, {
          toolCallId: call.toolCallId,
          cause,
          ...(cause instanceof Error && cause.message ? { message: cause.message } : {}),
        });
        return settle({
          toolCallId: call.toolCallId,
          toolName: call.toolName,
          result: err.message,
          isError: true,
        });
      }
    } catch (cause) {
      // Only control flow (SubAgentSuspension) or unexpected plumbing errors
      // reach here. A suspension is not a tool failure (no tool event);
      // anything else reports before propagating.
      if (!(cause instanceof SubAgentSuspension)) emitToolFailed(cause, false);
      throw cause;
    }
  });
}

// --- Loop-level observation (1.6): shared by the buffered + streaming loops ---

/** Per-loop observation state. `root: false` = a sub-agent sharing the parent runtime. */
export interface LoopObserve {
  rt: ObservationRuntime;
  runSpanId: string;
  runStartedAt: number;
  root: boolean;
}

export interface LoopObserveInit {
  operation: 'generate-text' | 'stream-chat';
  /** Durable session runId — observation adopts it for correlation. */
  runId?: string;
  /** True on resumeFromCheckpoint legs. */
  resumed?: boolean;
  resumeFromStepId?: string;
  resumeFromStepIndex?: number;
  /**
   * Pre-created ROOT runtime (resume entry points create it early so
   * checkpoint.loaded precedes run.started on the same sequence).
   */
  runtime?: ObservationRuntime;
  /** Sub-agent: share the parent's runtime; the loop emits no run.* events. */
  inherited?: { runtime: ObservationRuntime; parentSpanId?: string };
}

/**
 * Create the loop's observation state and emit run.started (root loops only).
 * Returns undefined when observation is off — every emit site guards with one
 * branch and no ids are drawn (fast path).
 */
export function beginLoopObserve(
  deps: ResolvedDependencies,
  options: CommonCallOptions,
  init: LoopObserveInit,
): LoopObserve | undefined {
  if (init.inherited) {
    const rt = init.inherited.runtime;
    return {
      rt,
      runSpanId: init.inherited.parentSpanId ?? '',
      runStartedAt: rt.now(),
      root: false,
    };
  }
  const rt = init.runtime ?? createObservationRuntime(deps, { runId: init.runId });
  if (!rt) return undefined;
  const span = rt.startSpan();
  rt.emit({
    type: 'run.started',
    spanId: span.spanId,
    agentPath: options.agentPath,
    operation: init.operation,
    provider: options.model.provider,
    model: options.model.modelId,
    surface: options.model.surface,
    durable: options.session !== undefined,
    resumed: init.resumed === true,
    ...(init.resumeFromStepId !== undefined ? { resumeFromStepId: init.resumeFromStepId } : {}),
    ...(init.resumeFromStepIndex !== undefined
      ? { resumeFromStepIndex: init.resumeFromStepIndex }
      : {}),
    messageCount: options.messages.length,
    toolCount: Object.keys(options.tools ?? {}).length,
    ...(rt.capture.messages ? { capturedMessages: options.messages } : {}),
  });
  return { rt, runSpanId: span.spanId, runStartedAt: span.startedAt, root: true };
}

/** The loop's exit shape — endLoopObserve maps it onto exactly one terminal event. */
export interface LoopOutcome {
  finishReason: string;
  endReason: 'natural' | 'stop-condition' | 'max-steps' | 'runaway-tool-errors';
  stoppedBy?: string;
  stepCount: number;
  /** THIS leg's usage (result semantics). */
  usage: Usage;
  /** Durable: cumulative across legs (checkpoint semantics). */
  cumulativeUsage?: Usage;
  suspend?: {
    reason: 'approval' | 'client-tool' | 'sub-agent-approval';
    pendingApprovalCount: number;
    pendingToolCount: number;
    checkpointStepId?: string;
    checkpointStepIndex?: number;
  };
  error?: unknown;
}

/** Emit the run's terminal event (root loops only; the terminal guard drops any second). */
export function endLoopObserve(
  lo: LoopObserve,
  deps: ResolvedDependencies,
  options: CommonCallOptions,
  outcome: LoopOutcome,
): void {
  if (!lo.root) return;
  const rt = lo.rt;
  const durationMs = rt.durationSince(lo.runStartedAt);
  const base = { spanId: lo.runSpanId, agentPath: options.agentPath, durationMs };
  if (outcome.error !== undefined) {
    rt.emit({
      type: 'run.failed',
      ...base,
      status: 'failed',
      error: toObservedError(outcome.error, rt.capture.errorMessages),
      stepCount: outcome.stepCount,
      ...counterFields(rt),
      partialUsage: outcome.usage,
    });
    return;
  }
  if (outcome.suspend) {
    rt.emit({
      type: 'run.suspended',
      ...base,
      status: 'suspended',
      reason: outcome.suspend.reason,
      pendingApprovalCount: outcome.suspend.pendingApprovalCount,
      pendingToolCount: outcome.suspend.pendingToolCount,
      ...(outcome.suspend.checkpointStepId !== undefined
        ? { checkpointStepId: outcome.suspend.checkpointStepId }
        : {}),
      ...(outcome.suspend.checkpointStepIndex !== undefined
        ? { checkpointStepIndex: outcome.suspend.checkpointStepIndex }
        : {}),
      usage: outcome.usage,
    });
    return;
  }
  if (outcome.finishReason === 'aborted') {
    rt.emit({ type: 'run.aborted', ...base, status: 'aborted', usage: outcome.usage });
    return;
  }
  const costUsd = observeCost(
    rt,
    deps.priceProvider,
    'run',
    options.model.provider,
    options.model.modelId,
    outcome.usage,
    lo.runSpanId,
  );
  rt.emit({
    type: 'run.completed',
    ...base,
    status: 'completed',
    finishReason: outcome.finishReason,
    endReason: outcome.endReason,
    ...(outcome.stoppedBy !== undefined ? { stoppedBy: outcome.stoppedBy } : {}),
    stepCount: outcome.stepCount,
    ...counterFields(rt),
    usage: outcome.usage,
    ...(outcome.cumulativeUsage !== undefined ? { cumulativeUsage: outcome.cumulativeUsage } : {}),
    ...(costUsd !== undefined ? { costUsd } : {}),
  });
}

/** step.started — after applyPrepareStep so the EFFECTIVE model/tools are reported. */
export function emitStepStarted(
  lo: LoopObserve,
  options: CommonCallOptions,
  span: { spanId: string },
  stepIndex: number,
  effectiveModel: string,
  messageCount: number,
  estimatedInputTokens: number | undefined,
  activeToolCount: number,
  cumulativeUsage: Usage,
): void {
  lo.rt.emit({
    type: 'step.started',
    spanId: span.spanId,
    parentSpanId: lo.runSpanId,
    agentPath: options.agentPath,
    stepIndex,
    model: effectiveModel,
    messageCount,
    ...(estimatedInputTokens !== undefined && estimatedInputTokens > 0
      ? { estimatedInputTokens }
      : {}),
    activeToolCount,
    cumulativeUsage,
  });
}

/** step.completed — every step gets one, including break/abort steps. */
export function emitStepCompleted(
  lo: LoopObserve,
  options: CommonCallOptions,
  span: { spanId: string; startedAt: number },
  stepIndex: number,
  sr: StepResult,
  denied: DenialMap | undefined,
  cumulativeUsage: Usage,
  stoppedBy?: string,
): void {
  const deniedCount = denied ? sr.toolResults.filter((r) => denied.has(r.toolCallId)).length : 0;
  lo.rt.emit({
    type: 'step.completed',
    spanId: span.spanId,
    parentSpanId: lo.runSpanId,
    agentPath: options.agentPath,
    stepIndex,
    durationMs: lo.rt.durationSince(span.startedAt),
    finishReason: sr.finishReason,
    toolCallCount: sr.toolCalls.length,
    toolResultCount: sr.toolResults.length,
    toolErrorCount: sr.toolResults.filter((r) => r.isError && !denied?.has(r.toolCallId)).length,
    deniedToolCount: deniedCount,
    usage: sr.usage,
    cumulativeUsage,
    ...(stoppedBy !== undefined ? { stoppedBy } : {}),
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

/** Text projection of a message's content (recall query / extraction input). */
function contentText(content: Message['content']): string {
  if (typeof content === 'string') return content;
  return content
    .filter((p): p is Extract<Part, { type: 'text' }> => p.type === 'text')
    .map((p) => p.text)
    .join('');
}

/**
 * Memory recall (1.7, D1): fetch relevant memories for the LAST user message
 * and format them as a system-context block. Returns `undefined` when there is
 * nothing to inject. The block is spliced in AT THE MODEL-CALL SITE only
 * (`withSystemBlock`) — never into the canonical history, so checkpoints and
 * chat persistence stay recall-free and resume legs cannot double-inject.
 * Best-effort: a failing store/embedder logs and the call proceeds bare.
 */
export async function computeRecallBlock(
  options: CommonCallOptions,
  deps: ResolvedDependencies,
  messages: Message[],
  ob?: ExecuteExtras['observe'],
): Promise<string | undefined> {
  const memory = options.memory;
  if (!memory || memory.recall === false) return undefined;
  const lastUser = [...messages].reverse().find((m) => m.role === 'user');
  const text = lastUser ? contentText(lastUser.content) : '';
  // Nothing to query with: no retrieval happened, so no operation is reported
  // either — an operation.started with no matching terminal would be a lie.
  if (!text) return undefined;
  const recallOpts = memory.recall === undefined ? {} : memory.recall;
  // `'default'` selects the built-in Generative-Agents scorer without making the
  // caller import it; anything else is used verbatim. Omitted = raw store
  // ranking, the pre-2.0 behavior.
  const scorer: MemoryScorer | undefined =
    recallOpts.scorer === 'default' ? defaultMemoryScorer : recallOpts.scorer;
  // Observation (2.0): one operation span per recall. Guarded so the observer-less
  // fast path allocates no event and draws no extra id (scripted-id fixtures).
  const span = ob?.rt.startSpan();
  if (ob && span) {
    ob.rt.emit({
      type: 'operation.started',
      spanId: span.spanId,
      parentSpanId: ob.parentSpanId,
      agentPath: options.agentPath,
      subsystem: 'memory',
      operation: 'memory.recall',
    });
  }
  try {
    const hits = await recall(
      { scope: memory.scope, text, topK: recallOpts.topK ?? 5 },
      memory.seams,
      {
        ...(scorer ? { scorer } : {}),
        ...(recallOpts.expandLinks !== undefined ? { expandLinks: recallOpts.expandLinks } : {}),
      },
    );
    if (ob && span) {
      ob.rt.emit({
        type: 'operation.completed',
        spanId: span.spanId,
        parentSpanId: ob.parentSpanId,
        agentPath: options.agentPath,
        subsystem: 'memory',
        operation: 'memory.recall',
        durationMs: ob.rt.durationSince(span.startedAt),
        resultCount: hits.length,
      });
    }
    if (hits.length === 0) return undefined;
    // `maxChars` is the recall block's token budget (2.0). Before it, the block
    // was unbounded: a chatty store could eat the very window compaction had
    // just cleared.
    const format: { header?: string; maxChars?: number } = {};
    if (recallOpts.header !== undefined) format.header = recallOpts.header;
    if (recallOpts.maxChars !== undefined) format.maxChars = recallOpts.maxChars;
    return formatMemoriesForPrompt(hits, format);
  } catch (error) {
    deps.logger.error('memory recall failed', { error });
    if (ob && span) {
      ob.rt.emit({
        type: 'operation.failed',
        spanId: span.spanId,
        parentSpanId: ob.parentSpanId,
        agentPath: options.agentPath,
        subsystem: 'memory',
        operation: 'memory.recall',
        durationMs: ob.rt.durationSince(span.startedAt),
        error: toObservedError(error, ob.rt.capture.errorMessages),
      });
    }
    return undefined;
  }
}

/** Splice a system-context block into a NEW message array (no-op without one). */
export function withSystemBlock(messages: Message[], block: string | undefined): Message[] {
  if (!block) return messages;
  const [first, ...rest] = messages;
  if (first && first.role === 'system' && typeof first.content === 'string') {
    return [{ role: 'system', content: `${first.content}\n\n${block}` }, ...rest];
  }
  return [{ role: 'system', content: block }, ...messages];
}

/**
 * Memory extraction (1.7, D1): kick the mem0 extract→reconcile pass over this
 * call's new turns WITHOUT blocking the run. Returns a promise that NEVER
 * rejects (failures log and resolve `[]`) — exposed as `result.memory`.
 *
 * WRITE POLICY (2.0): `'session-end'` and `'manual'` both return `undefined`
 * here — at LOOP level they are the same instruction, "do not write on this
 * turn". They differ only in what the HOST is expected to do afterwards (call
 * `remember()` when the session closes vs. whenever it decides to), and the SDK
 * cannot observe either moment, so it must not guess at one. `'each-turn'`
 * (and an unset policy) keeps the pre-2.0 behavior.
 *
 * SWEEP (2.0): with `sweep: 'on-extract'` a TTL garbage-collection pass is
 * chained AFTER the extraction settles — fire-and-forget, failures logged, and
 * deliberately off the returned promise: `result.memory` reports the mutations
 * this turn wrote, never how much housekeeping happened to follow.
 */
export function startMemoryExtract(
  options: CommonCallOptions,
  deps: ResolvedDependencies,
  newTurns: Message[],
  ob?: ExecuteExtras['observe'],
): Promise<MemoryMutation[]> | undefined {
  const memory = options.memory;
  if (!memory || memory.extract === false) return undefined;
  if (memory.writePolicy === 'session-end' || memory.writePolicy === 'manual') return undefined;
  const infer = memory.extract === undefined ? true : (memory.extract.infer ?? true);
  const lastUser = [...options.messages].reverse().find((m) => m.role === 'user');
  const turns = lastUser ? [lastUser, ...newTurns] : newTurns;
  if (turns.length === 0) return Promise.resolve([]);

  // Observation (2.0): started fires SYNCHRONOUSLY (the write is in flight from
  // here), completed/failed land whenever the pass settles — after the run's
  // terminal event, which the runtime tolerates for non-terminal types (the
  // `cost.calculated` precedent).
  const span = ob?.rt.startSpan();
  if (ob && span) {
    ob.rt.emit({
      type: 'operation.started',
      spanId: span.spanId,
      parentSpanId: ob.parentSpanId,
      agentPath: options.agentPath,
      subsystem: 'memory',
      operation: 'memory.extract',
    });
  }
  const settled = remember(turns, memory.scope, memory.seams, { infer }).then(
    (mutations) => {
      if (ob && span) {
        ob.rt.emit({
          type: 'operation.completed',
          spanId: span.spanId,
          parentSpanId: ob.parentSpanId,
          agentPath: options.agentPath,
          subsystem: 'memory',
          operation: 'memory.extract',
          durationMs: ob.rt.durationSince(span.startedAt),
          resultCount: mutations.length,
        });
      }
      return mutations;
    },
    (error: unknown) => {
      deps.logger.error('memory extract failed', { error });
      if (ob && span) {
        ob.rt.emit({
          type: 'operation.failed',
          spanId: span.spanId,
          parentSpanId: ob.parentSpanId,
          agentPath: options.agentPath,
          subsystem: 'memory',
          operation: 'memory.extract',
          durationMs: ob.rt.durationSince(span.startedAt),
          error: toObservedError(error, ob.rt.capture.errorMessages),
        });
      }
      return [] as MemoryMutation[];
    },
  );
  if (memory.sweep === 'on-extract') {
    void settled.then(async () => {
      try {
        await sweepExpired(memory.seams.store, memory.scope, deps.clock);
      } catch (error) {
        deps.logger.error('memory sweep failed', { error });
      }
    });
  }
  return settled;
}

/**
 * ChatStore history must remain the caller's raw transcript even when the
 * model/checkpoint history is compacted or replaced by `prepareStep`. On a
 * durable resume, prefer the matching full ChatRecord because the checkpoint
 * intentionally carries only the effective model history.
 */
export async function prepareChatPersistence(
  options: CommonCallOptions,
  deps: ResolvedDependencies,
  fallbackMessages: Message[],
  resumed: boolean,
): Promise<{ messages: Message[]; writable: boolean }> {
  const fallback = (): { messages: Message[]; writable: boolean } => ({
    messages: [...fallbackMessages],
    writable: true,
  });
  const chat = options.chat;
  if (!chat || !resumed) return fallback();

  try {
    const record = await chat.store.loadChat(chat.chatId);
    if (!record) return fallback();

    const scopeKeys = ['userId', 'agentId', 'runId', 'actorId', 'chatId'] as const;
    const scopeMatches = scopeKeys.every((key) => record.scope[key] === chat.scope[key]);
    if (record.chatId !== chat.chatId || !scopeMatches) {
      deps.logger.error('chat store scope mismatch; save skipped', {
        chatId: chat.chatId,
      });
      return { messages: [...fallbackMessages], writable: false };
    }

    return { messages: [...record.messages], writable: true };
  } catch (error) {
    // Loading is best-effort, but saving after an unverifiable load could
    // overwrite another tenant's history. Continue the run without writing.
    deps.logger.error('chat store load failed; save skipped', { chatId: chat.chatId, error });
    return { messages: [...fallbackMessages], writable: false };
  }
}

/**
 * Best-effort chat persistence (1.7, P2): save the FULL raw history at
 * a terminal boundary when `options.chat` is set. A throwing store logs via
 * `deps.logger.error` and never kills the run (SessionStore rule).
 */
export async function persistChat(
  options: CommonCallOptions,
  deps: ResolvedDependencies,
  messages: Message[],
  writable = true,
): Promise<void> {
  const chat = options.chat;
  if (!chat || !writable) return;
  try {
    await chat.store.saveChat({
      chatId: chat.chatId,
      scope: chat.scope,
      messages,
      ...(chat.parentId ? { parentId: chat.parentId } : {}),
      updatedAt: deps.clock.now(),
    });
  } catch (error) {
    deps.logger.error('chat store save failed', { chatId: chat.chatId, error });
  }
}

export function normalizeStop(
  stopWhen: CommonCallOptions['stopWhen'],
  maxSteps: number,
  budget?: CommonCallOptions['budget'],
): StopCondition[] {
  // The maxSteps bound is the loop's own guard — flagged so it never surfaces
  // as a `stoppedBy` marker (that would change every bounded run's output).
  const implicit = Object.assign(stepCountIs(maxSteps), { implicitMaxSteps: true });
  const conditions: StopCondition[] = [implicit];
  if (budget) conditions.push(...budgetConditions(budget));
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
  extras?: { usage?: Usage; costUSD?: number; elapsedMs?: number },
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
