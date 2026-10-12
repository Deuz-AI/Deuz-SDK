/**
 * The compaction boundary of a Claude 5.x run (2.3, F22 and 23.4): a native run
 * on claude-opus-5-5 with memory compacts in the middle of its tool loop, then
 * the process dies and the run resumes (preserved-thinking.mdx; native-agents
 * .mdx, "Memory"). Claude 5.x binds each thinking block to the request before
 * it, so every request must extend the one before it byte for byte, except
 * across the compaction, where one summary replaces the conversation and no
 * earlier thinking is replayed. Scripted Anthropic wire; not live-verified.
 */
import { createInMemoryAgentRunStore, resumeAgent, runAgent } from '../../../src/agent-run';
import type { AgentRunEnvelope } from '../../../src/types/agent-run';
import type { EvalTaskManifest } from '../../../src/testing';
import {
  prefixBreak,
  prefixBreaks,
  scriptedClaude,
  thinkThenAnswer,
  thinkThenCall,
  type ClaudeRequest,
} from '../../helpers/stable-prefix';
import {
  costKept,
  memoryRecord,
  mockPrices,
  parameters,
  ranOnce,
  stages,
  watchedMemory,
} from './support';

const QUESTION = 'Research my coffee, then order it.';
const MEMORY = 'User prefers dark roast coffee';
const SUMMARIZED = '[Earlier conversation summarized]';

/** A summary side call: the loop's own compaction request, by its prompt. */
const isSummary = (request: ClaudeRequest) =>
  JSON.stringify(request.messages).includes('Output only the summary') ||
  JSON.stringify(request.messages).includes('Output only the updated summary');

/** The thinking signatures a request replays, as they appear in its body. */
const signatures = (request: ClaudeRequest): string[] =>
  JSON.stringify(request.messages).match(/"signature":"[^"]+"/g) ?? [];

