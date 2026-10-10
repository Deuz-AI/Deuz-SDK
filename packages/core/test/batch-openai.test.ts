import { describe, expect, it } from 'vitest';
import { createBatchClient } from '../src/batch/client';
import { BatchError } from '../src/batch/errors';
import { InvalidRequestError } from '../src/errors';
import { createOpenAI, createOpenAIResponses } from '../src/openai';
import { createPriceProvider, PRICES_2026 } from '../src/pricing';
import { fakeOpenAIBatches } from './fixtures/batch-servers';
import { manualClock } from './fixtures/manual-clock';

// BA2: OpenAI's Batch API, driven end to end against an in-memory stand-in:
// a JSONL input file (Files API, purpose 'batch'), then Batches. Not
// live-verified; shapes from openai 7.32 and the Batch guide it links to.

const HOUR = 3_600_000;

function setup(
  surface: 'responses' | 'chat' = 'responses',
  extra: { priceProvider?: unknown } = {},
) {
  const server = fakeOpenAIBatches();
  const factory = surface === 'responses' ? createOpenAIResponses : createOpenAI;
  const model = factory({ apiKey: 'sk-test', fetch: server.fetch })(
    surface === 'responses' ? 'gpt-5.6-sol' : 'gpt-5-mini',
  );
  const { clock } = manualClock(1_000);
  let n = 0;
  const batch = createBatchClient({
    model,
    deps: { clock, generateId: () => `id${++n}`, ...extra } as never,
  });
  return { server, model, batch };
}

const reply = (text: string, usage: Record<string, unknown> = {}) => ({
  id: 'resp_1',
  object: 'response',
  status: 'completed',
  error: null,
  incomplete_details: null,
  output: [
    {
      type: 'message',
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_text', text, annotations: [] }],
    },
  ],
  usage: {
    input_tokens: 1000,
    input_tokens_details: { cached_tokens: 0 },
    output_tokens: 500,
    output_tokens_details: { reasoning_tokens: 0 },
    total_tokens: 1500,
    ...usage,
  },
});

describe('OpenAI batch: submit', () => {
  it('uploads the requests as a JSONL file and creates a 24-hour batch on /v1/responses', async () => {
    const { server, batch } = setup();
    const job = await batch.submit([
      { id: 'a', prompt: 'Summarize A.', maxOutputTokens: 100 },
      { id: 'b', instructions: 'Be terse.', prompt: 'Summarize B.' },
    ]);
    const upload = server.calls.find((call) => call.url.endsWith('/v1/files'))!;
    expect(upload.method).toBe('POST');
    expect(upload.headers.get('authorization')).toBe('Bearer sk-test');
    // The multipart body sets its own content type with the boundary.
    expect(upload.headers.get('content-type')).toBeNull();
    const form = upload.body as FormData;
    expect(form.get('purpose')).toBe('batch');
    expect((form.get('file') as File).name).toMatch(/\.jsonl$/);

    const lines = server.inputLines(job.id);
    expect(lines.map((line) => [line.custom_id, line.method, line.url])).toEqual([
      ['a', 'POST', '/v1/responses'],
      ['b', 'POST', '/v1/responses'],
    ]);
    expect(lines[0]!.body).toMatchObject({
      model: 'gpt-5.6-sol',
      max_output_tokens: 100,
      store: false,
    });
    expect(lines[0]!.body).not.toHaveProperty('stream');
    expect(lines[1]!.body).toMatchObject({ instructions: 'Be terse.' });

    const create = server.calls.find((call) => call.url.endsWith('/v1/batches'))!;
    expect(JSON.parse(create.body as string)).toEqual({
      input_file_id: job.inputFileId,
      endpoint: '/v1/responses',
      completion_window: '24h',
    });
    expect(create.headers.get('content-type')).toBe('application/json');
  });

  it('returns a plain JSON job handle', async () => {
    const { batch } = setup();
    const job = await batch.submit([{ id: 'a', prompt: 'x' }]);
    expect(job).toMatchObject({
      version: 1,
      protocol: 'openai',
      provider: 'openai',
      modelId: 'gpt-5.6-sol',
      surface: 'responses',
      endpoint: '/v1/responses',
      submittedAt: 1_000,
      expiresAt: 1_700_086_400_000,
      holdUntil: 1_000 + 25 * HOUR,
      requests: [{ id: 'a' }],
    });
    expect(job.id).toMatch(/^batch_/);
    expect(JSON.parse(JSON.stringify(job))).toEqual(job);
  });

  it('targets /v1/chat/completions for a Chat Completions model', async () => {
    const { server, batch } = setup('chat');
    const job = await batch.submit([{ id: 'a', prompt: 'x' }]);
    expect(job.endpoint).toBe('/v1/chat/completions');
    const line = server.inputLines(job.id)[0]!;
    expect(line.url).toBe('/v1/chat/completions');
    expect(line.body).not.toHaveProperty('stream_options');
  });

  it('labels the batch through metadata', async () => {
    const { server, batch } = setup();
    await batch.submit([{ id: 'a', prompt: 'x' }], { displayName: 'nightly' });
    const create = server.calls.find((call) => call.url.endsWith('/v1/batches'))!;
    expect(JSON.parse(create.body as string).metadata).toEqual({ display_name: 'nightly' });
  });

  it('refuses more than 50,000 requests before uploading anything', async () => {
    const { server, batch } = setup();
    const requests = Array.from({ length: 50_001 }, (_, i) => ({ id: `r${i}`, prompt: 'x' }));
    await expect(batch.submit(requests)).rejects.toMatchObject({ kind: 'invalid-request' });
    expect(server.calls).toHaveLength(0);
  }, 30_000);
});

