/**
 * An interrupted run resumed by the next process: the first process dies on
 * a store write after its first step was checkpointed; `resumeAgent` picks the
 * run up from the store and finishes it without repeating the first step's
 * effect or its paid model turn.
 */
import { createInMemoryAgentRunStore, resumeAgent, runAgent } from '../../../src/agent-run';
import type { AgentRunStore } from '../../../src/types/agent-run';
import type { EvalTaskManifest } from '../../../src/testing';
import { completes, mockPrices, scripted } from '../support';

const MOCK = { provider: 'mock', id: 'mock-model', protocol: 'chat_completions' };

export const interruptedRun: EvalTaskManifest = {
  id: 'resume/interrupted-run',
  version: 1,
  title: 'Finish a run whose process died between steps',
  tags: ['resume', 'durable'],
  model: MOCK,
  start: {
    messages: [{ role: 'user', content: 'Archive ticket T-9, then notify its reporter.' }],
  },
  tools: { allowed: ['archive', 'notify'] },
  budget: { usd: 0.01 },
  artifacts: ['modelCalls'],
  acceptance: [
    completes,
    {
      name: 'archived once and notified once',
      check: (_outcome, context) =>
        JSON.stringify(context.store.done) === JSON.stringify(['archive:T-9', 'notify:T-9']),
    },
    {
      name: 'the first step was not paid for again',
      // archive (first process), then notify and the answer (resume).
      check: (_outcome, context) => context.store.modelCalls === 3,
    },
  ],
  async run(context) {
    const done: string[] = [];
    context.store.done = done;
    const { model, calls } = scripted([
      { toolCalls: [{ toolName: 'archive', id: 'a1', args: { ticket: 'T-9' } }] },
      { toolCalls: [{ toolName: 'notify', id: 'n1', args: { ticket: 'T-9' } }] },
      { text: 'Archived T-9 and notified its reporter.' },
    ]);
    const effect =
      (name: string) =>
      ({ ticket }: { ticket: string }) => {
        context.effect(`${name}:${ticket}`);
        done.push(`${name}:${ticket}`);
        return 'ok';
      };
    const ticket = {
      type: 'object' as const,
      properties: { ticket: { type: 'string' } },
      required: ['ticket'],
    };
    const durable = createInMemoryAgentRunStore();
    // The first process dies on the write that reserves its second model call,
    // so that call is never made; everything saved before it is durable.
    let alive = true;
    const dying: AgentRunStore = {
      load: (runId) => durable.load(runId),
      save(envelope) {
        if (envelope.modelSteps >= 2) alive = false;
        if (!alive) throw new Error('process crashed');
        return durable.save(envelope);
      },
    };
    const options = {
      model,
      messages: context.messages,
      tools: {
        archive: { parameters: ticket, execute: effect('archive') },
        notify: { parameters: ticket, execute: effect('notify') },
      },
      signal: context.signal,
      deps: { observer: context.observer, priceProvider: mockPrices },
    };
    const first = await runAgent({
      ...options,
      session: { store: dying, runId: 't9', scope: 'eval' },
    });
    if (first.status === 'failed') context.interrupt('process crash between steps');
    const resumed = await resumeAgent({
      ...options,
      session: { store: durable, runId: 't9', scope: 'eval' },
    });
    context.store.modelCalls = calls();
    context.artifact('modelCalls', calls());
    return { ...resumed, recovery: 'resumed' };
  },
};
