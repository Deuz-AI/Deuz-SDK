import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createAnthropic } from '../src/anthropic';
import { createBatchClient } from '../src/batch/client';
import { BatchError } from '../src/batch/errors';
import { createMemoryBatchJobStore } from '../src/batch/store';
import type { BatchJob, BatchJobStore } from '../src/batch/types';
import { NoObjectGeneratedError } from '../src/errors';
import { createGoogle } from '../src/google';
import { createOpenAIResponses } from '../src/openai';
import { fakeAnthropicBatches, fakeOpenAIBatches } from './fixtures/batch-servers';
import { manualClock } from './fixtures/manual-clock';

// BA2: what the batch client does on top of the three protocols — polling,
// structured output, job handles and the job store.

const message = (content: unknown[], stop_reason = 'end_turn') => ({
  id: 'msg',
  type: 'message',
  role: 'assistant',
  content,
  stop_reason,
  stop_details: null,
  usage: { input_tokens: 10, output_tokens: 5 },
});

function anthropicSetup(modelId = 'claude-haiku-5-5', store?: BatchJobStore) {
  const server = fakeAnthropicBatches();
  const model = createAnthropic({ apiKey: 'k', fetch: server.fetch })(modelId);
  const time = manualClock(0);
  const batch = createBatchClient({
    model,
    deps: { clock: time.clock },
    ...(store ? { store } : {}),
  });
  return { server, model, time, batch };
}

describe('createBatchClient', () => {
  it('refuses a model without a batch API', () => {
    const model = createGoogle({ apiKey: 'k' })('gemini-3.1-pro');
    expect(() => createBatchClient({ model })).toThrow(BatchError);
  });

  it('refuses a holdMs that is not a positive integer', () => {
    const model = createAnthropic({ apiKey: 'k' })('claude-haiku-5-5');
    expect(() => createBatchClient({ model, holdMs: 0 })).toThrow(/holdMs/);
  });

  it('records holdMs on the job as holdUntil', async () => {
    const server = fakeAnthropicBatches();
    const model = createAnthropic({ apiKey: 'k', fetch: server.fetch })('claude-haiku-5-5');
    const batch = createBatchClient({
      model,
      holdMs: 48 * 3_600_000,
      deps: { clock: manualClock(100).clock },
    });
    const job = await batch.submit([{ id: 'a', prompt: 'x' }]);
    expect(job.holdUntil).toBe(100 + 48 * 3_600_000);
  });

  it('refuses a job handle from another provider or a malformed one', async () => {
    const { batch } = anthropicSetup();
    const openai = fakeOpenAIBatches();
    const other = createBatchClient({
      model: createOpenAIResponses({ apiKey: 'k', fetch: openai.fetch })('gpt-5.6-sol'),
    });
    const job = await other.submit([{ id: 'a', prompt: 'x' }]);
    await expect(batch.status(job)).rejects.toMatchObject({ kind: 'invalid-job' });
    await expect(batch.status({ id: 'x' } as unknown as BatchJob)).rejects.toMatchObject({
      kind: 'invalid-job',
    });
  });

  it('keeps the request warnings on the job', async () => {
    const { batch } = anthropicSetup('claude-sonnet-5-5');
    const job = await batch.submit([{ id: 'a', prompt: 'x', temperature: 0.2 }]);
    expect(job.warnings).toContainEqual(
      expect.objectContaining({ type: 'unsupported-setting', setting: 'temperature' }),
    );
  });
});