describe('OpenAI batch: status and cancel', () => {
  it.each([
    ['validating', 'pending', false],
    ['in_progress', 'running', false],
    ['finalizing', 'running', false],
    ['cancelling', 'cancelling', false],
    ['completed', 'completed', true],
    ['cancelled', 'cancelled', true],
    ['expired', 'expired', true],
    ['failed', 'failed', true],
    ['something_new', 'running', false],
  ])('normalizes %s to %s', async (provider, state, ended) => {
    const { server, batch } = setup();
    const job = await batch.submit([{ id: 'a', prompt: 'x' }]);
    server.setStatus(job.id, provider);
    expect(await batch.status(job)).toMatchObject({
      id: job.id,
      state,
      ended,
      providerState: provider,
    });
  });

  it('reports request counts and the expiry', async () => {
    const { server, batch } = setup();
    const job = await batch.submit([
      { id: 'a', prompt: 'x' },
      { id: 'b', prompt: 'y' },
    ]);
    server.finish(job.id, 'completed', {
      a: { body: reply('A') },
      b: { status: 400, body: { error: { message: 'bad' } } },
    });
    expect(await batch.status(job)).toMatchObject({
      counts: { total: 2, succeeded: 1, errored: 1, processing: 0 },
      expiresAt: 1_700_086_400_000,
    });
  });

  it('cancels through POST /batches/{id}/cancel', async () => {
    const { server, batch } = setup();
    const job = await batch.submit([{ id: 'a', prompt: 'x' }]);
    const status = await batch.cancel(job);
    expect(status.state).toBe('cancelling');
    expect(server.calls.at(-1)).toMatchObject({ method: 'POST' });
    expect(server.calls.at(-1)!.url).toMatch(/\/v1\/batches\/batch_\d+\/cancel$/);
  });
});

