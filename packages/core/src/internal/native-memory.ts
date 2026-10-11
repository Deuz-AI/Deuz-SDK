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
 *   one that never started (`reconcileAgentRun`).
 * Loaded on demand: a run without `memory` never pulls this module or the
 * memory pipeline in.
 */
import type { Message } from '../types/message';
import type { BudgetLedger, NativeExecutionContext } from '../types/execution';
import type { Clock, Logger } from '../types/deps';
import type { MemoryCallOptions, MemoryScope } from '../memory';
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
 * ancestor run that has memory.
 */
const runningScopes = new WeakMap<BudgetLedger, Map<string, MemoryScope>>();

/**
 * Register a run's memory scope for its execution, after checking it against
 * the closest ancestor run that has one: a child may narrow it (pin more
 * fields), never widen it or step into another user, agent or chat. Returns
 * the release, called when the run's executor ends.
 */
export function claimMemoryScope(
  execution: NativeExecutionContext,
  scope: MemoryScope | undefined,
): () => void {
  const running = runningScopes.get(execution.ledger);
  if (scope && running) {
    let parent: MemoryScope | undefined;
    let depth = -1;
    for (const [id, owned] of running) {
      if (execution.scopeId.startsWith(`${id}/`) && id.length > depth) {
        parent = owned;
        depth = id.length;
      }
    }
    if (parent && !scopeWithin(scope, parent))
      throw new TypeError(
        `This run's memory scope ${scopeKey(scope)} widens its parent run's ${scopeKey(parent)}; a child may only narrow it.`,
      );
  }
  if (!scope) return () => {};
  const map = running ?? new Map<string, MemoryScope>();
  if (!running) runningScopes.set(execution.ledger, map);
  map.set(execution.scopeId, scope);
  return () => {
    if (map.get(execution.scopeId) === scope) map.delete(execution.scopeId);
  };
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
      memory.seams,
      {
        ...(scorer ? { scorer } : {}),
        ...(options.expandLinks !== undefined ? { expandLinks: options.expandLinks } : {}),
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

/**
 * Run one extraction: every record it writes carries the run and operation
 * ids. `sweep: 'on-extract'` follows it, best-effort. Throws when the pass fails.
 */
export async function runExtraction(
  memory: MemoryCallOptions,
  turns: Message[],
  extraction: AgentRunMemoryExtraction,
  runId: string,
  clock: Clock,
  logger: Logger,
): Promise<number> {
  const { remember, sweepExpired } = await import('./memory-pipeline');
  const mutations = await remember(turns, memory.scope, memory.seams, {
    infer: extraction.infer,
    metadata: { deuz: { runId, operationId: extraction.operationId } },
  });
  if (memory.sweep === 'on-extract') {
    try {
      await sweepExpired(memory.seams.store, memory.scope, clock);
    } catch (error) {
      logger.error('memory sweep failed', { error });
    }
  }
  return mutations.length;
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
