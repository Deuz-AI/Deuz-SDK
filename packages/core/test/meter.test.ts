/**
 * deuz meter (2.5): the budget proxy's public contract, offline. The upstream
 * is a fake provider on a 127.0.0.1 port; no real provider is called.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemoryBudgetStore } from '../src/budget-store';
import { createPriceProvider } from '../src/pricing';
import {
  createMeterHandler,
  declaredReceipt,
  estimatePromptTokens,
  type MeterOptions,
  type MeterReceipt,
  type MeterWarning,
} from '../src/meter/index';
import { createJsonlReceiptSink, createMeterProxy } from '../src/node/meter';

type Behavior = (req: IncomingMessage, res: ServerResponse, body: string) => void | Promise<void>;

let upstream: Server;
let base = '';
let behavior: Behavior = (_req, res) => {
  res.end();
};
const seen: { url: string; headers: IncomingMessage['headers']; body: string }[] = [];

beforeAll(async () => {
  upstream = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += String(chunk);
    seen.push({ url: req.url ?? '', headers: req.headers, body });
    await behavior(req, res, body);
  });
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const address = upstream.address();
  base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
});

afterAll(async () => {
  upstream.closeAllConnections();
  await new Promise<void>((resolve) => upstream.close(() => resolve()));
});

beforeEach(() => {
  seen.length = 0;
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

const sse = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

const ANTHROPIC_START = sse('message_start', {
  type: 'message_start',
  message: {
    id: 'msg_1',
    usage: {
      input_tokens: 100,
      output_tokens: 1,
      cache_read_input_tokens: 1000,
      cache_creation_input_tokens: 200,
      cache_creation: { ephemeral_5m_input_tokens: 150, ephemeral_1h_input_tokens: 50 },
    },
  },
});
const ANTHROPIC_REST =
  sse('content_block_delta', {
    type: 'content_block_delta',
    index: 0,
    delta: { type: 'text_delta', text: 'Hello' },
  }) +
  sse('message_delta', {
    type: 'message_delta',
    delta: { stop_reason: 'end_turn' },
    usage: { output_tokens: 300 },
  }) +
  sse('message_stop', { type: 'message_stop' });
/** claude-opus-5-5: 100 x $4 + 300 x $20 + 1000 x $0.2 + 150 x $5 + 50 x $8, per million. */
const ANTHROPIC_USD = 0.00775;

function setup(extra: Partial<MeterOptions> = {}, limits: { usd?: number; tokens?: number } = {}) {
  const store = createInMemoryBudgetStore();
  const receipts: MeterReceipt[] = [];
  const warnings: MeterWarning[] = [];
  let n = 0;
  const meter = createMeterHandler({
    upstreams: [
      { provider: 'anthropic', kind: 'anthropic', baseUrl: base },
      { provider: 'openai', kind: 'openai', baseUrl: base },
    ],
    budget: { store, scopes: [{ key: 'dev', limits: { usd: 1, ...limits } }] },
    receipts: (receipt) => {
      receipts.push(receipt);
    },
    onWarning: (warning) => warnings.push(warning),
    deps: { generateId: () => `r${++n}` },
    ...extra,
  });
  return { meter, store, receipts, warnings };
}

