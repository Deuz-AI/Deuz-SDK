import type {
  AgentEvent,
  AgentResult,
  AgentRunEnvelope,
  AgentRunOptions,
  AgentRunReconcileOptions,
  AgentRunReconciliation,
  AgentRunRetry,
  AgentRunSession,
  AgentRunStore,
  AgentStream,
  AgentTool,
  AgentToolReceipt,
  AgentValidation,
} from './types/agent-run';
import type { ChatStore } from './chat';
import type { CommonCallOptions } from './types/config';
import type { StopDetails } from './types/methods';
import type { Message } from './types/message';
import type { LanguageModel } from './types/model';
import type { StopCondition, ToolSet } from './types/tool';
import type { WireToolRequest } from './adapters/types';
import type { SessionStore } from './types/session';
import type { StreamPart } from './types/stream';
import type { ExecutionContextSnapshot, NativeExecutionContext } from './types/execution';
import { createBroadcaster, createDeferred } from './internal/async-iter';
import { resolveDependencies } from './internal/resolve-deps';
import { createWarningSink } from './internal/warnings';
import { markRunLedger } from './internal/run-ledger';
import { parsePartialJson } from './internal/partial-json';
import { foldCallInput } from './generate';
import { inputShapeError } from './core/normalize';
import { EMPTY_USAGE } from './core/metering';
import { getCapabilities } from './core/registry';
import { runStream } from './core/inference';
import { runStreamToolLoop, type StreamToolLoopSnapshot } from './inference/stream-tool-loop';
import { createTurnContent, stopDetailsFrom } from './inference/run-step';
import {
  answersApproval,
  buildWireTools,
  collectHandoffTools,
  durableResumeOf,
  findHandoffTarget,
  evaluateInputGuardrails,
  evaluateOutputGuardrails,
  filterWireTools,
  mergeMcpTools,
  requestCountsOf,
  resumeHandoffState,
  rewriteAssistantText,
  rootStaticWire,
  sumUsage,
} from './inference/loop-shared';
import { bindsThinkingToPrefix } from './internal/stable-prefix';
import { pickObjectStrategy } from './inference/object-shared';
import {
  agentJSONSchema,
  assertAgentValidation,
  completedArrayElements,
  validateAgentValue,
} from './inference/agent-output';
import {
  prepareAgentTools,
  prepareMcpTools,
  type NativeToolOutput,
  type NativeToolReceipts,
} from './inference/agent-tools';
import type { CatalogChangeVerdict } from './inference/loop-shared';
import type { NativeMcp } from './inference/native-mcp';
import { readHandoffTarget } from './inference/handoff';
import {
  assertExecutionPolicy,
  createExecutionContext,
  intersectExecutionPolicies,
} from './execution-policy';
import { intersectBudgetLimits, subtreeLedgerSnapshot } from './budget-ledger';
import { toJSONSchema } from './schema/bridge';
import { assertEnvelopeRevision } from './internal/ops-validate';
import { assertCheckpointVersion } from './internal/checkpoint-version';
import { retryableCause } from './internal/native-retry';
import { withCapabilityOverride } from './internal/config-symbol';
// Native chat, memory and fail-over (2.3): loaded on demand by the runs that use them.
import { scopeKey } from './internal/native-scope';
// Native run discovery and the run lease (2.3).
import type { Clock } from './types/deps';
import { claimNativeRunLease, type NativeRunLease } from './internal/agent-run-lease';
import {
  agentRunListPage,
  compareAgentRunSummaries,
  isAfterAgentRunCursor,
  planAgentRunList,
  summarizeAgentRunEnvelope,
} from './internal/agent-run-list';

export type * from './types/agent-run';

// This coordinates one JavaScript process. When multiple processes or distinct
// store wrappers share a store, the `lease` option (2.3) claims the run across
// them; the store's revision check stays the fence against a stale writer.
const activeNativeRuns = new WeakMap<AgentRunStore, Set<string>>();

function errorData(error: unknown): { name: string; message: string; code?: string } {
  if (error instanceof Error) {
    const code = (error as Error & { code?: unknown }).code;
    return {
      name: error.name,
      message: error.message,
      ...(typeof code === 'string' ? { code } : {}),
    };
  }
  return { name: 'Error', message: String(error) };
}

function messageText(message: Message): string {
  return typeof message.content === 'string'
    ? message.content
    : message.content
        .filter((p) => p.type === 'text')
        .map((p) => p.text)
        .join('');
}

function lastAssistantText(messages: Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!;
    if (message.role === 'assistant') return messageText(message);
  }
  return '';
}

/**
 * The answer of a loop that ended naturally: the text of its FINAL turn. An
 * empty final turn is not recorded (2.3), and an earlier assistant turn's text
 * must never stand in for the answer the model did not give.
 */
function finalTurnText(messages: Message[]): string {
  const last = messages.at(-1);
  return last?.role === 'assistant' ? messageText(last) : '';
}

/** Native stop reasons name a refusal plainly (2.3); other finish reasons pass through. */
function stopReasonOf(finishReason: string): string {
  return finishReason === 'content_filter' ? 'refusal' : finishReason;
}

/**
 * The user turn that closes the loop's history before finalization (2.3, F15).
 * It is part of the durable, append-only transcript.
 */
const FINALIZE_PROMPT =
  'Now provide the final output in the required format, based on the work above.';

/**
 * The stop reason of a run a `'drain'` lease signal stopped at a model-step
 * boundary (2.3). Such a run did not end: its last save is where a resume goes on.
 */
const DRAINED = 'drained';

/** A turn with nothing in it: never stored, because no provider accepts one back. */
function isBlankTurn(message: Message): boolean {
  return typeof message.content === 'string'
    ? message.content === ''
    : message.content.length === 0;
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1)
    throw new TypeError(`${name} must be a positive integer.`);
  return value;
}

/** An outcome a caller found for a call whose effect was unknown (2.3). */
type ReconciledOutcome = NonNullable<AgentRunOptions['reconciledToolResults']>[number];

/**
 * The receipt stages that record a call's outcome (2.3): its effect ran, and its
 * result or error is known. `executing` (unknown) and `suspended` (a child
 * agent waits) record none.
 */
const OUTCOME_STAGES: ReadonlySet<AgentToolReceipt['stage']> = new Set([
  'executed',
  'completed',
  'failed',
  'validation-failed',
  'projection-failed',
]);

/**
 * The outcomes `reconciledToolResults` records (2.3), by call ID: only for the
 * run's unknown effects, each once, and never for a call `retryToolCallIds`
 * runs again. Anything else is a TypeError, raised before anything is written.
 */
function reconciledOutcomes(
  entries: unknown,
  unknownEffects: readonly AgentToolReceipt[],
  retryToolCallIds: readonly string[] | undefined,
): Map<string, ReconciledOutcome> {
  const outcomes = new Map<string, ReconciledOutcome>();
  if (entries === undefined) return outcomes;
  if (!Array.isArray(entries))
    throw new TypeError('reconciledToolResults must be an array of { toolCallId, output }.');
  for (const entry of entries as unknown[]) {
    const id = (entry as { toolCallId?: unknown } | null)?.toolCallId;
    if (typeof id !== 'string' || !id)
      throw new TypeError('reconciledToolResults: every entry needs a non-empty toolCallId.');
    if (outcomes.has(id)) throw new TypeError(`reconciledToolResults lists ${id} more than once.`);
    if (retryToolCallIds?.includes(id))
      throw new TypeError(
        `reconciledToolResults and retryToolCallIds both list ${id}: a call is either recorded or run again.`,
      );
    if (!unknownEffects.some((receipt) => receipt.toolCallId === id))
      throw new TypeError(
        `reconciledToolResults: ${id} is not a call of this run whose effect is unknown.`,
      );
    outcomes.set(id, entry as ReconciledOutcome);
  }
  return outcomes;
}

/** Newer shared ledgers are valid; replacing persisted accounting with fresh counters is not. */
function assertAccountingContinuity(
  saved: ExecutionContextSnapshot,
  live: NativeExecutionContext,
): void {
  for (const prior of saved.ledger.reservations) {
    // A child proves its own slice; the parent's durable ledger owns siblings,
    // which 2.2 compaction may already have folded away.
    if (live.depth > 0 && !prior.scopes.some((scope) => scope.id === live.scopeId)) continue;
    const current = live.ledger.get(prior.requestId);
    if (
      !current ||
      current.modelId !== prior.modelId ||
      current.kind !== prior.kind ||
      JSON.stringify(current.reservation) !== JSON.stringify(prior.reservation) ||
      JSON.stringify(current.scopes) !== JSON.stringify(prior.scopes) ||
      (prior.state !== 'released' && current.state === 'released') ||
      (prior.state === 'settled' &&
        (current.state !== 'settled' ||
          JSON.stringify(current.actual) !== JSON.stringify(prior.actual))) ||
      (prior.state === 'unknown' && current.state === 'reserved')
    ) {
      throw new TypeError(
        'Native resume requires a ledger retaining all persisted accounting reservations.',
      );
    }
  }
}

/**
 * The envelope version a save writes (2.3): 2 once the run records state a 2.2
 * reader would silently ignore (memory, transcript, chat, fail-over), and
 * while its stored turn has open calls a 2.2 resume would answer wrongly; else
 * 1. A 2.2 process refuses version 2 before it writes anything.
 */
function envelopeVersion(envelope: AgentRunEnvelope): 1 | 2 {
  return envelope.memory ||
    envelope.transcript ||
    envelope.chat ||
    envelope.models ||
    openTurnMisreadBy22(envelope)
    ? 2
    : 1;
}

/**
 * The tool call IDs the history's last assistant turn leaves unanswered. Only
 * tool messages may follow that turn, then the system messages a transfer
 * appended (as the resume settle reads it).
 */
function openCalls(messages: readonly Message[]): string[] {
  let end = messages.length;
  while (end > 0 && messages[end - 1]!.role === 'system') end--;
  const answered = new Set<string>();
  for (let i = end - 1; i >= 0; i--) {
    const { role, content } = messages[i]!;
    if (role === 'tool') {
      if (Array.isArray(content))
        for (const part of content) if (part.type === 'tool_result') answered.add(part.toolUseId);
      continue;
    }
    if (role !== 'assistant' || !Array.isArray(content)) return [];
    return content.flatMap((part) =>
      part.type === 'tool_use' && !answered.has(part.id) ? [part.id] : [],
    );
  }
  return [];
}

/**
 * Whether a 2.2 resume would answer the stored turn's open calls wrongly
 * (2.3). Such a turn is the one a resume settles next, until a checkpoint
 * answers it; a terminal run is only read back. 2.3 binds each approval to an
 * `approvalId` that 2.2 cannot match: 2.2 accepts the verdict at its resume
 * gate, then settles by the bare call ID and answers the call `No approval
 * response.`, so a run that waits on an approval is misread, and so is, once a
 * resume took the turn up, an open call the run's gate held. An open call is
 * also misread when its receipt records `failed` (2.2 does not know the stage
 * and answers the call with no result), when its receipt is `suspended` (2.2
 * looks the sub-agent's checkpoint up under its own key and starts the
 * sub-agent over), and, once a resume took the turn up, when it is a client
 * call still pending (2.2 waits for a client result only while the run is
 * suspended).
 */
