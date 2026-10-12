/**
 * A native run behind the UI bridge (2.3, 23.5): a route streams the run with
 * `toDeuzAgentStreamResponse` into one journal per run, the client folds the
 * frames with `agentStateFromParts`, a person approves the pending call in the
 * UI, and the resumed leg ends with the run's typed output (ui-streaming.mdx,
 * "Native agent runs"; native-agents.mdx, "Native agents in a UI").
 */
import {
  createInMemoryAgentRunStore,
  resumeStreamAgent,
  streamAgent,
} from '../../../src/agent-run';
import {
  agentStateFromParts,
  createInMemoryStreamStateStore,
  readDeuzStream,
  resumeDeuzStreamResponse,
  toDeuzAgentStreamResponse,
  type DeuzUIPart,
} from '../../../src/ui';
import type { AgentResult } from '../../../src/types/agent-run';
import type { EvalTaskManifest } from '../../../src/testing';
import { offline, runWith, type TaskModel } from '../support';

const MOCK = { provider: 'mock', id: 'mock-model', protocol: 'chat_completions' };

interface Cleanup {
  deleted: string[];
}

const cleanupOutput = {
  mode: 'json' as const,
  schema: {
    type: 'object',
    properties: { deleted: { type: 'array', items: { type: 'string' } } },
    required: ['deleted'],
  },
  validate: (value: unknown): Cleanup => {
    const deleted = (value as Partial<Cleanup> | null)?.deleted;
    if (!Array.isArray(deleted) || !deleted.every((name) => typeof name === 'string'))
      throw new Error('deleted must be an array of deployment names');
    return { deleted };
  },
};

/** What a client reads from one response: the parts, and the event id of each. */
async function readAll(response: Response): Promise<{ parts: DeuzUIPart[]; ids: number[] }> {
  const parts: DeuzUIPart[] = [];
  const ids: number[] = [];
  for await (const part of readDeuzStream(response, { onEventId: (id) => ids.push(Number(id)) }))
    parts.push(part);
  return { parts, ids };
}

/** Run the cleanup through the UI bridge on `on`'s model. */
export function approveFromUI(on: TaskModel): NonNullable<EvalTaskManifest['run']> {
  return async (context) => {
    const runs = createInMemoryAgentRunStore();
    const journal = createInMemoryStreamStateStore();
    const deleted: string[] = [];
    context.store.deleted = deleted;
    const options = {
      ...runWith(on, context),
      messages: context.messages,
      output: cleanupOutput,
      session: { store: runs, runId: 'cleanup-1', scope: 'eval' },
      tools: {
        delete_deployment: {
          description: 'Delete a preview deployment.',
          parameters: {
            type: 'object' as const,
            properties: { deployment: { type: 'string' } },
            required: ['deployment'],
          },
          needsApproval: true,
          execute: ({ deployment }: { deployment: string }) => {
            context.effect(`delete:${deployment}`);
            deleted.push(deployment);
            return `deleted ${deployment}`;
          },
        },
      },
    };
    // One journal per run, under its run id: every leg numbers on from the last.
    const wire = { store: journal, streamId: 'cleanup-1', runId: 'cleanup-1' };

    // Leg 1: the route streams the run, and the client folds what it reads.
    const first = streamAgent<Cleanup>(options);
    const leg1 = await readAll(toDeuzAgentStreamResponse(first, wire));
    const waiting = agentStateFromParts<Cleanup>(leg1.parts);
    context.store.asked =
      waiting.status === 'suspended'
        ? waiting.pendingApprovals.map((request) => ({
            tool: request.toolName,
            input: request.input,
          }))
        : waiting.status;
    context.store.deletedBeforeApproval = deleted.length;
    if (waiting.status !== 'suspended') return (await first.result) as AgentResult<Cleanup>;

    // Leg 2: the person approves in the UI; the client sends the verdicts.
    const resumed = resumeStreamAgent<Cleanup>({
      ...options,
      approvalResponses: context.approve(waiting.pendingApprovals),
    });
    const leg2 = await readAll(toDeuzAgentStreamResponse(resumed, wire));
    const final = agentStateFromParts<Cleanup>(leg2.parts, waiting);
    context.store.final =
      final.status === 'completed' ? { status: final.status, output: final.output } : final.status;

    // A client that joins late replays the run's journal from the start.
    const replay = await readAll(
      resumeDeuzStreamResponse(journal, 'cleanup-1', { pollIntervalMs: 1, idleTimeoutMs: 1_000 }),
    );
    const rebuilt = agentStateFromParts<Cleanup>(replay.parts);
    context.store.rebuilt =
      rebuilt.status === 'completed'
        ? { status: rebuilt.status, output: rebuilt.output }
        : rebuilt.status;
    const ids = [...leg1.ids, ...leg2.ids];
    context.store.journal = {
      // The second leg numbers on from the first instead of starting over.
      continued: (leg2.ids[0] ?? -1) > (leg1.ids.at(-1) ?? Infinity),
      increasing: ids.every((id, index) => index === 0 || id > ids[index - 1]!),
      replayedIds: JSON.stringify(replay.ids) === JSON.stringify(ids),
    };
    return resumed.result;
  };
}

export const uiApprovalRoundTrip: EvalTaskManifest = {
  id: 'ui/approval-round-trip',
  version: 1,
  title: 'Approve a pending call in the UI and get the typed result',
  tags: ['ui', 'approval', 'native'],
  model: MOCK,
  start: { messages: [{ role: 'user', content: 'Delete the stale preview deployment pr-418.' }] },
  tools: { allowed: ['delete_deployment'] },
  approvals: ['delete_deployment'],
  budget: { usd: 0.01 },
  acceptance: [
    {
      name: 'the client saw the run wait for the approval of the deletion',
      check: (_outcome, context) =>
        JSON.stringify(context.store.asked) ===
          JSON.stringify([{ tool: 'delete_deployment', input: { deployment: 'pr-418' } }]) &&
        context.store.deletedBeforeApproval === 0,
    },
    {
      name: 'deleted pr-418 once, after the approval',
      check: (_outcome, context) =>
        JSON.stringify(context.store.deleted) === JSON.stringify(['pr-418']),
    },
    {
      name: "the client's final state is the run's typed output",
      check: (outcome, context) =>
        outcome.status === 'completed' &&
        JSON.stringify(context.store.final) ===
          JSON.stringify({ status: 'completed', output: { deleted: ['pr-418'] } }),
    },
    {
      name: 'one journal across both legs: a late client rebuilds the same state',
      check: (_outcome, context) =>
        JSON.stringify(context.store.journal) ===
          JSON.stringify({ continued: true, increasing: true, replayedIds: true }) &&
        JSON.stringify(context.store.rebuilt) === JSON.stringify(context.store.final),
    },
  ],
  run: approveFromUI(
    offline([
      {
        toolCalls: [{ toolName: 'delete_deployment', id: 'd1', args: { deployment: 'pr-418' } }],
      },
      // The tool loop ends, then the finalization asks for the typed result.
      { text: 'Deleted pr-418.' },
      { text: JSON.stringify({ deleted: ['pr-418'] }) },
    ]),
  ),
};
