import { describe, expect, it } from 'vitest';
import { createBatchClient } from '../src/batch/client';
import { InvalidRequestError, RateLimitError } from '../src/errors';
import { createGoogleNative } from '../src/google';
import { fakeGeminiBatches } from './fixtures/batch-servers';
import { manualClock } from './fixtures/manual-clock';

// BA2: Gemini batch mode (Developer API) against an in-memory stand-in shaped
// by the REST converters of @google/genai 2.28. Not live-verified.

function setup() {
  const server = fakeGeminiBatches();
  const model = createGoogleNative({ apiKey: 'goog-test', fetch: server.fetch })('gemini-3.1-pro');
  const { clock } = manualClock(9_000);
  return { server, batch: createBatchClient({ model, deps: { clock } }) };
}

const response = (text: string) => ({
  candidates: [{ content: { role: 'model', parts: [{ text }] }, finishReason: 'STOP' }],
  usageMetadata: { promptTokenCount: 30, candidatesTokenCount: 7, totalTokenCount: 37 },
});

describe('Gemini batch: submit', () => {
  it('posts inlined { request, metadata.key } entries to models/{model}:batchGenerateContent', async () => {
    const { server, batch } = setup();
    const job = await batch.submit(
      [
        { id: 'a', prompt: 'One?', maxOutputTokens: 50 },
        { id: 'b', instructions: 'Short.', prompt: 'Two?' },
      ],
      { displayName: 'nightly' },
    );
    const create = server.calls[0]!;
    expect(create.method).toBe('POST');
    expect(create.url).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-pro:batchGenerateContent',
    );
    expect(create.headers.get('x-goog-api-key')).toBe('goog-test');
    const body = JSON.parse(create.body as string);
    expect(body.batch.displayName).toBe('nightly');
    const requests = body.batch.inputConfig.requests.requests;
    expect(requests.map((entry: { metadata: unknown }) => entry.metadata)).toEqual([
      { key: 'a' },
      { key: 'b' },
    ]);
    expect(requests[0].request).toMatchObject({
      contents: [{ role: 'user', parts: [{ text: 'One?' }] }],
      generationConfig: { maxOutputTokens: 50 },
    });
    expect(requests[1].request.systemInstruction).toEqual({ parts: [{ text: 'Short.' }] });
    expect(job).toMatchObject({ protocol: 'gemini', id: 'batches/b1', submittedAt: 9_000 });
  });

  it('names an unlabelled batch', async () => {
    const { server, batch } = setup();
    await batch.submit([{ id: 'a', prompt: 'x' }]);
    expect(JSON.parse(server.calls[0]!.body as string).batch.displayName).toBe('deuz-batch');
  });
});

describe('Gemini batch: status and cancel', () => {
  it.each([
    ['BATCH_STATE_PENDING', 'pending', false],
    ['BATCH_STATE_RUNNING', 'running', false],
    ['BATCH_STATE_SUCCEEDED', 'completed', true],
    ['BATCH_STATE_FAILED', 'failed', true],
    ['BATCH_STATE_CANCELLED', 'cancelled', true],
    ['BATCH_STATE_EXPIRED', 'expired', true],
    ['JOB_STATE_SUCCEEDED', 'completed', true],
    ['BATCH_STATE_SOMETHING_NEW', 'running', false],
  ])('normalizes %s to %s', async (provider, state, ended) => {
    const { server, batch } = setup();
    const job = await batch.submit([{ id: 'a', prompt: 'x' }]);
    server.setState(job.id, provider);
    expect(await batch.status(job)).toMatchObject({
      id: job.id,
      state,
      ended,
      providerState: provider,
    });
  });

  it('cancels with POST batches/{id}:cancel and reads the state back', async () => {
    const { server, batch } = setup();
    const job = await batch.submit([{ id: 'a', prompt: 'x' }]);
    const status = await batch.cancel(job);
    expect(status.state).toBe('cancelled');
    const [cancel, read] = server.calls.slice(-2);
    expect(cancel).toMatchObject({
      method: 'POST',
      url: expect.stringMatching(/\/v1beta\/batches\/b1:cancel$/),
    });
    expect(read).toMatchObject({
      method: 'GET',
      url: expect.stringMatching(/\/v1beta\/batches\/b1$/),
    });
  });

  it('refuses a job id that is not a batch name', async () => {
    const { batch } = setup();
    const job = await batch.submit([{ id: 'a', prompt: 'x' }]);
    await expect(batch.status({ ...job, id: '../models/x' })).rejects.toMatchObject({
      kind: 'invalid-job',
    });
  });
});

describe('Gemini batch: results', () => {
  it('maps inlined responses and errors by their metadata key', async () => {
    const { server, batch } = setup();
    const job = await batch.submit([
      { id: 'a', prompt: 'x' },
      { id: 'b', prompt: 'y' },
      { id: 'c', prompt: 'z' },
    ]);
    server.finish(job.id, 'BATCH_STATE_SUCCEEDED', [
      { response: response('Bee'), metadata: { key: 'b' } },
      { error: { code: 3, message: 'Invalid argument.' }, metadata: { key: 'c' } },
      { response: response('Ay'), metadata: { key: 'a' } },
    ]);
    const results = Object.fromEntries(
      (await batch.collect(job)).map((result) => [result.id, result]),
    );
    expect(results.a).toMatchObject({ status: 'succeeded', text: 'Ay' });
    expect(results.b).toMatchObject({
      status: 'succeeded',
      text: 'Bee',
      usage: { inputTokens: 30, outputTokens: 7 },
      usageAvailable: true,
    });
    expect(results.c!.status).toBe('errored');
    expect(results.c!.error).toBeInstanceOf(InvalidRequestError);
  });

  it('falls back to request order for responses without metadata', async () => {
    const { server, batch } = setup();
    const job = await batch.submit([
      { id: 'first', prompt: 'x' },
      { id: 'second', prompt: 'y' },
    ]);
    server.finish(job.id, 'BATCH_STATE_SUCCEEDED', [
      { response: response('1') },
      { error: { code: 429, message: 'Slow down.' } },
    ]);
    const [first, second] = await batch.collect(job);
    expect(first).toMatchObject({ id: 'first', text: '1' });
    expect(second!.error).toBeInstanceOf(RateLimitError);
  });

  it('reads responses written to a file', async () => {
    const { server, batch } = setup();
    const job = await batch.submit([
      { id: 'a', prompt: 'x' },
      { id: 'b', prompt: 'y' },
    ]);
    server.finishToFile(job.id, 'BATCH_STATE_SUCCEEDED', [
      { key: 'b', response: response('B') },
      { key: 'a', response: response('A') },
    ]);
    const results = await batch.collect(job);
    expect(results.map((result) => [result.id, result.text])).toEqual([
      ['b', 'B'],
      ['a', 'A'],
    ]);
    expect(server.calls.at(-1)!.url).toBe(
      'https://generativelanguage.googleapis.com/v1beta/files/out-1:download?alt=media',
    );
  });

  it('reports requests of an expired batch without a response as expired', async () => {
    const { server, batch } = setup();
    const job = await batch.submit([
      { id: 'a', prompt: 'x' },
      { id: 'b', prompt: 'y' },
    ]);
    server.finish(job.id, 'BATCH_STATE_EXPIRED', [
      { response: response('A'), metadata: { key: 'a' } },
    ]);
    const results = await batch.collect(job);
    expect(results.map((result) => [result.id, result.status])).toEqual([
      ['a', 'succeeded'],
      ['b', 'expired'],
    ]);
  });
});
