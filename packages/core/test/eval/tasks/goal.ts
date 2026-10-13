/**
 * A goal and its wakeup (2.3, 23.6): a goal waits for its weekly schedule; an
 * early pass and a second process's delivery of the same occurrence change
 * nothing; the woken goal's native run does the work; the run's spend is
 * charged once; and the goal completes only on evidence from outside the
 * model (goals.mdx). Every transition takes its time explicitly, and the
 * scheduler is ticked by hand: no timer runs.
 */
import { createInMemoryAgentRunStore, runAgent } from '../../../src/agent-run';
import {
  createGoal,
  createInMemoryGoalStore,
  goalEventFromOccurrence,
  parseGoal,
  serializeGoal,
  transitionGoal,
  type GoalCommand,
  type GoalRecord,
  type GoalStore,
} from '../../../src/goal';
import { createScheduler } from '../../../src/schedule';
import type { EvalTaskManifest } from '../../../src/testing';
import { offline, runWith, type TaskModel } from '../support';

const MOCK = { provider: 'mock', id: 'mock-model', protocol: 'chat_completions' };
/** Monday 2026-10-12, 08:00 UTC: the goal is set. */
const START = Date.UTC(2026, 9, 12, 8);
/** 09:00 UTC that Monday: the schedule's occurrence. */
const DUE = Date.UTC(2026, 9, 12, 9);

/** Load, transition, save at the next revision; what the goal did. */
async function step(
  goals: GoalStore,
  goalId: string,
  command: GoalCommand,
  now: number,
  revisions: number[],
): Promise<{ record: GoalRecord; outcome: string; reason?: string; acceptance?: string }> {
  const goal = (await goals.load(goalId))!;
  const next = transitionGoal(goal, command, { now });
  if (next.changed) {
    await goals.save(next.record);
    revisions.push(next.record.revision);
  }
  return {
    record: next.record,
    outcome: next.outcome,
    ...(next.reason !== undefined ? { reason: next.reason } : {}),
    ...(next.acceptance !== undefined ? { acceptance: next.acceptance.verdict } : {}),
  };
}

/** Run the digest goal; its native run works on `on`'s model. */
export function digestGoal(on: TaskModel): NonNullable<EvalTaskManifest['run']> {
  return async (context) => {
    const goals = createInMemoryGoalStore();
    const revisions: number[] = [];
    const objective = String(context.messages[0]!.content);
    const goal = createGoal(
      {
        goalId: 'weekly-digest',
        scope: 'acme',
        objective,
        criteria: [{ id: 'delivered', description: 'The digest reached #team.' }],
        budget: { usd: 0.05 },
      },
      { now: START },
    );
    await goals.save(goal);
    revisions.push(goal.revision);
    const wakeup = { reason: 'wakeup', at: DUE, schedule: 'weekly-digest' } as const;
    await step(goals, 'weekly-digest', { type: 'wait', wait: wakeup }, START, revisions);

    // A periodic pass at 08:30 finds the wakeup not due yet.
    const wakeups: string[] = [];
    const early = await step(goals, 'weekly-digest', { type: 'tick' }, DUE - 1_800_000, revisions);
    wakeups.push(early.reason ?? early.outcome);
    // Two processes run the schedule, each with its own in-memory claim, so
    // both deliver the 09:00 occurrence: the goal's dedupe keeps one.
    for (const worker of ['a', 'b']) {
      const scheduler = createScheduler({
        schedules: [
          {
            id: 'weekly-digest',
            cron: '0 9 * * 1',
            run: async (occurrence) => {
              const event = goalEventFromOccurrence(occurrence, {
                scope: 'acme',
                goalId: 'weekly-digest',
              });
              const delivered = await step(
                goals,
                'weekly-digest',
                { type: 'event', event },
                occurrence.at + 1_000,
                revisions,
              );
              wakeups.push(delivered.reason ?? delivered.outcome);
            },
          },
        ],
      });
      const ticked = await scheduler.tick(DUE + 1_000);
      context.store[`worker-${worker}`] = ticked.occurrences.map((entry) => entry.status);
    }
    context.store.wakeups = wakeups;

    // The woken goal's run.
    const woken = (await goals.load('weekly-digest'))!;
    if (woken.status !== 'active') return { status: 'stopped', reason: `goal ${woken.status}` };
    await step(
      goals,
      'weekly-digest',
      { type: 'link-run', runId: 'digest-1' },
      DUE + 2_000,
      revisions,
    );
    const runs = createInMemoryAgentRunStore();
    const sent: string[] = [];
    context.store.sent = sent;
    const result = await runAgent({
      ...runWith(on, context),
      messages: context.messages,
      session: { store: runs, runId: 'digest-1', scope: 'acme' },
      tools: {
        send_digest: {
          description: "Send this week's digest to a channel.",
          parameters: {
            type: 'object',
            properties: { channel: { type: 'string' } },
            required: ['channel'],
          },
          execute: ({ channel }: { channel: string }) => {
            context.effect(`digest:2026-W42:${channel}`);
            sent.push(channel);
            return `digest sent to ${channel}`;
          },
        },
      },
    });

    // The run's spend, keyed by the run: a repeated bookkeeping pass is a duplicate.
    const spent = result.accounting?.spent ?? { tokens: result.usage.totalTokens, usd: 0 };
    const charge = {
      type: 'charge',
      usd: spent.usd,
      tokens: spent.tokens,
      key: 'digest-1',
    } as const;
    const charged = [
      await step(goals, 'weekly-digest', charge, DUE + 3_000, revisions),
      await step(goals, 'weekly-digest', charge, DUE + 4_000, revisions),
    ];
    context.store.charges = charged.map((entry) => entry.reason ?? entry.outcome);
    context.store.runSpent = spent;

    // The model says it sent the digest: that alone passes nothing.
    const claimed = await step(
      goals,
      'weekly-digest',
      {
        type: 'evaluate',
        evidence: [{ id: 'answer', source: 'model', ref: 'run:digest-1', summary: result.text }],
        results: [
          { criterionId: 'delivered', verdict: 'passed', source: 'model', evidence: ['answer'] },
        ],
      },
      DUE + 5_000,
      revisions,
    );
    const refused = await step(
      goals,
      'weekly-digest',
      { type: 'complete' },
      DUE + 6_000,
      revisions,
    );
    context.store.claim = { acceptance: claimed.acceptance, complete: refused.reason };

    // The tool's receipt in the run's checkpoint is evidence from outside the model.
    const receipt = Object.values((await runs.load('digest-1'))?.toolResults ?? {}).find(
      (entry) => entry.toolName === 'send_digest' && entry.stage === 'completed',
    );
    if (receipt) {
      await step(
        goals,
        'weekly-digest',
        {
          type: 'evaluate',
          evidence: [
            {
              id: 'receipt',
              source: 'tool',
              ref: `run:digest-1/tool:${receipt.toolCallId}`,
              runId: 'digest-1',
              summary: `send_digest(${JSON.stringify(receipt.input)}) completed`,
            },
          ],
          results: [
            { criterionId: 'delivered', verdict: 'passed', source: 'tool', evidence: ['receipt'] },
          ],
        },
        DUE + 7_000,
        revisions,
      );
      await step(goals, 'weekly-digest', { type: 'complete' }, DUE + 8_000, revisions);
    }
    const final = (await goals.load('weekly-digest'))!;
    context.store.goal = {
      status: final.status,
      outcome: final.outcome?.reason,
      runId: final.runId,
      verdict: final.results.map(
        (entry) => `${entry.criterionId}:${entry.verdict}:${entry.source}`,
      ),
      spent: final.spent,
    };
    context.store.revisions = revisions;
    context.store.roundTrips =
      JSON.stringify(parseGoal(serializeGoal(final))) === JSON.stringify(final);
    return result;
  };
}