function post(path: string, body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`http://meter.local${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

const anthropicBody = (extra: Record<string, unknown> = {}) => ({
  model: 'claude-opus-5-5',
  max_tokens: 1000,
  messages: [{ role: 'user', content: 'hi' }],
  ...extra,
});

describe('deuz meter handler', () => {
  it('streams Anthropic SSE through chunk by chunk and settles the measured usage', async () => {
    const gate = deferred();
    behavior = async (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'request-id': 'req_up_1' });
      res.write(ANTHROPIC_START);
      await gate.promise;
      // An event split across two writes.
      const cut = ANTHROPIC_REST.indexOf('output_tokens');
      res.write(ANTHROPIC_REST.slice(0, cut));
      res.end(ANTHROPIC_REST.slice(cut));
    };
    const { meter, store, receipts } = setup();
    const response = await meter.fetch(
      post('/v1/messages', anthropicBody({ stream: true }), { 'x-api-key': 'sk-ant-secret' }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('x-deuz-meter-id')).toBe('r1');
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    // The first event arrives while the upstream is still holding the rest back.
    let text = decoder.decode((await reader.read()).value, { stream: true });
    expect(text).toContain('message_start');
    gate.resolve();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
    expect(text).toBe(ANTHROPIC_START + ANTHROPIC_REST);

    const [receipt] = receipts;
    expect(receipt).toMatchObject({
      source: 'measured',
      provider: 'anthropic',
      protocol: 'anthropic-messages',
      model: 'claude-opus-5-5',
      route: '/v1/messages',
      status: 200,
      outcome: 'completed',
      stream: true,
      usageComplete: true,
      usd: ANTHROPIC_USD,
      settlement: 'measured',
      budgetKeys: ['dev'],
      upstreamRequestId: 'req_up_1',
      priced: true,
      usage: {
        inputTokens: 100,
        outputTokens: 300,
        cachedReadTokens: 1000,
        cacheWriteTokens: 150,
        cacheWrite1hTokens: 50,
        totalTokens: 1600,
      },
    });
    expect(receipt!.estimate!.usd).toBeGreaterThan(ANTHROPIC_USD);
    expect(await store.usage('dev')).toEqual({ tokens: 1600, usd: ANTHROPIC_USD });
    expect(meter.stats()).toMatchObject({ requests: 1, completed: 1, inFlight: 0, tokens: 1600 });
  });

  it('reads non-streaming Anthropic JSON usage', async () => {
    behavior = (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'msg_2', usage: { input_tokens: 50, output_tokens: 10 } }));
    };
    const { meter, receipts } = setup();
    const response = await meter.fetch(post('/v1/messages', anthropicBody()));
    await response.json();
    expect(receipts[0]).toMatchObject({
      stream: false,
      usageComplete: true,
      settlement: 'measured',
      usage: { inputTokens: 50, outputTokens: 10, totalTokens: 60 },
      usd: (50 * 4 + 10 * 20) / 1e6,
    });
  });

  it('injects include_usage into streaming Chat Completions and measures the usage chunk', async () => {
    behavior = (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'hi' } }] })}\n\n`);
      res.write(
        `data: ${JSON.stringify({
          choices: [],
          usage: {
            prompt_tokens: 500,
            completion_tokens: 100,
            total_tokens: 600,
            prompt_tokens_details: { cached_tokens: 200 },
          },
        })}\n\n`,
      );
      res.end('data: [DONE]\n\n');
    };
    const { meter, receipts } = setup();
    const response = await meter.fetch(
      post('/v1/chat/completions', {
        model: 'gpt-5.6-sol',
        stream: true,
        stream_options: { foo: 1 },
        messages: [{ role: 'user', content: 'hi' }],
      }),
    );
    await response.text();
    expect(JSON.parse(seen[0]!.body).stream_options).toEqual({ foo: 1, include_usage: true });
    expect(receipts[0]).toMatchObject({
      protocol: 'openai-chat',
      provider: 'openai',
      settlement: 'measured',
      usage: { inputTokens: 300, cachedReadTokens: 200, outputTokens: 100, totalTokens: 600 },
      usd: (300 * 4 + 200 * 0.4 + 100 * 20) / 1e6,
    });
  });

  it('charges the estimate, fail-closed, when a stream ends without usage', async () => {
    behavior = (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(
        `data: ${JSON.stringify({ choices: [{ delta: { content: 'hi' } }] })}\n\ndata: [DONE]\n\n`,
      );
    };
    const { meter, store, receipts, warnings } = setup({ injectStreamUsage: false });
    const response = await meter.fetch(
      post('/v1/chat/completions', { model: 'gpt-5.6-sol', stream: true, max_tokens: 64 }),
    );
    await response.text();
    expect(JSON.parse(seen[0]!.body).stream_options).toBeUndefined();
    const receipt = receipts[0]!;
    expect(receipt).toMatchObject({ settlement: 'estimate', usageComplete: false });
    expect(receipt.charged).toEqual({
      tokens: receipt.estimate!.tokens,
      usd: receipt.estimate!.usd,
    });
    expect((await store.usage('dev')).tokens).toBe(receipt.estimate!.tokens);
    expect(warnings).toContainEqual(expect.objectContaining({ type: 'usage-missing' }));
  });

  it('reads the Responses API usage from response.completed', async () => {
    behavior = (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(
        sse('response.output_text.delta', { type: 'response.output_text.delta', delta: 'x' }),
      );
      res.end(
        sse('response.completed', {
          type: 'response.completed',
          response: {
            status: 'completed',
            usage: {
              input_tokens: 1000,
              input_tokens_details: { cached_tokens: 400 },
              output_tokens: 200,
              output_tokens_details: { reasoning_tokens: 50 },
              total_tokens: 1200,
            },
          },
        }),
      );
    };
    const { meter, receipts } = setup();
    await (await meter.fetch(post('/v1/responses', { model: 'gpt-5.6-sol', stream: true }))).text();
    expect(receipts[0]).toMatchObject({
      protocol: 'openai-responses',
      settlement: 'measured',
      usage: { inputTokens: 600, cachedReadTokens: 400, outputTokens: 200, reasoningTokens: 50 },
      usd: 0.00656,
    });
  });

  it('measures a streamed reply that carries no content-type (ChatGPT Codex backend)', async () => {
    behavior = (_req, res) => {
      res.writeHead(200);
      res.end(
        sse('response.completed', {
          type: 'response.completed',
          response: {
            status: 'completed',
            usage: { input_tokens: 1000, output_tokens: 200, total_tokens: 1200 },
          },
        }),
      );
    };
    const { meter, receipts } = setup();
    await (await meter.fetch(post('/v1/responses', { model: 'gpt-5.6-sol', stream: true }))).text();
    expect(receipts[0]).toMatchObject({
      settlement: 'measured',
      stream: true,
      usage: { inputTokens: 1000, outputTokens: 200 },
    });
  });

  it('answers 402 at the ceiling in each provider error shape, without forwarding', async () => {
    const { meter, receipts } = setup({}, { usd: 0.01 });
    const anthropic = await meter.fetch(post('/v1/messages', anthropicBody({ stream: true })));
    expect(anthropic.status).toBe(402);
    const error = (await anthropic.json()) as {
      type: string;
      error: { type: string; message: string };
    };
    expect(error.type).toBe('error');
    expect(error.error.type).toBe('billing_error');
    // Nothing is committed yet: the request's estimate alone is over the limit.
    expect(error.error.message).toContain('budget dev cannot cover this request');
    expect(error.error.message).not.toContain('exhausted');

    const openai = await meter.fetch(
      post('/v1/chat/completions', { model: 'gpt-5.6-sol', max_tokens: 10_000 }),
    );
    expect(openai.status).toBe(402);
    expect(((await openai.json()) as { error: { code: string } }).error.code).toBe(
      'insufficient_quota',
    );

    expect(seen).toHaveLength(0);
    expect(receipts[0]).toMatchObject({
      outcome: 'refused',
      status: 402,
      settlement: 'none',
      refusal: {
        reason: 'budget_exceeded',
        key: 'dev',
        dimension: 'usd',
        limit: 0.01,
        committed: 0,
      },
    });
  });

  it('says "is exhausted" only once the committed spend has reached the limit', async () => {
    const { meter, store } = setup({}, { usd: 0.01 });
    await store.reserve({
      requestId: 'earlier',
      modelId: 'claude-opus-5-5',
      tokens: 0,
      usd: 0.01,
      scopes: [{ key: 'dev', limits: { usd: 0.01 } }],
    });
    await store.settle('earlier', { tokens: 0, usd: 0.01 });
    const refused = await meter.fetch(post('/v1/messages', anthropicBody()));
    expect(refused.status).toBe(402);
    const body = (await refused.json()) as { error: { message: string } };
    expect(body.error.message).toContain('budget dev is exhausted');
  });

  it('releases the hold when the upstream refuses the request', async () => {
    behavior = (_req, res) => {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'no' } }),
      );
    };
    const { meter, store, receipts } = setup();
    const response = await meter.fetch(post('/v1/messages', anthropicBody()));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { message: 'no' } });
    expect(receipts[0]).toMatchObject({ outcome: 'upstream_error', settlement: 'released' });
    expect(await store.usage('dev')).toEqual({ tokens: 0, usd: 0 });
  });

  it('charges the estimate when the client goes away before the response begins', async () => {
    const sent = deferred();
    behavior = async () => {
      sent.resolve(); // the request reached the provider; it never answers
      await new Promise(() => {});
    };
    const { meter, store, receipts } = setup();
    const controller = new AbortController();
    const request = new Request('http://meter.local/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(anthropicBody()),
      signal: controller.signal,
    });
    const answered = meter.fetch(request);
    await sent.promise;
    controller.abort();
    await answered;
    await meter.flush();
    const receipt = receipts[0]!;
    expect(receipt).toMatchObject({ outcome: 'aborted', settlement: 'estimate' });
    expect(receipt.charged?.tokens).toBe(receipt.estimate!.tokens);
    expect((await store.usage('dev')).tokens).toBe(receipt.estimate!.tokens);
  });

  it('forwards a request that carried Expect: 100-continue', async () => {
    behavior = (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ usage: { input_tokens: 10, output_tokens: 5 } }));
    };
    const { meter, receipts } = setup();
    const response = await meter.fetch(
      post('/v1/messages', anthropicBody(), { expect: '100-continue' }),
    );
    expect(response.status).toBe(200);
    await response.text();
    await meter.flush();
    expect(seen[0]!.headers.expect).toBeUndefined();
    expect(receipts[0]).toMatchObject({ settlement: 'measured' });
  });

  it('estimates every Chat Completions choice (n) at the output cap', async () => {
    const { meter, receipts } = setup({}, { usd: 1e-9 });
    const body = { model: 'gpt-5.6-sol', max_tokens: 1000, n: 8 };
    expect((await meter.fetch(post('/v1/chat/completions', body))).status).toBe(402);
    expect(receipts[0]!.estimate!.tokens).toBe(
      estimatePromptTokens(JSON.stringify(body), 3) + 8 * 1000,
    );
  });

  it('admits an unpriced model under warn and refuses it under reject', async () => {
    behavior = (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ usage: { input_tokens: 5, output_tokens: 5 } }));
    };
    const warned = setup();
    for (let i = 0; i < 2; i++)
      await (
        await warned.meter.fetch(post('/v1/messages', anthropicBody({ model: 'mystery-1' })))
      ).text();
    expect(warned.receipts[0]).toMatchObject({
      priced: false,
      settlement: 'measured',
      charged: { tokens: 10, usd: 0 },
    });
    expect(warned.receipts[0]!.usd).toBeUndefined();
    expect(warned.warnings.filter((w) => w.type === 'unpriced-model')).toHaveLength(1);
    expect(warned.meter.stats().unpricedModels).toEqual(['mystery-1']);

    seen.length = 0;
    const strict = setup({ unknownPrice: 'reject' });
    const refused = await strict.meter.fetch(
      post('/v1/messages', anthropicBody({ model: 'mystery-1' })),
    );
    expect(refused.status).toBe(402);
    expect(seen).toHaveLength(0);
    expect(strict.receipts[0]).toMatchObject({
      outcome: 'refused',
      refusal: { reason: 'unpriced_model' },
    });
  });

  it('passes auth headers through untouched and never exposes them', async () => {
    behavior = (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ usage: { input_tokens: 1, output_tokens: 1 } }));
    };
    let visible: Record<string, string> = {};
    const store = createInMemoryBudgetStore();
    const { meter, receipts } = setup({
      budget: {
        store,
        scopes: (info) => {
          visible = { ...info.headers };
          return [{ key: `harness:${info.headers['x-harness'] ?? 'none'}`, limits: { usd: 1 } }];
        },
      },
    });
    await (
      await meter.fetch(
        post('/v1/messages', anthropicBody(), {
          'x-api-key': 'sk-ant-secret',
          authorization: 'Bearer sk-oauth-secret',
          'anthropic-version': '2023-06-01',
          'x-harness': 'claude-code',
        }),
      )
    ).text();
    expect(seen[0]!.headers['x-api-key']).toBe('sk-ant-secret');
    expect(seen[0]!.headers.authorization).toBe('Bearer sk-oauth-secret');
    expect(visible['anthropic-version']).toBe('2023-06-01');
    expect(visible['x-api-key']).toBeUndefined();
    expect(visible.authorization).toBeUndefined();
    expect(receipts[0]!.budgetKeys).toEqual(['harness:claude-code']);
    expect(JSON.stringify(receipts)).not.toMatch(/secret|"hi"/);
  });

  it('rejects unmetered POST routes by default and passes other methods through', async () => {
    behavior = (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [] }));
    };
    const { meter, receipts } = setup();
    const batch = await meter.fetch(post('/v1/batches', { input_file_id: 'f' }));
    expect(batch.status).toBe(404);
    expect(((await batch.json()) as { error: { code: string } }).error.code).toBe(
      'unmetered_route',
    );
    const models = await meter.fetch(new Request('http://meter.local/v1/models?limit=5'));
    expect(await models.json()).toEqual({ data: [] });
    expect(seen.map((item) => item.url)).toEqual(['/v1/models?limit=5']);
    expect(receipts).toHaveLength(1);
    expect(meter.stats()).toMatchObject({ passthrough: 1, failed: 1 });

    const open = setup({ unmeteredRoutes: 'forward' });
    await (await open.meter.fetch(post('/v1/batches', { input_file_id: 'f' }))).text();
    expect(open.receipts[0]).toMatchObject({ outcome: 'completed', settlement: 'none' });
  });

  it('sends Anthropic-shaped requests on a shared mount to the Anthropic upstream', async () => {
    // Claude Code 2.1.331 sends HEAD /api/hello with no anthropic-version header.
    behavior = (_req, res) => {
      res.writeHead(200);
      res.end();
    };
    const meter = createMeterHandler({
      upstreams: [
        { provider: 'anthropic', kind: 'anthropic', baseUrl: `${base}/an` },
        { provider: 'openai', kind: 'openai', baseUrl: `${base}/oa` },
      ],
    });
    await meter.fetch(new Request('http://meter.local/api/hello', { method: 'HEAD' }));
    await meter.fetch(
      new Request('http://meter.local/v1/models', { headers: { 'anthropic-beta': 'x' } }),
    );
    await meter.fetch(new Request('http://meter.local/v1/models'));
    expect(seen.map((item) => item.url)).toEqual([
      '/an/api/hello',
      '/an/v1/models',
      '/oa/v1/models',
    ]);
  });
});

