/**
 * Native run memory (2.3, 23.4). The legacy loops recall on every call and
 * extract fire-and-forget; a native run is checkpointed, so both are bound to
 * its record instead:
 * - the recall runs ONCE, before the run's first model call, and enters the
 *   canonical history as an appended `role: 'system'` message (the shape the
 *   legacy loops use for preserved thinking, `providerMetadata.deuz.memoryRecall`);
 *   a resume replays it and never recalls again;
 * - extraction runs only for a completed run, under an operation id the
 *   checkpoint records as pending before anything is written, and every record
 *   it writes carries that id, so an interrupted pass can be told apart from
 *   one that never started (`reconcileAgentRun`);
 * - the pass saves how many mutations it planned before its first memory
 *   write (2.4, H5), so an interrupted pass that wrote only part of them is
 *   told apart from one that finished.
 * Loaded on demand: a run without `memory` never pulls this module or the
 * memory pipeline in.
 */
import type { Message } from '../types/message';
import type { BudgetLedger, NativeExecutionContext } from '../types/execution';
import type { Clock, Logger } from '../types/deps';
import type { MemoryCallOptions, MemoryMutation, MemoryScope } from '../memory';
import type { CallWarning } from '../types/methods';
import type {
  AgentRunMemoryExtraction,
  AgentRunRecall,
  AgentRunTranscript,
} from '../types/agent-run';
import { assertScope } from '../memory';
import { scopeKey, scopeWithin } from './native-scope';
import { isRecallMessage, recallMessage } from './stable-prefix';

/** Option shape checks that must fail a run before anything is read or written. */
export function assertMemoryOptions(memory: MemoryCallOptions): void {
  if (!memory || typeof memory !== 'object' || !memory.seams || !memory.scope)
    throw new TypeError('Native memory requires seams and a scope.');
  assertScope(memory.scope);
}

/**
 * The memory scope of each native run that is running now, per shared ledger
 * and execution scope id. A child context's scope id extends its parent's
 * (`<parent>/<child>`), so the nearest registered prefix is the closest
 * ancestor run that has memory. Runs that share one context (a tool that hands
 * its own `ctx.execution` to a nested run) each hold their own claim under the
 * same id, innermost last.
 */
const runningScopes = new WeakMap<BudgetLedger, Map<string, { scope: MemoryScope }[]>>();

/**
 * Register a run's memory scope for its execution, after checking it against
 * the closest run that has one: the latest run on the same execution context,
 * else the closest ancestor. A run may narrow that scope (pin more fields),
 * never widen it or step into another user, agent or chat. Returns the
 * release, called when the run's executor ends; it drops only this run's
 * claim.
 */
export function claimMemoryScope(
  execution: NativeExecutionContext,
  scope: MemoryScope | undefined,
): () => void {
  const running = runningScopes.get(execution.ledger);
  if (scope && running) {
    let parent: { scope: MemoryScope } | undefined;
    let depth = -1;
    for (const [id, claims] of running) {
      if (
        (id === execution.scopeId || execution.scopeId.startsWith(`${id}/`)) &&
        id.length > depth
      ) {
        parent = claims.at(-1);
        depth = id.length;
      }
    }
    if (parent && !scopeWithin(scope, parent.scope))
      throw new TypeError(
        `This run's memory scope ${scopeKey(scope)} widens its parent run's ${scopeKey(parent.scope)}; a child may only narrow it.`,
      );
  }
  if (!scope) return () => {};
  const map = running ?? new Map<string, { scope: MemoryScope }[]>();
  if (!running) runningScopes.set(execution.ledger, map);
  const claims = map.get(execution.scopeId) ?? [];
  map.set(execution.scopeId, claims);
  // A fresh token per run: equal scopes of two runs are still two claims.
  const claim = { scope };
  claims.push(claim);
  return () => {
    const index = claims.indexOf(claim);
    if (index >= 0) claims.splice(index, 1);
    if (claims.length === 0 && map.get(execution.scopeId) === claims) map.delete(execution.scopeId);
  };
}

