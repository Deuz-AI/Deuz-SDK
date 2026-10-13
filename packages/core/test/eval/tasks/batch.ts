/**
 * A batch, submitted and collected (2.3, `@deuz-sdk/core/batch`): three
 * support tickets go to a provider's batch API in one job; every request
 * reserves a hold under the run's execution context, the client polls until
 * the batch ends, and each result settles its hold on the batch tier
 * (batch.mdx). Offline, the provider is the in-memory stand-in of Anthropic's
 * Message Batches API (test/fixtures/batch-servers.ts); not live-verified.
 */
import { createAnthropic } from '../../../src/anthropic';
import { createBatchClient, createMemoryBatchJobStore } from '../../../src/batch';
import { createExecutionContext } from '../../../src/execution-policy';
import { createPriceProvider } from '../../../src/pricing';
import type { Usage } from '../../../src/types/usage';
import type { EvalTaskManifest } from '../../../src/testing';
import { fakeAnthropicBatches } from '../../fixtures/batch-servers';
import type { TaskModel } from '../support';

const HAIKU = { provider: 'anthropic', id: 'claude-haiku-5-5', protocol: 'messages' };

const TICKETS: Record<string, string> = {
  t1: 'I was charged twice for order 5512.',
  t2: 'The app crashes every time I open the settings page.',
  t3: 'I cannot sign in: the password reset email never arrives.',
};
const EXPECTED: Record<string, string> = { t1: 'billing', t2: 'bug', t3: 'account' };

const labelSchema = {
  type: 'object',
  properties: { label: { type: 'string', enum: ['billing', 'bug', 'account', 'other'] } },
  required: ['label'],
};

/** What the stand-in's model answers: a label read off the ticket's words. */
function labelOf(ticket: string): string {
  if (/charged|refund|invoice/i.test(ticket)) return 'billing';
  if (/crash|error|broken/i.test(ticket)) return 'bug';
  if (/sign in|password|log in/i.test(ticket)) return 'account';
  return 'other';
}

/** The user text of one Messages request body. */
function userText(params: Record<string, unknown>): string {
  const content = (params.messages as { content: unknown }[])[0]!.content;
  return typeof content === 'string'
    ? content
    : (content as { type: string; text?: string }[]).map((part) => part.text ?? '').join('');
}

/**
 * Claude Haiku 5.5 on the stand-in Message Batches API. A batch ends on its
 * second status read, each request answered by `labelOf`.
 */
export function offlineBatches(): TaskModel {
  return {
    model: () => {
      const server = fakeAnthropicBatches();
      const reads = new Map<string, number>();
      const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        const path = new URL(input instanceof Request ? input.url : String(input)).pathname;
        const status = /^\/v1\/messages\/batches\/([^/]+)$/.exec(path);
        if ((init?.method ?? 'GET') === 'GET' && status) {
          const id = decodeURIComponent(status[1]!);
          reads.set(id, (reads.get(id) ?? 0) + 1);
          if (reads.get(id) === 2) {
            const requests = server.batches.get(id)!.requests as {
              custom_id: string;
              params: Record<string, unknown>;
            }[];
            server.finish(
              id,
              Object.fromEntries(
                requests.map((request) => [
                  request.custom_id,
                  {
                    type: 'succeeded',
                    message: {
                      id: `msg_${request.custom_id}`,
                      type: 'message',
                      role: 'assistant',
                      model: HAIKU.id,
                      content: [
                        {
                          type: 'text',
                          text: JSON.stringify({ label: labelOf(userText(request.params)) }),
                        },
                      ],
                      stop_reason: 'end_turn',
                      stop_sequence: null,
                      usage: { input_tokens: 120, output_tokens: 8, cache_read_input_tokens: 0 },
                    },
                  },
                ]),
              ),
            );
          }
        }
        return server.fetch(input, init);
      }) as typeof globalThis.fetch;
      return createAnthropic({ apiKey: 'offline', fetch })(HAIKU.id);
    },
    prices: createPriceProvider(),
  };
}

