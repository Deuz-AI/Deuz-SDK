/**
 * Nested-agent tasks: a parent delegates to an `agentTool` sub-agent with its
 * own tools, and a sub-agent whose payment tool needs a human approval that
 * reaches the top-level run.
 */
import { createInMemoryAgentRunStore, resumeAgent, runAgent } from '../../../src/agent-run';
import { agentTool } from '../../../src/inference/agent-tool';
import type { EvalTaskManifest } from '../../../src/testing';
import { completes, mockPrices, scripted } from '../support';

const MOCK = { provider: 'mock', id: 'mock-model', protocol: 'chat_completions' };
const promptParameters = {
  type: 'object' as const,
  properties: { query: { type: 'string' } },
  required: ['query'],
};

export const delegatedResearch: EvalTaskManifest = {
  id: 'nested-agent/delegated-lookup',
  version: 1,
  title: "Answer from a sub-agent's findings",
  tags: ['nested-agent'],
  model: MOCK,
  start: { messages: [{ role: 'user', content: 'What is the status of incident INC-42?' }] },
  tools: { allowed: ['investigator', 'search_tickets'] },
  budget: { usd: 0.01 },
  acceptance: [
    completes,
    {
      name: "answer carries the sub-agent's finding",
      check: (outcome) => (outcome.text ?? '').includes('mitigated'),
    },
    {
      name: 'the sub-agent searched once',
      check: (_outcome, context) => context.store.searches === 1,
    },
    {
      name: "the sub-agent's usage is in the parent's",
      check: (outcome) => (outcome.usage?.totalTokens ?? 0) === 4 * 15,
    },
  ],
  async run(context) {
    context.store.searches = 0;
    const child = scripted([
      { toolCalls: [{ toolName: 'search_tickets', args: { query: 'INC-42' } }] },
      { text: 'INC-42 was mitigated at 14:05; root cause: an expired certificate.' },
    ]);
    const parent = scripted([
      {
        toolCalls: [
          { toolName: 'investigator', args: { prompt: 'Find the current status of INC-42.' } },
        ],
      },
      { text: 'INC-42 is mitigated (expired certificate, fixed at 14:05).' },
    ]);
    return runAgent({
      model: parent.model,
      messages: context.messages,
      tools: {
        investigator: agentTool({
          name: 'investigator',
          description: 'Investigates incidents in the ticket system.',
          model: child.model,
          tools: {
            search_tickets: {
              description: 'Search incident tickets.',
              parameters: promptParameters,
              execute: () => {
                context.store.searches = (context.store.searches as number) + 1;
                return [{ id: 'INC-42', state: 'mitigated', at: '14:05', cause: 'certificate' }];
              },
            },
          },
        }),
      },
      signal: context.signal,
      deps: { observer: context.observer, priceProvider: mockPrices },
    });
  },
};

export const childApproval: EvalTaskManifest = {
  id: 'nested-agent/child-approval',
  version: 1,
  title: 'A sub-agent payment that needs the human, resumed from the top',
  tags: ['nested-agent', 'approval'],
  model: MOCK,
  start: { messages: [{ role: 'user', content: 'Pay invoice 881 (40 EUR).' }] },
  tools: { allowed: ['accounts', 'pay'] },
  approvals: ['pay'],
  budget: { usd: 0.01 },
  acceptance: [
    completes,
    {
      name: 'the approval request named the sub-agent',
      check: (_outcome, context) =>
        JSON.stringify(context.store.agentPath) === JSON.stringify(['accounts']),
    },
    {
      name: 'paid exactly once',
      check: (_outcome, context) => context.store.payments === 1,
    },
  ],
  async run(context) {
    context.store.payments = 0;
    const child = scripted([
      { toolCalls: [{ toolName: 'pay', id: 'pay-881', args: { invoice: 881, amount: 40 } }] },
      { text: 'Invoice 881 is paid.' },
    ]);
    const parent = scripted([
      {
        toolCalls: [{ toolName: 'accounts', id: 'delegate', args: { prompt: 'Pay invoice 881' } }],
      },
      { text: 'Done: invoice 881 (40 EUR) is paid.' },
    ]);
    const options = {
      model: parent.model,
      messages: context.messages,
      session: { store: createInMemoryAgentRunStore(), runId: 'pay', scope: 'eval' },
      tools: {
        accounts: agentTool({
          name: 'accounts',
          description: 'Handles payments.',
          model: child.model,
          tools: {
            pay: {
              description: 'Pay an invoice.',
              parameters: {
                type: 'object',
                properties: { invoice: { type: 'number' }, amount: { type: 'number' } },
                required: ['invoice', 'amount'],
              },
              needsApproval: true,
              execute: (args) => {
                const { invoice } = args as { invoice: number };
                context.effect(`pay:invoice-${invoice}`);
                context.store.payments = (context.store.payments as number) + 1;
                return 'paid';
              },
            },
          },
        }),
      },
      signal: context.signal,
      deps: { observer: context.observer, priceProvider: mockPrices },
    };
    const first = await runAgent(options);
    if (first.status !== 'suspended') return first;
    context.store.agentPath = first.pendingApprovals[0]?.agentPath;
    return resumeAgent({ ...options, approvalResponses: context.approve(first.pendingApprovals) });
  },
};
