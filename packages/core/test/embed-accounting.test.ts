/**
 * embed-accounting.test.ts (2.4, spec §3.1) — `embed`/`embedMany` with
 * `accounting` charge the embedding to an execution context's ledger: a
 * reservation before the first request, the provider's usage after it, one
 * charge per request id. A request that may have been billed without usage
 * stays unknown; one refused before billing is released. Without
 * `accounting` nothing changes: the request is byte-identical to 2.3.
 */
import { describe, expect, it } from 'vitest';
import { embed, embedMany } from '../src/inference/embed';
import { createOpenAIEmbedding } from '../src/openai';
import { createExecutionContext } from '../src/execution-policy';
import type { NativeExecutionContext } from '../src/types/execution';
import type { Usage } from '../src/types/usage';

const model = createOpenAIEmbedding({ apiKey: 'sk-test' })('text-embedding-3-small');

/** $1 per million tokens for the embedding model; nothing else has a price. */
const priceProvider = {
  priceUsage: (modelId: string, usage: Usage) =>
    modelId === 'text-embedding-3-small' ? usage.totalTokens / 1_000_000 : undefined,
};

interface Captured {
  url: string;
  method: string;
  headers: [string, string][];
  body: string;
}

/** A fetch answering each request with the next response; captures every request. */
function stubFetch(...responses: (() => Response | Promise<Response>)[]) {
  const requests: Captured[] = [];
  const fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    requests.push({
      url: request.url,
      method: request.method,
      headers: [...request.headers.entries()].sort(),
      body: await request.text(),
    });
    const next = responses.shift();
    if (!next) throw new Error('unexpected request');
    return next();
  };
  return { fetch: fetch as typeof globalThis.fetch, requests };
}

const ok = (tokens?: number) => () =>
  Response.json({
    data: [{ index: 0, embedding: [0.5, 0.25] }],
    ...(tokens !== undefined ? { usage: { prompt_tokens: tokens, total_tokens: tokens } } : {}),
  });

const deps = (fetch: typeof globalThis.fetch) => ({ fetch, priceProvider });

