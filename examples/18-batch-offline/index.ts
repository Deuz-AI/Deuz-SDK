/**
 * 18 — Batch requests, offline: submit, poll, read, settle (2.3).
 *
 * `@deuz-sdk/core/batch` sends single-turn requests to a provider's batch API
 * and reads the answers back later, at the provider's batch rates. With an
 * execution context, every request reserves a budget hold when the batch is
 * submitted, before the provider sees anything, and each result settles its
 * hold as it is read. The provider is a scripted stand-in for Anthropic's
 * Message Batches API, plugged in as the model's `fetch`: no key, no network.
 */
import { createExecutionContext } from '@deuz-sdk/core/agent';
import { createAnthropic } from '@deuz-sdk/core/anthropic';
import { createBatchClient } from '@deuz-sdk/core/batch';
import type { BatchJob, BatchRequest, BatchStatus } from '@deuz-sdk/core/batch';
import { createPriceProvider, priceUsage } from '@deuz-sdk/core/pricing';

// --- THE SCRIPTED API -----------------------------------------------------------
// A stand-in for Anthropic's Message Batches API. It accepts a batch, reports it
// in progress on the first status read and ended from the second on, and then
// serves one result line per request from RESULTS.

/** A succeeded result: the reply the model would have written, with its usage. */
const answer = (text: string, input: number, output: number) => ({
  type: 'succeeded',
  message: {
    type: 'message',
    role: 'assistant',
    content: [{ type: 'text', text }],
    stop_reason: 'end_turn',
    usage: { input_tokens: input, output_tokens: output },
  },
});

/** What the provider did with each request, by request id. */
const RESULTS: Record<string, { type: string }> = {
  'ticket-1': answer('{"category":"bug","urgent":true}', 182, 14),
  'ticket-2': answer('{"category":"billing","urgent":true}', 179, 15),
  'ticket-3': { type: 'expired' }, // the batch window closed before it ran
  'ticket-4': answer('{"category":"question","urgent":false}', 176, 15),
};

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const batches = new Map<string, { ids: string[]; reads: number }>();

/** Anthropic's `request_counts`: everything processing until the batch ends. */
function requestCounts(ids: string[], ended: boolean) {
  const count = (type: string) =>
    (ended ? ids.filter((id) => RESULTS[id]!.type === type) : []).length;
  return {
    processing: ended ? 0 : ids.length,
    succeeded: count('succeeded'),
    errored: count('errored'),
    canceled: count('canceled'),
    expired: count('expired'),
  };
}

const scriptedApi = (async (input: string | URL | Request, init?: RequestInit) => {
  const { pathname } = new URL(input instanceof Request ? input.url : String(input));
  const method = init?.method ?? 'GET';
  console.log(`   [api] ${method} ${pathname}`);
  if (method === 'POST' && pathname === '/v1/messages/batches') {
    const { requests } = JSON.parse(String(init?.body)) as { requests: { custom_id: string }[] };
    const id = `msgbatch_0${batches.size + 1}`;
    const ids = requests.map((request) => request.custom_id);
    batches.set(id, { ids, reads: 0 });
    return json({
      id,
      type: 'message_batch',
      processing_status: 'in_progress',
      request_counts: requestCounts(ids, false),
    });
  }
  const [, id = '', results] =
    /^\/v1\/messages\/batches\/([\w-]+)(\/results)?$/.exec(pathname) ?? [];
  const batch = batches.get(id);
  if (!batch) {
    return json({ type: 'error', error: { type: 'not_found_error', message: 'Not found.' } }, 404);
  }
  if (results) {
    const lines = batch.ids.map((custom_id) =>
      JSON.stringify({ custom_id, result: RESULTS[custom_id] }),
    );
    return new Response(lines.join('\n'));
  }
  batch.reads += 1;
  const ended = batch.reads > 1;
  return json({
    id,
    type: 'message_batch',
    processing_status: ended ? 'ended' : 'in_progress',
    request_counts: requestCounts(batch.ids, ended),
    ...(ended
      ? { results_url: `https://api.anthropic.com/v1/messages/batches/${id}/results` }
      : {}),
  });
}) as typeof fetch;

// --- THE CLIENT -------------------------------------------------------------------
// REAL PROVIDER: drop `fetch: scriptedApi` and pass your key:
//   const anthropic = createAnthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
// OpenAI (`createOpenAIResponses`) and Gemini (`createGoogleNative`) models batch
// through the same client.
const anthropic = createAnthropic({ apiKey: 'offline', fetch: scriptedApi });
const priceProvider = createPriceProvider(); // the bundled table, batch cards included
// A run's budget: every hold is admitted against it when the batch is submitted.
const execution = createExecutionContext({ budget: { usd: 0.05 } });
const batch = createBatchClient({
  model: anthropic('claude-sonnet-5-5'),
  execution,
  deps: { priceProvider },
});

