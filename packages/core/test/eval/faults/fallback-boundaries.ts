/**
 * Faults at a native run's model fail-over (2.3, 23.4): a provider error after
 * a tool effect, with the process dying between the failed attempt and the
 * fallback's; and the budget across the attempts, a fallback with no price
 * under a USD budget and a resume (native-agents.mdx, "Model fail-over").
 * Claude speaks the scripted Anthropic wire and the fallbacks the Chat
 * Completions wire; not live-verified.
 */
import {
  createInMemoryAgentRunStore,
  resumeStreamAgent,
  streamAgent,
} from '../../../src/agent-run';
import { createInMemoryBudgetStore } from '../../../src/budget-store';
import { createExecutionContext } from '../../../src/execution-policy';
import type {
  AgentResult,
  AgentRunEnvelope,
  AgentRunStore,
  AgentStream,
  AgentToolSet,
} from '../../../src/types/agent-run';
import type { PriceProvider } from '../../../src/types/deps';
import type { EvalTaskContext, EvalTaskManifest } from '../../../src/testing';
import { claudeTurn, overloaded } from '../../fixtures/wire-turns';
import {
  TURN,
  claudeOn,
  costKept,
  gptTurn,
  mockPrices,
  openaiAnswering,
  parameters,
  ranOnce,
} from './support';

const CLAUDE = { provider: 'anthropic', id: 'claude-opus-5-5', protocol: 'messages' };

const prompt = [{ role: 'user' as const, content: 'Charge order 7, then tell the team.' }];

/** Each named tool records one real-world effect per execution. */
function effectTools(context: EvalTaskContext, effects: Record<string, string>): AgentToolSet {
  const done = ((context.store.effects as string[] | undefined) ??= []);
  return Object.fromEntries(
    Object.entries(effects).map(([name, effect]) => [
      name,
      {
        description: `Run ${name}.`,
        parameters,
        execute: () => {
          context.effect(effect);
          done.push(effect);
          return `${name} done`;
        },
      },
    ]),
  );
}

/** A store that fails the first save `when` selects (the process dies there); healthy otherwise. */
function dyingAt(
  inner: AgentRunStore,
  when: (envelope: AgentRunEnvelope) => boolean,
  onDeath: () => void,
): AgentRunStore {
  let dead = false;
  return {
    load: (runId) => inner.load(runId),
    save(envelope) {
      if (!dead && when(envelope)) {
        dead = true;
        onDeath();
        throw new Error('process died');
      }
      return inner.save(envelope);
    },
  };
}

/** Drain a native stream: its result, and the warnings it carried. */
async function drain(stream: AgentStream) {
  const warnings: { type: string; setting?: string; message: string }[] = [];
  for await (const event of stream.events)
    if (event.type === 'part' && event.part.type === 'warning') warnings.push(event.part.warning);
  return { result: (await stream.result) as AgentResult, warnings };
}

const holdsOf = (envelope: AgentRunEnvelope | undefined, modelId: string) =>
  (envelope?.execution?.ledger.reservations ?? []).filter((entry) => entry.modelId === modelId);

