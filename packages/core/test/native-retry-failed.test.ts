/**
 * native-retry-failed.test.ts (2.3, EV1 F-EV1-2) — `retryFailed`.
 *
 * A native run that fails stays failed: a resume returns the stored failure.
 * Before 2.3 shipped, that held for a transient failure too, such as a model
 * stream that broke off or a budget admission refused with a serialization
 * conflict, so a durable run could not go on after a short outage. The failed
 * envelope now records whether its cause was transient (`retry`), and
 * `resumeAgent({ retryFailed: true })` re-enters such a run from its last
 * checkpoint. Every other failure is refused before anything is written.
 */
import { describe, expect, it } from 'vitest';
import { createInMemoryAgentRunStore, resumeAgent, runAgent } from '../src/agent-run';
import { BudgetLedgerError } from '../src/budget-ledger';
import { createInMemoryBudgetStore } from '../src/budget-store';
import {
  APICallError,
  AuthenticationError,
  BreakerOpenError,
  ContextOverflowError,
  InvalidRequestError,
  NetworkError,
  OverloadedError,
  RateLimitError,
  TimeoutError,
} from '../src/errors';
import { ExecutionPolicyError, createExecutionContext } from '../src/execution-policy';
import { retryableCause } from '../src/internal/native-retry';
import { attachConfig, readConfig } from '../src/internal/config-symbol';
import { createMockModel, type MockResponse } from '../src/testing';
import type { AgentRunStore, AgentToolSet } from '../src/types/agent-run';
import type { BudgetStore } from '../src/types/budget-store';
import type { PriceProvider } from '../src/types/deps';

const parameters = { type: 'object' as const, properties: {} };
const chargeCall: MockResponse = { toolCalls: [{ toolName: 'charge', id: 'c1', args: {} }] };
const prices: PriceProvider = {
  priceUsage: (_model, usage) => (usage.inputTokens * 1 + usage.outputTokens * 4) / 1_000_000,
};

/**
 * A mock model whose calls fail as `faults` says, by call number: `'break'`
 * cuts the response stream after its first event (a dropped connection; the
 * scripted response is used up), a status answers with that HTTP error.
 */
function faulty(
  responses: MockResponse[],
  faults: Record<number, 'break' | number>,
  onCall?: (call: number) => void,
) {
  const base = createMockModel({ responses });
  const config = readConfig(base)!;
  let calls = 0;
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls += 1;
    onCall?.(calls);
    const fault = faults[calls];
    if (typeof fault === 'number')
      return new Response(JSON.stringify({ error: { message: 'injected', type: 'error' } }), {
        status: fault,
        headers: { 'content-type': 'application/json' },
      });
    const response = await config.fetch!(input, init);
    if (fault !== 'break') return response;
    const text = await response.text();
    const cut = text.indexOf('\n\n') + 2;
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(text.slice(0, cut)));
        controller.error(new TypeError('terminated'));
      },
    });
    return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  }) as typeof globalThis.fetch;
  return { model: attachConfig({ ...base }, { ...config, fetch }), calls: () => calls };
}

function charging(effects: string[]): AgentToolSet {
  return {
    charge: {
      parameters,
      execute: () => {
        effects.push('charge');
        return 'charged';
      },
    },
  };
}

/** A budget store whose `reserve` fails once, at the `nth` call, with `error`. */
function refusingReserve(nth: number, error: unknown) {
  const inner = createInMemoryBudgetStore();
  let count = 0;
  const store: BudgetStore = {
    ...inner,
    reserve: (...args: Parameters<BudgetStore['reserve']>) =>
      ++count === nth ? Promise.reject(error) : inner.reserve(...args),
  };
  return { store, inner };
}

const serializationFailure = (code: string) =>
  Object.assign(new Error('could not serialize access due to concurrent update'), { code });

