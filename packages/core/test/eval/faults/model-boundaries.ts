/**
 * Faults on the model side of a native run: a stream that breaks mid-turn, a
 * turn refused or cut off by max_tokens while it carried a tool call, a
 * cancellation or deadline while the verifier runs, and a sub-agent whose
 * provider refuses its first request.
 */
import {
  createInMemoryAgentRunStore,
  resumeAgent,
  runAgent,
  streamAgent,
} from '../../../src/agent-run';
import { createExecutionContext } from '../../../src/execution-policy';
import { agentTool } from '../../../src/inference/agent-tool';
import { createDeferred } from '../../../src/internal/async-iter';
import { attachConfig, readConfig } from '../../../src/internal/config-symbol';
import type { AgentToolSet } from '../../../src/types/agent-run';
import type { Clock } from '../../../src/types/deps';
import type { FinishReason } from '../../../src/types/usage';
import type { EvalTaskContext, EvalTaskManifest } from '../../../src/testing';
import { MOCK, breakingOnce, costKept, mockPrices, parameters, scripted, stages } from './support';

const chargeCall = { toolCalls: [{ toolName: 'charge', id: 'c1', args: { amount: 5 } }] };

/** A tool whose effect must never run in these scenarios. */
function chargeTool(context: EvalTaskContext): AgentToolSet {
  return {
    charge: {
      description: 'Charge the card.',
      parameters: {
        type: 'object',
        properties: { amount: { type: 'number' } },
        required: ['amount'],
      },
      execute: () => {
        context.effect('charge');
        context.store.charged = true;
        return 'charged';
      },
    },
  };
}

const neverCharged = {
  name: 'the tool never ran',
  check: (_outcome: unknown, context: EvalTaskContext) => context.store.charged !== true,
};

const prompt = [{ role: 'user' as const, content: 'Charge 5 EUR.' }];

export const midStream: EvalTaskManifest = {
  id: 'fault/mid-model-stream',
  version: 1,
  title: 'The model stream breaks off in the middle of a tool call',
  tags: ['fault', 'native', 'model'],
  model: MOCK,
  start: { messages: prompt },
  fault: { boundary: 'mid-model-stream', recovery: 'failed-cost-held' },
  acceptance: [
    { name: 'the run fails, it does not complete', check: (o) => o.status === 'failed' },
    neverCharged,
    costKept,
    {
      name: 'the broken call stays held as unknown, not dropped',
      check: (outcome) => (outcome.accounting?.unknownTokens ?? 0) >= 1,
    },
  ],
  async run(context) {
    const store = createInMemoryAgentRunStore();
    const { model, calls } = breakingOnce([chargeCall, chargeCall, { text: 'Charged.' }]);
    const options = {
      model,
      messages: context.messages,
      tools: chargeTool(context),
      session: { store, runId: 'r', scope: 'eval' },
      deps: { observer: context.observer, priceProvider: mockPrices },
    };
    const first = await runAgent(options);
    if (context.observer.events().some((event) => event.type === 'model.failed'))
      context.interrupt('mid-model-stream');
    // The failed result is terminal: a resume returns it without a model call.
    const resumed = await resumeAgent(options);
    context.store.billedCalls = calls();
    return {
      ...resumed,
      recovery:
        first.status === 'failed' && JSON.stringify(resumed) === JSON.stringify(first)
          ? 'failed-cost-held'
          : 'other',
    };
  },
};

function cutTurn(id: string, finishReason: FinishReason, reason: string): EvalTaskManifest {
  return {
    id,
    version: 1,
    title: `A tool call in a turn that ended with ${finishReason} is never dispatched`,
    tags: ['fault', 'native', 'finish-gate'],
    model: MOCK,
    start: { messages: prompt },
    fault: { boundary: id.replace('fault/', ''), recovery: 'stop-without-dispatch' },
    acceptance: [
      {
        name: `stops with reason ${reason}`,
        check: (outcome) => outcome.status === 'stopped' && outcome.reason === reason,
      },
      neverCharged,
      costKept,
    ],
    async run(context) {
      const { model, calls } = scripted([{ ...chargeCall, finishReason }]);
      const result = await runAgent({
        model,
        messages: context.messages,
        tools: chargeTool(context),
        deps: { observer: context.observer, priceProvider: mockPrices },
      });
      const cut = context.observer
        .events()
        .some(
          (event) =>
            event.type === 'model.completed' &&
            event.finishReason === finishReason &&
            event.toolCallCount > 0,
        );
      if (cut) context.interrupt(id.replace('fault/', ''));
      context.store.billedCalls = calls();
      return {
        ...result,
        recovery: calls() === 1 && result.status === 'stopped' ? 'stop-without-dispatch' : 'other',
      };
    },
  };
}

export const refusalMidToolCall = cutTurn(
  'fault/refusal-mid-tool-call',
  'content_filter',
  'refusal',
);
export const maxTokensMidToolCall = cutTurn('fault/max-tokens-mid-tool-call', 'length', 'length');

