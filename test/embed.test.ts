import { describe, it, expect, beforeAll, afterEach, afterAll } from 'vitest';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { embed, embedMany } from '../src/inference/embed';
import { createOpenAIEmbedding, openaiEmbedding } from '../src/openai';
import { createGoogleEmbedding } from '../src/google';
import { createVoyage } from '../src/voyage';
import { embeddingUsage } from '../src/core/metering';
import { decodeBase64Floats } from '../src/adapters/embeddings';
import { UnsupportedCapabilityError } from '../src/errors';

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

/** Encode a Float32 little-endian base64 string (mirror of the decoder). */
function encodeBase64Floats(vec: number[]): string {
  const buf = new ArrayBuffer(vec.length * 4);
  const view = new DataView(buf);
  vec.forEach((v, i) => view.setFloat32(i * 4, v, true));
  const bytes = new Uint8Array(buf);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

describe('embeddingUsage', () => {
  it('maps tokens onto inputTokens/totalTokens; undefined → 0', () => {
    expect(embeddingUsage(12)).toMatchObject({ inputTokens: 12, totalTokens: 12, outputTokens: 0 });
    expect(embeddingUsage(undefined)).toMatchObject({ inputTokens: 0, totalTokens: 0 });
  });
});

describe('base64 float decode', () => {
  it('round-trips a little-endian Float32 vector', () => {
    const vec = [0.5, -0.25, 1.5, 0];
    const decoded = decodeBase64Floats(encodeBase64Floats(vec));
    decoded.forEach((v, i) => expect(v).toBeCloseTo(vec[i]!, 5));
  });
});

describe('embed (OpenAI)', () => {
  it('embeds a single value and reports usage', async () => {
    let captured: Request | undefined;
    server.use(
      http.post('https://api.openai.com/v1/embeddings', async ({ request }) => {
        captured = request;
        return HttpResponse.json({
          data: [{ index: 0, embedding: encodeBase64Floats([1, 2, 3]) }],
          usage: { prompt_tokens: 4, total_tokens: 4 },
        });
      }),
    );

    const { embedding, usage } = await embed({
      model: createOpenAIEmbedding({ apiKey: 'sk-test' })('text-embedding-3-small'),
      value: 'hello',
    });

    expect(embedding).toEqual([1, 2, 3]);
    expect(usage.inputTokens).toBe(4);
    expect(captured?.headers.get('authorization')).toBe('Bearer sk-test');
    const body = await captured!.json();
    expect(body.encoding_format).toBe('base64'); // 3-small supports base64
    expect(body.input).toEqual(['hello']);
  });

  it('fires onUsage once', async () => {
    server.use(
      http.post('https://api.openai.com/v1/embeddings', () =>
        HttpResponse.json({ data: [{ index: 0, embedding: [0.1] }], usage: { total_tokens: 2 } }),
      ),
    );
    const calls: number[] = [];
    await embed({
      model: openaiEmbedding('text-embedding-3-small'),
      value: 'x',
      deps: { keyProvider: { getKey: () => 'sk-x' } },
      onUsage: (u) => calls.push(u.inputTokens),
    });
    expect(calls).toEqual([2]);
  });
});

describe('embedMany (OpenAI) — batching + ordering', () => {
  it('splits into sub-batches, preserves order, sums tokens', async () => {
    let batchCount = 0;
    server.use(
      http.post('https://api.openai.com/v1/embeddings', async ({ request }) => {
        batchCount++;
        const body = (await request.json()) as { input: string[] };
        // Return vectors out of order to prove index-sorting works.
        const data = body.input.map((v, i) => ({ index: i, embedding: [Number(v)] })).reverse();
        return HttpResponse.json({ data, usage: { total_tokens: body.input.length } });
      }),
    );

    const values = ['1', '2', '3', '4', '5'];
    const { embeddings, usage } = await embedMany({
      model: createOpenAIEmbedding({ apiKey: 'sk-test' })('text-embedding-3-small'),
      values,
      maxBatchSize: 2, // → 3 sub-batches (2,2,1)
    });

    expect(batchCount).toBe(3);
    expect(embeddings).toEqual([[1], [2], [3], [4], [5]]);
    expect(usage.inputTokens).toBe(5);
  });

  it('empty values → no request, zero usage', async () => {
    const { embeddings, usage } = await embedMany({
      model: createOpenAIEmbedding({ apiKey: 'sk-test' })('text-embedding-3-small'),
      values: [],
    });
    expect(embeddings).toEqual([]);
    expect(usage.totalTokens).toBe(0);
  });

  it('normalize:true returns unit vectors', async () => {
    server.use(
      http.post('https://api.openai.com/v1/embeddings', () =>
        HttpResponse.json({ data: [{ index: 0, embedding: [3, 4] }], usage: { total_tokens: 1 } }),
      ),
    );
    const { embeddings } = await embedMany({
      model: createOpenAIEmbedding({ apiKey: 'sk-test' })('text-embedding-3-small'),
      values: ['x'],
      normalize: true,
    });
    expect(embeddings[0]![0]).toBeCloseTo(0.6, 5);
    expect(embeddings[0]![1]).toBeCloseTo(0.8, 5);
  });
});

describe('embedMany (Gemini native)', () => {
  it('uses batchEmbedContents, x-goog-api-key, taskType, request order', async () => {
    let captured: Request | undefined;
    server.use(
      http.post(
        'https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:batchEmbedContents',
        async ({ request }) => {
          captured = request;
          return HttpResponse.json({
            embeddings: [{ values: [0.1, 0.2] }, { values: [0.3, 0.4] }],
          });
        },
      ),
    );

    const { embeddings, usage } = await embedMany({
      model: createGoogleEmbedding({ apiKey: 'AIza-test' })('gemini-embedding-001'),
      values: ['a', 'b'],
      taskType: 'search_document',
    });

    expect(embeddings).toEqual([
      [0.1, 0.2],
      [0.3, 0.4],
    ]);
    expect(usage.totalTokens).toBe(0); // Gemini reports no usage
    expect(captured?.headers.get('x-goog-api-key')).toBe('AIza-test');
    const body = (await captured!.json()) as { requests: { model: string; taskType?: string }[] };
    expect(body.requests[0]!.model).toBe('models/gemini-embedding-001');
    expect(body.requests[0]!.taskType).toBe('RETRIEVAL_DOCUMENT');
  });
});

describe('embedMany (Voyage)', () => {
  it('maps taskType → input_type and sets output_dimension', async () => {
    let captured: Request | undefined;
    server.use(
      http.post('https://api.voyageai.com/v1/embeddings', async ({ request }) => {
        captured = request;
        return HttpResponse.json({
          data: [{ index: 0, embedding: [0.9] }],
          usage: { total_tokens: 3 },
        });
      }),
    );
    const { embeddings, usage } = await embedMany({
      model: createVoyage({ apiKey: 'pa-test' })('voyage-3.5'),
      values: ['q'],
      taskType: 'search_query',
      dimensions: 256,
    });
    expect(embeddings).toEqual([[0.9]]);
    expect(usage.inputTokens).toBe(3);
    const body = await captured!.json();
    expect(body.input_type).toBe('query');
    expect(body.output_dimension).toBe(256);
  });
});

describe('capability guard', () => {
  it('throws UnsupportedCapabilityError for an xAI embedding model (no network)', async () => {
    await expect(
      embedMany({
        // Force a bad surface/provider combo: cast a fake xai embedding model.
        model: { provider: 'xai', modelId: 'grok-embed', surface: 'openai-embeddings' } as never,
        values: ['x'],
        deps: { keyProvider: { getKey: () => 'k' } },
      }),
    ).rejects.toBeInstanceOf(UnsupportedCapabilityError);
  });
});

describe('retry', () => {
  it('retries a 429 then succeeds (deterministic clock)', async () => {
    let n = 0;
    server.use(
      http.post('https://api.openai.com/v1/embeddings', () => {
        n++;
        if (n === 1) return new HttpResponse('rate', { status: 429 });
        return HttpResponse.json({
          data: [{ index: 0, embedding: [1] }],
          usage: { total_tokens: 1 },
        });
      }),
    );
    const { embeddings } = await embedMany({
      model: createOpenAIEmbedding({ apiKey: 'sk-test' })('text-embedding-3-small'),
      values: ['x'],
      // Deterministic, instant backoff via injected clock.
      deps: {
        clock: { now: () => 0, setTimeout: (fn) => (fn(), () => {}) },
        generateId: () => 'id',
      },
    });
    expect(n).toBe(2);
    expect(embeddings).toEqual([[1]]);
  });
});
