import { describe, it, expect } from 'vitest';
import { createCohereReranker, retrieve, type ScoredChunk, type Reranker } from '../src/rag';
import { createVoyageReranker } from '../src/voyage';
import { mockFetch } from '../src/testing';
import {
  APICallError,
  AuthenticationError,
  InvalidRequestError,
  NetworkError,
  RateLimitError,
} from '../src/errors';

function chunk(index: number, text: string, score: number): ScoredChunk {
  return { index, text, score, meta: { id: `c${index}` } };
}

const candidates: ScoredChunk[] = [
  chunk(0, 'Paris is the capital of France.', 0.9),
  chunk(1, 'The Eiffel Tower is in Paris.', 0.8),
  chunk(2, 'Bananas are yellow.', 0.7),
];

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
  });
}

function bodyOf(call: { init?: RequestInit } | undefined): Record<string, unknown> {
  return JSON.parse(String(call?.init?.body)) as Record<string, unknown>;
}

function headerOf(call: { init?: RequestInit } | undefined, name: string): string | undefined {
  return (call?.init?.headers as Record<string, string> | undefined)?.[name];
}

interface Case {
  name: string;
  provider: string;
  url: string;
  defaultModel: string;
  countField: string;
  make: (s: {
    apiKey?: string;
    model?: string;
    topK?: number;
    fetch?: typeof fetch;
    baseURL?: string;
    headers?: Record<string, string>;
    deps?: { fetch?: typeof fetch; keyProvider?: { getKey: (p: string) => string | undefined } };
  }) => Reranker;
  ok: (results: { index: number; score: number }[]) => unknown;
  errorBody: (message: string) => unknown;
}

const cases: Case[] = [
  {
    name: 'createVoyageReranker',
    provider: 'voyage',
    url: 'https://api.voyageai.com/v1/rerank',
    defaultModel: 'rerank-2.5',
    countField: 'top_k',
    make: (s) => createVoyageReranker(s),
    ok: (results) => ({
      object: 'list',
      data: results.map((r) => ({ index: r.index, relevance_score: r.score })),
      model: 'rerank-2.5',
      usage: { total_tokens: 12 },
    }),
    errorBody: (message) => ({ detail: message }),
  },
  {
    name: 'createCohereReranker',
    provider: 'cohere',
    url: 'https://api.cohere.com/v2/rerank',
    defaultModel: 'rerank-v4.0-pro',
    countField: 'top_n',
    make: (s) => createCohereReranker(s),
    ok: (results) => ({
      id: 'r1',
      results: results.map((r) => ({ index: r.index, relevance_score: r.score })),
      meta: { billed_units: { search_units: 1 } },
    }),
    errorBody: (message) => ({ id: 'e1', message }),
  },
];