export const scheduledDigest: EvalTaskManifest = {
  id: 'goal/scheduled-digest',
  version: 1,
  title: 'A goal woken once by its schedule, completed on evidence',
  tags: ['goal', 'wakeup', 'native'],
  model: MOCK,
  start: { messages: [{ role: 'user', content: "Send this week's digest to #team." }] },
  tools: { allowed: ['send_digest'] },
  budget: { usd: 0.01 },
  acceptance: [
    {
      name: 'the goal completed on the tool receipt, not on the model saying so',
      check: (_outcome, context) => {
        const goal = context.store.goal as { status: string; outcome?: string; verdict: string[] };
        return (
          goal.status === 'completed' &&
          goal.outcome === 'accepted' &&
          JSON.stringify(goal.verdict) === JSON.stringify(['delivered:passed:tool']) &&
          JSON.stringify(context.store.claim) ===
            JSON.stringify({ acceptance: 'inconclusive', complete: 'acceptance-not-passed' })
        );
      },
    },
    {
      name: 'woken once: the early pass and the second delivery changed nothing',
      check: (_outcome, context) =>
        JSON.stringify(context.store.wakeups) ===
          JSON.stringify(['unchanged', 'applied', 'duplicate']) &&
        JSON.stringify(context.store['worker-a']) === JSON.stringify(['ran']) &&
        JSON.stringify(context.store['worker-b']) === JSON.stringify(['ran']),
    },
    {
      name: 'the digest went to #team once, from the run the goal links',
      check: (_outcome, context) =>
        JSON.stringify(context.store.sent) === JSON.stringify(['#team']) &&
        (context.store.goal as { runId?: string }).runId === 'digest-1',
    },
    {
      name: "the run's spend was charged once",
      check: (_outcome, context) => {
        const spent = (context.store.goal as { spent: { usd: number; tokens: number } }).spent;
        const run = context.store.runSpent as { usd: number; tokens: number };
        return (
          JSON.stringify(context.store.charges) === JSON.stringify(['applied', 'duplicate']) &&
          spent.tokens === run.tokens &&
          Math.abs(spent.usd - run.usd) < 1e-12
        );
      },
    },
    {
      name: 'every change was saved at the next revision, and the record round-trips',
      check: (_outcome, context) => {
        const revisions = context.store.revisions as number[];
        return (
          revisions.every((revision, index) => revision === index + 1) &&
          context.store.roundTrips === true
        );
      },
    },
  ],
  run: digestGoal(
    offline([
      { toolCalls: [{ toolName: 'send_digest', id: 'd1', args: { channel: '#team' } }] },
      { text: "Sent this week's digest to #team." },
    ]),
  ),
};
