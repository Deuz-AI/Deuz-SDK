import { describe, expect, it } from 'vitest';
import { createAnthropic } from '../src/anthropic';
import { createBatchClient } from '../src/batch/client';
import { createPriceProvider } from '../src/pricing';
import { InvalidRequestError, OverloadedError } from '../src/errors';
import { fakeAnthropicBatches } from './fixtures/batch-servers';
import { manualClock } from './fixtures/manual-clock';

// BA2: Anthropic Message Batches against an in-memory stand-in shaped by
// @anthropic-ai/sdk 0.133. Not live-verified.

function setup(settings: { baseURL?: string; headers?: Record<string, string> } = {}) {
  const server = fakeAnthropicBatches(settings.baseURL);
  const model = createAnthropic({ apiKey: 'sk-ant-test', fetch: server.fetch, ...settings })(
    'claude-haiku-5-5',
  );
  const { clock } = manualClock(5_000);
  const batch = createBatchClient({
    model,
    deps: { clock, priceProvider: createPriceProvider() },
  });
  return { server, batch };
}

const message = (text: string) => ({
  id: 'msg_1',
  type: 'message',
  role: 'assistant',
  model: 'claude-haiku-5-5',
  content: [{ type: 'text', text }],
  stop_reason: 'end_turn',
  stop_sequence: null,
  stop_details: null,
  usage: { input_tokens: 2000, output_tokens: 1000, cache_read_input_tokens: 0 },
});

describe('Anthropic batch: submit', () => {
  it('posts { custom_id, params } requests with non-streaming Messages bodies', async () => {
    const { server, batch } = setup();
    const job = await batch.submit([
      { id: 'q1', prompt: 'One?', maxOutputTokens: 64 },
      { id: 'q2', instructions: 'Answer in French.', prompt: 'Two?' },
    ]);
    const create = server.calls[0]!;
    expect(create.method).toBe('POST');
    expect(create.url).toBe('https://api.anthropic.com/v1/messages/batches');
    expect(create.headers.get('x-api-key')).toBe('sk-ant-test');
    expect(create.headers.get('anthropic-version')).toBe('2023-06-01');
    const body = JSON.parse(create.body as string) as {
      requests: { custom_id: string; params: Record<string, unknown> }[];
    };
    expect(body.requests.map((request) => request.custom_id)).toEqual(['q1', 'q2']);
    expect(body.requests[0]!.params).toMatchObject({
      model: 'claude-haiku-5-5',
      max_tokens: 64,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'One?' }] }],
    });
    expect(body.requests[0]!.params).not.toHaveProperty('stream');
    expect(body.requests[1]!.params.system).toBe('Answer in French.');
    expect(job).toMatchObject({
      protocol: 'anthropic',
      id: 'msgbatch_1',
      submittedAt: 5_000,
      expiresAt: Date.parse('2026-10-11T00:00:00Z'),
    });
  });

  it('sends the betas the requests carry on the batch call, each once', async () => {
    const { server, batch } = setup({ headers: { 'anthropic-beta': 'beta-a, beta-b' } });
    await batch.submit([
      { id: 'a', prompt: 'x' },
      { id: 'b', prompt: 'y' },
    ]);
    expect(server.calls[0]!.headers.get('anthropic-beta')).toBe('beta-a,beta-b');
  });
});

