import type {
  AgentEvent,
  AgentResult,
  AgentRunEnvelope,
  AgentRunOptions,
  AgentRunSession,
  AgentRunStore,
  AgentStream,
  AgentTool,
  AgentValidation,
} from './types/agent-run';
import type { CommonCallOptions } from './types/config';
import type { CallWarning, StopDetails } from './types/methods';
import type { Message } from './types/message';
import type { WireToolRequest } from './adapters/types';
import type { SessionStore } from './types/session';
import type { StreamPart } from './types/stream';
import type { ExecutionContextSnapshot, NativeExecutionContext } from './types/execution';
import { createBroadcaster, createDeferred } from './internal/async-iter';
import { resolveDependencies } from './internal/resolve-deps';
import { createWarningSink } from './internal/warnings';
import { parsePartialJson } from './internal/partial-json';
import { foldCallInput } from './generate';
import { inputShapeError } from './core/normalize';
import { EMPTY_USAGE } from './core/metering';
import { getCapabilities } from './core/registry';
import { runStream } from './core/inference';
import { runStreamToolLoop, type StreamToolLoopSnapshot } from './inference/stream-tool-loop';
import { assembleAssistant, stopDetailsFrom, type EncryptedReasoning } from './inference/run-step';
import {
  buildWireTools,
  evaluateInputGuardrails,
  evaluateOutputGuardrails,
  filterWireTools,
  mergeMcpTools,
  rewriteAssistantText,
  sumUsage,
} from './inference/loop-shared';
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
import type { NativeMcp } from './inference/native-mcp';
import {
  assertExecutionPolicy,
  createExecutionContext,
  intersectExecutionPolicies,
} from './execution-policy';
import { intersectBudgetLimits, subtreeLedgerSnapshot } from './budget-ledger';
import { toJSONSchema } from './schema/bridge';
import { assertEnvelopeRevision } from './internal/ops-validate';
import { assertCheckpointVersion } from './internal/checkpoint-version';

export type * from './types/agent-run';

// This coordinates one JavaScript process. External stores still need an
// application lease when multiple processes or distinct store wrappers share it.
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