/**
 * Where a native run's memory calls report (2.4): their warnings
 * (`embedding-mismatch`, `unaccounted-usage`) go to the run's warnings, and
 * the memory LLM and embedder are charged to the run's execution context.
 */
export interface NativeMemoryCalls {
  onWarning?: (warning: CallWarning) => void;
  execution?: NativeExecutionContext;
}

/**
 * The seams a native run's memory calls use: the host's, charged to the
 * run's execution context (2.4) unless the host set one itself.
 */
function chargedSeams(memory: MemoryCallOptions, calls: NativeMemoryCalls | undefined) {
  const execution = memory.seams.execution ?? calls?.execution;
  return execution ? { ...memory.seams, execution } : memory.seams;
}

/** The index of the last user message, or -1. */
function lastUserIndex(messages: readonly Message[]): number {
  for (let index = messages.length - 1; index >= 0; index--)
    if (messages[index]!.role === 'user') return index;
  return -1;
}

function textOf(content: Message['content']): string {
  return typeof content === 'string'
    ? content
    : content
        .filter((part) => part.type === 'text')
        .map((part) => (part as { text: string }).text)
        .join('');
}

/**
 * Recall for a new run: query with the last user message, render the hits as
 * the legacy loops do, and return them as the message to append. Once per user
 * turn: a recall message already answering the last user message (a replayed
 * transcript) stands. Best-effort, as in the legacy loops: a failing store or
 * embedder is logged and the run goes on without.
 */
export async function recallOnce(
  memory: MemoryCallOptions,
  messages: readonly Message[],
  logger: Logger,
  calls?: NativeMemoryCalls,
): Promise<{ recall: AgentRunRecall; message?: Message }> {
  if (memory.recall === false) return { recall: { status: 'skipped' } };
  const lastUser = lastUserIndex(messages);
  if (messages.slice(lastUser + 1).some(isRecallMessage)) return { recall: { status: 'skipped' } };
  const text = lastUser >= 0 ? textOf(messages[lastUser]!.content) : '';
  if (!text) return { recall: { status: 'skipped' } };
  const options = memory.recall ?? {};
  try {
    const { recall, formatMemoriesForPrompt, defaultMemoryScorer } =
      await import('./memory-pipeline');
    const scorer = options.scorer === 'default' ? defaultMemoryScorer : options.scorer;
    const hits = await recall(
      { scope: memory.scope, text, topK: options.topK ?? 5 },
      chargedSeams(memory, calls),
      {
        ...(scorer ? { scorer } : {}),
        ...(options.expandLinks !== undefined ? { expandLinks: options.expandLinks } : {}),
        ...(calls?.onWarning ? { onWarning: calls.onWarning } : {}),
      },
    );
    const block = formatMemoriesForPrompt(hits, {
      ...(options.header !== undefined ? { header: options.header } : {}),
      ...(options.maxChars !== undefined ? { maxChars: options.maxChars } : {}),
    });
    if (!block) return { recall: { status: 'empty' } };
    return {
      recall: { status: 'recalled', count: hits.length },
      message: recallMessage(block),
    };
  } catch (error) {
    logger.error('memory recall failed', { error });
    return { recall: { status: 'failed' } };
  }
}

/** Whether a completed run hands its turns to extraction (`extract`, `writePolicy`). */
export function extracts(memory: MemoryCallOptions): boolean {
  return (
    memory.extract !== false &&
    memory.writePolicy !== 'session-end' &&
    memory.writePolicy !== 'manual'
  );
}

/** Whether the extraction infers facts with the memory LLM (`extract.infer`, default on). */
export function infers(memory: MemoryCallOptions): boolean {
  return memory.extract === undefined || memory.extract === false
    ? true
    : (memory.extract.infer ?? true);
}

/**
 * What extraction reads: the input's last user turn, then the run's own turns.
 * The SDK's turns (recall, finalization prompt, repair and verifier feedback)
 * and system messages are left out: they are no fact about the user.
 */