describe('Anthropic batch: status', () => {
  it.each([
    [{ processing_status: 'in_progress' }, 'running', false],
    [{ processing_status: 'canceling' }, 'cancelling', false],
    [{ processing_status: 'ended' }, 'completed', true],
    [
      { processing_status: 'ended', cancel_initiated_at: '2026-10-10T01:00:00Z' },
      'cancelled',
      true,
    ],
    [
      {
        processing_status: 'ended',
        request_counts: { processing: 0, succeeded: 0, errored: 0, canceled: 0, expired: 2 },
      },
      'expired',
      true,
    ],
  ])('normalizes %o to %s', async (patch, state, ended) => {
    const { server, batch } = setup();
    const job = await batch.submit([
      { id: 'a', prompt: 'x' },
      { id: 'b', prompt: 'y' },
    ]);
    Object.assign(server.batches.get(job.id)!.batch, patch);
    expect(await batch.status(job)).toMatchObject({ state, ended });
  });

  it('counts requests by result type', async () => {
    const { server, batch } = setup();
    const job = await batch.submit([
      { id: 'a', prompt: 'x' },
      { id: 'b', prompt: 'y' },
    ]);
    expect((await batch.status(job)).counts).toEqual({
      total: 2,
      succeeded: 0,
      errored: 0,
      cancelled: 0,
      expired: 0,
      processing: 2,
    });
    server.finish(job.id, {
      a: { type: 'succeeded', message: message('A') },
      b: { type: 'canceled' },
    });
    expect((await batch.status(job)).counts).toMatchObject({
      total: 2,
      succeeded: 1,
      cancelled: 1,
      processing: 0,
    });
  });

  it('cancels and reports the canceling batch', async () => {
    const { server, batch } = setup();
    const job = await batch.submit([{ id: 'a', prompt: 'x' }]);
    expect((await batch.cancel(job)).state).toBe('cancelling');
    expect(server.calls.at(-1)!.url).toBe(
      `https://api.anthropic.com/v1/messages/batches/${job.id}/cancel`,
    );
  });
});

describe('Anthropic batch: results', () => {
  it('maps succeeded, errored, canceled and expired results by custom_id', async () => {
    const { server, batch } = setup();
    const job = await batch.submit([
      { id: 'ok', prompt: 'x' },
      { id: 'bad', prompt: 'y' },
      { id: 'busy', prompt: 'z' },
      { id: 'stop', prompt: 'w' },
      { id: 'late', prompt: 'v' },
    ]);
    server.finish(job.id, {
      late: { type: 'expired' },
      stop: { type: 'canceled' },
      busy: {
        type: 'errored',
        error: {
          type: 'error',
          error: { type: 'overloaded_error', message: 'Overloaded' },
          request_id: 'req_9',
        },
      },
      bad: {
        type: 'errored',
        error: {
          type: 'error',
          error: { type: 'invalid_request_error', message: 'Bad params' },
          request_id: null,
        },
      },
      ok: { type: 'succeeded', message: message('Answer') },
    });
    const results = Object.fromEntries(
      (await batch.collect(job)).map((result) => [result.id, result]),
    );
    expect(results.ok).toMatchObject({
      status: 'succeeded',
      text: 'Answer',
      finishReason: 'stop',
      usage: { inputTokens: 2000, outputTokens: 1000 },
    });
    // claude-haiku-5-5 on the batch tier: $0.05 input, $0.25 output per million.
    expect(results.ok!.costUsd).toBe(0.00035);
    expect(results.bad!.status).toBe('errored');
    expect(results.bad!.error).toBeInstanceOf(InvalidRequestError);
    expect(results.busy!.error).toBeInstanceOf(OverloadedError);
    expect(results.busy!.error).toMatchObject({ requestId: 'req_9' });
    expect(results.stop).toEqual({ id: 'stop', status: 'cancelled', text: '' });
    expect(results.late).toEqual({ id: 'late', status: 'expired', text: '' });
  });

  it('reads results on the configured host when results_url points elsewhere', async () => {
    const { server, batch } = setup({ baseURL: 'https://proxy.example.com' });
    const job = await batch.submit([{ id: 'a', prompt: 'x' }]);
    server.finish(
      job.id,
      { a: { type: 'succeeded', message: message('A') } },
      { resultsUrl: `https://api.anthropic.com/v1/messages/batches/${job.id}/results` },
    );
    const [result] = await batch.collect(job);
    expect(result!.text).toBe('A');
    const read = server.calls.at(-1)!;
    expect(read.url).toBe(`https://proxy.example.com/v1/messages/batches/${job.id}/results`);
    expect(read.headers.get('x-api-key')).toBe('sk-ant-test');
  });

  it('explains an ended batch whose results were archived', async () => {
    const { server, batch } = setup();
    const job = await batch.submit([{ id: 'a', prompt: 'x' }]);
    Object.assign(server.batches.get(job.id)!.batch, {
      processing_status: 'ended',
      results_url: null,
      archived_at: '2026-11-08T00:00:00Z',
    });
    await expect(batch.collect(job)).rejects.toMatchObject({
      kind: 'provider',
      message: /archived/,
    });
  });
});