/** Store for tests and single-process applications; durable applications supply their own store. */
export function createInMemoryAgentRunStore(): AgentRunStore {
  const runs = new Map<string, AgentRunEnvelope>();
  return {
    load: (runId) => {
      const value = runs.get(runId);
      return value ? structuredClone(value) : undefined;
    },
    save: (envelope) => {
      assertEnvelopeRevision(runs.get(envelope.runId), envelope);
      runs.set(envelope.runId, structuredClone(envelope));
    },
  };
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
  let settledOutcome: AgentResult<T> | undefined;
  let writeTail: Promise<void> = Promise.resolve();
  /** The run's MCP servers (2.3, F01), closed on every exit. */
  let nativeMcp: NativeMcp | undefined;

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
    // Every actual save advances the fence durable stores check (2.2).
    envelope.revision = (envelope.revision ?? 0) + 1;
    const snapshot = structuredClone(envelope);
    const write = writeTail.then(() => options.session!.store.save(snapshot));
    writeTail = write.catch((error) => {
      persistFailed = true;
      throw error;
    });
    writeTail.catch(() => {});
    return writeTail;
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
    settledOutcome = outcome;
  }
  const stopped = (reason: string, stopDetails?: StopDetails) =>
    finish({ ...base(), status: 'stopped', reason, ...(stopDetails ? { stopDetails } : {}) });
  function emitPart(part: StreamPart, phase: 'running' | 'finalizing'): void {
    events.push({ type: 'part', part, phase });
    if (part.type === 'text-delta') text.push(part.text);
  }

  async function pump(): Promise<void> {
    try {
      envelope.runId ||= resolveDependencies(options.deps).generateId();
      let maxSteps = positiveInteger(options.maxSteps ?? 20, 'maxSteps');
      let maxOutputAttempts = positiveInteger(options.maxOutputAttempts ?? 2, 'maxOutputAttempts');
      let maxVerifyAttempts = positiveInteger(options.maxVerifyAttempts ?? 3, 'maxVerifyAttempts');
      if (options.session && (!options.session.runId || !options.session.scope)) {
        throw new TypeError('Native sessions require non-empty runId and scope.');
      }
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
      const unsupported = options as AgentRunOptions<T> &
        Pick<CommonCallOptions, 'chat' | 'memory' | 'fallbackModels'>;
      if (
        unsupported.chat !== undefined ||
        unsupported.memory !== undefined ||
        (unsupported.fallbackModels?.length ?? 0) > 0
      ) {
        throw new TypeError(
          'Native runs do not yet support chat, memory, or fallbackModels; use the legacy APIs for these options.',
        );
      }
      if (resume) {
        if (!options.session) throw new TypeError('resumeAgent requires a native session.');
        const saved = await options.session.store.load(options.session.runId);
        if (!saved) throw new TypeError(`Unknown native run: ${options.session.runId}`);
        if (
          saved.kind !== 'deuz-agent-run' ||
          saved.version !== 1 ||
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
      } else if (options.session && (await options.session.store.load(options.session.runId))) {
        throw new TypeError('Native run already exists; use resumeAgent.');
      }
      if (!resume) {
        const invalid = inputShapeError(options, 'runAgent');
        if (invalid) throw invalid;
      }
      common = foldCallInput(
        {
          ...options,
          tools: undefined,
          session: undefined,
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
      }
      if (!resume) envelope.messages = [...common.messages];
      common.messages = envelope.messages;
      // Validate ALL schema/context configuration before the first paid call.
      const outputSchema = options.output ? await agentJSONSchema(options.output) : undefined;
      if (options.output?.element)
        assertAgentValidation(options.output.element, 'Agent array element');
      const nativeTools = { ...options.tools };
      const savedClients =
        envelope.pendingClientCalls ??
        (envelope.result?.status === 'suspended' ? envelope.result.pendingClientCalls : []);
      // Client results enter the same approval/validation/projection executor as
      // server results. They are never appended as already-approved history.
      const clientValues = new Map(
        (options.clientToolResults ?? []).map((item) => [item.toolCallId, item]),
      );
      const clientNames = new Set(
        savedClients
          .filter((call) => clientValues.has(call.toolCallId))
          .map((call) => call.toolName),
      );
      for (const name of clientNames) {
        const original = nativeTools[name];
        if (!original || original.execute) continue;
        nativeTools[name] = {
          ...original,
          execute: (_args, ctx) => {
            const provided = clientValues.get(ctx.toolCallId);
            if (!provided) throw new TypeError('No result supplied for this client call.');
            clientValues.delete(ctx.toolCallId);
            if (
              !savedClients.some(
                (call) => call.toolName === name && clientValues.has(call.toolCallId),
              )
            ) {
              // Later calls of this tool must suspend again as client-side calls.
              if (common.tools?.[name]) common.tools[name]!.execute = undefined;
            }
            if (provided.isError) throw new Error(String(provided.output));
            return provided.output;
          },
        };
      }
      const onToolOutput = (output: NativeToolOutput): void => {
        events.push({ type: 'tool-output', ...output });
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
          envelope.messages = [...ctx.messages];
          // Persist the in-flight tool-call history as well as its receipt so
          // canonical resume can settle that exact ID without another model call.
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
            ...(previous?.handoff ? { handoff: previous.handoff } : {}),
          };
          await persist();
        },
      };
      common.tools = await prepareAgentTools(
        nativeTools,
        options.toolsContext,
        onToolOutput,
        receipts,
      );
      const binding: NonNullable<AgentRunEnvelope['binding']> = {
        model: `${common.model.provider}/${common.model.surface}/${common.model.modelId}`,
        tools: JSON.stringify(
          await Promise.all(
            Object.entries(common.tools).map(async ([name, tool]) => [
              name,
              tool.description,
              await toJSONSchema(tool.parameters),
              tool.outputSchema,
              options.tools?.[name]?.contextSchema
                ? await toJSONSchema(options.tools[name]!.contextSchema!)
                : undefined,
            ]),
          ),
        ),
        output: JSON.stringify(outputSchema ?? null),
        ...(options.bindingId !== undefined ? { revision: options.bindingId } : {}),
      };
      // The MCP catalog (2.3) is compared below, once the servers are reached.
      const recordedCatalog = envelope.binding?.mcp;
      if (envelope.binding) {
        const { mcp: _catalog, ...recorded } = envelope.binding;
        if (JSON.stringify(binding) !== JSON.stringify(recorded))
          throw new TypeError('Native agent binding changed across resume.');
      }
      if (envelope.phase === 'terminal') {
        if (!envelope.result || envelope.result.status === 'suspended')
          throw new TypeError('Invalid native terminal checkpoint.');
        const terminal = envelope.result as AgentResult<T>;
        settledOutcome = terminal;
        return;
      }
      // MCP (2.3, F01): connected only now, after a terminal run has returned
      // and before anything is persisted, so an unreachable server fails a fresh
      // run cleanly and a resume checks the servers' catalog before it writes. The
      // tools pass through the same receipts as local tools.
      if ((options.mcp?.length ?? 0) > 0 || recordedCatalog !== undefined) {
        const native = await import('./inference/native-mcp');
        if (options.mcp?.length) {
          nativeMcp = await native.resolveNativeMcp(
            options.mcp,
            resolveDependencies(options.deps),
            (tools, replayOf) => prepareMcpTools(tools, replayOf, onToolOutput, receipts),
          );
          binding.mcp = await nativeMcp.catalog();
        }
        const drift = native.catalogDrift(recordedCatalog, binding.mcp);
        // Rejected like a changed local tool set; the stored run stays intact.
        if (drift) throw new TypeError(`MCP tool catalog changed across resume (${drift}).`);
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
      if (
        resume &&
        pendingCheckpoint?.status === 'suspended' &&
        (pendingApprovals.some(
          (request) =>
            !options.approvalResponses?.some(
              (response) => response.approvalId === request.approvalId,
            ),
        ) ||
          pendingClients.some((call) => !clientIds.has(call.toolCallId)))
      ) {
        const outcome: AgentResult<T> = {
          ...base(),
          status: 'suspended',
          pendingApprovals,
          pendingClientCalls: pendingClients,
        };
        settledOutcome = outcome;
        return;
      }
      // A local tool shadows an MCP tool of the same name, as in the loop's merge.
      const replayOf = (name: string): AgentTool['replay'] =>
        options.tools && Object.hasOwn(options.tools, name)
          ? options.tools[name]!.replay
          : nativeMcp?.replayOf(name);
      const unreconciled = Object.values(envelope.toolResults ?? {}).filter(
        (receipt) =>
          receipt.stage === 'executing' &&
          replayOf(receipt.toolName) !== 'idempotent' &&
          !options.retryToolCallIds?.includes(receipt.toolCallId),
      );
      if (resume && unreconciled.length) {
        // This is a recoverable interruption, so do not replace the checkpoint
        // with a terminal record that would prevent an explicit reconciliation.
        const outcome: AgentResult<T> = {
          ...base(),
          status: 'stopped',
          reason: 'tool-reconciliation-required',
        };
        settledOutcome = outcome;
        return;
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
      if (clientResults.length) envelope.pendingClientCalls = [];
      delete envelope.result;
      await persist();

      const checkpointStore: SessionStore = {
        load: (runId) => envelope.checkpoints[runId],
        save: async (checkpoint) => {
          envelope.checkpoints[checkpoint.runId] = structuredClone(checkpoint);
          if (checkpoint.runId === envelope.runId) {
            envelope.messages = checkpoint.messages;
            envelope.usage = checkpoint.usage;
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
        if (options.signal?.aborted) {
          await stopped('aborted');
          return false;
        }
        if (common.execution)
          assertExecutionPolicy(common.execution, {
            now: resolveDependencies(options.deps).clock.now(),
          });
        return true;
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

      // A hot refresh mid-run (2.3, F01) opens a new binding revision: the new
      // catalog is recorded, durably, before the model is offered it, so a later
      // resume compares against the catalog the run actually used. The change is
      // reported as a warning; its tools carry receipts like every other.
      const recordCatalog = async (): Promise<CallWarning[]> => {
        const catalog = await nativeMcp!.catalog();
        const { catalogDrift } = await import('./inference/native-mcp');
        const drift = catalogDrift(envelope.binding?.mcp, catalog);
        if (!drift) return [];
        envelope.binding = { ...envelope.binding!, mcp: catalog };
        await persist();
        return [
          {
            type: 'other',
            setting: 'mcp',
            message: `MCP tool catalog changed mid-run (${drift}); the run's resume binding now records the new catalog.`,
          },
        ];
      };

      // Structured-only runs go straight to finalization. Runs with tools/MCP
      // traverse the canonical loop first; no tool executor exists here.
      const hasLoopTools = Object.keys(common.tools).length > 0 || (options.mcp?.length ?? 0) > 0;
      /** The tool request of the loop's last model call, when this leg ran the loop. */
      let loopWire: WireToolRequest | undefined;
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
          events.push({ type: 'phase', phase: 'running' });
          let snapshot: StreamToolLoopSnapshot | undefined;
          const before = envelope.modelSteps;
          const inner = runStreamToolLoop(
            {
              ...common,
              maxSteps: maxSteps - before,
              guardrails: { ...options.guardrails, onOutput: undefined },
              session: { store: checkpointStore, runId: envelope.runId, durability: 'strict' },
              approvalResponses: resume
                ? (options.approvalResponses ?? [])
                : options.approvalResponses,
            },
            {
              ...(resume && checkpoint
                ? {
                    resumeFrom: { stepIndex: checkpoint.stepIndex, usage: checkpoint.usage },
                    resumeHandoff: checkpoint.handoff,
                  }
                : {}),
              onSnapshot: (value) => {
                snapshot = value;
              },
              onCheckpoint: (value) => {
                envelope.loopOutcome = {
                  finishReason: value.finishReason,
                  endReason: value.endReason,
                  stoppedBy: value.stoppedBy,
                  ...(value.stopDetails ? { stopDetails: value.stopDetails } : {}),
                };
                envelope.pendingClientCalls = value.pendingClientCalls;
              },
              ...(nativeMcp
                ? { mcp: { runtime: nativeMcp.runtime, refreshed: recordCatalog } }
                : {}),
            },
          );
          for await (const part of inner.fullStream) {
            if (part.type === 'step-start') envelope.modelSteps++;
            if (part.type === 'step-finish') envelope.usage = sumUsage(envelope.usage, part.usage);
            emitPart(part, 'running');
          }
          await inner.consume?.();
          if (!snapshot) throw new Error('Canonical loop did not produce a terminal snapshot.');
          const loop = snapshot as StreamToolLoopSnapshot;
          envelope.messages = loop.messages;
          envelope.usage = loop.cumulativeUsage;
          common.messages = loop.messages;
          currentText = lastAssistantText(loop.messages);
          if (loop.error !== undefined) throw loop.error;
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
        }
      } else if (envelope.phase === 'running') {
        const input = await evaluateInputGuardrails(common, envelope.messages);
        input.parts.forEach((part) => emitPart(part, 'running'));
        if (input.outcome === 'block') {
          await stopped('guardrail:input');
          return;
        }
        envelope.messages = input.messages;
      }

      envelope.phase = 'finalizing';
      events.push({ type: 'phase', phase: 'finalizing' });
      await persist();
      // Finalization is one more turn of the same conversation (2.3, F15). It
      // keeps the loop's tools on the wire, with `tool_choice: 'none'`, so the
      // request prefix (prompt cache, preserved thinking) is the loop's own. A
      // leg that did not run the loop rebuilds the run's static tool request.
      let finalizeTools: WireToolRequest | undefined | null = null;
      const finalizeToolRequest = async (): Promise<WireToolRequest | undefined> => {
        if (finalizeTools !== null) return finalizeTools;
        const wire =
          loopWire ??
          (hasLoopTools
            ? filterWireTools(
                await buildWireTools(
                  mergeMcpTools(nativeMcp?.runtime, common.tools),
                  common.toolChoice,
                  common.maxToolConcurrency,
                ),
                common.activeTools,
                resolveDependencies(options.deps).logger,
              )
            : undefined);
        finalizeTools = wire && wire.tools.length > 0 ? { ...wire, toolChoice: 'none' } : undefined;
        return finalizeTools;
      };
      // One sink for every finalization attempt, so a re-drive does not repeat
      // a warning its first attempt already reported.
      const finalizeWarnings = createWarningSink(resolveDependencies(options.deps).logger);
      for (;;) {
        if (envelope.candidateText === undefined) {
          if (!(await checkLimit())) return;
          if ((envelope.outputAttempts ?? 0) >= maxOutputAttempts) {
            await stopped('output-attempts-exhausted');
            return;
          }
          // The request must end with a user turn: one that ends with the
          // assistant's own answer is a prefill, which Claude 5.x models reject.
          // Appended once and persisted below, so a resumed attempt reuses it.
          if (envelope.messages.at(-1)?.role === 'assistant')
            envelope.messages = [...envelope.messages, { role: 'user', content: FINALIZE_PROMPT }];
          const attempt = envelope.finalizationAttempts++;
          envelope.outputAttempts = (envelope.outputAttempts ?? 0) + 1;
          envelope.modelSteps++;
          // Persist the phase and reservation BEFORE dispatch. An interrupted
          // call consumes an attempt; resume never repeats completed tool work.
          await persist();
          const output = options.output;
          const strategy = output
            ? pickObjectStrategy(
                { model: common.model, mode: output.mode, effort: common.effort },
                getCapabilities(common.model, undefined, common.capabilities),
              )
            : undefined;
          const toolRequest = await finalizeToolRequest();
          const spentBefore = common.execution!.ledger.totals(common.execution!.scopeId).spent.usd;
          const inner = runStream(
            {
              ...common,
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
              warnings: finalizeWarnings,
            },
          );
          let buffer = '';
          let reasoningText = '';
          let reasoningSignature: string | undefined;
          const encryptedReasoning: EncryptedReasoning = [];
          let toolId: string | undefined;
          let lastDraft: string | undefined;
          let elementCount = 0;
          let streamError: unknown;
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
            emitPart(part, 'finalizing');
            if (part.type === 'error') streamError = part.error;
            if (part.type === 'finish') finishMeta = part.providerMetadata;
            if (part.type === 'reasoning-delta') {
              if (part.encrypted)
                encryptedReasoning.push({ text: part.text, signature: part.signature });
              else {
                reasoningText += part.text;
                if (part.signature) reasoningSignature = part.signature;
              }
            }
            if (part.type === 'text-delta' && strategy !== 'tool') {
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
          if (streamError !== undefined) throw streamError;
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
              : assembleAssistant(
                  buffer,
                  reasoningText,
                  reasoningSignature,
                  new Map(),
                  [],
                  encryptedReasoning,
                ).assistantMessage;
          if (phase && strategy !== 'tool') answer.providerMetadata = { openai: { phase } };
          if (!isBlankTurn(answer)) envelope.messages = [...envelope.messages, answer];
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
          envelope.messages.push({
            role: 'user',
            content: `The final output failed validation: ${errorData(error).message}. Return a corrected final output.`,
          });
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
          } else if (currentText) {
            envelope.messages = [...envelope.messages, { role: 'assistant', content: currentText }];
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
              signal: options.signal,
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
            envelope.messages.push({
              role: 'user',
              content:
                verdict.feedback ?? 'The output was rejected. Produce a corrected final answer.',
            });
            delete envelope.candidateText;
            // Repair budget applies to each verifier candidate, while modelSteps
            // and verificationAttempts remain cumulative and strictly bounded.
            envelope.outputAttempts = 0;
            await persist();
            continue;
          }
        }
        await finish({ ...base(), status: 'completed', output: accepted });
        return;
      }
    } catch (error) {
      const failed: AgentResult<T> = { ...base(), status: 'failed', error: errorData(error) };
      // A failed durable commit must never publish a successful completion.
      // Keep the last persisted recovery point rather than overwriting it.
      if (!persistFailed && common && admitted) {
        try {
          await finish(failed);
        } catch {
          settledOutcome = failed;
        }
      } else {
        settledOutcome = failed;
      }
    } finally {
      await nativeMcp?.close();
      removeLedgerPersistence?.();
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