describe('OpenAI batch: results', () => {
  it('reads both result files and normalizes every request, whatever the order', async () => {
    const { server, batch } = setup();
    const job = await batch.submit([
      { id: 'ok', prompt: 'x' },
      { id: 'bad', prompt: 'y' },
      { id: 'late', prompt: 'z' },
    ]);
    server.finish(job.id, 'completed', {
      late: { error: { code: 'batch_expired', message: 'Not run in time.' } },
      bad: {
        status: 400,
        body: { error: { message: 'Invalid prompt.', type: 'invalid_request_error' } },
      },
      ok: {
        body: reply('Hello', { input_tokens: 1200, input_tokens_details: { cached_tokens: 200 } }),
      },
    });
    const results = await batch.collect(job);
    // The output file first, then the error file: the provider's order, each
    // result yielded (and settled) as it is read.
    expect(results.map((result) => [result.id, result.status])).toEqual([
      ['ok', 'succeeded'],
      ['late', 'expired'],
      ['bad', 'errored'],
    ]);
    const ok = results[0]!;
    expect(ok).toMatchObject({ text: 'Hello', finishReason: 'stop', usageAvailable: true });
    expect(ok.usage).toMatchObject({ inputTokens: 1000, cachedReadTokens: 200, outputTokens: 500 });
    const bad = results[2]!;
    expect(bad.error).toBeInstanceOf(InvalidRequestError);
    expect(bad.error!.message).toBe('Invalid prompt.');
    expect((bad.error as InvalidRequestError).requestId).toBe('req_2');
  });

  it('prices each result on the batch tier, and leaves a model without a batch card unpriced', async () => {
    const carded = createPriceProvider({
      table: { 'gpt-5.6-sol': { ...PRICES_2026['gpt-5.6-sol']!, batch: { input: 2, output: 10 } } },
    });
    const { server, batch } = setup('responses', { priceProvider: carded });
    const job = await batch.submit([{ id: 'a', prompt: 'x' }]);
    server.finish(job.id, 'completed', { a: { body: reply('A') } });
    const [result] = await batch.collect(job);
    // 1,000 input tokens at $2/M + 500 output tokens at $10/M.
    expect(result!.costUsd).toBe(0.007);

    const plain = setup('responses', { priceProvider: createPriceProvider() });
    const other = await plain.batch.submit([{ id: 'a', prompt: 'x' }]);
    plain.server.finish(other.id, 'completed', { a: { body: reply('A') } });
    const [unpriced] = await plain.batch.collect(other);
    expect(unpriced!.costUsd).toBeUndefined();
    expect(unpriced!.usage).toBeDefined();
  });

  it('reports a request the provider never answered after a completed batch as an error', async () => {
    const { server, batch } = setup();
    const job = await batch.submit([
      { id: 'a', prompt: 'x' },
      { id: 'b', prompt: 'y' },
    ]);
    server.finish(job.id, 'completed', { a: { body: reply('A') } });
    const results = await batch.collect(job);
    expect(results[1]).toMatchObject({ id: 'b', status: 'errored', text: '' });
    expect(results[1]!.error).toBeInstanceOf(BatchError);
    expect(results[1]!.error!.message).toMatch(/no result/i);
  });

  it('marks the requests of a cancelled batch that never ran as cancelled', async () => {
    const { server, batch } = setup();
    const job = await batch.submit([
      { id: 'a', prompt: 'x' },
      { id: 'b', prompt: 'y' },
    ]);
    await batch.cancel(job);
    server.finish(job.id, 'cancelled', { a: { body: reply('A') } });
    const results = await batch.collect(job);
    expect(results.map((result) => [result.id, result.status])).toEqual([
      ['a', 'succeeded'],
      ['b', 'cancelled'],
    ]);
  });

  it('fails every request of a batch whose input did not validate', async () => {
    const { server, batch } = setup();
    const job = await batch.submit([{ id: 'a', prompt: 'x' }]);
    server.setStatus(job.id, 'failed');
    server.batches.get(job.id)!.errors = {
      object: 'list',
      data: [{ code: 'invalid_json', message: 'Line 1 is not JSON.', line: 1 }],
    };
    const status = await batch.status(job);
    expect(status).toMatchObject({ state: 'failed', error: 'Line 1 is not JSON.' });
    const [result] = await batch.collect(job);
    expect(result).toMatchObject({ id: 'a', status: 'errored' });
    expect(result!.error!.message).toMatch(/Line 1 is not JSON/);
  });

  it('refuses to read results before the batch ends', async () => {
    const { server, batch } = setup();
    const job = await batch.submit([{ id: 'a', prompt: 'x' }]);
    server.setStatus(job.id, 'in_progress');
    await expect(batch.collect(job)).rejects.toMatchObject({
      name: 'BatchError',
      kind: 'not-ended',
    });
  });

  it('maps a failed lifecycle call to the wire’s typed error', async () => {
    const { batch } = setup();
    const job = await batch.submit([{ id: 'a', prompt: 'x' }]);
    await expect(batch.status({ ...job, id: 'batch_missing' })).rejects.toMatchObject({
      name: 'ModelNotFoundError',
      statusCode: 404,
    });
  });
});