export const verifierAbort: EvalTaskManifest = {
  id: 'fault/verifier-abort',
  version: 1,
  title: 'The run is cancelled while the verifier runs',
  tags: ['fault', 'native', 'verifier'],
  model: MOCK,
  start: { messages: [{ role: 'user', content: 'Answer.' }] },
  fault: { boundary: 'verifier-abort', recovery: 'stopped-aborted' },
  acceptance: [
    {
      name: 'stops as aborted, never completed',
      check: (outcome) => outcome.status === 'stopped' && outcome.reason === 'aborted',
    },
    {
      name: 'a resume neither verifies nor calls the model again',
      check: (_outcome, context) => context.store.verifierCalls === 1,
    },
    costKept,
  ],
  async run(context) {
    const store = createInMemoryAgentRunStore();
    const { model, calls } = scripted([{ text: '42' }]);
    const controller = new AbortController();
    const entered = createDeferred<void>();
    let verifierCalls = 0;
    const options = {
      model,
      messages: context.messages,
      session: { store, runId: 'r', scope: 'eval' },
      verify: async () => {
        verifierCalls += 1;
        entered.resolve();
        // A slow verifier that does not watch the signal: the verdict arrives late.
        await new Promise((resolve) => setTimeout(resolve, 5));
        return { status: 'verified' as const };
      },
      deps: { observer: context.observer, priceProvider: mockPrices },
    };
    const pending = streamAgent({ ...options, signal: controller.signal }).result;
    await entered.promise;
    controller.abort();
    context.interrupt('verifier-abort');
    const first = await pending;
    const resumed = await resumeAgent(options);
    context.store.verifierCalls = verifierCalls;
    context.store.billedCalls = calls();
    return {
      ...resumed,
      recovery:
        first.status === 'stopped' && calls() === 1 && verifierCalls === 1
          ? 'stopped-aborted'
          : 'other',
    };
  },
};

/** A clock the scenario moves by hand. */
function handClock(start = 1_000): Clock & { advance(ms: number): void } {
  let now = start;
  return {
    now: () => now,
    setTimeout: () => () => {},
    advance(ms) {
      now += ms;
    },
  };
}

export const verifierDeadline: EvalTaskManifest = {
  id: 'fault/verifier-deadline',
  version: 1,
  title: 'The execution deadline passes while the verifier runs',
  tags: ['fault', 'native', 'verifier'],
  model: MOCK,
  start: { messages: [{ role: 'user', content: 'Answer.' }] },
  fault: { boundary: 'verifier-deadline', recovery: 'failed-deadline' },
  acceptance: [
    {
      name: 'fails on the deadline instead of completing',
      check: (outcome) =>
        outcome.status === 'failed' && outcome.error?.message === 'Execution deadline has elapsed.',
    },
    costKept,
  ],
  async run(context) {
    const clock = handClock();
    const { model, calls } = scripted([{ text: '42' }]);
    const result = await runAgent({
      model,
      messages: context.messages,
      verify: () => {
        clock.advance(100);
        context.interrupt('verifier-deadline');
        return { status: 'verified' };
      },
      execution: createExecutionContext({
        scopeId: 'deadline',
        policy: { deadlineAt: clock.now() + 50 },
      }),
      deps: { clock, observer: context.observer, priceProvider: mockPrices },
    });
    context.store.billedCalls = calls();
    return {
      ...result,
      recovery: result.status === 'failed' && calls() === 1 ? 'failed-deadline' : 'other',
    };
  },
};

export const childInitialization: EvalTaskManifest = {
  id: 'fault/child-initialization',
  version: 1,
  title: "A sub-agent's provider refuses its first request",
  tags: ['fault', 'native', 'nested-agent'],
  model: MOCK,
  start: { messages: [{ role: 'user', content: 'Ask the helper, then answer.' }] },
  fault: { boundary: 'child-initialization', recovery: 'parent-told' },
  acceptance: [
    { name: 'the parent completes', check: (outcome) => outcome.status === 'completed' },
    {
      name: 'the delegation is a known failure, not an unknown effect',
      check: (_outcome, context) =>
        JSON.stringify(context.store.receipts) === JSON.stringify(['h1:failed']),
    },
    {
      name: "the child's tool never ran",
      check: (_outcome, context) => context.store.childEffects === 0,
    },
    costKept,
  ],
  async run(context) {
    let childEffects = 0;
    let childRequests = 0;
    const child = scripted([{ toolCalls: [{ toolName: 'lookup', args: {} }] }, { text: 'x' }]);
    const config = readConfig(child.model)!;
    // The sub-agent's credentials are rejected: a 401 the SDK does not retry.
    const childModel = attachConfig(
      { ...child.model },
      {
        ...config,
        fetch: (async () => {
          childRequests += 1;
          context.interrupt('child-initialization');
          return new Response(
            JSON.stringify({ error: { message: 'invalid api key', type: 'auth' } }),
            { status: 401, headers: { 'content-type': 'application/json' } },
          );
        }) as typeof fetch,
      },
    );
    const parent = scripted([
      { toolCalls: [{ toolName: 'helper', id: 'h1', args: { prompt: 'look it up' } }] },
      { text: 'The helper is unavailable, so I answered without it.' },
    ]);
    const store = createInMemoryAgentRunStore();
    const options = {
      model: parent.model,
      messages: context.messages,
      session: { store, runId: 'g', scope: 'eval' },
      tools: {
        helper: agentTool({
          name: 'helper',
          description: 'Looks things up.',
          model: childModel,
          tools: {
            lookup: {
              parameters,
              execute: () => {
                childEffects += 1;
                return 'found';
              },
            },
          },
        }),
      },
      deps: { observer: context.observer, priceProvider: mockPrices },
    };
    const result = await runAgent(options);
    context.store.receipts = stages(await store.load('g'));
    // A resume of the finished run repeats nothing.
    const again = await resumeAgent(options);
    context.store.childEffects = childEffects;
    context.store.billedCalls = parent.calls();
    return {
      ...again,
      recovery:
        result.status === 'completed' && childRequests === 1 && parent.calls() === 2
          ? 'parent-told'
          : 'other',
    };
  },
};