describe.each(cases)('$name', (c) => {
  it('posts query + chunk texts to the rerank endpoint with the default model and bearer key', async () => {
    const f = mockFetch(() => jsonResponse(c.ok([{ index: 2, score: 0.1 }])));
    await c.make({ apiKey: 'k-123', fetch: f.fetch }).rerank('capital of France', candidates, 2);
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]?.url).toBe(c.url);
    expect(f.calls[0]?.init?.method).toBe('POST');
    expect(headerOf(f.calls[0], 'authorization')).toBe('Bearer k-123');
    expect(headerOf(f.calls[0], 'content-type')).toBe('application/json');
    const body = bodyOf(f.calls[0]);
    expect(body.model).toBe(c.defaultModel);
    expect(body.query).toBe('capital of France');
    expect(body.documents).toEqual(candidates.map((x) => x.text));
    expect(body[c.countField]).toBe(2);
  });

  it('maps provider indices back to the original chunks with the relevance score, best first', async () => {
    const f = mockFetch(() =>
      jsonResponse(
        c.ok([
          { index: 1, score: 0.42 },
          { index: 0, score: 0.97 },
        ]),
      ),
    );
    const out = await c.make({ apiKey: 'k', fetch: f.fetch }).rerank('q', candidates, 2);
    expect(out).toEqual([
      { ...candidates[0], score: 0.97 },
      { ...candidates[1], score: 0.42 },
    ]);
    // the input candidates are never mutated
    expect(candidates[0]?.score).toBe(0.9);
  });

  it('honours an explicit model and caps the count at the factory topK', async () => {
    const f = mockFetch(() => jsonResponse(c.ok([{ index: 0, score: 0.5 }])));
    const out = await c
      .make({ apiKey: 'k', model: 'custom-rerank', topK: 1, fetch: f.fetch })
      .rerank('q', candidates, 3);
    const body = bodyOf(f.calls[0]);
    expect(body.model).toBe('custom-rerank');
    expect(body[c.countField]).toBe(1);
    expect(out).toHaveLength(1);
  });

  it('truncates defensively when the provider returns more results than asked', async () => {
    const f = mockFetch(() =>
      jsonResponse(
        c.ok([
          { index: 0, score: 0.3 },
          { index: 1, score: 0.2 },
          { index: 2, score: 0.1 },
        ]),
      ),
    );
    const out = await c.make({ apiKey: 'k', fetch: f.fetch }).rerank('q', candidates, 1);
    expect(out).toEqual([{ ...candidates[0], score: 0.3 }]);
  });

  it('makes no request for an empty candidate list or topN 0', async () => {
    const f = mockFetch(() => jsonResponse(c.ok([])));
    const r = c.make({ apiKey: 'k', fetch: f.fetch });
    expect(await r.rerank('q', [], 5)).toEqual([]);
    expect(await r.rerank('q', candidates, 0)).toEqual([]);
    expect(f.calls).toHaveLength(0);
  });

  it('deps.keyProvider outranks the factory apiKey; factory fetch outranks deps.fetch', async () => {
    const factoryFetch = mockFetch(() => jsonResponse(c.ok([])));
    const depsFetch = mockFetch(() => jsonResponse(c.ok([])));
    const asked: string[] = [];
    await c
      .make({
        apiKey: 'factory-key',
        fetch: factoryFetch.fetch,
        deps: {
          fetch: depsFetch.fetch,
          keyProvider: {
            getKey: (p) => {
              asked.push(p);
              return 'provider-key';
            },
          },
        },
      })
      .rerank('q', candidates, 1);
    expect(asked).toEqual([c.provider]);
    expect(headerOf(factoryFetch.calls[0], 'authorization')).toBe('Bearer provider-key');
    expect(depsFetch.calls).toHaveLength(0);
  });

  it('falls back to the factory apiKey when the keyProvider has none, and uses deps.fetch', async () => {
    const depsFetch = mockFetch(() => jsonResponse(c.ok([])));
    await c
      .make({
        apiKey: 'factory-key',
        deps: { fetch: depsFetch.fetch, keyProvider: { getKey: () => undefined } },
      })
      .rerank('q', candidates, 1);
    expect(headerOf(depsFetch.calls[0], 'authorization')).toBe('Bearer factory-key');
  });

  it('throws AuthenticationError without a key and never calls fetch', async () => {
    const f = mockFetch(() => jsonResponse(c.ok([])));
    const err = await c
      .make({ fetch: f.fetch })
      .rerank('q', candidates, 1)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AuthenticationError);
    expect((err as AuthenticationError).provider).toBe(c.provider);
    expect(f.calls).toHaveLength(0);
  });

  it('respects baseURL (trailing slash trimmed) and merges extra headers', async () => {
    const f = mockFetch(() => jsonResponse(c.ok([])));
    await c
      .make({
        apiKey: 'k',
        fetch: f.fetch,
        baseURL: 'https://relay.example/v9/',
        headers: { 'x-extra': '1' },
      })
      .rerank('q', candidates, 1);
    expect(f.calls[0]?.url).toBe('https://relay.example/v9/rerank');
    expect(headerOf(f.calls[0], 'x-extra')).toBe('1');
  });

  it('maps HTTP failures onto the DeuzError taxonomy and never leaks the key', async () => {
    const r429 = mockFetch(() =>
      jsonResponse(c.errorBody('slow down'), { status: 429, headers: { 'retry-after': '2' } }),
    );
    const e429 = await c
      .make({ apiKey: 'secret-key', fetch: r429.fetch })
      .rerank('q', candidates, 1)
      .catch((e: unknown) => e);
    expect(e429).toBeInstanceOf(RateLimitError);
    expect((e429 as RateLimitError).message).toBe('slow down');
    expect((e429 as RateLimitError).retryAfterMs).toBe(2000);
    expect((e429 as RateLimitError).provider).toBe(c.provider);
    expect(JSON.stringify(e429)).not.toContain('secret-key');
    expect(String((e429 as Error).message)).not.toContain('secret-key');

    const r401 = mockFetch(() => jsonResponse(c.errorBody('bad key'), { status: 401 }));
    const e401 = await c
      .make({ apiKey: 'secret-key', fetch: r401.fetch })
      .rerank('q', candidates, 1)
      .catch((e: unknown) => e);
    expect(e401).toBeInstanceOf(AuthenticationError);

    const r400 = mockFetch(() => jsonResponse(c.errorBody('bad request'), { status: 400 }));
    const e400 = await c
      .make({ apiKey: 'k', fetch: r400.fetch })
      .rerank('q', candidates, 1)
      .catch((e: unknown) => e);
    expect(e400).toBeInstanceOf(InvalidRequestError);
    expect((e400 as InvalidRequestError).message).toBe('bad request');

    const r503 = mockFetch(() => new Response('upstream down', { status: 503 }));
    const e503 = await c
      .make({ apiKey: 'k', fetch: r503.fetch })
      .rerank('q', candidates, 1)
      .catch((e: unknown) => e);
    expect(e503).toBeInstanceOf(APICallError);
    expect((e503 as APICallError).isRetryable).toBe(true);
    expect((e503 as APICallError).statusCode).toBe(503);
  });

  it('wraps a transport failure in NetworkError', async () => {
    const failing = (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    const err = await c
      .make({ apiKey: 'k', fetch: failing })
      .rerank('q', candidates, 1)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NetworkError);
    expect((err as NetworkError).provider).toBe(c.provider);
  });

  it('rejects a response whose index points outside the candidate list', async () => {
    const f = mockFetch(() => jsonResponse(c.ok([{ index: 7, score: 0.9 }])));
    const err = await c
      .make({ apiKey: 'k', fetch: f.fetch })
      .rerank('q', candidates, 1)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(APICallError);
    expect((err as APICallError).isRetryable).toBe(false);
  });

  it('plugs into retrieve() as the reranker seam', async () => {
    const f = mockFetch(() => jsonResponse(c.ok([{ index: 1, score: 0.99 }])));
    const out = await retrieve(
      'tower',
      {
        embedder: { dims: 1, embed: async (t) => t.map(() => [1]) },
        store: { upsert: async () => {}, query: async () => candidates },
        reranker: c.make({ apiKey: 'k', fetch: f.fetch }),
      },
      { topK: 3, topN: 1 },
    );
    expect(out).toEqual([{ ...candidates[1], score: 0.99 }]);
  });
});