describe('which failures are transient (retryableCause)', () => {
  const modelCall = 'model-call';
  it.each([
    ['a network error', new NetworkError({ message: 'down' }), modelCall],
    ['a rate limit after its retries', new RateLimitError({ message: '429' }), modelCall],
    ['an overload', new OverloadedError({ message: '529' }), modelCall],
    ['a 503', new APICallError({ message: '503', statusCode: 503, isRetryable: true }), modelCall],
    [
      'a 500 not marked retryable',
      new APICallError({ message: '500', statusCode: 500, isRetryable: false }),
      modelCall,
    ],
    [
      'an open breaker',
      new BreakerOpenError({ provider: 'p', modelId: 'm', cooldownUntil: 1 }),
      modelCall,
    ],
    ['a stalled stream', new TimeoutError('chunk'), modelCall],
    ['no first token', new TimeoutError('ttft'), modelCall],
    ["a step's own deadline", new TimeoutError('step'), undefined],
    ["a tool's timeout", new TimeoutError('tool'), undefined],
    ['an invalid request', new InvalidRequestError({ message: '400' }), undefined],
    ['a rejected key', new AuthenticationError({ message: '401' }), undefined],
    ['a context overflow', new ContextOverflowError({ message: 'too long' }), undefined],
    [
      'an admission refused with 40001',
      new BudgetLedgerError('admission_failed', 'failed', serializationFailure('40001')),
      'admission',
    ],
    [
      'an admission refused with 40P01',
      new BudgetLedgerError('admission_failed', 'failed', serializationFailure('40P01')),
      'admission',
    ],
    [
      'an admission refused otherwise',
      new BudgetLedgerError('admission_failed', 'failed', new Error('connection refused')),
      undefined,
    ],
    [
      'a hold the store failed to close',
      new BudgetLedgerError('admission_failed', 'failed', serializationFailure('40001'), {
        requestId: 'r/1',
      }),
      undefined,
    ],
    ['a spent budget', new BudgetLedgerError('budget_exceeded', 'over'), undefined],
    ['a policy refusal', new ExecutionPolicyError('model_not_allowed', 'no'), undefined],
  ])('%s', (_label, error, cause) => {
    expect(retryableCause(error, false)).toBe(cause);
  });

  it('takes a runtime error for a broken stream only when the call broke off', () => {
    expect(retryableCause(new TypeError('terminated'), true)).toBe('model-call');
    expect(retryableCause(new TypeError('terminated'), false)).toBeUndefined();
    const infrastructure = Object.assign(new Error('receipt lost'), { fatalExecution: true });
    expect(retryableCause(infrastructure, true)).toBeUndefined();
  });
});