export const compactionPreservedThinking: EvalTaskManifest = {
  id: 'fault/compaction-preserved-thinking',
  version: 1,
  title: 'A Claude 5.x run compacts mid-loop, then the process dies and the run resumes',
  tags: ['fault', 'native', 'compaction', 'preserved-thinking', 'memory'],
  model: { provider: 'anthropic', id: 'claude-opus-5-5', protocol: 'messages' },
  start: {
    messages: [
      { role: 'system', content: 'You research and buy coffee.' },
      { role: 'user', content: QUESTION },
    ],
  },
  // Documented (preserved-thinking.mdx): on Claude 5.x one summary replaces the
  // conversation, and the compacted history is checkpointed like any other; a
  // resume replays it unchanged. The run recalled once, before its first call.
  fault: { boundary: 'compaction-boundary', recovery: 'resumed-on-compacted-prefix' },
  acceptance: [
    { name: 'completes', check: (outcome) => outcome.status === 'completed' },
    ranOnce('order:dark-roast'),
    {
      name: 'one summary, and the resume did not compact again',
      check: (_outcome, context) => context.store.summaries === 1,
    },
    {
      name: 'every request extends the one before it, except across the compaction',
      check: (_outcome, context) =>
        JSON.stringify(context.store.breaks) === JSON.stringify(['at the compaction']),
    },
    {
      name: 'no thinking from before the summary is replayed after it',
      check: (_outcome, context) => context.store.replayedOldThinking === false,
    },
    {
      name: 'the resumed request extends the last one before the crash, its thinking unchanged',
      check: (_outcome, context) =>
        context.store.resumedExtends === true && context.store.resumedReplays === true,
    },
    {
      name: 'recall ran once, with the question, never the summary',
      check: (_outcome, context) =>
        JSON.stringify(context.store.recallQueries) === JSON.stringify([QUESTION]),
    },
    costKept,
  ],
  async run(context) {
    const memory = await watchedMemory([memoryRecord('m-0', MEMORY, { userId: 'u1' })]);
    let searches = 0;
    const claude = scriptedClaude((request) => {
      const body = JSON.stringify(request.messages);
      if (isSummary(request))
        return thinkThenAnswer('SX', 'CONDENSED: four searches, beans found.');
      if (body.includes(SUMMARIZED))
        return body.includes('"tool_use_id":"tu_order"')
          ? thinkThenAnswer('SD', 'Ordered the dark roast.')
          : thinkThenCall('SB', 'tu_order', 'order');
      return thinkThenCall(`S${searches}`, `tu_${searches++}`, 'search');
    }, 'claude-opus-5-5');
    const durable = createInMemoryAgentRunStore();
    let requestsBeforeCrash: number | undefined;
    const options = {
      model: claude.model,
      messages: context.messages,
      tools: {
        search: {
          description: 'Search the coffee notes.',
          parameters,
          execute: () => 'found beans',
        },
        order: {
          description: 'Order the coffee.',
          parameters,
          execute: () => {
            context.effect('order:dark-roast');
            ((context.store.effects as string[] | undefined) ??= []).push('order:dark-roast');
            return 'ordered';
          },
        },
      },
      maxSteps: 10,
      // 100 "tokens" a message in a 1,000-token window: the history passes the
      // threshold after the fourth search, inside the tool loop.
      capabilities: { contextWindow: 1_000 },
      compaction: { threshold: 0.5, countTokens: (messages: unknown[]) => messages.length * 100 },
      memory: { seams: memory.seams, scope: { userId: 'u1' }, extract: false as const },
      deps: { observer: context.observer, priceProvider: mockPrices },
    };
    // The process dies once the step after the order is admitted: the
    // compacted history and the order's receipt are already checkpointed.
    const dying = {
      load: (runId: string) => durable.load(runId),
      save(envelope: AgentRunEnvelope) {
        if (
          requestsBeforeCrash === undefined &&
          stages(envelope).includes('tu_order:completed') &&
          envelope.execution?.ledger.reservations.some((entry) => entry.state === 'reserved')
        ) {
          requestsBeforeCrash = claude.requests.length;
          context.interrupt('compaction-boundary');
          throw new Error('process died');
        }
        return durable.save(envelope);
      },
    };
    const first = await runAgent({
      ...options,
      session: { store: dying, runId: 'c', scope: 'eval' },
    });
    const resumed = await resumeAgent({
      ...options,
      session: { store: durable, runId: 'c', scope: 'eval' },
    });

    const requests = claude.requests;
    const conversation = requests.filter((request) => !isSummary(request));
    const firstCompacted = conversation.findIndex((request) =>
      JSON.stringify(request.messages).includes(SUMMARIZED),
    );
    context.store.summaries = requests.filter(isSummary).length;
    context.store.breaks = prefixBreaks(conversation).map((hit) =>
      hit.startsWith(`request ${firstCompacted - 1} -> ${firstCompacted}:`)
        ? 'at the compaction'
        : hit,
    );
    const before = new Set(conversation.slice(0, firstCompacted).flatMap(signatures));
    context.store.replayedOldThinking = conversation
      .slice(firstCompacted)
      .some((request) => signatures(request).some((signature) => before.has(signature)));
    const lastBefore = requests[(requestsBeforeCrash ?? 0) - 1];
    const firstAfter = requests[requestsBeforeCrash ?? 0];
    context.store.resumedExtends =
      lastBefore !== undefined && firstAfter !== undefined && !prefixBreak(lastBefore, firstAfter);
    context.store.resumedReplays =
      firstAfter !== undefined && signatures(firstAfter).includes('"signature":"SB"');
    context.store.recallQueries = memory.searches.map((query) => query.text);
    context.store.billedCalls = requests.length;
    return {
      ...resumed,
      recovery:
        first.status === 'failed' &&
        resumed.status === 'completed' &&
        requests.filter(isSummary).length === 1
          ? 'resumed-on-compacted-prefix'
          : 'other',
    };
  },
};