export const providerFallback: EvalTaskManifest = {
  id: 'fault/provider-fallback',
  version: 1,
  title:
    'The model fails after a tool effect; the process dies between the failed attempt and the fallback',
  tags: ['fault', 'native', 'fallback'],
  model: CLAUDE,
  start: { messages: prompt },
  // Documented (native-agents.mdx, Model fail-over): the step runs again from
  // the last checkpoint on the next candidate, so the effect never repeats;
  // the checkpoint records the fail-over, and a resume routes around the
  // failed model.
  fault: { boundary: 'provider-fallback', recovery: 'resumed-on-recorded-attempt' },
  acceptance: [
    { name: 'completes', check: (outcome) => outcome.status === 'completed' },
    ranOnce('charge:order-7'),
    {
      name: 'the checkpoint recorded the attempt before the process died',
      check: (_outcome, context) =>
        JSON.stringify(context.store.recorded) ===
        JSON.stringify({
          attempts: ['1: claude-opus-5-5 -> gpt-5.2 at step 2, running, overloaded'],
          selected: 'gpt-5.2',
        }),
    },
    {
      name: 'the resume called the recorded fallback once, never the failed model',
      check: (_outcome, context) =>
        JSON.stringify(context.store.calls) === JSON.stringify({ primary: 2, fallback: 1 }),
    },
    {
      name: "the fallback continued the run's history",
      check: (_outcome, context) => context.store.fallbackSawEffect === true,
    },
    costKept,
  ],
  async run(context) {
    const durable = createInMemoryAgentRunStore();
    const primary = claudeOn('claude-opus-5-5', [
      claudeTurn([{ type: 'tool_use', id: 'toolu_1', name: 'charge', json: '{}' }], 'tool_use'),
      overloaded,
    ]);
    const fallback = openaiAnswering('gpt-5.2', () =>
      gptTurn({ text: 'Charged order 7 and told the team.' }),
    );
    const options = {
      model: primary.model,
      fallbackModels: [fallback.model],
      maxRetries: 0,
      messages: context.messages,
      tools: effectTools(context, { charge: 'charge:order-7' }),
      deps: { observer: context.observer, priceProvider: mockPrices },
    };
    // The process dies once the fallback's call is admitted, before it is sent.
    const store = dyingAt(
      durable,
      (envelope) => holdsOf(envelope, 'gpt-5.2').length > 0,
      () => context.interrupt('provider-fallback'),
    );
    const first = await drain(
      streamAgent({ ...options, session: { store, runId: 'r', scope: 'eval' } }),
    );
    const models = (await durable.load('r'))?.models;
    context.store.recorded = {
      attempts: (models?.attempts ?? []).map(
        (attempt) =>
          `${attempt.attempt}: ${attempt.model.modelId} -> ${attempt.next.modelId} at step ${attempt.modelStep}, ${attempt.phase}, ${attempt.error.code}`,
      ),
      selected: models?.selected.modelId,
    };
    const resumed = await drain(
      resumeStreamAgent({ ...options, session: { store: durable, runId: 'r', scope: 'eval' } }),
    );
    context.store.calls = { primary: primary.wire.calls(), fallback: fallback.calls() };
    context.store.fallbackSawEffect = fallback.bodies()[0]?.includes('charge done') === true;
    context.store.billedCalls = primary.wire.calls() + fallback.calls();
    return {
      ...resumed.result,
      recovery:
        first.result.status === 'failed' &&
        resumed.result.status === 'completed' &&
        primary.wire.calls() === 2 &&
        fallback.calls() === 1
          ? 'resumed-on-recorded-attempt'
          : 'other',
    };
  },
};

/** The mock prices for every model but the self-hosted fallback, which has none. */
const pricesWithoutFallback: PriceProvider = {
  priceUsage: (model, usage, options) =>
    model === 'acme-local-7b' ? undefined : mockPrices.priceUsage(model, usage, options),
};

const scopes = [{ key: 'team:ops', limits: { usd: 0.05 } }];