describe('embedding accounting', () => {
  it('sends the same request with or without accounting, and touches no ledger without it', async () => {
    const plain = stubFetch(ok(4));
    await embed({ model, value: 'hello', deps: deps(plain.fetch) });
    const execution = createExecutionContext({ budget: { tokens: 10_000 } });
    const accounted = stubFetch(ok(4));
    await embed({
      model,
      value: 'hello',
      deps: deps(accounted.fetch),
      accounting: { execution, requestId: 'emb-1' },
    });
    expect(accounted.requests).toEqual(plain.requests);
  });

  it('reserves before the request and settles the reported usage at its price', async () => {
    const execution = createExecutionContext({ budget: { tokens: 10_000, usd: 1 } });
    const seen: { state?: string }[] = [];
    const { fetch } = stubFetch(() => {
      seen.push({ state: execution.ledger.get('emb-1')?.state });
      return ok(4)();
    });
    const result = await embed({
      model,
      value: 'hello',
      deps: deps(fetch),
      accounting: { execution, requestId: 'emb-1' },
    });
    expect(result.embedding).toEqual([0.5, 0.25]);
    expect(seen).toEqual([{ state: 'reserved' }]);
    expect(execution.ledger.get('emb-1')).toMatchObject({
      modelId: 'text-embedding-3-small',
      kind: 'embedding',
      state: 'settled',
      actual: { tokens: 4, usd: 0.000004 },
    });
    // The estimate came from the shared token estimator, priced like the usage.
    const reservation = execution.ledger.get('emb-1')!.reservation;
    expect(reservation.tokens).toBeGreaterThan(0);
    expect(reservation.usd).toBe(reservation.tokens! / 1_000_000);
  });

  it('takes the kind and the estimates it is given', async () => {
    const execution = createExecutionContext();
    const { fetch } = stubFetch(ok(4));
    await embedMany({
      model,
      values: ['a'],
      deps: deps(fetch),
      accounting: { execution, requestId: 'r', kind: 'rag-ingest', tokens: 77, usd: 0.5 },
    });
    expect(execution.ledger.get('r')).toMatchObject({
      kind: 'rag-ingest',
      reservation: { tokens: 77, usd: 0.5 },
    });
  });

  it('charges a request id once, however often it is embedded', async () => {
    const execution = createExecutionContext({ budget: { tokens: 10_000 } });
    const { fetch, requests } = stubFetch(ok(4), ok(4));
    for (let i = 0; i < 2; i++)
      await embedMany({
        model,
        values: ['hello'],
        deps: deps(fetch),
        accounting: { execution, requestId: 'emb-1' },
      });
    expect(requests).toHaveLength(2);
    expect(execution.ledger.totals().spent.tokens).toBe(4);
  });

  it('keeps the estimate held when the provider reports no usage', async () => {
    const execution = createExecutionContext({ budget: { tokens: 10_000 } });
    const { fetch } = stubFetch(ok());
    await embed({
      model,
      value: 'x',
      deps: deps(fetch),
      accounting: { execution, requestId: 'r' },
    });
    expect(execution.ledger.get('r')).toMatchObject({ state: 'unknown' });
    expect(execution.ledger.totals().reserved.tokens).toBeGreaterThan(0);
  });

  it('releases a request the provider refused before billing, and holds one it may have billed', async () => {
    const run = async (respond: () => Response | Promise<Response>) => {
      const execution = createExecutionContext({ budget: { tokens: 10_000 } });
      const { fetch } = stubFetch(respond);
      await expect(
        embed({
          model,
          value: 'x',
          maxRetries: 0,
          deps: deps(fetch),
          accounting: { execution, requestId: 'r' },
        }),
      ).rejects.toThrow();
      return execution.ledger.get('r')?.state;
    };
    expect(await run(() => Response.json({ error: { message: 'no' } }, { status: 401 }))).toBe(
      'released',
    );
    expect(await run(() => Response.json({ error: { message: 'busy' } }, { status: 429 }))).toBe(
      'released',
    );
    expect(await run(() => Response.json({ error: { message: 'down' } }, { status: 500 }))).toBe(
      'unknown',
    );
    expect(
      await run(() => {
        throw new TypeError('socket hang up');
      }),
    ).toBe('unknown');
  });

  it('refuses over budget before any request is sent', async () => {
    const execution = createExecutionContext({ budget: { tokens: 1 } });
    const { fetch, requests } = stubFetch(ok(4));
    await expect(
      embed({
        model,
        value: 'hello world',
        deps: deps(fetch),
        accounting: { execution, requestId: 'r' },
      }),
    ).rejects.toMatchObject({ code: 'budget_exceeded' });
    expect(requests).toHaveLength(0);
  });

  it('applies the execution policy: allowed models and the deadline', async () => {
    const check = async (execution: NativeExecutionContext, code: string) => {
      const { fetch, requests } = stubFetch(ok(4));
      await expect(
        embed({ model, value: 'x', deps: deps(fetch), accounting: { execution, requestId: 'r' } }),
      ).rejects.toMatchObject({ code });
      expect(requests).toHaveLength(0);
    };
    await check(
      createExecutionContext({ policy: { allowedModels: ['other'] } }),
      'model_not_allowed',
    );
    await check(createExecutionContext({ policy: { deadlineAt: 1 } }), 'deadline_exceeded');
  });

  it('charges nothing for no values', async () => {
    const execution = createExecutionContext();
    await embedMany({ model, values: [], accounting: { execution, requestId: 'r' } });
    expect(execution.ledger.get('r')).toBeUndefined();
  });

  it('refuses malformed accounting before any request', async () => {
    const { fetch, requests } = stubFetch(ok(4));
    for (const accounting of [{ execution: {}, requestId: 'r' }, { requestId: '' }])
      await expect(
        embed({
          model,
          value: 'x',
          deps: deps(fetch),
          accounting: { execution: createExecutionContext(), ...accounting } as never,
        }),
      ).rejects.toThrow(TypeError);
    expect(requests).toHaveLength(0);
  });
});