/** Label the tickets in one batch on `on`'s model, polling every `pollMs`. */
export function triage(on: TaskModel, pollMs: number): NonNullable<EvalTaskManifest['run']> {
  return async (context) => {
    const tickets = context.store.tickets as Record<string, string>;
    const execution = createExecutionContext({
      scopeId: 'triage',
      budget: { usd: context.task.budget!.usd! },
    });
    const jobs = createMemoryBatchJobStore();
    const batch = createBatchClient({
      model: on.model(context),
      execution,
      store: jobs,
      deps: { priceProvider: on.prices },
    });
    const job = await batch.submit(
      Object.entries(tickets).map(([id, ticket]) => ({
        id,
        instructions: 'Label the support ticket: billing, bug, account or other.',
        prompt: ticket,
        schema: labelSchema,
        mode: 'json' as const,
        maxOutputTokens: 64,
      })),
    );
    await batch.wait(job, { intervalMs: pollMs, signal: context.signal });
    const results = await batch.collect(job);
    const settled = JSON.stringify(execution.ledger.snapshot());
    // Reading the results again settles nothing twice.
    await batch.collect(job);
    context.store.results = results
      .map((result) => ({
        id: result.id,
        status: result.status,
        label: (result.object as { label?: string } | undefined)?.label,
      }))
      .sort((left, right) => left.id.localeCompare(right.id));
    context.store.pricing = await Promise.all(
      results.map(async (result) => {
        const usage = result.usage as Usage;
        const standard = await on.prices.priceUsage(HAIKU.id, usage);
        const discounted = await on.prices.priceUsage(HAIKU.id, usage, { tier: 'batch' });
        return (
          result.costUsd !== undefined &&
          result.costUsd === discounted &&
          standard !== undefined &&
          Math.abs(result.costUsd * 2 - standard) < 1e-12
        );
      }),
    );
    context.store.holds = execution.ledger
      .snapshot()
      .reservations.filter((entry) => entry.kind === 'batch')
      .map((entry) => entry.state);
    context.store.readTwiceUnchanged = JSON.stringify(execution.ledger.snapshot()) === settled;
    context.store.job = {
      pending: (await batch.pending()).length,
      closed: (await jobs.get(job.id))?.closedAt !== undefined,
    };
    const succeeded = results.every((result) => result.status === 'succeeded' && !result.error);
    return {
      status: succeeded ? 'completed' : 'failed',
      output: Object.fromEntries(
        results.map((result) => [result.id, (result.object as { label?: string })?.label]),
      ),
      accounting: execution.ledger.totals(),
    };
  };
}

export const batchTriage: EvalTaskManifest = {
  id: 'batch/ticket-triage',
  version: 1,
  title: 'Label three tickets in one batch and collect every result',
  tags: ['batch'],
  model: HAIKU,
  start: { store: { tickets: TICKETS } },
  tools: { allowed: [] },
  budget: { usd: 0.05 },
  acceptance: [
    {
      name: 'one result per ticket, each labeled right',
      check: (outcome, context) =>
        outcome.status === 'completed' &&
        JSON.stringify(context.store.results) ===
          JSON.stringify(
            Object.entries(EXPECTED).map(([id, label]) => ({ id, status: 'succeeded', label })),
          ),
    },
    {
      name: 'priced on the batch tier, at half the standard rate',
      check: (_outcome, context) =>
        JSON.stringify(context.store.pricing) === JSON.stringify([true, true, true]),
    },
    {
      name: 'every hold settled once; reading the results again changed nothing',
      check: (_outcome, context) =>
        JSON.stringify(context.store.holds) === JSON.stringify(['settled', 'settled', 'settled']) &&
        context.store.readTwiceUnchanged === true,
    },
    {
      name: 'the job store closed the job',
      check: (_outcome, context) =>
        JSON.stringify(context.store.job) === JSON.stringify({ pending: 0, closed: true }),
    },
  ],
  run: triage(offlineBatches(), 1),
};