export function extractionTurns(transcript: AgentRunTranscript): Message[] {
  const internal = new Set(transcript.internal);
  const input = transcript.messages.slice(0, transcript.input);
  const lastUser = input[lastUserIndex(input)];
  const own = transcript.messages
    .slice(transcript.input)
    .filter(
      (message, offset) => !internal.has(transcript.input + offset) && message.role !== 'system',
    );
  return lastUser ? [lastUser, ...own] : own;
}

/** How far a pass has got (2.4, H5), saved before the writes it describes. */
export interface ExtractionProgress {
  /** Every mutation the pass planned. */
  planned: number;
  /** The deletions and invalidations applied so far (they leave no record to find). */
  mutations?: number;
}

/** The extraction record of a pass under way (2.4): pending, with its progress. */
export function progressed(
  extraction: AgentRunMemoryExtraction,
  progress: ExtractionProgress,
): AgentRunMemoryExtraction {
  return {
    operationId: extraction.operationId,
    status: 'pending',
    infer: extraction.infer,
    ...progress,
  };
}

/**
 * Stamp an upsert with the pass's ids. A new record has them already; an
 * updated one keeps its own metadata otherwise, and with it the ids of the
 * operation that wrote it before (2.4: the pass that changed a record is the
 * one it names).
 */
function stamped(
  mutation: MemoryMutation,
  deuz: { runId: string; operationId: string },
): MemoryMutation {
  if (mutation.op !== 'upsert') return mutation;
  return {
    ...mutation,
    record: { ...mutation.record, metadata: { ...mutation.record.metadata, deuz } },
  };
}

/**
 * Run one extraction: every record it writes carries the run and operation
 * ids. The pass is planned first and its size handed to `checkpoint` before
 * the first memory write (2.4, H5); deletions and invalidations, which leave
 * no record to find, are applied next and counted in a second checkpoint, and
 * the records last. A plan that deletes a record it also writes keeps the
 * store's own order (records, then deletions) in one apply.
 * `sweep: 'on-extract'` follows it, best-effort. Throws when the pass fails;
 * nothing is written when the first checkpoint throws.
 */
export async function runExtraction(
  memory: MemoryCallOptions,
  turns: Message[],
  extraction: AgentRunMemoryExtraction,
  runId: string,
  clock: Clock,
  logger: Logger,
  checkpoint: (progress: ExtractionProgress) => Promise<void>,
  calls?: NativeMemoryCalls,
): Promise<number> {
  const { remember, applyMutations, sweepExpired } = await import('./memory-pipeline');
  const deuz = { runId, operationId: extraction.operationId };
  const plan = (
    await remember(turns, memory.scope, chargedSeams(memory, calls), {
      infer: extraction.infer,
      metadata: { deuz },
      apply: false,
      ...(calls?.onWarning ? { onWarning: calls.onWarning } : {}),
    })
  ).map((mutation) => stamped(mutation, deuz));
  await checkpoint({ planned: plan.length });
  const records = plan.filter(
    (mutation): mutation is Extract<MemoryMutation, { op: 'upsert' }> => mutation.op === 'upsert',
  );
  const removals = plan.filter(
    (mutation): mutation is Exclude<MemoryMutation, { op: 'upsert' }> => mutation.op !== 'upsert',
  );
  const written = new Set(records.map((mutation) => mutation.record.id));
  if (records.length > 0 && removals.length > 0 && !removals.some(({ id }) => written.has(id))) {
    await applyMutations(memory.seams.store, removals);
    await checkpoint({ planned: plan.length, mutations: removals.length });
    await applyMutations(memory.seams.store, records);
  } else if (plan.length > 0) await applyMutations(memory.seams.store, plan);
  if (memory.sweep === 'on-extract') {
    try {
      await sweepExpired(memory.seams.store, memory.scope, clock);
    } catch (error) {
      logger.error('memory sweep failed', { error });
    }
  }
  return plan.length;
}

