/**
 * Faults at a native run's memory (2.3, 23.4): a nested run whose memory scope
 * leaves the scope of the run it serves, on its own child execution context and
 * on the parent's context itself (native-agents.mdx, "Memory": a run under
 * another native run's execution may only narrow that run's memory scope).
 */
import { createInMemoryAgentRunStore, runAgent } from '../../../src/agent-run';
import { createExecutionContext } from '../../../src/execution-policy';
import type { MemoryScope } from '../../../src/memory';
import type { AgentRunStore } from '../../../src/types/agent-run';
import type { NativeExecutionContext } from '../../../src/types/execution';
import type { EvalTaskContext, EvalTaskManifest } from '../../../src/testing';
import {
  MOCK,
  TURN,
  memoryRecord,
  mockPrices,
  parameters,
  scripted,
  watchedMemory,
} from './support';

const PLANNER: MemoryScope = { userId: 'ada', agentId: 'planner' };
const ADA_FACT = 'ada drinks green tea';
const BOB_FACT = 'bob drinks black coffee';

/** A run store that counts its writes. */
function countingStore(): { store: AgentRunStore; saves: () => number } {
  const inner = createInMemoryAgentRunStore();
  let saves = 0;
  return {
    store: {
      load: (runId) => inner.load(runId),
      save: (envelope) => {
        saves += 1;
        return inner.save(envelope);
      },
    },
    saves: () => saves,
  };
}

/**
 * A run with ada's planner memory asks `helper`, a tool that starts a nested
 * native run with `scope` on the execution context `pick` hands it, then
 * answers. What the nested run returned, and what it touched while it ran,
 * lands in `context.store`.
 */
async function delegate(
  context: EvalTaskContext,
  boundary: string,
  scope: MemoryScope,
  pick: (execution: NativeExecutionContext) => NativeExecutionContext,
) {
  const memory = await watchedMemory([
    memoryRecord('ada-1', ADA_FACT, PLANNER),
    memoryRecord('bob-1', BOB_FACT, { userId: 'bob' }),
  ]);
  const parent = scripted([
    { toolCalls: [{ toolName: 'helper', id: 'h1', args: {} }] },
    { text: 'You drink green tea; the helper could not look further.' },
  ]);
  const nestedModel = scripted([{ text: 'never asked' }]);
  const nestedRuns = countingStore();
  let nested: Awaited<ReturnType<typeof runAgent>> | undefined;
  const result = await runAgent({
    model: parent.model,
    messages: context.messages,
    execution: createExecutionContext({ scopeId: 'planner' }),
    memory: { seams: memory.seams, scope: PLANNER, extract: false },
    session: { store: createInMemoryAgentRunStore(), runId: 'planner', scope: 'eval' },
    tools: {
      helper: {
        description: 'Ask a helper agent about the user.',
        parameters,
        execute: async (_args: unknown, call: { execution?: NativeExecutionContext }) => {
          const before = { searches: memory.searches.length, writes: memory.writes.length };
          context.interrupt(boundary);
          nested = await runAgent({
            model: nestedModel.model,
            prompt: 'What does this user drink?',
            execution: pick(call.execution!),
            memory: { seams: memory.seams, scope },
            session: { store: nestedRuns.store, runId: 'helper', scope: 'eval' },
            deps: { observer: context.observer, priceProvider: mockPrices },
          });
          context.store.nested = {
            searches: memory.searches.length - before.searches,
            writes: memory.writes.length - before.writes,
            modelCalls: nestedModel.calls(),
            saves: nestedRuns.saves(),
          };
          return nested.status === 'failed' ? `failed: ${nested.error.message}` : nested.status;
        },
      },
    },
    deps: { observer: context.observer, priceProvider: mockPrices },
  });
  context.store.parent = {
    status: result.status,
    told: JSON.stringify(result.messages).includes('memory scope'),
    committed: result.accounting?.committed,
  };
  context.store.billedCalls = parent.calls();
  // Every memory read was the parent's own recall, and nothing was written.
  context.store.searchedScopes = memory.searches.map((query) => JSON.stringify(query.scope));
  context.store.memoryWrites = memory.writes.length;
  context.store.records = (await memory.store.list({})).map((record) => record.id).sort();
  // Ada's memory reached her run's requests, bob's never reached a model.
  context.store.recalled = parent.bodies().every((body) => body.includes(ADA_FACT));
  context.store.bobInRequests = [...parent.bodies(), ...nestedModel.bodies()].some((body) =>
    body.includes(BOB_FACT),
  );
  if (!nested) throw new Error('the helper never ran');
  return { nested, parentAccounting: result.accounting };
}

function scopeScenario(
  id: string,
  title: string,
  scope: MemoryScope,
  pick: (execution: NativeExecutionContext) => NativeExecutionContext,
): EvalTaskManifest {
  return {
    id,
    version: 1,
    title,
    tags: ['fault', 'native', 'memory', 'nested-agent'],
    model: MOCK,
    start: { messages: [{ role: 'user', content: 'What do I drink? Ask the helper too.' }] },
    // Documented (native-agents.mdx, Memory): a wider scope fails the nested run
    // before any call; the run it serves goes on.
    fault: { boundary: 'memory-scope', recovery: 'scope-refused' },
    acceptance: [
      {
        name: 'the nested run fails on its memory scope',
        check: (outcome) =>
          outcome.status === 'failed' && /memory scope/.test(outcome.error?.message ?? ''),
      },
      {
        name: 'it failed before any memory read or write, model call or save',
        check: (_outcome, context) =>
          JSON.stringify(context.store.nested) ===
          JSON.stringify({ searches: 0, writes: 0, modelCalls: 0, saves: 0 }),
      },
      {
        name: 'nothing crossed scopes',
        check: (_outcome, context) =>
          JSON.stringify(context.store.searchedScopes) ===
            JSON.stringify([JSON.stringify(PLANNER)]) &&
          context.store.recalled === true &&
          context.store.memoryWrites === 0 &&
          JSON.stringify(context.store.records) === JSON.stringify(['ada-1', 'bob-1']) &&
          context.store.bobInRequests === false,
      },
      {
        name: 'the parent completes and is told why',
        check: (_outcome, context) =>
          JSON.stringify(context.store.parent).startsWith('{"status":"completed","told":true'),
      },
      {
        // The parent is the only run that called a model.
        name: "every billed call is in the parent's accounting",
        check: (_outcome, context) => {
          const calls = context.store.billedCalls as number;
          const committed = (context.store.parent as { committed?: { tokens: number } }).committed;
          return committed !== undefined && committed.tokens >= calls * TURN.tokens;
        },
      },
    ],
    async run(context) {
      const { nested } = await delegate(context, 'memory-scope', scope, pick);
      const touched = context.store.nested as { modelCalls: number; saves: number };
      return {
        ...nested,
        recovery:
          nested.status === 'failed' && touched.modelCalls === 0 && touched.saves === 0
            ? 'scope-refused'
            : 'other',
      };
    },
  };
}

export const memoryScopeWidened = scopeScenario(
  'fault/memory-scope-widened',
  "A nested run on a child execution context asks for a wider memory scope than its parent run's",
  // Drops the agent pin: wider than the planner's scope.
  { userId: 'ada' },
  (execution) => execution.child({ scopeId: 'helper' }),
);

export const memoryScopeSharedContext = scopeScenario(
  'fault/memory-scope-shared-context',
  "A nested run handed its parent's own execution context asks for another user's memory",
  { userId: 'bob' },
  (execution) => execution,
);