describe('wait', () => {
  it('polls on the injected clock until the batch ends', async () => {
    const { server, time, batch } = anthropicSetup();
    const job = await batch.submit([{ id: 'a', prompt: 'x' }]);
    const seen: string[] = [];
    const done = batch.wait(job, {
      intervalMs: 1_000,
      onStatus: (status) => seen.push(status.state),
    });
    await time.advance(0); // the first poll
    await time.advance(1_000);
    await time.advance(1_000);
    server.finish(job.id, {
      a: { type: 'succeeded', message: message([{ type: 'text', text: 'A' }]) },
    });
    await time.advance(1_000);
    await expect(done).resolves.toMatchObject({ state: 'completed', ended: true });
    expect(seen).toEqual(['running', 'running', 'running', 'completed']);
  });

  it('gives up after timeoutMs', async () => {
    const { time, batch } = anthropicSetup();
    const job = await batch.submit([{ id: 'a', prompt: 'x' }]);
    const done = batch.wait(job, { intervalMs: 1_000, timeoutMs: 2_500 });
    const failure = expect(done).rejects.toMatchObject({ name: 'BatchError', kind: 'timeout' });
    await time.advance(3_000);
    await failure;
  });

  it('polls again after a retryable provider error, and stops on another', async () => {
    let failures = 1;
    const server = fakeAnthropicBatches();
    const flaky = (async (input: string | URL | Request, init?: RequestInit) => {
      if ((init?.method ?? 'GET') === 'GET' && failures-- > 0)
        return new Response(
          JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'slow' } }),
          {
            status: 429,
          },
        );
      return server.fetch(input, init);
    }) as typeof fetch;
    const model = createAnthropic({ apiKey: 'k', fetch: flaky })('claude-haiku-5-5');
    const time = manualClock(0);
    const batch = createBatchClient({ model, deps: { clock: time.clock } });
    const job = await batch.submit([{ id: 'a', prompt: 'x' }]);
    server.finish(job.id, { a: { type: 'expired' } });
    const done = batch.wait(job, { intervalMs: 500 });
    await time.advance(0); // the first poll: a 429
    await time.advance(500);
    await expect(done).resolves.toMatchObject({ state: 'expired' });

    failures = 0;
    const missing = { ...job, id: 'msgbatch_unknown' };
    await expect(batch.wait(missing)).rejects.toMatchObject({ name: 'ModelNotFoundError' });
  });

  it('stops when its signal aborts', async () => {
    const { time, batch } = anthropicSetup();
    const job = await batch.submit([{ id: 'a', prompt: 'x' }]);
    const controller = new AbortController();
    const done = batch.wait(job, { intervalMs: 1_000, signal: controller.signal });
    const failure = expect(done).rejects.toThrow('stop now');
    await time.advance(10);
    controller.abort(new Error('stop now'));
    await failure;
  });
});