export const fallbackBudgetSettlement: EvalTaskManifest = {
  id: 'fault/fallback-budget-settlement',
  version: 1,
  title: 'A fail-over to a model with no price under a USD budget, then a crash and a resume',
  tags: ['fault', 'native', 'fallback', 'budget'],
  model: CLAUDE,
  start: { messages: prompt },
  // Documented (native-agents.mdx, Model fail-over; budgets.mdx, Models
  // without a price and Open holds): every attempt is admitted against the run's
  // execution; the failed one stays held at its estimate; a fallback with no
  // price warns once and runs, its tokens counted and its cost left out; each
  // call is settled once, and a resume reserves its calls anew.
  fault: { boundary: 'fallback-budget-settlement', recovery: 'settled-across-resume' },
  acceptance: [
    { name: 'completes', check: (outcome) => outcome.status === 'completed' },
    ranOnce('charge:order-7'),
    ranOnce('notify:team'),
    {
      name: 'one ledger entry per model call, none left open',
      check: (_outcome, context) => {
        const ledger = context.store.ledger as { id: string; state: string }[];
        const calls = context.store.calls as { primary: number; fallback: number };
        return (
          ledger.length === calls.primary + calls.fallback &&
          new Set(ledger.map((entry) => entry.id)).size === ledger.length &&
          ledger.every((entry) => entry.state !== 'reserved')
        );
      },
    },
    {
      name: 'each answered call is counted once at its usage, the failed one at its estimate',
      check: (_outcome, context) =>
        JSON.stringify(
          (context.store.ledger as { model: string; state: string; tokens?: number }[]).map(
            (entry) => `${entry.model}:${entry.state}:${entry.tokens ?? 'held'}`,
          ),
        ) ===
        JSON.stringify([
          'claude-opus-5-5:settled:15',
          'claude-opus-5-5:unknown:held',
          'acme-local-7b:unknown:15',
          'acme-local-7b:unknown:15',
          'acme-local-7b:unknown:15',
        ]),
    },
    {
      name: 'the fallback without a price warned once and went on',
      check: (outcome, context) =>
        JSON.stringify(context.store.unpricedWarnings) ===
          JSON.stringify(['budget.usd: acme-local-7b']) &&
        outcome.accounting?.unpriced === (context.store.calls as { fallback: number }).fallback,
    },
    {
      name: 'the budget store holds what the ledger holds, and only the failed attempt open',
      check: (outcome, context) => {
        const usage = context.store.storeUsage as { tokens: number; usd: number };
        const committed = outcome.accounting?.committed;
        return (
          committed !== undefined &&
          usage.tokens === committed.tokens &&
          Math.abs(usage.usd - committed.usd) < 1e-12 &&
          JSON.stringify(context.store.openHolds) === JSON.stringify(['claude-opus-5-5'])
        );
      },
    },
    {
      name: 'no billed call is missing from the accounting',
      // The fallback's calls count their tokens; their cost is unknown.
      check: (outcome, context) => {
        const calls = context.store.calls as { primary: number; fallback: number };
        const committed = outcome.accounting?.committed;
        return (
          committed !== undefined &&
          committed.tokens >= (calls.primary + calls.fallback) * TURN.tokens &&
          committed.usd >= calls.primary * TURN.usd - 1e-12
        );
      },
    },
  ],
  async run(context) {
    const durable = createInMemoryAgentRunStore();
    const budgets = createInMemoryBudgetStore();
    const primary = claudeOn('claude-opus-5-5', [
      claudeTurn([{ type: 'tool_use', id: 'toolu_1', name: 'charge', json: '{}' }], 'tool_use'),
      overloaded,
    ]);
    // A replayed step gets the same answer: the request asks for the notice
    // until its result is in the history.
    const fallback = openaiAnswering('acme-local-7b', (body) =>
      body.includes('"tool_call_id":"call_n"')
        ? gptTurn({ text: 'Charged order 7 and told the team.' })
        : gptTurn({ toolCalls: [{ id: 'call_n', name: 'notify', json: '{}' }] }),
    );
    const options = {
      model: primary.model,
      fallbackModels: [fallback.model],
      maxRetries: 0,
      // Bounds each call's reservation, so the USD budget admits the loop.
      maxOutputTokens: 1_000,
      messages: context.messages,
      tools: effectTools(context, { charge: 'charge:order-7', notify: 'notify:team' }),
      deps: { observer: context.observer, priceProvider: pricesWithoutFallback },
    };
    // The process dies on the receipt of the notice, after the fallback's
    // call settled: the tool never ran, and the resume replays the step.
    const store = dyingAt(
      durable,
      (envelope) =>
        Object.values(envelope.toolResults ?? {}).some((receipt) => receipt.toolName === 'notify'),
      () => context.interrupt('fallback-budget-settlement'),
    );
    const first = await drain(
      streamAgent({
        ...options,
        session: { store, runId: 'r', scope: 'eval' },
        execution: createExecutionContext({
          scopeId: 'r',
          budget: { usd: 0.05 },
          admission: { store: budgets, scopes },
        }),
      }),
    );
    const saved = (await durable.load('r'))!;
    const resumed = await drain(
      resumeStreamAgent({
        ...options,
        session: { store: durable, runId: 'r', scope: 'eval' },
        execution: createExecutionContext({
          snapshot: saved.execution!,
          admission: { store: budgets },
        }),
      }),
    );
    const unpriced = (warnings: typeof first.warnings) =>
      warnings
        .filter((warning) => warning.type === 'unpriced-model')
        .map((warning) => `${warning.setting}: ${warning.message.split(' ')[0]}`);
    context.store.unpricedWarnings = unpriced(first.warnings);
    context.artifact('resumedLegUnpricedWarnings', unpriced(resumed.warnings));
    context.store.calls = { primary: primary.wire.calls(), fallback: fallback.calls() };
    context.store.ledger = ((await durable.load('r'))?.execution?.ledger.reservations ?? []).map(
      (entry) => ({
        id: entry.requestId,
        model: entry.modelId,
        state: entry.state,
        ...(entry.actual.tokens !== undefined ? { tokens: entry.actual.tokens } : {}),
      }),
    );
    context.store.storeUsage = await budgets.usage('team:ops');
    context.store.openHolds = (await budgets.holds({ before: Number.MAX_SAFE_INTEGER })).map(
      (hold) => hold.modelId,
    );
    return {
      ...resumed.result,
      recovery:
        first.result.status === 'failed' &&
        resumed.result.status === 'completed' &&
        primary.wire.calls() === 2
          ? 'settled-across-resume'
          : 'other',
    };
  },
};