/**
 * Whether records of this operation are in the store already: the pass ran
 * (at least its writes did) before its outcome could be saved.
 */
export async function operationWrote(
  memory: MemoryCallOptions,
  operationId: string,
): Promise<number> {
  const records = await memory.seams.store.list(memory.scope);
  return records.filter(
    (record) =>
      (record.metadata?.deuz as { operationId?: unknown } | undefined)?.operationId === operationId,
  ).length;
}

const PARTIAL = 'memory-extraction-partial';

function partialWarning(runId: string, confirmed: number, planned: number): CallWarning {
  return {
    type: PARTIAL,
    setting: 'memory',
    message: `The memory extraction of run ${runId} was interrupted: ${confirmed} of the ${planned} memory mutations it planned are in the store, and the rest were not written.`,
  };
}

/**
 * Settle a pass an interruption left, from its record and the store (2.4, H5).
 * Confirmed are the records found under its operation id plus the deletions
 * its record counts. Every planned mutation confirmed: completed. Only some:
 * `'failed'` with a `memory-extraction-partial` warning, final (a later call
 * reports it again and never runs the pass). None: `undefined`, the pass runs
 * again. A record without a planned count (a 2.3 process wrote it) is
 * completed when a record of its operation is found, as in 2.3. The returned
 * record is the given one when nothing changed.
 */
export async function settleInterrupted(
  memory: MemoryCallOptions,
  extraction: AgentRunMemoryExtraction,
  runId: string,
): Promise<{ extraction: AgentRunMemoryExtraction; warning?: CallWarning } | undefined> {
  const { planned } = extraction;
  if (planned !== undefined && extraction.error?.code === PARTIAL)
    return { extraction, warning: partialWarning(runId, extraction.mutations ?? 0, planned) };
  const found = planned === 0 ? 0 : await operationWrote(memory, extraction.operationId);
  const confirmed = (planned === undefined ? 0 : (extraction.mutations ?? 0)) + found;
  const { error: _error, ...rest } = extraction;
  if (planned === 0 || (planned !== undefined && confirmed >= planned))
    return { extraction: { ...rest, status: 'completed', mutations: planned } };
  if (confirmed === 0) return undefined;
  if (planned === undefined)
    return { extraction: { ...rest, status: 'completed', mutations: confirmed } };
  const warning = partialWarning(runId, confirmed, planned);
  return {
    extraction: {
      ...rest,
      status: 'failed',
      mutations: confirmed,
      error: { name: 'MemoryExtractionPartialError', message: warning.message, code: PARTIAL },
    },
    warning,
  };
}

/**
 * The V3 form of a settled extraction (2.4): a pass that wrote part of its
 * plan is `'partial'` there (v1 and v2 records keep `'failed'` with the
 * `memory-extraction-partial` code, since their status union is closed).
 * Typed as the shared record, which carries it in a V3 envelope only.
 */
export function asV3Extraction(extraction: AgentRunMemoryExtraction): AgentRunMemoryExtraction {
  if (extraction.status !== 'failed' || extraction.error?.code !== PARTIAL) return extraction;
  return { ...extraction, status: 'partial' as AgentRunMemoryExtraction['status'] };
}

/**
 * Settles a V3 run's pass right after it failed (2.4): from what its record
 * planned and the store holds, as `reconcileAgentRun` would. A pass that
 * wrote part of its plan is `'partial'`, with its warning; one that wrote all
 * of it is completed. `undefined` when it planned nothing yet, wrote nothing,
 * or the store cannot be read: the pass stays `'failed'`.
 */
export async function settlePartialV3(
  memory: MemoryCallOptions,
  extraction: AgentRunMemoryExtraction,
  runId: string,
): Promise<{ extraction: AgentRunMemoryExtraction; warning?: CallWarning } | undefined> {
  if (extraction.planned === undefined) return undefined;
  try {
    const settled = await settleInterrupted(memory, extraction, runId);
    return settled && { ...settled, extraction: asV3Extraction(settled.extraction) };
  } catch {
    return undefined;
  }
}