describe('retryFailed (2.3): a run that failed in transit goes on', () => {
  it('re-enters a run whose model stream broke off, from its last checkpoint', async () => {
    const store = createInMemoryAgentRunStore();
    const effects: string[] = [];
    const { model, calls } = faulty([chargeCall, chargeCall, { text: 'done' }], { 1: 'break' });
    const options = {
      model,
      prompt: 'charge',
      tools: charging(effects),
      session: { store, runId: 'r', scope: 't' },
      deps: { priceProvider: prices },
    };
    const first = await runAgent(options);
    expect(first).toMatchObject({ status: 'failed', error: { message: 'terminated' } });
    const failed = await store.load('r');
    // Recorded additively: a 2.2 reader sees the same failed envelope.
    expect(failed).toMatchObject({
      version: 1,
      phase: 'terminal',
      result: first,
      retry: { cause: 'model-call', phase: 'running' },
    });
    // No default change: a resume returns the failure.
    expect(await resumeAgent(options)).toEqual(first);
    expect(calls()).toBe(1);

    const retried = await resumeAgent({ ...options, retryFailed: true });
    expect(retried).toMatchObject({ status: 'completed', output: 'done' });
    // The broken turn's call never ran; the retried turn's ran once.
    expect(effects).toEqual(['charge']);
    expect(calls()).toBe(3);
    const done = (await store.load('r'))!;
    expect(done.retry).toBeUndefined();
    // The broken call stays held at its estimate, once; each retried call is
    // reserved and settled on its own.
    expect(done.execution!.ledger.reservations.map((entry) => entry.state)).toEqual([
      'unknown',
      'settled',
      'settled',
    ]);
    expect(retried.accounting).toMatchObject({ unknownTokens: 1 });
    // The failed call counts as a model step.
    expect(retried.modelSteps).toBe(3);
    // A run that did not fail ignores the option.
    expect(await resumeAgent({ ...options, retryFailed: true })).toEqual(retried);
    expect(calls()).toBe(3);
  });

  it('never repeats the steps that completed before the failure', async () => {
    const store = createInMemoryAgentRunStore();
    const effects: string[] = [];
    const { model, calls } = faulty([chargeCall, { text: 'lost' }, { text: 'done' }], {
      2: 'break',
    });
    const options = {
      model,
      prompt: 'charge',
      tools: charging(effects),
      session: { store, runId: 'mid', scope: 't' },
    };
    expect((await runAgent(options)).status).toBe('failed');
    const retried = await resumeAgent({ ...options, retryFailed: true });
    expect(retried).toMatchObject({ status: 'completed', output: 'done' });
    expect(effects).toEqual(['charge']);
    expect(calls()).toBe(3);
    expect(
      retried.messages.filter((message) => message.role === 'tool').map((m) => m.content),
    ).toEqual([[expect.objectContaining({ toolUseId: 'c1', result: 'charged' })]]);
  });

  it('re-enters finalization when the failed call was the final answer', async () => {
    const store = createInMemoryAgentRunStore();
    const { model, calls } = faulty([{ text: '{"n":1}' }, { text: '{"n":2}' }], { 1: 'break' });
    const options = {
      model,
      prompt: 'pick a number',
      output: {
        schema: {
          type: 'object' as const,
          properties: { n: { type: 'number' as const } },
          required: ['n'],
        },
        mode: 'json' as const,
        validate: (value: unknown) => value as { n: number },
      },
      session: { store, runId: 'final', scope: 't' },
    };
    expect((await runAgent(options)).status).toBe('failed');
    expect((await store.load('final'))!.retry).toEqual({
      cause: 'model-call',
      phase: 'finalizing',
    });
    const retried = await resumeAgent({ ...options, retryFailed: true });
    expect(retried).toMatchObject({ status: 'completed', output: { n: 2 } });
    expect(calls()).toBe(2);
  });

  it('retries an admission the budget store refused with a serialization conflict', async () => {
    const { store, inner } = refusingReserve(2, serializationFailure('40001'));
    const runs = createInMemoryAgentRunStore();
    const effects: string[] = [];
    const { model, calls } = faulty([chargeCall, { text: 'done' }], {});
    const scopes = [{ key: 'user:1', limits: { tokens: 1_000_000 } }];
    const options = {
      model,
      prompt: 'charge',
      tools: charging(effects),
      session: { store: runs, runId: 'adm', scope: 't' },
      deps: { priceProvider: prices },
    };
    const first = await runAgent({
      ...options,
      execution: createExecutionContext({ scopeId: 'adm', admission: { store, scopes } }),
    });
    expect(first).toMatchObject({ status: 'failed', error: { code: 'admission_failed' } });
    const saved = (await runs.load('adm'))!;
    expect(saved.retry).toEqual({ cause: 'admission', phase: 'running' });
    const retried = await resumeAgent({
      ...options,
      retryFailed: true,
      execution: createExecutionContext({ snapshot: saved.execution!, admission: { store } }),
    });
    expect(retried).toMatchObject({ status: 'completed', output: 'done' });
    expect(effects).toEqual(['charge']);
    expect(calls()).toBe(2);
    // The refused admission left no hold: the store holds both settled calls.
    expect(await inner.usage('user:1')).toMatchObject({ tokens: 30 });
  });

  it('records the cause again when a retry fails in transit too', async () => {
    const store = createInMemoryAgentRunStore();
    const effects: string[] = [];
    const { model, calls } = faulty([chargeCall, chargeCall, chargeCall, { text: 'done' }], {
      1: 'break',
      2: 'break',
    });
    const options = {
      model,
      prompt: 'charge',
      tools: charging(effects),
      session: { store, runId: 'twice', scope: 't' },
    };
    expect((await runAgent(options)).status).toBe('failed');
    expect((await resumeAgent({ ...options, retryFailed: true })).status).toBe('failed');
    expect((await store.load('twice'))!.retry).toEqual({ cause: 'model-call', phase: 'running' });
    expect(await resumeAgent({ ...options, retryFailed: true })).toMatchObject({
      status: 'completed',
    });
    expect(effects).toEqual(['charge']);
    expect(calls()).toBe(4);
  });

  it('refuses every other failure before writing anything', async () => {
    const cases: [
      string,
      () => Promise<{ store: AgentRunStore; retry: () => Promise<unknown> }>,
    ][] = [
      [
        'a request the provider rejected (400)',
        async () => {
          const store = createInMemoryAgentRunStore();
          const { model } = faulty([{ text: 'done' }], { 1: 400 });
          const options = {
            model,
            prompt: 'x',
            maxRetries: 0,
            session: { store, runId: 'b', scope: 't' },
          };
          expect(await runAgent(options)).toMatchObject({ status: 'failed' });
          return { store, retry: () => resumeAgent({ ...options, retryFailed: true }) };
        },
      ],
      [
        'an admission refused for another reason',
        async () => {
          const { store: budget } = refusingReserve(1, new Error('connection refused'));
          const store = createInMemoryAgentRunStore();
          const { model } = faulty([chargeCall, { text: 'done' }], {});
          const options = {
            model,
            prompt: 'x',
            tools: charging([]),
            session: { store, runId: 'b', scope: 't' },
          };
          const scopes = [{ key: 'user:1', limits: { tokens: 1_000_000 } }];
          expect(
            await runAgent({
              ...options,
              execution: createExecutionContext({
                scopeId: 'b',
                admission: { store: budget, scopes },
              }),
            }),
          ).toMatchObject({ status: 'failed', error: { code: 'admission_failed' } });
          const saved = (await store.load('b'))!;
          return {
            store,
            retry: () =>
              resumeAgent({
                ...options,
                retryFailed: true,
                execution: createExecutionContext({
                  snapshot: saved.execution!,
                  admission: { store: budget },
                }),
              }),
          };
        },
      ],
    ];
    for (const [label, setup] of cases) {
      const { store, retry } = await setup();
      const before = await store.load('b');
      expect(before!.retry, label).toBeUndefined();
      expect(await retry(), label).toMatchObject({
        status: 'failed',
        error: { name: 'TypeError', message: expect.stringContaining('retryFailed') },
      });
      expect(await store.load('b'), label).toEqual(before);
    }
  });

  it('stops for reconciliation, recording nothing, while an effect of the run is unknown', async () => {
    // A fatal store conflict raised inside a tool call, after its effect (as a
    // sub-agent's refused admission surfaces): the receipt stays 'executing'.
    const effects: string[] = [];
    const tools: AgentToolSet = {
      charge: {
        parameters,
        execute: () => {
          effects.push('charge');
          if (effects.length === 1)
            throw new BudgetLedgerError(
              'admission_failed',
              'The persistent budget store failed; nothing was changed.',
              serializationFailure('40001'),
            );
          return 'charged';
        },
      },
    };
    const store = createInMemoryAgentRunStore();
    const { model, calls } = faulty([chargeCall, { text: 'done' }], {});
    const options = { model, prompt: 'charge', tools, session: { store, runId: 'u', scope: 't' } };
    expect(await runAgent(options)).toMatchObject({
      status: 'failed',
      error: { code: 'admission_failed' },
    });
    const before = await store.load('u');
    expect(before).toMatchObject({ retry: { cause: 'admission', phase: 'running' } });
    expect(await resumeAgent({ ...options, retryFailed: true })).toMatchObject({
      status: 'stopped',
      reason: 'tool-reconciliation-required',
      unknownEffects: [{ toolCallId: 'c1', stage: 'executing' }],
    });
    expect(await store.load('u')).toEqual(before);
    const retried = await resumeAgent({
      ...options,
      retryFailed: true,
      reconciledToolResults: [{ toolCallId: 'c1', output: 'charged' }],
    });
    expect(retried).toMatchObject({ status: 'completed', output: 'done' });
    expect(effects).toEqual(['charge']);
    expect(calls()).toBe(2);
  });

  it.each([
    ['inside its deadline, a 503 is transient', 5_000, { cause: 'model-call', phase: 'running' }],
    ['past its deadline, nothing is', 500, undefined],
  ])('a provider error when the run %s', async (_label, deadlineAt, retry) => {
    let now = 0;
    const clock = { now: () => now, setTimeout: () => () => {} };
    const store = createInMemoryAgentRunStore();
    // The provider answers a second later, with a 503.
    const { model } = faulty([{ text: 'done' }], { 1: 503 }, () => {
      now += 1_000;
    });
    const options = {
      model,
      prompt: 'x',
      maxRetries: 0,
      session: { store, runId: 'late', scope: 't' },
      deps: { clock },
    };
    const first = await runAgent({
      ...options,
      execution: createExecutionContext({ scopeId: 'late', policy: { deadlineAt } }),
    });
    // The provider's error, not the deadline, failed the run.
    expect(first).toMatchObject({ status: 'failed', error: { name: 'APICallError' } });
    const saved = (await store.load('late'))!;
    expect(saved.retry).toEqual(retry);
    const retried = await resumeAgent({
      ...options,
      retryFailed: true,
      execution: createExecutionContext({ snapshot: saved.execution! }),
    });
    expect(retried.status).toBe(retry ? 'completed' : 'failed');
  });

  it('rejects a retryFailed that is not a boolean', async () => {
    const store = createInMemoryAgentRunStore();
    const { model } = faulty([{ text: 'done' }], {});
    expect(
      await runAgent({
        model,
        prompt: 'x',
        session: { store, runId: 'v', scope: 't' },
        retryFailed: 'yes' as unknown as boolean,
      }),
    ).toMatchObject({ status: 'failed', error: { name: 'TypeError' } });
    expect(await store.load('v')).toBeUndefined();
  });
});
