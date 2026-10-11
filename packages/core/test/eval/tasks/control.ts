/**
 * Control-flow tasks: a client-side tool answered by the client (not a human
 * rescue), a verifier that sends a candidate back once, and a runaway tool loop
 * whose honest stop is the accepted outcome.
 */
import { createInMemoryAgentRunStore, resumeAgent, runAgent } from '../../../src/agent-run';
import type { EvalTaskManifest } from '../../../src/testing';
import { answerMentions, completes, mockPrices, scripted } from '../support';

const MOCK = { provider: 'mock', id: 'mock-model', protocol: 'chat_completions' };

export const clientTool: EvalTaskManifest = {
  id: 'client-tool/locate-user',
  version: 1,
  title: 'Suspend for a client-side tool, resume with its result',
  tags: ['client-tool', 'durable'],
  model: MOCK,
  start: { messages: [{ role: 'user', content: 'Which city am I in?' }] },
  tools: { allowed: ['get_location'] },
  budget: { usd: 0.01 },
  acceptance: [
    completes,
    answerMentions('Lyon'),
    {
      name: 'suspended for the client before answering',
      check: (_outcome, context) => context.store.suspendedFor === 'get_location',
    },
  ],
  async run(context) {
    const { model } = scripted([
      { toolCalls: [{ toolName: 'get_location', id: 'loc-1', args: {} }] },
      { text: 'You are in Lyon.' },
    ]);
    const options = {
      model,
      messages: context.messages,
      session: { store: createInMemoryAgentRunStore(), runId: 'loc', scope: 'eval' },
      // No execute: the browser answers this one.
      tools: { get_location: { parameters: { type: 'object' as const, properties: {} } } },
      signal: context.signal,
      deps: { observer: context.observer, priceProvider: mockPrices },
    };
    const first = await runAgent(options);
    if (first.status !== 'suspended') return first;
    context.store.suspendedFor = first.pendingClientCalls[0]?.toolName;
    return resumeAgent({
      ...options,
      clientToolResults: first.pendingClientCalls.map((call) => ({
        toolCallId: call.toolCallId,
        output: { city: 'Lyon', country: 'FR' },
      })),
    });
  },
};

export const verifierRetry: EvalTaskManifest = {
  id: 'verifier/second-candidate',
  version: 1,
  title: 'Revise a candidate the verifier rejected',
  tags: ['verifier'],
  model: MOCK,
  start: { messages: [{ role: 'user', content: 'How far is Lyon from Paris by road?' }] },
  tools: { allowed: [] },
  budget: { usd: 0.01 },
  acceptance: [
    completes,
    answerMentions('465 km'),
    {
      name: 'verified after one rejection',
      check: (outcome, context) =>
        (outcome as { verification?: string }).verification === 'verified' &&
        context.store.verdicts === 'rejected,verified',
    },
  ],
  async run(context) {
    const verdicts: string[] = [];
    const { model } = scripted([{ text: 'About 465.' }, { text: 'About 465 km by road.' }]);
    const result = await runAgent({
      model,
      messages: context.messages,
      verify: ({ text }) => {
        const verdict = /\bkm\b/.test(text)
          ? ({ status: 'verified' } as const)
          : ({ status: 'rejected', feedback: 'State the unit.' } as const);
        verdicts.push(verdict.status);
        return verdict;
      },
      signal: context.signal,
      deps: { observer: context.observer, priceProvider: mockPrices },
    });
    context.store.verdicts = verdicts.join(',');
    return result;
  },
};

export const runawayLoop: EvalTaskManifest = {
  id: 'control/runaway-loop-stops',
  version: 1,
  title: 'Stop a tool loop that never converges, without claiming success',
  tags: ['control', 'stop'],
  model: MOCK,
  start: { messages: [{ role: 'user', content: 'Poll the job until it finishes.' }] },
  tools: { allowed: ['poll_job'] },
  budget: { usd: 0.01 },
  acceptance: [
    {
      name: 'stops at maxSteps instead of completing',
      check: (outcome) => outcome.status === 'stopped' && outcome.reason === 'max-steps',
    },
    {
      name: 'polled exactly maxSteps times',
      check: (_outcome, context) => context.store.polls === 4,
    },
  ],
  async run(context) {
    context.store.polls = 0;
    // The job never finishes: every turn polls again.
    const { model } = scripted([{ toolCalls: [{ toolName: 'poll_job', args: {} }] }]);
    return runAgent({
      model,
      messages: context.messages,
      maxSteps: 4,
      tools: {
        poll_job: {
          description: 'Read the job state.',
          parameters: { type: 'object', properties: {} },
          execute: () => {
            context.store.polls = (context.store.polls as number) + 1;
            return { state: 'running' };
          },
        },
      },
      signal: context.signal,
      deps: { observer: context.observer, priceProvider: mockPrices },
    });
  },
};