describe('deuz meter helpers', () => {
  it('estimates base64 runs as attachments, not prose', () => {
    expect(estimatePromptTokens('a'.repeat(30), 3)).toBe(10);
    expect(estimatePromptTokens(`${'a '.repeat(15)}${'QUJD'.repeat(512)}`, 3)).toBe(10 + 64);
  });

  it('builds declared receipts in the same shape', async () => {
    const receipt = await declaredReceipt(
      {
        provider: 'acp:zed',
        model: 'claude-opus-5-5',
        route: 'acp:session/prompt',
        usage: {
          inputTokens: 1000,
          outputTokens: 100,
          reasoningTokens: 0,
          cachedReadTokens: 0,
          cacheWriteTokens: 0,
          cacheWrite1hTokens: 0,
          totalTokens: 1100,
        },
      },
      {
        priceProvider: createPriceProvider(),
        generateId: () => 'd1',
        clock: { now: () => 5, setTimeout: () => () => {} },
      },
    );
    expect(receipt).toMatchObject({
      version: 1,
      id: 'd1',
      requestId: 'declared:d1',
      source: 'declared',
      startedAt: 5,
      usd: 0.006,
      settlement: 'none',
      priced: true,
    });
  });
});

describe('deuz meter node proxy', () => {
  it('serves on 127.0.0.1, settles a client abort fail-closed and writes JSONL receipts', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'deuz-meter-'));
    const hold = deferred();
    behavior = async (req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(ANTHROPIC_START);
      req.on('close', () => hold.resolve());
      await hold.promise;
      res.end();
    };
    const store = createInMemoryBudgetStore();
    const sink = createJsonlReceiptSink({ path: join(dir, 'logs', 'meter.jsonl') });
    const proxy = createMeterProxy({
      upstreams: [{ provider: 'anthropic', kind: 'anthropic', baseUrl: base }],
      budget: { store, scopes: [{ key: 'dev', limits: { usd: 1 } }] },
      receipts: sink,
    });
    try {
      const { url, host } = await proxy.listen();
      expect(host).toBe('127.0.0.1');
      const abort = new AbortController();
      const response = await fetch(`${url}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': 'sk-ant-secret' },
        body: JSON.stringify(anthropicBody({ stream: true })),
        signal: abort.signal,
      });
      const reader = response.body!.getReader();
      expect(new TextDecoder().decode((await reader.read()).value)).toContain('message_start');
      abort.abort();
      await vi.waitFor(() => expect(proxy.stats().aborted).toBe(1));
      await proxy.close();

      const lines = (await readFile(join(dir, 'logs', 'meter.jsonl'), 'utf8')).trim().split('\n');
      expect(lines).toHaveLength(1);
      const receipt = JSON.parse(lines[0]!) as MeterReceipt;
      expect(receipt).toMatchObject({
        outcome: 'aborted',
        settlement: 'estimate',
        usageComplete: false,
      });
      expect(receipt.charged!.usd).toBe(receipt.estimate!.usd);
      expect((await store.usage('dev')).usd).toBe(receipt.estimate!.usd);
      expect(lines[0]).not.toContain('sk-ant-secret');
    } finally {
      hold.resolve();
      await proxy.close({ force: true });
      await rm(dir, { recursive: true, force: true });
    }
  });
});
