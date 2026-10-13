/**
 * Approval tasks: a deploy gated by a human, approved once and denied once. The
 * approval is part of the task (`approvals`), so it is a required approval and
 * never a human rescue.
 */
import { createInMemoryAgentRunStore, resumeAgent, runAgent } from '../../../src/agent-run';
import type { EvalTaskContext, EvalTaskManifest, EvalTaskOutcome } from '../../../src/testing';
import { completes, offline, runWith, type TaskModel } from '../support';

const MOCK = { provider: 'mock', id: 'mock-model', protocol: 'chat_completions' };

function deployments(context: EvalTaskContext): string[] {
  return ((context.store.deployments as string[] | undefined) ??= []);
}

/** Run until the approval gate, let the human decide, resume to the end. */
export function gatedDeploy(
  on: TaskModel,
  approved: boolean,
): (context: EvalTaskContext) => Promise<EvalTaskOutcome> {
  return async (context) => {
    const options = {
      ...runWith(on, context),
      messages: context.messages,
      session: { store: createInMemoryAgentRunStore(), runId: 'deploy', scope: 'eval' },
      tools: {
        deploy: {
          description: 'Deploy a version to production.',
          parameters: {
            type: 'object' as const,
            properties: { version: { type: 'string' } },
            required: ['version'],
          },
          needsApproval: true,
          execute: ({ version }: { version: string }) => {
            context.effect(`deploy:${version}`);
            deployments(context).push(version);
            return `deployed ${version}`;
          },
        },
      },
    };
    const first = await runAgent(options);
    if (first.status !== 'suspended') return first;
    context.store.pending = first.pendingApprovals.map((request) => request.toolName);
    return resumeAgent({
      ...options,
      approvalResponses: context.approve(first.pendingApprovals, approved),
    });
  };
}

const deployTurn = {
  toolCalls: [{ toolName: 'deploy', id: 'deploy-1', args: { version: 'v2.3.0' } }],
};

const start = { messages: [{ role: 'user' as const, content: 'Ship v2.3.0 to production.' }] };

const askedFirst = {
  name: 'asked for approval before deploying',
  check: (_outcome: unknown, context: EvalTaskContext) =>
    JSON.stringify(context.store.pending) === JSON.stringify(['deploy']),
};

export const deployApproved: EvalTaskManifest = {
  id: 'approval/deploy-approved',
  version: 1,
  title: 'Deploy after a required approval',
  tags: ['approval'],
  model: MOCK,
  start,
  tools: { allowed: ['deploy'] },
  approvals: ['deploy'],
  budget: { usd: 0.01 },
  acceptance: [
    completes,
    askedFirst,
    {
      name: 'deployed exactly once',
      check: (_outcome, context) => JSON.stringify(deployments(context)) === '["v2.3.0"]',
    },
  ],
  run: gatedDeploy(offline([deployTurn, { text: 'v2.3.0 is live.' }]), true),
};

export const deployDenied: EvalTaskManifest = {
  id: 'approval/deploy-denied',
  version: 1,
  title: 'Respect a denied approval',
  tags: ['approval'],
  model: MOCK,
  start,
  tools: { allowed: ['deploy'] },
  approvals: ['deploy'],
  budget: { usd: 0.01 },
  acceptance: [
    completes,
    askedFirst,
    {
      name: 'never deployed',
      check: (_outcome, context) => deployments(context).length === 0,
    },
    {
      name: 'tells the user it did not deploy',
      check: (outcome) => /not deployed/i.test(outcome.text ?? ''),
    },
    {
      name: 'the model was told about the denial',
      check: (outcome) =>
        JSON.stringify((outcome as { messages?: unknown }).messages ?? []).includes('denied'),
    },
  ],
  run: gatedDeploy(
    offline([deployTurn, { text: 'The deployment was denied, so v2.3.0 was not deployed.' }]),
    false,
  ),
};