describe('structured requests', () => {
  const Label = z.object({ label: z.enum(['spam', 'ham']) });

  it('parses and validates the JSON reply of the json strategy', async () => {
    const { server, batch } = anthropicSetup();
    const job = await batch.submit([
      { id: 'good', prompt: 'x', schema: Label },
      { id: 'wrong', prompt: 'y', schema: Label },
      { id: 'broken', prompt: 'z', schema: Label },
    ]);
    expect(job.requests.map((request) => request.object)).toEqual([
      { strategy: 'json' },
      { strategy: 'json' },
      { strategy: 'json' },
    ]);
    server.finish(job.id, {
      good: { type: 'succeeded', message: message([{ type: 'text', text: '{"label":"spam"}' }]) },
      wrong: { type: 'succeeded', message: message([{ type: 'text', text: '{"label":"eggs"}' }]) },
      broken: {
        type: 'succeeded',
        message: message([{ type: 'text', text: '{"label":' }], 'max_tokens'),
      },
    });
    const results = Object.fromEntries(
      (await batch.collect(job)).map((result) => [result.id, result]),
    );
    expect(results.good).toMatchObject({ status: 'succeeded', object: { label: 'spam' } });
    expect(results.good!.error).toBeUndefined();
    // The request ran (and was billed); its object did not validate.
    expect(results.wrong).toMatchObject({ status: 'succeeded', text: '{"label":"eggs"}' });
    expect(results.wrong!.object).toBeUndefined();
    expect(results.wrong!.error).toBeInstanceOf(NoObjectGeneratedError);
    expect(results.broken!.finishReason).toBe('length');
    expect(results.broken!.error).toBeInstanceOf(NoObjectGeneratedError);
  });

  it('reads the forced tool call of the tool strategy', async () => {
    const { server, batch } = anthropicSetup('claude-haiku-4-5');
    const job = await batch.submit([
      { id: 't', prompt: 'x', schema: Label, schemaName: 'classify', mode: 'tool' },
    ]);
    expect(job.requests[0]!.object).toEqual({ strategy: 'tool', toolName: 'classify' });
    server.finish(job.id, {
      t: {
        type: 'succeeded',
        message: message(
          [{ type: 'tool_use', id: 'tu', name: 'classify', input: { label: 'ham' } }],
          'tool_use',
        ),
      },
    });
    const [result] = await batch.collect(job);
    expect(result).toMatchObject({
      status: 'succeeded',
      object: { label: 'ham' },
      finishReason: 'tool_calls',
    });
  });

  it('validates with the schemas a new client is given', async () => {
    const { server, model, batch } = anthropicSetup();
    const job = await batch.submit([{ id: 'a', prompt: 'x', schema: Label }]);
    server.finish(job.id, {
      a: { type: 'succeeded', message: message([{ type: 'text', text: '{"label":"eggs"}' }]) },
    });
    // A new process: the in-memory schemas are gone.
    const restarted = createBatchClient({ model });
    const [unchecked] = await restarted.collect(JSON.parse(JSON.stringify(job)) as BatchJob);
    expect(unchecked).toMatchObject({ object: { label: 'eggs' } });
    const [checked] = await restarted.collect(job, { schemas: { a: Label } });
    expect(checked!.error).toBeInstanceOf(NoObjectGeneratedError);
  });
});

describe('job store', () => {
  it('records each job, and closes it once every result was read', async () => {
    const store = createMemoryBatchJobStore();
    const { server, batch } = anthropicSetup('claude-haiku-5-5', store);
    const first = await batch.submit([{ id: 'a', prompt: 'x' }]);
    const second = await batch.submit([{ id: 'b', prompt: 'y' }]);
    expect(await store.get(first.id)).toEqual(first);
    expect((await batch.pending()).map((job) => job.id)).toEqual([first.id, second.id]);

    server.finish(first.id, {
      a: { type: 'succeeded', message: message([{ type: 'text', text: 'A' }]) },
    });
    // Stopping early leaves the job open.
    for await (const result of batch.results(first)) {
      expect(result.id).toBe('a');
      break;
    }
    expect((await batch.pending()).map((job) => job.id)).toEqual([first.id, second.id]);
    await batch.collect(first);
    expect((await store.get(first.id))!.closedAt).toBeTypeOf('number');
    expect((await batch.pending()).map((job) => job.id)).toEqual([second.id]);
  });

  it('pending() needs a store', async () => {
    const { batch } = anthropicSetup();
    await expect(batch.pending()).rejects.toMatchObject({ kind: 'store' });
  });

  it('hands back the submitted job when the store fails to record it', async () => {
    const failing: BatchJobStore = {
      ...createMemoryBatchJobStore(),
      put: async () => {
        throw new Error('disk full');
      },
    };
    const { batch } = anthropicSetup('claude-haiku-5-5', failing);
    const error = await batch.submit([{ id: 'a', prompt: 'x' }]).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(BatchError);
    expect(error).toMatchObject({
      kind: 'store',
      job: { id: 'msgbatch_1', protocol: 'anthropic' },
    });
  });

  it('keeps stored jobs apart from the caller’s objects', async () => {
    const store = createMemoryBatchJobStore();
    const { batch } = anthropicSetup('claude-haiku-5-5', store);
    const job = await batch.submit([{ id: 'a', prompt: 'x' }]);
    (job.requests as { id: string }[])[0]!.id = 'mutated';
    expect((await store.get(job.id))!.requests[0]!.id).toBe('a');
  });
});