function openTurnMisreadBy22(envelope: AgentRunEnvelope): boolean {
  if (envelope.phase === 'terminal') return false;
  const checkpoint = envelope.checkpoints[envelope.runId];
  if (!checkpoint || checkpoint.status === 'completed') return false;
  if (checkpoint.status === 'suspended' && (checkpoint.pendingApprovals?.length ?? 0) > 0)
    return true;
  const waiting = new Set((envelope.pendingClientCalls ?? []).map((call) => call.toolCallId));
  const gated = checkpoint.approvalRequestCounts ?? {};
  return openCalls(checkpoint.messages).some((id) => {
    const stage = envelope.toolResults?.[JSON.stringify([envelope.modelSteps, id])]?.stage;
    return (
      stage === 'failed' ||
      stage === 'suspended' ||
      (checkpoint.status === 'running' && (waiting.has(id) || Object.hasOwn(gated, id)))
    );
  });
}

/** The chat's part of the native resume binding (2.3). */
function chatBinding(chat: NonNullable<AgentRunOptions['chat']>): string {
  return JSON.stringify([chat.chatId, scopeKey(chat.scope)]);
}

/** Native chat options must name their store, chat and owner before anything runs (2.3). */
function assertChatOptions(chat: NonNullable<AgentRunOptions['chat']>): void {
  if (
    !chat ||
    typeof chat !== 'object' ||
    !chat.store ||
    typeof chat.chatId !== 'string' ||
    !chat.chatId ||
    !chat.scope ||
    typeof chat.scope !== 'object'
  )
    throw new TypeError('Native chat requires a store, a non-empty chatId and a scope.');
}

/** A model's part of the native resume binding. */
function modelBinding(model: LanguageModel): string {
  return `${model.provider}/${model.surface}/${model.modelId}`;
}

/**
 * A tool set's part of the native resume binding: each tool's name, description
 * and schemas. Function bodies cannot be compared; `bindingId` covers them.
 */
function toolBinding(
  tools: ToolSet,
  contextSchemaOf: (name: string) => AgentTool['contextSchema'],
): Promise<unknown[]> {
  return Promise.all(
    Object.entries(tools).map(async ([name, tool]) => {
      const contextSchema = contextSchemaOf(name);
      return [
        name,
        tool.description,
        await toJSONSchema(tool.parameters),
        tool.outputSchema,
        contextSchema ? await toJSONSchema(contextSchema) : undefined,
      ];
    }),
  );
}

/**
 * The handoff targets of a run's prepared tools (2.3), for its resume binding:
 * each target's name, model, instructions and own tools, which run in this
 * native run once a transfer is accepted. A target's own transfer tools are
 * followed too. Undefined when the run has no target.
 */
async function handoffBinding(tools: ToolSet): Promise<string | undefined> {
  const targets = new Map<string, unknown>();
  // Transfer groups can reference each other: each tool set is read once.
  const visited = new Set<ToolSet>();
  const visit = async (set: ToolSet): Promise<void> => {
    if (visited.has(set)) return;
    visited.add(set);
    for (const tool of Object.values(set)) {
      const meta = readHandoffTarget(tool);
      if (!meta) continue;
      const own = meta.def.tools ?? {};
      const target = [
        meta.name,
        modelBinding(meta.def.model),
        meta.def.instructions ?? null,
        // A prepared tool keeps its original's context schema.
        await toolBinding(own, (name) => (own[name] as Partial<AgentTool>).contextSchema),
      ];
      targets.set(JSON.stringify(target), target);
      await visit(own);
    }
  };
  await visit(tools);
  return targets.size > 0 ? JSON.stringify([...targets.values()]) : undefined;
}

/**
 * Store for tests and single-process applications; durable applications supply
 * their own store. It lists its runs (2.3) by the time of their last save on
 * `clock`, which defaults to the host clock.
 */
export function createInMemoryAgentRunStore(
  options: { clock?: Clock } = {},
): AgentRunStore & Required<Pick<AgentRunStore, 'list'>> {
  const clock = options.clock ?? resolveDependencies().clock;
  const runs = new Map<string, { envelope: AgentRunEnvelope; updatedAt: number }>();
  return {
    load: (runId) => {
      const value = runs.get(runId);
      return value ? structuredClone(value.envelope) : undefined;
    },
    save: (envelope) => {
      assertEnvelopeRevision(runs.get(envelope.runId)?.envelope, envelope);
      runs.set(envelope.runId, { envelope: structuredClone(envelope), updatedAt: clock.now() });
    },
    async list(query) {
      const plan = planAgentRunList(query);
      const rows = [...runs.values()]
        .map((row) => summarizeAgentRunEnvelope(row.envelope, row.updatedAt))
        .filter(
          (run) =>
            (plan.phases === undefined || plan.phases.includes(run.phase)) &&
            (plan.updatedBefore === undefined || run.updatedAt < plan.updatedBefore) &&
            (plan.scope === undefined || run.scope === plan.scope) &&
            isAfterAgentRunCursor(run, plan.after),
        )
        .sort(compareAgentRunSummaries);
      return agentRunListPage(rows.slice(0, plan.limit + 1), plan.limit);
    },
  };
}

/**
 * Settle what a native run left behind after its outcome (2.3): write the chat
 * projection again when the stored run says it is behind or its last write
 * failed (never over a chat that moved on without the run: `'superseded'`, see
 * `AgentRunChatState`), and settle an extraction an interruption left pending
 * (or that failed). An extraction whose records are in the memory store
 * already, under its operation id, is recorded completed without another
 * memory LLM call; otherwise it runs now. Only for a run that ended or is
 * suspended: an active run settles these itself. The `chat` and `memory`
 * scopes must be the run's. Rejects when the run is unknown, still running, or
 * bound differently, and when a store write fails.
 *
 * Call it only when no executor drives the run. An extraction stays pending
 * from the terminal commit until its outcome is saved, also while the
 * executor that completed the run is still extracting, and a second pass
 * would extract again. With a `LeaseProvider`, pass `lease`: the call then
 * claims the run as an executor does and rejects with `'lease_held'` while
 * one holds it (an executor keeps its lease until its extraction is saved).
 */
export async function reconcileAgentRun(
  options: AgentRunReconcileOptions,
): Promise<AgentRunReconciliation> {
  const { store, runId, scope } = options.session ?? ({} as Partial<AgentRunSession>);
  if (!store || !runId || !scope)
    throw new TypeError('reconcileAgentRun requires a session with a store, runId and scope.');
  let active = activeNativeRuns.get(store);
  if (active?.has(runId)) throw new TypeError('This native run already has an active executor.');
  if (!active) {
    active = new Set();
    activeNativeRuns.set(store, active);
  }
  active.add(runId);
  /** The run's cross-process claim (2.3, `lease`), released on every exit. */
  let lease: NativeRunLease | undefined;
  /** The run ended, so a cancel queued for it is moot. */
  let ended = false;
  try {
    const deps = resolveDependencies(options.deps);
    // Across processes (2.3): taken before the run is read, as an executor
    // takes it, so a run another executor drives (one still extracting, say)
    // is refused before anything else.
    if (options.lease !== undefined)
      lease = await claimNativeRunLease(options.lease, options.session, deps, undefined);
    const saved = await store.load(runId);
    if (!saved) throw new TypeError(`Unknown native run: ${runId}`);
    if (
      saved.kind !== 'deuz-agent-run' ||
      (saved.version !== 1 && saved.version !== 2) ||
      saved.runId !== runId ||
      saved.scope !== scope
    )
      throw new TypeError('Native checkpoint version, identity, or scope mismatch.');
    if (saved.phase !== 'terminal' && saved.result?.status !== 'suspended')
      throw new TypeError('reconcileAgentRun settles a run that ended or is suspended.');
    if (
      (options.chat && saved.binding?.chat !== chatBinding(options.chat)) ||
      (options.memory && saved.binding?.memory !== scopeKey(options.memory.scope))
    )
      throw new TypeError('Native agent binding changed across resume.');
    // A cancel the claim found queued, as a resume that does not take the run
    // up decides on it: an ended run drops it, a suspended one keeps it.
    ended = saved.phase === 'terminal';
    await lease?.collect(ended ? 'terminal' : 'active');
    const envelope = structuredClone(saved);
    const save = async (): Promise<void> => {
      // A call that lost the lease saves nothing more to the run.
      lease?.assertHeld();
      envelope.version = envelopeVersion(envelope);
      envelope.revision = (envelope.revision ?? 0) + 1;
      await store.save(structuredClone(envelope));
    };
    const outcome: AgentRunReconciliation = { runId };
    if (options.chat && envelope.transcript) {
      const nativeChat = await import('./internal/native-chat');
      if (nativeChat.projectionBehind(envelope.transcript, envelope.chat)) {
        lease?.assertHeld();
        envelope.chat = await nativeChat.saveProjection(
          options.chat,
          runId,
          envelope.transcript,
          envelope.chat,
          Object.values(envelope.toolResults ?? {}),
          deps.clock,
          true,
        );
        await save();
        outcome.chat = envelope.chat.status;
      } else outcome.chat = 'current';
    }
    const extraction = envelope.memory?.extraction;
    if (options.memory && extraction && envelope.transcript) {
      if (extraction.status !== 'completed') {
        const nativeMemory = await import('./internal/native-memory');
        const wrote = await nativeMemory.operationWrote(options.memory, extraction.operationId);
        if (wrote > 0)
          envelope.memory!.extraction = { ...extraction, status: 'completed', mutations: wrote };
        else {
          lease?.assertHeld();
          try {
            const mutations = await nativeMemory.runExtraction(
              options.memory,
              nativeMemory.extractionTurns(envelope.transcript),
              extraction,
              runId,
              deps.clock,
              deps.logger,
            );
            envelope.memory!.extraction = { ...extraction, status: 'completed', mutations };
          } catch (error) {
            envelope.memory!.extraction = {
              ...extraction,
              status: 'failed',
              error: errorData(error),
            };
          }
        }
        await save();
      }
      outcome.memory = envelope.memory!.extraction!.status;
    }
    return outcome;
  } catch (error) {
    // A lost lease is the reason, however the loss surfaced.
    throw lease ? lease.failure(error) : error;
  } finally {
    // The lease goes back before the in-process claim, as an executor's does.
    await lease?.release(ended);
    active.delete(runId);
    if (active.size === 0) activeNativeRuns.delete(store);
  }
}

export function runAgent<T = string>(options: AgentRunOptions<T>): Promise<AgentResult<T>> {
  return streamAgent(options).result;
}

export function resumeAgent<T = string>(
  options: AgentRunOptions<T> & { session: AgentRunSession },
): Promise<AgentResult<T>> {
  return resumeStreamAgent(options).result;
}

export function streamAgent<T = string>(options: AgentRunOptions<T>): AgentStream<T> {
  return makeAgentStream(options, false);
}

export function resumeStreamAgent<T = string>(
  options: AgentRunOptions<T> & { session: AgentRunSession },
): AgentStream<T> {
  return makeAgentStream(options, true);
}