// Structured output, as for generateObject: each result's `object` is the parsed reply.
const triage = {
  type: 'object',
  properties: {
    category: { type: 'string', enum: ['bug', 'billing', 'question'] },
    urgent: { type: 'boolean' },
  },
  required: ['category', 'urgent'],
  additionalProperties: false,
};
const ticket = (id: string, text: string): BatchRequest => ({
  id,
  instructions: 'Triage the support ticket: pick its category and say whether it is urgent.',
  prompt: text,
  schema: triage,
  maxOutputTokens: 200, // the hold reserves this much output: keep it close to what you need
});

// --- OUTPUT -------------------------------------------------------------------------
const usd = (value: number | undefined) =>
  value === undefined ? 'no price' : `$${Number(value.toFixed(6))}`;

/** The ledger's record of a request's hold: the estimate while held, the usage once settled. */
function hold(job: BatchJob, requestId: string): string {
  const record = execution.ledger.get(job.requests.find((r) => r.id === requestId)!.hold!.id)!;
  switch (record.state) {
    case 'reserved':
      return `hold reserved: ${record.reservation.tokens} tokens, ${usd(record.reservation.usd)}`;
    case 'settled':
      return `hold settled: ${record.actual.tokens} tokens, ${usd(record.actual.usd)}`;
    case 'released':
      return 'hold released';
    case 'unknown':
      // Usage without a price: its tokens count, its dollars stay out of USD totals.
      // An error that may have been billed (no usage) keeps the whole estimate held.
      return record.actual.tokens === undefined
        ? `hold unknown: ${record.reservation.tokens} tokens still held (it may have been billed)`
        : `hold unknown: ${record.actual.tokens} tokens, cost unknown (left out of USD totals)`;
  }
}

function showLedger(): void {
  const { spent, reserved, unpriced } = execution.ledger.totals();
  console.log(
    `   ledger: ${usd(spent.usd)} spent, ${usd(reserved.usd)} held, budget ${usd(execution.budget.usd)}` +
      (unpriced ? `; ${unpriced} call without a price` : ''),
  );
}

function showStatus(status: BatchStatus): void {
  const counts = Object.entries(status.counts ?? {})
    .filter(([name, n]) => name !== 'total' && n)
    .map(([name, n]) => `${n} ${name}`);
  console.log(`   [status] ${status.state} (${status.providerState}): ${counts.join(', ')}`);
}

// --- THE STEPS ----------------------------------------------------------------------
console.log('1) submit: each request reserves a hold, at batch rates, before anything is sent');
const job = await batch.submit([
  ticket('ticket-1', 'The app crashes every time I upload a photo from my phone.'),
  ticket('ticket-2', 'I was charged twice for my October invoice.'),
  ticket('ticket-3', 'How do I export my projects as CSV?'),
]);
const holdHours = (job.holdUntil - job.submittedAt) / 3_600_000;
console.log(`   job ${job.id} on ${job.modelId}: holds stay open up to ${holdHours} h (holdMs)`);
for (const request of job.requests) console.log(`   ${request.id}: ${hold(job, request.id)}`);
showLedger();

console.log('\n2) wait: poll until the batch ends (a real batch takes minutes to hours)');
await batch.wait(job, { intervalMs: 500, onStatus: showStatus }); // the default interval is 60 s

console.log('\n3) results: each one settles its hold before it is handed out');
for await (const result of batch.results(job)) {
  if (result.status === 'succeeded' && result.usage) {
    const standard = priceUsage(job.modelId, result.usage);
    console.log(`   ${result.id} ${result.status}: ${JSON.stringify(result.object)}`);
    console.log(
      `      ${result.usage.inputTokens} in / ${result.usage.outputTokens} out: ` +
        `${usd(result.costUsd)} at batch rates (${usd(standard)} standard)`,
    );
  } else if (result.status === 'errored') {
    console.log(`   ${result.id} ${result.status}: ${result.error?.message}`);
  } else {
    console.log(`   ${result.id} ${result.status}: never ran, so never billed`);
  }
  console.log(`      ${hold(job, result.id)}`);
}
showLedger();

console.log('\n4) a model without a batch price: it still runs, with an unpriced-model warning');
// Claude Sonnet 4.5 has a standard price in the bundled table, but no batch card.
const older = createBatchClient({
  model: anthropic('claude-sonnet-4-5'),
  execution,
  deps: { priceProvider },
});
const second = await older.submit([ticket('ticket-4', 'Can I change the email on my account?')]);
for (const warning of second.warnings ?? []) {
  console.log(`   [warning] ${warning.type}: ${warning.message}`);
}
console.log(`   ticket-4: ${hold(second, 'ticket-4')}`);
await older.wait(second, { intervalMs: 500, onStatus: showStatus });
for (const result of await older.collect(second)) {
  console.log(
    `   ${result.id} ${result.status}: ${JSON.stringify(result.object)}, cost ${usd(result.costUsd)}`,
  );
  console.log(`      ${hold(second, result.id)}`);
}
showLedger();
