/**
 * Model fail-over (2.3, 23.4): the run's primary model is overloaded, so its
 * call fails over to the next of `fallbackModels` inside the same run, which
 * finishes the work. The run records the fail-over and keeps the failed
 * attempt's hold (native-agents.mdx, "Model fail-over"). The primary is
 * Claude Opus 5.5 on the scripted Anthropic wire, answering 529.
 */
import { createInMemoryAgentRunStore, runAgent } from '../../../src/agent-run';
import { createAnthropic } from '../../../src/anthropic';
import type { EvalTaskManifest } from '../../../src/testing';
import { overloaded } from '../../fixtures/wire-turns';
import { completes, offline, runWith, type TaskModel } from '../support';

const MOCK = { provider: 'mock', id: 'mock-model', protocol: 'chat_completions' };
const PRIMARY = 'claude-opus-5-5';

interface Post {
  channel: string;
  text: string;
}

/** Run the task on a primary that is down, with `on`'s model as the fallback. */
export function failOver(on: TaskModel): NonNullable<EvalTaskManifest['run']> {
  return async (context) => {
    let primaryCalls = 0;
    const primary = createAnthropic({
      apiKey: 'offline',
      fetch: (async () => {
        primaryCalls += 1;
        if (primaryCalls === 1) context.interrupt('primary model overloaded');
        return overloaded();
      }) as typeof globalThis.fetch,
    })(PRIMARY);
    const { model: fallback, ...rest } = runWith(on, context);
    const runs = createInMemoryAgentRunStore();
    const posts: Post[] = [];
    context.store.posts = posts;
    const result = await runAgent({
      ...rest,
      model: primary,
      fallbackModels: [fallback],
      // Fail over at once instead of retrying the overloaded model.
      maxRetries: 0,
      messages: context.messages,
      session: { store: runs, runId: 'inc-7', scope: 'eval' },
      tools: {
        post_message: {
          description: 'Post a message to a team channel.',
          parameters: {
            type: 'object',
            properties: { channel: { type: 'string' }, text: { type: 'string' } },
            required: ['channel', 'text'],
          },
          execute: ({ channel, text }: Post) => {
            context.effect(`post:${channel}`);
            posts.push({ channel, text });
            return 'posted';
          },
        },
      },
    });
    const envelope = await runs.load('inc-7');
    context.store.failOver = {
      attempts: (envelope?.models?.attempts ?? []).map(
        (attempt) => `${attempt.model.modelId} -> ${attempt.next.modelId}`,
      ),
      selected: envelope?.models?.selected.modelId,
    };
    context.store.primaryCalls = primaryCalls;
    context.store.primaryHolds = (envelope?.execution?.ledger.reservations ?? [])
      .filter((entry) => entry.modelId === PRIMARY)
      .map((entry) => entry.state);
    return { ...result, recovery: 'failed-over' };
  };
}

export const primaryDown: EvalTaskManifest = {
  id: 'fallback/primary-down',
  version: 1,
  title: 'Finish the work on the fallback model when the primary is overloaded',
  tags: ['fallback', 'native'],
  model: MOCK,
  start: {
    messages: [
      {
        role: 'user',
        content:
          'Post to #ops that incident INC-7 is resolved: the cache node was restarted at 14:05.',
      },
    ],
  },
  tools: { allowed: ['post_message'] },
  budget: { usd: 0.01 },
  acceptance: [
    completes,
    {
      name: 'posted to #ops once',
      check: (_outcome, context) => {
        const posts = context.store.posts as Post[];
        return posts.length === 1 && posts[0]!.channel === '#ops' && /INC-7/.test(posts[0]!.text);
      },
    },
    {
      name: 'the run recorded the fail-over to its fallback',
      check: (_outcome, context) =>
        JSON.stringify(context.store.failOver) ===
        JSON.stringify({
          attempts: [`${PRIMARY} -> ${context.task.model!.id}`],
          selected: context.task.model!.id,
        }),
    },
    {
      name: 'the overloaded primary was called once and never again',
      check: (_outcome, context) => context.store.primaryCalls === 1,
    },
    {
      name: "the failed attempt's hold stays in the accounting",
      check: (outcome, context) =>
        JSON.stringify(context.store.primaryHolds) === JSON.stringify(['unknown']) &&
        (outcome.accounting?.unknownTokens ?? 0) >= 1,
    },
  ],
  run: failOver(
    offline([
      {
        toolCalls: [
          {
            toolName: 'post_message',
            id: 'p1',
            args: {
              channel: '#ops',
              text: 'INC-7 is resolved: the cache node was restarted at 14:05.',
            },
          },
        ],
      },
      { text: 'Posted the INC-7 resolution to #ops.' },
    ]),
  ),
};