function makeAgentStream<T>(options: AgentRunOptions<T>, resume: boolean): AgentStream<T> {
  const events = createBroadcaster<AgentEvent<T>>();
  const text = createBroadcaster<string>();
  const partial = createBroadcaster<{ attempt: number; value: unknown }>();
  type Element = T extends readonly (infer E)[] ? E : never;
  const elements = createBroadcaster<{ attempt: number; index: number; value: Element }>();
  const result = createDeferred<AgentResult<T>>();
  let started = false;
  let envelope: AgentRunEnvelope = {
    kind: 'deuz-agent-run',
    version: 1,
    runId: options.session?.runId ?? '',
    scope: options.session?.scope ?? '',
    phase: 'running',
    messages: [],
    usage: { ...EMPTY_USAGE },
    modelSteps: 0,
    finalizationAttempts: 0,
    verificationAttempts: 0,
    checkpoints: {},
  };
  let currentText = '';
  let common: CommonCallOptions;
  let persistFailed = false;
  let admitted = false;
  let removeLedgerPersistence: (() => void) | undefined;
  let releaseRun: (() => void) | undefined;
  /** The cross-process claim (2.3, `lease`), released on every exit. */
  let lease: NativeRunLease | undefined;
  /** The run's terminal state is durable: a cancel it was sent is settled. */
  let terminalSaved = false;
  let settledOutcome: AgentResult<T> | undefined;
  let writeTail: Promise<void> = Promise.resolve();
  /** The run's MCP servers (2.3, F01), closed on every exit. */
  let nativeMcp: NativeMcp | undefined;
  /** Chat and memory support (2.3), loaded when the run uses them. */
  let nativeChat: typeof import('./internal/native-chat') | undefined;
  let nativeMemory: typeof import('./internal/native-memory') | undefined;
  /** Model fail-over (2.3): the routing of every model call, once `fallbackModels` is set. */
  let router: import('./internal/native-fallback').ModelRouter | undefined;
  /** The run's memory scope is claimed for its execution until the executor ends (2.3). */
  let releaseMemoryScope: (() => void) | undefined;
  /**
   * A resume that found the run ended, or still waiting on its caller (2.3):
   * it writes nothing of the run's own, but may repair a chat projection left
   * behind. A resume refused for any reason writes nothing at all.
   */
  let repairable = false;
  /** This leg completed the run, so it extracts (2.3); a terminal resume never does. */
  let extractNow = false;
  /**
   * This resume re-enters a run that failed in transit (2.3, `retryFailed`):
   * until its first write it writes nothing, the stored run stays failed.
   */
  let retrying = false;
  /** The model call whose failure ended the run (2.3), and whether it broke off. */
  let callFailure: { error: unknown; brokeOff: boolean } | undefined;

  let persistedLedger: string | undefined;
  // A child of a caller's shared ledger records only its own slice (2.2): the
  // parent persists the shared ledger, and every sibling rewriting all of it
  // made checkpoint volume grow quadratically with swarm size.
  function executionSnapshot(execution: NativeExecutionContext): ExecutionContextSnapshot {
    const saved = execution.snapshot();
    return options.execution && execution.depth > 0
      ? { ...saved, ledger: subtreeLedgerSnapshot(saved.ledger, execution.scopeId) }
      : saved;
  }
  const ledgerKey = (saved: ExecutionContextSnapshot | undefined): string =>
    saved ? JSON.stringify([saved.ledger.reservations, saved.ledger.aggregates ?? null]) : '';

  // Writes serialize even when multiple sub-agents checkpoint concurrently.
  function persist(): Promise<void> {
    if (common?.execution) envelope.execution = executionSnapshot(common.execution);
    if (!options.session || !admitted) return Promise.resolve();
    persistedLedger = ledgerKey(envelope.execution);
    envelope.version = envelopeVersion(envelope);
    // Every actual save advances the fence durable stores check (2.2).
    envelope.revision = (envelope.revision ?? 0) + 1;
    const snapshot = structuredClone(envelope);
    const write = writeTail.then(() => {
      // An executor that lost its lease (2.3) writes nothing more.
      lease?.assertHeld();
      return options.session!.store.save(snapshot);
    });
    writeTail = write.catch((error) => {
      persistFailed = true;
      throw error;
    });
    writeTail.catch(() => {});
    return writeTail;
  }

  /**
   * A save after the run's outcome is durable (2.3): the chat projection's
   * acknowledgement or the extraction's outcome. It never fails the run: the
   * outcome was committed before, and a lost write leaves the record behind
   * for the next save or `reconcileAgentRun`. The revision advances only when
   * the store took the write.
   */
  async function saveBookkeeping(): Promise<void> {
    if (!options.session || persistFailed) return;
    const snapshot = structuredClone(envelope);
    snapshot.version = envelopeVersion(snapshot);
    snapshot.revision = (envelope.revision ?? 0) + 1;
    const write = writeTail.then(() => {
      lease?.assertHeld();
      return options.session!.store.save(snapshot);
    });
    writeTail = write.catch(() => {});
    try {
      await write;
      envelope.revision = snapshot.revision;
    } catch (error) {
      resolveDependencies(options.deps).logger.error('native run bookkeeping save failed', {
        runId: envelope.runId,
        error,
      });
    }
  }

  /** A warning about the run's records (2.3), on the stream and in the log. */
  function warnRecords(setting: 'chat' | 'memory', message: string, error?: unknown): void {
    resolveDependencies(options.deps).logger.error(message, { runId: envelope.runId, error });
    emitPart(
      { type: 'warning', warning: { type: 'other', setting, message } },
      envelope.phase === 'running' ? 'running' : 'finalizing',
    );
  }

  /**
   * After the outcome (2.3): project the chat (always after a leg that wrote,
   * and as a repair when the projection is behind), then run the extraction a
   * completed leg recorded as pending. Never throws.
   */
  async function settleRecords(): Promise<void> {
    const deps = resolveDependencies(options.deps);
    if (options.chat && envelope.transcript && nativeChat) {
      if (admitted || nativeChat.projectionBehind(envelope.transcript, envelope.chat)) {
        // A leg that did not run (a terminal or still-suspended resume) only
        // repairs: it never replaces a chat that moved on without the run.
        const state = await nativeChat.saveProjection(
          options.chat,
          envelope.runId,
          envelope.transcript,
          envelope.chat,
          Object.values(envelope.toolResults ?? {}),
          deps.clock,
          !admitted,
        );
        envelope.chat = state;
        if (state.status === 'failed')
          warnRecords(
            'chat',
            `The chat projection of run ${envelope.runId} could not be saved (${state.error?.message ?? 'unknown error'}); the run's checkpoint is intact and the next save repairs it.`,
            state.error,
          );
        else if (state.status === 'scope-mismatch')
          warnRecords(
            'chat',
            `Chat ${options.chat.chatId} belongs to another scope; run ${envelope.runId} left it untouched.`,
          );
        else if (state.status === 'superseded')
          warnRecords(
            'chat',
            `Chat ${options.chat.chatId} moved on without run ${envelope.runId}; its projection was not written.`,
          );
        await saveBookkeeping();
      }
    }
    const extraction = envelope.memory?.extraction;
    if (extractNow && extraction && options.memory && envelope.transcript && nativeMemory) {
      try {
        const mutations = await nativeMemory.runExtraction(
          options.memory,
          nativeMemory.extractionTurns(envelope.transcript),
          extraction,
          envelope.runId,
          deps.clock,
          deps.logger,
        );
        envelope.memory!.extraction = { ...extraction, status: 'completed', mutations };
      } catch (error) {
        envelope.memory!.extraction = { ...extraction, status: 'failed', error: errorData(error) };
        warnRecords(
          'memory',
          `The memory extraction of run ${envelope.runId} failed (${errorData(error).message}); the run's outcome stands.`,
          error,
        );
      }
      await saveBookkeeping();
    }
  }

  function base() {
    return {
      runId: envelope.runId,
      text: currentText,
      messages: [...envelope.messages],
      usage: { ...envelope.usage },
      modelSteps: envelope.modelSteps,
      ...(common?.execution
        ? { accounting: common.execution.ledger.totals(common.execution.scopeId) }
        : {}),
      ...(envelope.verification ? { verification: envelope.verification } : {}),
    };
  }
  async function finish(outcome: AgentResult<T>): Promise<void> {
    envelope.result = outcome;
    envelope.phase = outcome.status === 'suspended' ? 'running' : 'terminal';
    await persist();
    if (admitted && envelope.phase === 'terminal') terminalSaved = true;
    settledOutcome = outcome;
  }
  // An abort that a lease cancel caused (2.3) stops the run as 'cancelled'.
  const stopped = (reason: string, stopDetails?: StopDetails) =>
    finish({
      ...base(),
      status: 'stopped',
      reason: reason === 'aborted' && lease?.cancelled ? 'cancelled' : reason,
      ...(stopDetails ? { stopDetails } : {}),
    });
  /**
   * A drain (2.3) stops the run where it stands, unended: no outcome is
   * committed, so the run's last save stays the point a resume goes on from.
   */
  const drained = (): void => {
    settledOutcome = { ...base(), status: 'stopped', reason: DRAINED };
  };
  /** A drain reached this executor's lease (2.3). A cancel or abort outranks it. */
  const drainDue = (): boolean => lease !== undefined && lease.draining && !lease.signal.aborted;
  function emitPart(part: StreamPart, phase: 'running' | 'finalizing'): void {
    events.push({ type: 'part', part, phase });
    if (part.type === 'text-delta') text.push(part.text);
  }

  /**
   * The transient cause of the run's failure (2.3), recorded so `retryFailed`
   * may go on from it. Never once the run lost its lease, was cancelled or ran
   * out of time, as for a fail-over.
   */
  function transientCause(error: unknown): AgentRunRetry['cause'] | undefined {
    if (lease && lease.failure(error) !== error) return undefined;
    if ((lease?.signal ?? options.signal)?.aborted) return undefined;
    if (common?.execution) {
      try {
        assertExecutionPolicy(common.execution, {
          now: resolveDependencies(options.deps).clock.now(),
        });
      } catch {
        return undefined;
      }
    }
    return retryableCause(
      error,
      callFailure !== undefined && callFailure.error === error && callFailure.brokeOff,
    );
  }

  async function pump(): Promise<void> {
    try {
      envelope.runId ||= resolveDependencies(options.deps).generateId();
      let maxSteps = positiveInteger(options.maxSteps ?? 20, 'maxSteps');
      let maxOutputAttempts = positiveInteger(options.maxOutputAttempts ?? 2, 'maxOutputAttempts');
      let maxVerifyAttempts = positiveInteger(options.maxVerifyAttempts ?? 3, 'maxVerifyAttempts');
      // A mid-run MCP catalog change stops a native run unless it accepts it (2.3).
      const catalogPolicy = options.onCatalogChange ?? 'stop';
      if (catalogPolicy !== 'stop' && catalogPolicy !== 'accept')
        throw new TypeError("onCatalogChange must be 'stop' or 'accept'.");
      if (options.retryFailed !== undefined && typeof options.retryFailed !== 'boolean')
        throw new TypeError('retryFailed must be a boolean.');
      if (options.session && (!options.session.runId || !options.session.scope)) {
        throw new TypeError('Native sessions require non-empty runId and scope.');
      }
      if (options.lease !== undefined && !options.session)
        throw new TypeError('A native run lease requires a session.');
      if (options.session) {
        const { store, runId } = options.session;
        let active = activeNativeRuns.get(store);
        if (!active) {
          active = new Set();
          activeNativeRuns.set(store, active);
        }
        if (active.has(runId))
          throw new TypeError('This native run already has an active executor.');
        active.add(runId);
        releaseRun = () => {
          active.delete(runId);
          if (active.size === 0) activeNativeRuns.delete(store);
        };
      }
      // Across processes (2.3): the run's lease, taken before the run is read,
      // so a run another executor drives is refused before anything else. It
      // is renewed at once and on a heartbeat from there: a cancel signalled
      // after that first renewal stops this run, a new one included.
      if (options.lease !== undefined)
        lease = await claimNativeRunLease(
          options.lease,
          options.session!,
          resolveDependencies(options.deps),
          options.signal ?? options.abortSignal,
        );
      // These legacy completion hooks have accept-as-is semantics. Native runs
      // use only the tri-state verifier and never silently inherit that behavior.
      const legacy = options as AgentRunOptions<T> & {
        verifyStep?: unknown;
        doneWhen?: unknown;
        falseFinishGuard?: unknown;
      };
      if (
        legacy.verifyStep !== undefined ||
        legacy.doneWhen !== undefined ||
        legacy.falseFinishGuard !== undefined
      ) {
        throw new TypeError(
          'Native runs use verify with verified/rejected/inconclusive; legacy completion hooks are unsupported.',
        );
      }
      if (
        options.fallbackModels !== undefined &&
        (!Array.isArray(options.fallbackModels) ||
          options.fallbackModels.some((model) => !model || typeof model.modelId !== 'string'))
      )
        throw new TypeError('fallbackModels must be an array of models.');
      const nativeFallback = options.fallbackModels?.length
        ? await import('./internal/native-fallback')
        : undefined;
      // Chat and memory (2.3): their shape is checked before anything is read.
      if (options.chat !== undefined) assertChatOptions(options.chat);
      if (options.memory !== undefined) {
        nativeMemory = await import('./internal/native-memory');
        nativeMemory.assertMemoryOptions(options.memory);
      }
      if (options.chat !== undefined || options.memory !== undefined)
        nativeChat = await import('./internal/native-chat');
      if (resume) {
        if (!options.session) throw new TypeError('resumeAgent requires a native session.');
        const saved = await options.session.store.load(options.session.runId);
        if (!saved) throw new TypeError(`Unknown native run: ${options.session.runId}`);
        if (
          saved.kind !== 'deuz-agent-run' ||
          (saved.version !== 1 && saved.version !== 2) ||
          saved.runId !== options.session.runId ||
          saved.scope !== options.session.scope
        )
          throw new TypeError('Native checkpoint version, identity, or scope mismatch.');
        // So are the loop and sub-agent checkpoints it holds (2.3): one a newer
        // SDK wrote fails the resume here, before admission, so the stored run
        // stays resumable by that SDK.
        for (const [runId, checkpoint] of Object.entries(saved.checkpoints))
          assertCheckpointVersion(checkpoint, runId);
        envelope = structuredClone(saved);
        currentText = envelope.candidateText ?? lastAssistantText(envelope.messages);
        // A run that failed in transit (2.3) goes on when the caller asks: in the
        // phase it failed in, from its last checkpoint, after every check of a
        // resume. Its first write drops the failed result; until then nothing
        // is written. Any other failure stays final.
        if (
          options.retryFailed &&
          envelope.phase === 'terminal' &&
          envelope.result?.status === 'failed'
        ) {
          const { name, code, message } = envelope.result.error;
          if (!envelope.retry)
            throw new TypeError(
              `retryFailed: run ${envelope.runId} did not fail in transit (${code ?? name}: ${message}); only a model call that failed in transit or a budget admission refused with a serialization conflict is retried.`,
            );
          if (envelope.retry.phase !== 'running' && envelope.retry.phase !== 'finalizing')
            throw new TypeError('Invalid native retry record.');
          envelope.phase = envelope.retry.phase;
          retrying = true;
        }
      } else if (options.session && (await options.session.store.load(options.session.runId))) {
        throw new TypeError('Native run already exists; use resumeAgent.');
      }
      // A cancel the claim found queued under the run's key stops a stored run
      // that has not ended before any model call; a new run, or an ended one,
      // drops it. A runAgent that found the run existing threw above, leaving
      // the cancel queued for that run.
      await lease?.collect(
        !resume ? 'fresh' : envelope.phase === 'terminal' ? 'terminal' : 'active',
      );
      if (!resume) {
        const invalid = inputShapeError(options, 'runAgent');
        if (invalid) throw invalid;
      }
      common = foldCallInput(
        {
          ...options,
          ...(lease ? { signal: lease.signal } : {}),
          tools: undefined,
          session: undefined,
          // The run handles these itself (2.3); its loops never see them.
          chat: undefined,
          memory: undefined,
          fallbackModels: undefined,
          messages: resume ? envelope.messages : options.messages,
          prompt: resume ? undefined : options.prompt,
          instructions: resume ? undefined : options.instructions,
        } as CommonCallOptions,
        'runAgent',
      );
      if (
        options.execution &&
        envelope.execution &&
        (options.execution.scopeId !== envelope.execution.scopeId ||
          JSON.stringify(options.execution.policy) !==
            JSON.stringify(
              intersectExecutionPolicies(envelope.execution.policy, options.execution.policy),
            ) ||
          JSON.stringify(options.execution.budget) !==
            JSON.stringify(
              intersectBudgetLimits(envelope.execution.budget, options.execution.budget),
            ))
      ) {
        throw new TypeError('Native execution scope or constraints changed across resume.');
      }
      if (options.execution && envelope.execution)
        assertAccountingContinuity(envelope.execution, options.execution);
      if (!options.execution && envelope.execution?.ledger.subtree !== undefined) {
        throw new TypeError(
          'This native run was checkpointed under a shared execution context; resume it with that execution.',
        );
      }
      if (!options.execution) {
        const persistLedger = async (): Promise<void> => {
          await persist();
        };
        common.execution = envelope.execution
          ? createExecutionContext({ snapshot: envelope.execution, persist: persistLedger })
          : createExecutionContext({
              scopeId: envelope.runId,
              budget: options.budget,
              persist: persistLedger,
            });
        // The run owns this ledger, so its sub-agents report a warning once too.
        markRunLedger(common.execution.ledger);
      }
      // A run under another native run's execution may only narrow its memory scope (2.3).
      if (options.memory)
        releaseMemoryScope = nativeMemory!.claimMemoryScope(
          common.execution!,
          options.memory.scope,
        );
      // One warning sink for the whole run (2.3): the loop phases and every
      // finalization attempt report and stream each warning once.
      const runWarnings = createWarningSink(resolveDependencies(options.deps).logger);
      if (!resume) envelope.messages = [...common.messages];
      common.messages = envelope.messages;
      // Validate ALL schema/context configuration before the first paid call.
      const outputSchema = options.output ? await agentJSONSchema(options.output) : undefined;
      if (options.output?.element)
        assertAgentValidation(options.output.element, 'Agent array element');
      const savedClients =
        envelope.pendingClientCalls ??
        (envelope.result?.status === 'suspended' ? envelope.result.pendingClientCalls : []);
      // Client results enter the same approval/validation/projection executor as
      // server results. They are never appended as already-approved history.
      const clientValues = new Map(
        (options.clientToolResults ?? []).map((item) => [item.toolCallId, item]),
      );
      const onToolOutput = (output: NativeToolOutput): void => {
        events.push({ type: 'tool-output', ...output });
      };
      /**
       * Save `messages`, the history of the step in flight, as the run's
       * running checkpoint at its current step index, so a resume settles the
       * step's open calls from there without another model call.
       */
      const saveInFlight = async (
        messages: Message[],
        handoff = envelope.checkpoints[envelope.runId]?.handoff,
      ): Promise<void> => {
        envelope.messages = [...messages];
        if (envelope.transcript) nativeChat!.foldHistory(envelope.transcript, envelope.messages);
        const previous = envelope.checkpoints[envelope.runId];
        envelope.checkpoints[envelope.runId] = {
          version: 1,
          runId: envelope.runId,
          stepId: `${envelope.runId}#${previous?.stepIndex ?? 0}`,
          stepIndex: previous?.stepIndex ?? 0,
          status: 'running',
          messages: envelope.messages,
          usage: envelope.usage,
          createdAt: resolveDependencies(options.deps).clock.now(),
          ...(handoff ? { handoff } : {}),
          // The run's approval-request count (2.3) outlives every checkpoint.
          ...(previous?.approvalRequestCounts
            ? { approvalRequestCounts: previous.approvalRequestCounts }
            : {}),
        };
        await persist();
      };
      // One receipt boundary for every tool the run can execute: local, handoff
      // targets and (2.3, F01) MCP tools, refreshed catalogs included.
      const receipts: NativeToolReceipts = {
        load: (id) => envelope.toolResults?.[JSON.stringify([envelope.modelSteps, id])],
        retryToolCallIds: options.retryToolCallIds,
        modelStep: () => envelope.modelSteps,
        save: async (receipt, ctx) => {
          envelope.toolResults ??= {};
          receipt.modelStep ??= envelope.modelSteps;
          envelope.toolResults[JSON.stringify([receipt.modelStep, receipt.toolCallId])] = receipt;
          // Persist the in-flight tool-call history as well as its receipt so
          // canonical resume can settle that exact ID without another model call.
          await saveInFlight(ctx.messages);
        },
      };
      common.tools = await prepareAgentTools(
        options.tools,
        options.toolsContext,
        onToolOutput,
        receipts,
      );
      // Client calls (2.3): a call of one of the run's own tools without
      // `execute`. The settle applies a result a resume supplies through the
      // call's receipt, so a later resume answers the call from that record,
      // for example after the process died before the step was saved. Only the
      // settle gets an executor for them: the loop's own tools keep none, so a
      // later call of the same tool suspends as a client call again.
      const isClientTool = (name: string): boolean =>
        options.tools !== undefined &&
        Object.hasOwn(options.tools, name) &&
        !options.tools[name]!.execute;
      /** The open turn's client calls whose receipt records their result, by call ID. */
      const recordedClients = new Map(
        Object.values(envelope.toolResults ?? {})
          .filter(
            (receipt) =>
              receipt.modelStep === envelope.modelSteps &&
              OUTCOME_STAGES.has(receipt.stage) &&
              isClientTool(receipt.toolName),
          )
          .map((receipt) => [receipt.toolCallId, receipt]),
      );
      const settledClients = new Set(
        [
          ...savedClients.filter((call) => clientValues.has(call.toolCallId)),
          ...recordedClients.values(),
        ]
          .map((call) => call.toolName)
          .filter(isClientTool),
      );
      const settleTools =
        settledClients.size > 0
          ? await prepareAgentTools(
              Object.fromEntries(
                [...settledClients].map((name) => [
                  name,
                  {
                    ...options.tools![name]!,
                    // A recorded result is replayed before this runs.
                    execute: (_args: unknown, ctx: { toolCallId: string }) => {
                      const provided = clientValues.get(ctx.toolCallId);
                      if (!provided)
                        throw new TypeError('No result supplied for this client call.');
                      if (provided.isError) throw new Error(String(provided.output));
                      return provided.output;
                    },
                  },
                ]),
              ),
              options.toolsContext,
              onToolOutput,
              receipts,
            )
          : undefined;
      const binding: NonNullable<AgentRunEnvelope['binding']> = {
        model: modelBinding(common.model),
        tools: JSON.stringify(
          await toolBinding(common.tools, (name) => options.tools?.[name]?.contextSchema),
        ),
        output: JSON.stringify(outputSchema ?? null),
        ...(options.bindingId !== undefined ? { revision: options.bindingId } : {}),
        // The run's memory scope and chat (2.3): a resume may not change, add or drop them.
        ...(options.memory ? { memory: scopeKey(options.memory.scope) } : {}),
        ...(options.chat ? { chat: chatBinding(options.chat) } : {}),
        // So are its fail-over candidates (2.3), in order.
        ...(nativeFallback
          ? { fallback: nativeFallback.fallbackBinding(options.fallbackModels!) }
          : {}),
      };
      // Handoff targets (2.3) are compared on their own, and the MCP catalog
      // below, once the servers are reached: an envelope written before 2.3
      // records neither, and its resume records them.
      const handoffs = await handoffBinding(common.tools);
      const recordedCatalog = envelope.binding?.mcp;
      if (envelope.binding) {
        const { mcp: _catalog, handoffs: recordedHandoffs, ...recorded } = envelope.binding;
        if (
          JSON.stringify(binding) !== JSON.stringify(recorded) ||
          (recordedHandoffs !== undefined && recordedHandoffs !== handoffs)
        )
          throw new TypeError('Native agent binding changed across resume.');
      }
      if (handoffs !== undefined) binding.handoffs = handoffs;
      if (nativeFallback)
        router = nativeFallback.createModelRouter(
          options.fallbackModels!,
          common.capabilities,
          envelope.models,
        );
      if (envelope.phase === 'terminal') {
        if (!envelope.result || envelope.result.status === 'suspended')
          throw new TypeError('Invalid native terminal checkpoint.');
        const terminal = envelope.result as AgentResult<T>;
        settledOutcome = terminal;
        terminalSaved = true;
        repairable = true;
        return;
      }
      // MCP (2.3, F01): connected only now, after a terminal run has returned
      // and before anything is persisted, so an unreachable server fails a fresh
      // run cleanly and a resume checks the servers' catalog before it writes. The
      // tools pass through the same receipts as local tools.
      /** A drifted catalog this resume accepts (2.3): its first write records it. */
      let acceptedCatalog: { catalog: string; drift: string } | undefined;
      if ((options.mcp?.length ?? 0) > 0 || recordedCatalog !== undefined) {
        const native = await import('./inference/native-mcp');
        if (options.mcp?.length) {
          nativeMcp = await native.resolveNativeMcp(
            options.mcp,
            resolveDependencies(options.deps),
            (tools, replayOf) => prepareMcpTools(tools, replayOf, onToolOutput, receipts),
            // Two servers exposing one name reach the run's warnings (2.3).
            (warning) => {
              runWarnings.add(warning);
            },
          );
          binding.mcp = await nativeMcp.catalog();
        }
        const drift = native.catalogDrift(recordedCatalog, binding.mcp);
        if (drift) {
          // Rejected like a changed local tool set; the stored run stays intact.
          // Under `onCatalogChange: 'accept'` (2.3) the servers' new catalog
          // opens a new binding revision instead, as the hot refresh it missed
          // would have, unless the servers are gone or a call the model made
          // against the recorded catalog is still in flight.
          if (
            catalogPolicy !== 'accept' ||
            !nativeMcp ||
            native.mcpCallInFlight(envelope.messages, envelope.toolResults, [
              recordedCatalog,
              binding.mcp,
            ])
          )
            throw new TypeError(`MCP tool catalog changed across resume (${drift}).`);
          acceptedCatalog = { catalog: binding.mcp!, drift };
          binding.mcp = recordedCatalog;
        }
      }
      envelope.binding = binding;
      if (envelope.limits) {
        maxSteps = Math.min(maxSteps, envelope.limits.maxSteps);
        maxOutputAttempts = Math.min(maxOutputAttempts, envelope.limits.maxOutputAttempts);
        maxVerifyAttempts = Math.min(maxVerifyAttempts, envelope.limits.maxVerifyAttempts);
      }
      envelope.limits = { maxSteps, maxOutputAttempts, maxVerifyAttempts };
      const pendingCheckpoint = envelope.checkpoints[envelope.runId];
      const pendingApprovals = pendingCheckpoint?.pendingApprovals ?? [];
      const pendingClients =
        envelope.pendingClientCalls ??
        (envelope.result?.status === 'suspended' ? envelope.result.pendingClientCalls : []);
      const clientResults = options.clientToolResults ?? [];
      const clientIds = new Set<string>();
      for (const clientResult of clientResults) {
        if (
          !resume ||
          clientIds.has(clientResult.toolCallId) ||
          !pendingClients.some((call) => call.toolCallId === clientResult.toolCallId)
        ) {
          throw new TypeError('Client tool results must match unique pending call IDs on resume.');
        }
        clientIds.add(clientResult.toolCallId);
      }
      // A local tool shadows an MCP tool of the same name, as in the loop's merge.
      const replayOf = (name: string): AgentTool['replay'] =>
        options.tools && Object.hasOwn(options.tools, name)
          ? options.tools[name]!.replay
          : nativeMcp?.replayOf(name);
      // The calls whose effect is unknown: each started and its outcome was
      // never recorded. The policy the receipt recorded (2.3) is that of the tool
      // that ran the call, a handoff target's own included. Older receipts have
      // none. An idempotent call simply runs again.
      const unknownEffects = Object.values(envelope.toolResults ?? {}).filter(
        (receipt) =>
          receipt.stage === 'executing' &&
          !(receipt.idempotent ?? replayOf(receipt.toolName) === 'idempotent'),
      );
      // The outcomes the caller found in the systems those effects touched (2.3).
      const reconciled = reconciledOutcomes(
        options.reconciledToolResults,
        unknownEffects,
        options.retryToolCallIds,
      );
      if (
        resume &&
        ((pendingCheckpoint?.status === 'suspended' &&
          // A verdict must name the approval it answers (2.3): one kept from an
          // earlier gate under a reused call id leaves the run suspended. The
          // run's count covers its own gate's requests; a sub-agent's has its own.
          pendingApprovals.some(
            (request) =>
              !answersApproval(
                request,
                options.approvalResponses,
                envelope.messages,
                request.agentPath?.length
                  ? undefined
                  : requestCountsOf(pendingCheckpoint?.approvalRequestCounts),
              ),
          )) ||
          // A client call waits for its result until one is recorded (2.3), also
          // once a call beside it moved the stored step on.
          pendingClients.some(
            (call) => !clientIds.has(call.toolCallId) && !recordedClients.has(call.toolCallId),
          ))
      ) {
        const outcome: AgentResult<T> = {
          ...base(),
          status: 'suspended',
          pendingApprovals,
          pendingClientCalls: pendingClients,
        };
        settledOutcome = outcome;
        // A failed run being re-entered (2.3) is still failed in the store.
        repairable = !retrying;
        return;
      }
      if (
        resume &&
        unknownEffects.some(
          (receipt) =>
            !options.retryToolCallIds?.includes(receipt.toolCallId) &&
            !reconciled.has(receipt.toolCallId),
        )
      ) {
        // This is a recoverable interruption, so do not replace the checkpoint
        // with a terminal record that would prevent an explicit reconciliation.
        // Which calls are unknown is part of the result (2.3), and each is
        // reported on the stream as an unknown effect. A stop writes nothing,
        // so it names every call the store still holds as unknown, also those
        // this resume would have retried or reconciled: the next resume must
        // settle them all.
        for (const receipt of unknownEffects) {
          emitPart(
            {
              type: 'tool-state',
              toolCallId: receipt.toolCallId,
              toolName: receipt.toolName,
              state: 'error',
              outcome: 'unknown-effect',
            },
            'running',
          );
        }
        const outcome: AgentResult<T> = {
          ...base(),
          status: 'stopped',
          reason: 'tool-reconciliation-required',
          unknownEffects: structuredClone(unknownEffects),
        };
        settledOutcome = outcome;
        return;
      }
      // A drain (2.3) that reached this executor before the resume took the run
      // up stops it here, before its first write: the stored run stays as it was.
      if (resume && drainDue()) {
        drained();
        return;
      }
      // Chat and memory (2.3). A new run recalls once, here, after every check
      // and before its first save: the recall becomes part of the history every
      // step and every resume sends. The transcript starts with the input; every
      // later save of the history folds in its new turns first, so the stored
      // transcript never lags the stored history.
      if (!resume && (options.memory || options.chat)) {
        const input = envelope.messages.length;
        const internal: number[] = [];
        if (options.memory) {
          const { recall, message } = await nativeMemory!.recallOnce(
            options.memory,
            envelope.messages,
            resolveDependencies(options.deps).logger,
          );
          if (message) {
            recall.index = envelope.messages.length;
            internal.push(recall.index);
            envelope.messages = [...envelope.messages, message];
            common.messages = envelope.messages;
          }
          envelope.memory = { scope: structuredClone(options.memory.scope), recall };
        }
        envelope.transcript = nativeChat!.createTranscript(envelope.messages, input, internal);
      }
      admitted = true;
      if (options.execution && options.session) {
        removeLedgerPersistence = options.execution.ledger.addPersistence(() => {
          // Sibling reservations on a shared ledger leave this run's slice
          // unchanged, so no new write is needed. A write already issued for
          // this slice may still be in flight (another persist() can run while
          // a parent sink yields): admission must wait until it is durable.
          if (ledgerKey(executionSnapshot(common.execution!)) === persistedLedger) return writeTail;
          return persist();
        });
      }
      // The pending client calls stay listed until the settle's answers are saved
      // (2.3): a resume that dies before then accepts their results again. One
      // whose result a receipt already records is answered from that record.
      for (const id of clientIds) {
        const receipt = recordedClients.get(id);
        if (receipt)
          runWarnings.add({
            type: 'other',
            setting: 'clientToolResults',
            message: `Tool call ${id} (${receipt.toolName}) already has a recorded result, which answers it; the result passed for it was ignored.`,
          });
      }
      // A reconciled effect (2.3) landed: its receipt takes the outcome the
      // caller found, so the step goes on from it as from a recorded raw result
      // (validated and projected like the tool's own) and the call never runs
      // again. One that failed there answers the call with its error.
      for (const [key, receipt] of Object.entries(envelope.toolResults ?? {})) {
        const found =
          receipt.stage === 'executing' ? reconciled.get(receipt.toolCallId) : undefined;
        if (!found) continue;
        envelope.toolResults![key] = found.isError
          ? {
              ...receipt,
              stage: 'failed',
              error:
                typeof found.output === 'string'
                  ? found.output
                  : (JSON.stringify(found.output) ?? String(found.output)),
              reconciled: true,
            }
          : { ...receipt, stage: 'executed', rawResult: found.output, reconciled: true };
      }
      // An accepted catalog change (2.3) is recorded by this first write,
      // before any model call, and reported like a hot refresh's.
      if (acceptedCatalog) {
        envelope.binding.mcp = acceptedCatalog.catalog;
        runWarnings.add({
          type: 'other',
          setting: 'mcp',
          message: `MCP tool catalog changed across resume (${acceptedCatalog.drift}); the run's resume binding now records the new catalog.`,
        });
      }
      delete envelope.result;
      delete envelope.retry;
      await persist();

      /**
       * A drain (2.3) stopped the loop at a step boundary: the loop's last stop
       * condition fired after a step's tool calls ran, before another model call.
       */
      let drainStopped = false;
      const checkpointStore: SessionStore = {
        load: (runId) => envelope.checkpoints[runId],
        save: async (saved) => {
          // The loop records a stop as a completed checkpoint. A drain's is the
          // boundary the loop stopped at, so it is stored as the running one a
          // resume goes on from, as the loop would have saved it (2.3).
          const checkpoint =
            drainStopped && saved.runId === envelope.runId && saved.status === 'completed'
              ? { ...saved, status: 'running' as const }
              : saved;
          envelope.checkpoints[checkpoint.runId] = structuredClone(checkpoint);
          if (checkpoint.runId === envelope.runId) {
            envelope.messages = checkpoint.messages;
            envelope.usage = checkpoint.usage;
            if (envelope.transcript)
              nativeChat!.foldHistory(envelope.transcript, envelope.messages);
          }
          await persist();
        },
      };

      // Cancellation and the execution deadline (2.3, F05). Checked before every
      // model call AND at every point where async caller code (validation,
      // guardrails, the verifier) may have outlived the run, right before the
      // terminal commit. An elapsed deadline fails the run, exactly as it fails
      // model and tool dispatch; an abort stops it.
      const checkCancellation = async (): Promise<boolean> => {
        if ((lease?.signal ?? options.signal)?.aborted) {
          await stopped('aborted');
          return false;
        }
        if (common.execution)
          assertExecutionPolicy(common.execution, {
            now: resolveDependencies(options.deps).clock.now(),
          });
        return true;
      };

      /** The requests on the run's ledger now (2.3, for `retryFailed`). */
      const ledgerRequests = (): ReadonlySet<string> =>
        new Set(common.execution!.ledger.snapshot().reservations.map((entry) => entry.requestId));
      /**
       * Whether the model call that just failed broke off (2.3): the run's own
       * last call since `before`, sent, and left with an unknown outcome. Such a
       * call fails with whatever error the runtime raises for a broken stream.
       */
      const brokeOff = (before: ReadonlySet<string>): boolean => {
        const { ledger, scopeId } = common.execution!;
        const own = ledger
          .snapshot()
          .reservations.filter(
            (entry) => entry.scopes.at(-1)?.id === scopeId && !before.has(entry.requestId),
          );
        return own.at(-1)?.state === 'unknown';
      };

      const checkLimit = async (): Promise<boolean> => {
        if (!(await checkCancellation())) return false;
        if (envelope.modelSteps >= maxSteps) {
          await stopped('max-steps');
          return false;
        }
        if (
          options.budget?.tokens !== undefined &&
          envelope.usage.totalTokens >= options.budget.tokens
        ) {
          await stopped('budget.tokens');
          return false;
        }
        if (options.budget?.usd !== undefined) {
          const price =
            common.execution?.ledger.totals().committed.usd ??
            (await resolveDependencies(options.deps).priceProvider?.priceUsage(
              options.model.modelId,
              envelope.usage,
            ));
          if (typeof price !== 'number')
            throw new TypeError('A USD budget requires an execution ledger or priceProvider.');
          if (price >= options.budget.usd) {
            await stopped('budget.usd');
            return false;
          }
        }
        return true;
      };

      // A hot refresh mid-run (2.3, F01) that really changed the catalog either
      // stops the run before the model is offered it (`onCatalogChange: 'stop'`,
      // the default: nobody reviewed the new tools), or opens a new binding
      // revision: the new catalog is recorded, durably, before the model is
      // offered it, so a later resume compares against the catalog the run
      // actually used. Either way the change is reported as a warning; accepted
      // tools carry receipts like every other.
      const recordCatalog = async (): Promise<CatalogChangeVerdict> => {
        const catalog = await nativeMcp!.catalog();
        const { catalogDrift } = await import('./inference/native-mcp');
        const drift = catalogDrift(envelope.binding?.mcp, catalog);
        if (!drift) return { warnings: [], stop: false };
        if (catalogPolicy === 'stop') {
          return {
            warnings: [
              {
                type: 'other',
                setting: 'mcp',
                message: `MCP tool catalog changed mid-run (${drift}); the run stopped before offering it (onCatalogChange: 'stop').`,
              },
            ],
            stop: true,
          };
        }
        envelope.binding = { ...envelope.binding!, mcp: catalog };
        await persist();
        return {
          warnings: [
            {
              type: 'other',
              setting: 'mcp',
              message: `MCP tool catalog changed mid-run (${drift}); the run's resume binding now records the new catalog.`,
            },
          ],
          stop: false,
        };
      };

      /**
       * Fail a model call over (2.3): `failed` is the model the call went to,
       * `intended` the one the run meant. Only a retryable error before the
       * call's first content qualifies, and never once the run was cancelled or
       * ran out of time. Records the fail-over and warns; the caller saves it.
       */
      const failOver = (
        failed: LanguageModel,
        intended: LanguageModel,
        error: unknown,
        phase: 'running' | 'finalizing',
      ): boolean => {
        if (!router || !nativeFallback?.failsOver(error)) return false;
        if ((lease?.signal ?? options.signal)?.aborted) return false;
        if (common.execution) {
          try {
            assertExecutionPolicy(common.execution, {
              now: resolveDependencies(options.deps).clock.now(),
            });
          } catch {
            return false;
          }
        }
        const attempt = router.fail(failed, intended, errorData(error), envelope.modelSteps, phase);
        if (!attempt) return false;
        envelope.models = router.state(common.model);
        const name = (ref: typeof attempt.model) => `${ref.provider}/${ref.modelId}`;
        emitPart(
          {
            type: 'warning',
            warning: {
              type: 'other',
              setting: 'fallbackModels',
              message: `${name(attempt.model)} failed (${attempt.error.message}); the call went to ${name(attempt.next)}, which serves the rest of the run in its place.`,
            },
          },
          phase,
        );
        return true;
      };
      /** A handoff target's model, by the target's name (2.3, for fail-over routing). */
      const targetModel = (name: string): LanguageModel | undefined =>
        findHandoffTarget(collectHandoffTools(common.tools ?? {}), name)?.def.model;

      // The run's transcript (2.3) takes each loop leg's raw history: the loop's
      // own chat persistence, pointed at the envelope. A resume leg starts from
      // the transcript, so a compacted history never shortens it.
      const transcriptChat: CommonCallOptions['chat'] = envelope.transcript
        ? {
            chatId: envelope.runId,
            scope: { runId: envelope.runId },
            store: {
              loadChat: (chatId) => ({
                chatId,
                scope: { runId: envelope.runId },
                messages: [...envelope.transcript!.messages],
                updatedAt: 0,
              }),
              saveChat: (record) => {
                envelope.transcript!.messages = [...record.messages];
                envelope.transcript!.synced = nativeChat!.syncPoint(envelope.messages);
              },
            } satisfies ChatStore,
          }
        : undefined;

      // Structured-only runs go straight to finalization. Runs with tools/MCP
      // traverse the canonical loop first; no tool executor exists here.
      const hasLoopTools = Object.keys(common.tools).length > 0 || (options.mcp?.length ?? 0) > 0;
      /** The tool request of the loop's last model call, when this leg ran the loop. */
      let loopWire: WireToolRequest | undefined;
      /** The loop's active handoff agent at its end, when this leg ran the loop. */
      let loopHandoff: StreamToolLoopSnapshot['handoff'];
      if (envelope.phase === 'running' && (!options.output || hasLoopTools)) {
        const checkpoint = envelope.checkpoints[envelope.runId];
        const recoveredOutcome =
          resume && checkpoint?.status === 'completed' ? envelope.loopOutcome : undefined;
        if (resume && checkpoint?.status === 'completed' && !recoveredOutcome) {
          await stopped('recovery-required');
          return;
        }
        if (recoveredOutcome) {
          if (
            recoveredOutcome.stoppedBy ||
            recoveredOutcome.endReason !== 'natural' ||
            recoveredOutcome.finishReason !== 'stop'
          ) {
            await stopped(
              recoveredOutcome.stoppedBy ??
                (recoveredOutcome.endReason !== 'natural'
                  ? recoveredOutcome.endReason
                  : stopReasonOf(recoveredOutcome.finishReason)),
              recoveredOutcome.stopDetails,
            );
            return;
          }
          if (!options.output)
            envelope.candidateText = currentText = finalTurnText(envelope.messages);
        } else {
          if (!(await checkLimit())) return;
          // A drain (2.3) stops a new run before its first model call. A resume
          // goes on to its first step boundary, so what it was given (verdicts,
          // client results) is applied and saved before it stops.
          if (!resume && drainDue()) {
            drained();
            return;
          }
          events.push({ type: 'phase', phase: 'running' });
          // A leg whose model call failed over (2.3) runs again from the run's
          // last checkpoint, so only that call is repeated; without one, from
          // the history the first leg started with.
          const legInput = common.messages;
          // A drain (2.3) stops the loop after a step's tool calls ran, before
          // another model call. It is the loop's last stop condition, so every
          // other stop at the same boundary outranks it.
          const stopWhen: CommonCallOptions['stopWhen'] = lease
            ? [
                ...(common.stopWhen === undefined ? [] : [common.stopWhen].flat()),
                Object.assign((): boolean => (drainStopped = drainDue()), {
                  conditionName: DRAINED,
                }) satisfies StopCondition,
              ]
            : common.stopWhen;
          let snapshot: StreamToolLoopSnapshot | undefined;
          let loop: StreamToolLoopSnapshot;
          for (;;) {
            snapshot = undefined;
            const before = envelope.modelSteps;
            const legRequests = ledgerRequests();
            const legCheckpoint = envelope.checkpoints[envelope.runId];
            // Fail-over routing (2.3), by the loop's step index: the model each
            // step meant and the one it went to, and which steps produced
            // content. The loop runs ahead of this reader, so nothing here may
            // depend on when a part is read.
            const routes = new Map<number, { intended: LanguageModel; called: LanguageModel }>();
            const contentSteps = new Set<number>();
            let lastStep: number | undefined;
            let heldError: StreamPart | undefined;
            // A `prepareStep` model outranks a handoff target's (the loop saves
            // the active target in each checkpoint), which outranks the root
            // model; the call goes to that model's routed candidate.
            const prepareStep: CommonCallOptions['prepareStep'] = router
              ? async (context) => {
                  const prepared = common.prepareStep
                    ? await common.prepareStep(context)
                    : undefined;
                  const transfer = envelope.checkpoints[envelope.runId]?.handoff;
                  const target = transfer ? targetModel(transfer.to) : undefined;
                  const intended = prepared?.model ?? target ?? common.model;
                  const routed = router!.route(intended) ?? intended;
                  routes.set(context.stepIndex, { intended, called: routed });
                  return routed === intended ? prepared : { ...prepared, model: routed };
                }
              : common.prepareStep;
            const inner = runStreamToolLoop(
              {
                ...common,
                // The root model's routed candidate (2.3) also drives what the
                // loop calls on its own, such as compaction summaries.
                ...(router ? { model: router.route(common.model) ?? common.model } : {}),
                ...(legCheckpoint ? {} : { messages: legInput }),
                maxSteps: maxSteps - before,
                stopWhen,
                guardrails: { ...options.guardrails, onOutput: undefined },
                session: { store: checkpointStore, runId: envelope.runId, durability: 'strict' },
                ...(transcriptChat ? { chat: transcriptChat } : {}),
                ...(prepareStep ? { prepareStep } : {}),
                approvalResponses: resume
                  ? (options.approvalResponses ?? [])
                  : options.approvalResponses,
              },
              {
                ...(legCheckpoint
                  ? {
                      resumeFrom: durableResumeOf(legCheckpoint),
                      resumeHandoff: legCheckpoint.handoff,
                    }
                  : {}),
                onSnapshot: (value) => {
                  snapshot = value;
                },
                onCheckpoint: (value) => {
                  // A drain's stop (2.3) is no outcome of the loop, which goes on
                  // on resume: recorded as the step boundary it is.
                  const drain = drainStopped && value.stoppedBy === DRAINED;
                  envelope.loopOutcome = {
                    finishReason: value.finishReason,
                    endReason: drain ? 'natural' : value.endReason,
                    stoppedBy: drain ? undefined : value.stoppedBy,
                    ...(value.stopDetails ? { stopDetails: value.stopDetails } : {}),
                  };
                  envelope.pendingClientCalls = value.pendingClientCalls;
                },
                ...(nativeMcp
                  ? { mcp: { runtime: nativeMcp.runtime, refreshed: recordCatalog } }
                  : {}),
                warnings: runWarnings,
                // A pending call whose receipt records its outcome ran (2.3): the
                // resume settle answers it from the receipt, never gating it again.
                recorded: (call) => {
                  const receipt = receipts.load(call.toolCallId);
                  return receipt !== undefined && OUTCOME_STAGES.has(receipt.stage);
                },
                // What the resume settle answered (2.3) is saved before the leg's
                // first model call, at the same step: a denial or a client result
                // survives a failure of that call, and the turn is never settled
                // again. A stored turn left open is therefore always one of the
                // run's current model step, where its receipts are found.
                settled: async ({ messages, usage, handoff }) => {
                  envelope.usage = usage;
                  envelope.pendingClientCalls = [];
                  await saveInFlight(messages, handoff);
                },
                // Client calls answered from a supplied or recorded result (2.3).
                ...(settleTools ? { settleTools } : {}),
              },
            );
            for await (const part of inner.fullStream) {
              if (part.type === 'step-start') {
                envelope.modelSteps++;
                lastStep = part.stepIndex;
              }
              if (part.type === 'step-finish')
                envelope.usage = sumUsage(envelope.usage, part.usage);
              if (
                lastStep !== undefined &&
                (part.type === 'text-delta' ||
                  part.type === 'reasoning-delta' ||
                  part.type === 'tool-call-delta' ||
                  part.type === 'tool-call')
              )
                contentSteps.add(lastStep);
              // Held back while a fail-over may still answer it (2.3).
              if (part.type === 'error' && router) {
                heldError = part;
                continue;
              }
              emitPart(part, 'running');
            }
            await inner.consume?.();
            if (!snapshot) throw new Error('Canonical loop did not produce a terminal snapshot.');
            loop = snapshot as StreamToolLoopSnapshot;
            envelope.messages = loop.messages;
            envelope.usage = loop.cumulativeUsage;
            common.messages = loop.messages;
            currentText = lastAssistantText(loop.messages);
            if (loop.error === undefined) break;
            // The failed step is the last one the loop started; a failure
            // before its model call (no route yet) never fails over.
            const route = lastStep === undefined ? undefined : routes.get(lastStep);
            if (
              route &&
              !contentSteps.has(lastStep!) &&
              failOver(route.called, route.intended, loop.error, 'running')
            ) {
              await persist();
              // A drain (2.3) waits for the step boundary: the retried call is
              // part of the step in flight.
              if (!(await checkLimit())) return;
              continue;
            }
            if (heldError) emitPart(heldError, 'running');
            callFailure = { error: loop.error, brokeOff: brokeOff(legRequests) };
            throw loop.error;
          }
          // A drain (2.3) stopped the loop at a step boundary, which its last
          // checkpoint holds: the run stops there, unended.
          if (drainStopped) {
            drained();
            return;
          }
          if (loop.pendingApprovals.length || loop.pendingClientCalls.length) {
            envelope.pendingClientCalls = loop.pendingClientCalls;
            await finish({
              ...base(),
              status: 'suspended',
              pendingApprovals: loop.pendingApprovals,
              pendingClientCalls: loop.pendingClientCalls,
            });
            return;
          }
          // A refused or cut-off final turn (2.3, F16) stops here: it is never
          // reported completed, and verification never re-drives it.
          if (loop.stoppedBy || loop.endReason !== 'natural' || loop.finishReason !== 'stop') {
            await stopped(
              loop.stoppedBy ??
                (loop.endReason !== 'natural' ? loop.endReason : stopReasonOf(loop.finishReason)),
              loop.stopDetails,
            );
            return;
          }
          if (!options.output) envelope.candidateText = currentText = finalTurnText(loop.messages);
          loopWire = loop.wire;
          loopHandoff = loop.handoff;
        }
      } else if (envelope.phase === 'running') {
        const input = await evaluateInputGuardrails(common, envelope.messages);
        input.parts.forEach((part) => emitPart(part, 'running'));
        if (input.outcome === 'block') {
          await stopped('guardrail:input');
          return;
        }
        envelope.messages = input.messages;
        // A guardrail may have rewritten the history: the transcript keeps the raw input.
        if (envelope.transcript)
          envelope.transcript.synced = nativeChat!.syncPoint(envelope.messages);
      }

      envelope.phase = 'finalizing';
      events.push({ type: 'phase', phase: 'finalizing' });
      await persist();
      // A handoff (2.0) gives its target every following step, finalization
      // included (2.3): the target's model answers, with the target's tools on
      // a rebuilt wire. A leg that did not run the loop reads the transfer from
      // the run's checkpoint.
      const transfer = loopHandoff ?? envelope.checkpoints[envelope.runId]?.handoff;
      const finalAgent = transfer
        ? resumeHandoffState(
            transfer,
            common.tools,
            collectHandoffTools(common.tools),
            common.model,
            resolveDependencies(options.deps).logger,
          )
        : undefined;
      // The caller's `capabilities` override follows the target's model (2.3, F26).
      const finalModel = finalAgent
        ? withCapabilityOverride(finalAgent.model, common.capabilities)
        : common.model;
      // Finalization is one more turn of the same conversation (2.3, F15). It
      // keeps the loop's tools on the wire, with `tool_choice: 'none'`, so the
      // request prefix (prompt cache, preserved thinking) is the loop's own. A
      // leg that did not run the loop rebuilds the active agent's tool request.
      let finalizeTools: WireToolRequest | undefined | null = null;
      const finalizeToolRequest = async (): Promise<WireToolRequest | undefined> => {
        if (finalizeTools !== null) return finalizeTools;
        const wire =
          loopWire ??
          (!hasLoopTools
            ? undefined
            : // On a model that binds thinking to the prefix (2.3, F22) every
              // loop request carried the root agent's declared tools, and a
              // handoff rode the transcript as a tool-set change: so does this one.
              bindsThinkingToPrefix(finalModel)
              ? await rootStaticWire(common, nativeMcp?.runtime)
              : filterWireTools(
                  await buildWireTools(
                    mergeMcpTools(nativeMcp?.runtime, finalAgent?.tools ?? common.tools),
                    common.toolChoice,
                    common.maxToolConcurrency,
                  ),
                  common.activeTools,
                  resolveDependencies(options.deps).logger,
                ));
        finalizeTools = wire && wire.tools.length > 0 ? { ...wire, toolChoice: 'none' } : undefined;
        return finalizeTools;
      };
      /** The last final-answer call failed over (2.3): its retry is still that call. */
      let failedOver = false;
      for (;;) {
        if (envelope.candidateText === undefined) {
          if (!(await checkLimit())) return;
          if ((envelope.outputAttempts ?? 0) >= maxOutputAttempts) {
            await stopped('output-attempts-exhausted');
            return;
          }
          // A drain (2.3) stops the run before a final answer call, a repair
          // of one included; a call that failed over goes to the next model first.
          if (!failedOver && drainDue()) {
            drained();
            return;
          }
          failedOver = false;
          // The request must end with a user turn: one that ends with the
          // assistant's own answer is a prefill, which Claude 5.x models reject.
          // Appended once and persisted below, so a resumed attempt reuses it.
          if (envelope.messages.at(-1)?.role === 'assistant') {
            const prompt: Message = { role: 'user', content: FINALIZE_PROMPT };
            envelope.messages = [...envelope.messages, prompt];
            if (envelope.transcript)
              nativeChat!.appendTurn(envelope.transcript, prompt, envelope.messages, true);
          }
          const attempt = envelope.finalizationAttempts++;
          envelope.outputAttempts = (envelope.outputAttempts ?? 0) + 1;
          envelope.modelSteps++;
          // Persist the phase and reservation BEFORE dispatch. An interrupted
          // call consumes an attempt; resume never repeats completed tool work.
          await persist();
          const output = options.output;
          // A model that failed over (2.3) is not called again: the request,
          // its profile and the object strategy are the routed model's own.
          const callModel = router?.route(finalModel) ?? finalModel;
          const strategy = output
            ? pickObjectStrategy(
                { model: callModel, mode: output.mode, effort: common.effort },
                getCapabilities(callModel, undefined, common.capabilities),
              )
            : undefined;
          const toolRequest = await finalizeToolRequest();
          const spentBefore = common.execution!.ledger.totals(common.execution!.scopeId).spent.usd;
          const attemptRequests = ledgerRequests();
          const inner = runStream(
            {
              ...common,
              model: callModel,
              messages: envelope.messages,
              prompt: undefined,
              instructions: undefined,
              tools: undefined,
              toolChoice: undefined,
              session: undefined,
              mcp: undefined,
              // The requested mode, so a 'tool' the model cannot take is
              // reported like generateObject's (2.3, F26).
              ...(output?.mode !== undefined ? { mode: output.mode } : {}),
            },
            {
              ...(output && outputSchema
                ? {
                    object: {
                      schema: outputSchema,
                      name: output.name,
                      description: output.description,
                      strategy: strategy!,
                    },
                    operation: 'stream-object' as const,
                  }
                : {}),
              ...(toolRequest ? { tools: toolRequest } : {}),
              warnings: runWarnings,
            },
          );
          let buffer = '';
          // The answer turn keeps every reasoning block where it arrived (2.3, F21).
          const turn = createTurnContent();
          let toolId: string | undefined;
          let lastDraft: string | undefined;
          let elementCount = 0;
          let streamError: unknown;
          let heldError: StreamPart | undefined;
          let content = false;
          let finishMeta: Record<string, unknown> | undefined;
          const publishDraft = async (): Promise<void> => {
            if (!output) return;
            const draft = parsePartialJson(buffer);
            if (draft !== undefined) {
              const encoded = JSON.stringify(draft.value);
              if (encoded !== lastDraft) {
                lastDraft = encoded;
                const value = { attempt, value: draft.value };
                partial.push(value);
                events.push({ type: 'partial-output', ...value });
              }
            }
            if (output.element) {
              const complete = completedArrayElements(buffer);
              while (elementCount < complete.length) {
                const index = elementCount++;
                // Invalid elements are drafts too; they must never masquerade
                // as validated elements. Full output validation triggers repair.
                try {
                  const value = await validateAgentValue(
                    output.element as AgentValidation<Element>,
                    complete[index],
                  );
                  elements.push({ attempt, index, value });
                  events.push({ type: 'array-element', attempt, index, value });
                } catch {
                  /* rejected element stays absent from the validated stream */
                }
              }
            }
          };
          for await (const part of inner.fullStream) {
            if (part.type === 'error') {
              streamError = part.error;
              // Held back while a fail-over may still answer it (2.3).
              if (router) {
                heldError = part;
                continue;
              }
            }
            emitPart(part, 'finalizing');
            if (
              part.type === 'text-delta' ||
              part.type === 'reasoning-delta' ||
              part.type === 'tool-call-delta'
            )
              content = true;
            if (part.type === 'finish') finishMeta = part.providerMetadata;
            if (part.type === 'reasoning-delta') turn.reasoning(part);
            if (part.type === 'text-delta' && strategy !== 'tool') {
              turn.text(part);
              buffer += part.text;
              await publishDraft();
            }
            if (part.type === 'tool-call-delta' && strategy === 'tool') {
              toolId ??= part.id;
              if (part.id === toolId) {
                buffer += part.argsTextDelta;
                await publishDraft();
              }
            }
          }
          await inner.consume?.();
          // Token usage remains observable even when output validation fails.
          try {
            envelope.usage = sumUsage(envelope.usage, await inner.usage);
          } catch {
            /* transport error below */
          }
          if (streamError !== undefined) {
            if (!content && failOver(callModel, finalModel, streamError, 'finalizing')) {
              // The failed call does not use up a repair attempt; it stays counted
              // as a model step and a finalization attempt.
              envelope.outputAttempts = Math.max(0, (envelope.outputAttempts ?? 1) - 1);
              await persist();
              failedOver = true;
              continue;
            }
            if (heldError) emitPart(heldError, 'finalizing');
            callFailure = { error: streamError, brokeOff: brokeOff(attemptRequests) };
            throw streamError;
          }
          // A request that rides the loop's tools is a loop-style call, so the
          // per-request cost part is ours to emit: the run's cumulative cost,
          // exactly as the loop reports it after each step.
          if (toolRequest) {
            const totals = common.execution!.ledger.totals(common.execution!.scopeId);
            // Calls the provider has no price for add nothing to the cost (2.3),
            // and without a provider the cost is unknown: as in the loop.
            if (
              totals.unknownUsd === 0 ||
              (options.deps?.priceProvider !== undefined &&
                totals.unknownUsd === (totals.unpriced ?? 0))
            )
              emitPart(
                {
                  type: 'cost',
                  costUsd: totals.spent.usd,
                  deltaUsd: Math.max(0, Math.round((totals.spent.usd - spentBefore) * 1e6) / 1e6),
                  stepIndex: envelope.modelSteps - 1,
                },
                'finalizing',
              );
          }
          const reason = await inner.finishReason;
          if (reason !== 'stop' && !(strategy === 'tool' && reason === 'tool_calls')) {
            currentText = buffer;
            await stopped(stopReasonOf(reason), stopDetailsFrom(finishMeta));
            return;
          }
          envelope.candidateText = buffer;
          currentText = buffer;
          // The whole answer turn is kept: reasoning included, so the transcript
          // stays append-only. A forced `json_output` call (tool strategy) is
          // recorded as its JSON text, as before: a stored call would need an
          // answering tool result before the next request.
          const phase = (finishMeta?.openai as { phase?: string } | undefined)?.phase;
          const answer: Message =
            strategy === 'tool'
              ? { role: 'assistant', content: buffer }
              : turn.assemble(new Map(), []).assistantMessage;
          if (phase && strategy !== 'tool') answer.providerMetadata = { openai: { phase } };
          if (!isBlankTurn(answer)) {
            envelope.messages = [...envelope.messages, answer];
            if (envelope.transcript)
              nativeChat!.appendTurn(envelope.transcript, answer, envelope.messages);
          }
          await persist();
        }
        currentText = envelope.candidateText;
        let accepted: T;
        try {
          accepted = options.output
            ? await validateAgentValue(options.output, JSON.parse(currentText))
            : (currentText as T);
        } catch (error) {
          if ((envelope.outputAttempts ?? 0) >= maxOutputAttempts) {
            await stopped('invalid-output');
            return;
          }
          const repair: Message = {
            role: 'user',
            content: `The final output failed validation: ${errorData(error).message}. Return a corrected final output.`,
          };
          envelope.messages.push(repair);
          if (envelope.transcript)
            nativeChat!.appendTurn(envelope.transcript, repair, envelope.messages, true);
          delete envelope.candidateText;
          await persist();
          continue;
        }
        const guarded = await evaluateOutputGuardrails(common, {
          text: currentText,
          messages: envelope.messages,
          stepIndex: envelope.modelSteps - 1,
        });
        guarded.parts.forEach((part) => emitPart(part, 'finalizing'));
        const finalText = guarded.outcome === 'block' ? (guarded.replacement ?? '') : guarded.text;
        const wasRewritten = finalText !== currentText;
        if (wasRewritten) {
          currentText = finalText;
          // The answer turn keeps its reasoning; only its text is replaced.
          const last = envelope.messages.at(-1);
          if (last?.role === 'assistant') {
            const rewritten = rewriteAssistantText(last, currentText);
            envelope.messages = isBlankTurn(rewritten)
              ? envelope.messages.slice(0, -1)
              : [...envelope.messages.slice(0, -1), rewritten];
            if (envelope.transcript)
              nativeChat!.replaceLastTurn(
                envelope.transcript,
                isBlankTurn(rewritten) ? undefined : rewritten,
                envelope.messages,
              );
          } else if (currentText) {
            const answer: Message = { role: 'assistant', content: currentText };
            envelope.messages = [...envelope.messages, answer];
            if (envelope.transcript)
              nativeChat!.appendTurn(envelope.transcript, answer, envelope.messages);
          }
          envelope.candidateText = currentText;
        }
        if (guarded.outcome === 'block') {
          await stopped('guardrail:output');
          return;
        }
        // Rewrites must pass the schema again and the verifier sees the exact
        // candidate that can become the completed output.
        if (wasRewritten)
          accepted = options.output
            ? await validateAgentValue(options.output, JSON.parse(currentText))
            : (currentText as T);
        // Validation and guardrails are async caller code: a run cancelled while
        // they ran must not reach the verifier or the terminal commit.
        if (!(await checkCancellation())) return;
        if (options.verify) {
          if (envelope.verificationAttempts >= maxVerifyAttempts) {
            await stopped('verification-attempts-exhausted');
            return;
          }
          const attempt = envelope.verificationAttempts++;
          await persist();
          let verdict;
          try {
            verdict = await options.verify({
              output: accepted,
              text: currentText,
              messages: [...envelope.messages],
              usage: { ...envelope.usage },
              attempt,
              execution: common.execution!,
              signal: lease?.signal ?? options.signal,
            });
          } catch {
            // A verifier that threw because the run was cancelled reports the
            // cancellation, not an inconclusive verdict.
            if (!(await checkCancellation())) return;
            envelope.verification = 'inconclusive';
            await stopped('verification-inconclusive');
            return;
          }
          if (!verdict || !['verified', 'rejected', 'inconclusive'].includes(verdict.status))
            throw new TypeError('Verifier must return verified, rejected, or inconclusive.');
          envelope.verification = verdict.status;
          // The verdict is recorded, but a cancellation or deadline that arrived
          // while the verifier ran outranks it: nothing is committed as completed.
          if (!(await checkCancellation())) return;
          if (verdict.status === 'inconclusive') {
            await stopped('verification-inconclusive');
            return;
          }
          if (verdict.status === 'rejected') {
            if (envelope.verificationAttempts >= maxVerifyAttempts) {
              await stopped('verification-attempts-exhausted');
              return;
            }
            const feedback: Message = {
              role: 'user',
              content:
                verdict.feedback ?? 'The output was rejected. Produce a corrected final answer.',
            };
            envelope.messages.push(feedback);
            if (envelope.transcript)
              nativeChat!.appendTurn(envelope.transcript, feedback, envelope.messages, true);
            delete envelope.candidateText;
            // Repair budget applies to each verifier candidate, while modelSteps
            // and verificationAttempts remain cumulative and strictly bounded.
            envelope.outputAttempts = 0;
            await persist();
            continue;
          }
        }
        // The extraction is recorded as pending in the terminal commit itself
        // (2.3): nothing is written to memory before the outcome is durable, and
        // its own outcome follows in a later save.
        if (options.memory && envelope.memory && nativeMemory!.extracts(options.memory)) {
          envelope.memory.extraction = {
            operationId: resolveDependencies(options.deps).generateId(),
            status: 'pending',
            infer: nativeMemory!.infers(options.memory),
          };
          extractNow = true;
        }
        await finish({ ...base(), status: 'completed', output: accepted });
        return;
      }
    } catch (error) {
      const failed: AgentResult<T> = {
        ...base(),
        status: 'failed',
        // A lost lease (2.3) is the reason, however the loss surfaced.
        error: errorData(lease ? lease.failure(error) : error),
      };
      // A failed durable commit must never publish a successful completion.
      // Keep the last persisted recovery point rather than overwriting it.
      if (!persistFailed && common && admitted) {
        // A transient cause (2.3) is recorded with the failure, additively, so
        // `retryFailed` may go on from the run's last checkpoint.
        const cause = transientCause(error);
        if (cause)
          envelope.retry = {
            cause,
            phase: envelope.phase === 'finalizing' ? 'finalizing' : 'running',
          };
        try {
          await finish(failed);
        } catch {
          settledOutcome = failed;
        }
      } else {
        settledOutcome = failed;
      }
    } finally {
      // Chat projection and extraction (2.3), after the outcome and never in
      // place of it: a failed durable commit publishes neither.
      if (settledOutcome && (admitted || repairable) && !persistFailed) await settleRecords();
      releaseMemoryScope?.();
      await nativeMcp?.close();
      removeLedgerPersistence?.();
      // The lease goes back before the in-process claim, so the next executor
      // of this run in this process finds it free.
      await lease?.release(terminalSaved);
      releaseRun?.();
      if (settledOutcome) {
        events.push({ type: 'result', result: settledOutcome });
        result.resolve(settledOutcome);
      }
      events.close();
      text.close();
      partial.close();
      elements.close();
    }
  }

  function start(): void {
    if (started) return;
    started = true;
    void pump();
  }
  function stream<V>(broadcaster: ReturnType<typeof createBroadcaster<V>>): AsyncIterable<V> {
    return {
      [Symbol.asyncIterator]() {
        const branch = broadcaster.subscribe();
        start();
        return branch;
      },
    };
  }
  return {
    events: stream(events),
    textStream: stream(text),
    partialOutputStream: stream(partial),
    elementStream: stream(elements),
    get result() {
      start();
      return result.promise;
    },
    consume() {
      start();
      return result.promise;
    },
  };
}
