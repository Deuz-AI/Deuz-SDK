/**
 * Webhook delivery into a goal inbox (2.4, spec §3.2): a Fetch API handler
 * that verifies with the `schedule/signal.ts` helpers, takes the scope and
 * the target goal from host configuration only, dedupes by scope + namespace
 * + delivery id, and answers 202 only after the durable commit, 200 only for
 * a matching recorded duplicate and 409 for the same id with another payload
 * or target.
 */
import { createHash, createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createGoal } from '../src/goal';
import { goalInboxKey } from '../src/goal/runtime/store';
import type { GoalRuntimeStore } from '../src/goal/runtime/store-types';
import { createWebhookHandler, toNodeHandler } from '../src/goal/runtime/webhook';
import type {
  NodeIncomingMessageLike,
  NodeServerResponseLike,
  WebhookHandlerOptions,
} from '../src/goal/runtime/webhook';
import {
  SimulatedCrash,
  createScheduleStoreDouble,
  withStoreFaults,
  type StoreFault,
} from './fixtures/goal-runtime-double';

const T0 = Date.parse('2026-10-10T10:00:00Z');
const secret = "It's a Secret to Everybody";
const URL = 'https://app.example.com/hooks/github';
const body = '{"action":"opened","scope":"other","goalId":"goal-2"}';

const hex = (key: string | Uint8Array, data: string) =>
  createHmac('sha256', key).update(data).digest('hex');
const sha256 = (data: string) => `sha256:${createHash('sha256').update(data).digest('hex')}`;

function github(
  payload = body,
  headers: Record<string, string> = {},
  key: string | Uint8Array = secret,
): Request {
  return new Request(URL, {
    method: 'POST',
    body: payload,
    headers: {
      'content-type': 'application/json',
      'x-github-delivery': 'd-1',
      'x-hub-signature-256': `sha256=${hex(key, payload)}`,
      ...headers,
    },
  });
}

async function setup(options: Partial<WebhookHandlerOptions> = {}, fault?: () => StoreFault) {
  let now = T0;
  const clock = { now: () => now, setTimeout: () => () => {} };
  const store = createScheduleStoreDouble({ deps: { clock } });
  for (const [goalId, scope] of [
    ['goal-1', 'tenant'],
    ['goal-2', 'tenant'],
    ['goal-x', 'other'],
  ] as const)
    await store.save(createGoal({ goalId, scope, objective: `Do ${goalId}.` }, { now: T0 }));
  const seen: GoalRuntimeStore = fault ? withStoreFaults(store, { enqueue: fault }) : store;
  const handler = createWebhookHandler({
    store: seen,
    verify: { kind: 'github', secret },
    target: { scope: 'tenant', goalId: 'goal-1' },
    namespace: 'webhook:github',
    deps: { clock },
    ...options,
  });
  return {
    store,
    handler,
    later: (ms: number) => {
      now += ms;
    },
  };
}

async function answer(response: Response) {
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

async function inbox(store: GoalRuntimeStore, scope = 'tenant') {
  return (await store.inbox.list({ scope, limit: 1000 })).entries;
}

describe('createWebhookHandler', () => {
  it('answers 202 once the delivery is enqueued, for the goal the host configured', async () => {
    const { store, handler } = await setup();
    const response = await handler(github());
    expect(response.headers.get('content-type')).toBe('application/json');
    expect(await answer(response)).toEqual({
      status: 202,
      body: { ok: true, deliveryId: 'd-1' },
    });
    const id = goalInboxKey('tenant', 'webhook:github', 'd-1');
    const [entry] = await inbox(store);
    // The body names another scope and goal: only the host configuration counts.
    expect(entry).toMatchObject({
      id,
      scope: 'tenant',
      goalId: 'goal-1',
      namespace: 'webhook:github',
      deliveryId: 'd-1',
      disposition: 'pending',
      payload: { body, mediaType: 'application/json' },
      event: {
        kind: 'deuz-goal-event',
        id,
        key: id,
        source: { type: 'signal', id: 'webhook:github' },
        scope: 'tenant',
        goalId: 'goal-1',
        at: T0,
        payload: {
          ref: id,
          digest: sha256(body),
          mediaType: 'application/json',
          bytes: new TextEncoder().encode(body).length,
        },
      },
    });
    expect(await inbox(store, 'other')).toEqual([]);
  });

  it('answers 200 for a recorded duplicate, and 409 delivery_conflict for another payload or target', async () => {
    let route = 'goal-1';
    const { store, handler, later } = await setup({
      target: () => ({ scope: 'tenant', goalId: route }),
    });
    expect((await handler(github())).status).toBe(202);
    const [stored] = await inbox(store);
    // The sender retries later: same id, same body, same goal.
    later(60_000);
    expect(await answer(await handler(github()))).toEqual({
      status: 200,
      body: { ok: true, duplicate: true, deliveryId: 'd-1' },
    });
    // The same delivery id with another body: refused, nothing recorded.
    expect(await answer(await handler(github('{"action":"closed"}')))).toEqual({
      status: 409,
      body: { ok: false, reason: 'delivery_conflict' },
    });
    // The same delivery id and body routed to another goal: refused too.
    route = 'goal-2';
    expect((await handler(github())).status).toBe(409);
    expect(await inbox(store)).toEqual([stored]);
  });

  it('never answers 202 unless the commit happened', async () => {
    const faults: StoreFault[] = ['before', 'after'];
    const { store, handler } = await setup({}, () => faults.shift());
    expect(await answer(await handler(github()))).toEqual({
      status: 500,
      body: { ok: false, reason: 'store-error' },
    });
    expect(await inbox(store)).toEqual([]);
    // Committed, but the answer was lost: the sender's retry finds the duplicate.
    expect((await handler(github())).status).toBe(500);
    expect(await inbox(store)).toHaveLength(1);
    expect((await handler(github())).status).toBe(200);
    expect(SimulatedCrash).toBeDefined();
  });

  it('refuses an unverified request with 401 and writes nothing', async () => {
    const { store, handler } = await setup();
    const tampered = github();
    const forged = new Request(URL, {
      method: 'POST',
      body: '{"action":"deleted"}',
      headers: tampered.headers,
    });
    expect(await answer(await handler(forged))).toEqual({
      status: 401,
      body: { ok: false, reason: 'bad-signature' },
    });
    const unsigned = github(body, { 'x-hub-signature-256': '' });
    expect((await answer(await handler(unsigned))).body.reason).toBe('missing-signature');
    expect((await handler(github(body, {}, 'another secret'))).status).toBe(401);
    expect(await inbox(store)).toEqual([]);
  });

  it('answers 404 when no target matches or the goal is not in that scope', async () => {
    for (const target of [
      () => undefined,
      { scope: 'tenant', goalId: 'missing' },
      { scope: 'tenant', goalId: 'goal-x' },
      async () => ({ scope: 'other', goalId: 'goal-1' }),
    ] as WebhookHandlerOptions['target'][]) {
      const { store, handler } = await setup({ target });
      expect(await answer(await handler(github()))).toEqual({
        status: 404,
        body: { ok: false, reason: 'unknown-target' },
      });
      expect([...(await inbox(store)), ...(await inbox(store, 'other'))]).toEqual([]);
    }
  });

  it('chooses the target from the verified body through host code', async () => {
    const { store, handler } = await setup({
      target: ({ body: text, request }) => {
        const repo = (JSON.parse(text) as { repo?: string }).repo;
        expect(request.headers.get('x-github-delivery')).toMatch(/^d-\d$/);
        return repo === 'core' ? { scope: 'tenant', goalId: 'goal-2' } : undefined;
      },
    });
    expect((await handler(github('{"repo":"core"}'))).status).toBe(202);
    expect((await inbox(store))[0]?.goalId).toBe('goal-2');
    expect((await handler(github('{"repo":"docs"}', { 'x-github-delivery': 'd-2' }))).status).toBe(
      404,
    );
  });

  it('refuses another method with 405 and a body over maxBodyBytes with 413', async () => {
    const { store, handler } = await setup({ maxBodyBytes: 64 });
    const get = await handler(new Request(URL, { method: 'GET' }));
    expect(get.status).toBe(405);
    expect(get.headers.get('allow')).toBe('POST');
    const big = 'x'.repeat(65);
    expect(await answer(await handler(github(big)))).toEqual({
      status: 413,
      body: { ok: false, reason: 'payload-too-large' },
    });
    // A streamed body without a length is cut off as it arrives.
    const chunks = ['x'.repeat(40), 'x'.repeat(40)];
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        const chunk = chunks.shift();
        if (chunk === undefined) controller.close();
        else controller.enqueue(new TextEncoder().encode(chunk));
      },
    });
    const streamed = new Request(URL, {
      method: 'POST',
      body: stream,
      headers: { 'x-hub-signature-256': `sha256=${hex(secret, chunks.join(''))}` },
      duplex: 'half',
    } as RequestInit);
    expect((await handler(streamed)).status).toBe(413);
    expect((await handler(github('{"ok":1}'))).status).toBe(202);
    expect(await inbox(store)).toHaveLength(1);
  });

  it('verifies a generic HMAC header, with a byte secret, encoding and prefix', async () => {
    const key = new TextEncoder().encode('byte secret');
    const signature = createHmac('sha512', key).update(body).digest('base64');
    const { handler } = await setup({
      verify: {
        kind: 'hmac',
        secret: key,
        header: 'x-signature',
        algorithm: 'SHA-512',
        encoding: 'base64',
        prefix: 'v1=',
      },
      deliveryId: 'x-request-id',
    });
    const request = (sig: string) =>
      new Request(URL, {
        method: 'POST',
        body,
        headers: { 'x-signature': sig, 'x-request-id': 'r-1' },
      });
    expect((await handler(request(`v1=${signature}`))).status).toBe(202);
    expect((await handler(request(signature))).status).toBe(401);
  });

  it('verifies GitHub and Slack deliveries with byte secrets too', async () => {
    const key = new TextEncoder().encode(secret);
    const gh = await setup({ verify: { kind: 'github', secret: key } });
    expect((await gh.handler(github(body, {}, key))).status).toBe(202);
    const slackSecret = new TextEncoder().encode('slack signing secret');
    const slack = await setup({
      verify: { kind: 'slack', signingSecret: slackSecret, toleranceSeconds: 60 },
      namespace: 'webhook:slack:T123',
    });
    const signed = (timestamp: number) =>
      new Request(URL, {
        method: 'POST',
        body,
        headers: {
          'x-slack-request-timestamp': String(timestamp),
          'x-slack-signature': `v0=${hex(slackSecret, `v0:${timestamp}:${body}`)}`,
        },
      });
    expect((await slack.handler(signed(T0 / 1000))).status).toBe(202);
    // The replay window is read from the injected clock.
    slack.later(120_000);
    expect(await answer(await slack.handler(signed(T0 / 1000)))).toEqual({
      status: 401,
      body: { ok: false, reason: 'stale-timestamp' },
    });
    const entries = await inbox(slack.store);
    expect(entries.map((entry) => entry.namespace)).toEqual(['webhook:slack:T123']);
    // No delivery id header: the body digest dedupes.
    expect(entries[0]?.deliveryId).toBe(sha256(body));
  });

  it('runs a custom verifier on a request whose body it can read once', async () => {
    const { store, handler } = await setup({
      verify: {
        kind: 'custom',
        verify: async (request) => {
          const text = await request.text();
          return text.startsWith('{')
            ? { ok: true, body: text }
            : { ok: false, reason: 'bad-signature' };
        },
      },
    });
    expect((await handler(new Request(URL, { method: 'POST', body: '{"a":1}' }))).status).toBe(202);
    expect((await handler(new Request(URL, { method: 'POST', body: 'nope' }))).status).toBe(401);
    expect(await inbox(store)).toHaveLength(1);
  });

  it('takes the delivery id from a header, a function, the GitHub header or the body digest', async () => {
    const fromFunction = await setup({
      deliveryId: ({ body: text }) => (JSON.parse(text) as { id?: string }).id,
    });
    await fromFunction.handler(github('{"id":"evt-7"}'));
    // An id the function cannot find falls back to the body digest.
    await fromFunction.handler(github('{"other":true}'));
    expect((await inbox(fromFunction.store)).map((entry) => entry.deliveryId)).toEqual([
      'evt-7',
      sha256('{"other":true}'),
    ]);
    const githubDefault = await setup();
    await githubDefault.handler(github(body, { 'x-github-delivery': 'gh-9' }));
    expect((await inbox(githubDefault.store))[0]?.deliveryId).toBe('gh-9');
  });

  it('adds the host fields of the event from the verified payload', async () => {
    const { store, handler } = await setup({
      event: ({ body: text, deliveryId }) => ({
        correlationId: (JSON.parse(text) as { wait: string }).wait,
        expiresAt: T0 + 3_600_000,
        causationId: deliveryId,
      }),
    });
    await handler(github('{"wait":"goal-1#3"}'));
    expect((await inbox(store))[0]?.event).toMatchObject({
      correlationId: 'goal-1#3',
      expiresAt: T0 + 3_600_000,
      causationId: 'd-1',
      scope: 'tenant',
      goalId: 'goal-1',
    });
  });

  it('answers 500 when host code throws, before anything is written', async () => {
    const { store, handler } = await setup({
      target: () => {
        throw new Error('routing table unavailable');
      },
    });
    expect(await answer(await handler(github()))).toEqual({
      status: 500,
      body: { ok: false, reason: 'target-error' },
    });
    expect(await inbox(store)).toEqual([]);
  });

  it('checks its options when created', async () => {
    const { store } = await setup();
    const base = {
      store,
      verify: { kind: 'github', secret },
      target: { scope: 'tenant', goalId: 'goal-1' },
      namespace: 'webhook:github',
    } as WebhookHandlerOptions;
    expect(() => createWebhookHandler({ ...base, namespace: '' })).toThrow(TypeError);
    expect(() => createWebhookHandler({ ...base, maxBodyBytes: 0 })).toThrow(TypeError);
    expect(() => createWebhookHandler({ ...base, verify: { kind: 'magic' } as never })).toThrow(
      TypeError,
    );
    expect(() =>
      createWebhookHandler({ ...base, target: { scope: '', goalId: 'goal-1' } }),
    ).toThrow(TypeError);
  });
});

describe('toNodeHandler', () => {
  /** An `IncomingMessage` look-alike: method, url, headers and body chunks. */
  function incoming(
    chunks: (string | Uint8Array)[],
    fields: Partial<Omit<NodeIncomingMessageLike, typeof Symbol.asyncIterator>> = {},
  ): NodeIncomingMessageLike & { read: number } {
    const message = {
      method: 'POST',
      url: '/hooks/github?attempt=2',
      headers: { host: 'api.example.com' },
      ...fields,
      read: 0,
      async *[Symbol.asyncIterator]() {
        for (const chunk of chunks) {
          message.read += 1;
          yield chunk;
        }
      },
    };
    return message;
  }

  function outgoing() {
    const written = {
      statusCode: 0,
      headers: {} as Record<string, string>,
      body: undefined as string | undefined,
      ended: 0,
    };
    const response: NodeServerResponseLike = {
      get statusCode() {
        return written.statusCode;
      },
      set statusCode(value: number) {
        written.statusCode = value;
      },
      setHeader(name, value) {
        written.headers[name.toLowerCase()] = value;
      },
      end(chunk) {
        written.ended += 1;
        written.body =
          chunk === undefined
            ? ''
            : typeof chunk === 'string'
              ? chunk
              : new TextDecoder().decode(chunk);
      },
    };
    return { response, written };
  }

  it('builds the Request from the message and writes the Response back', async () => {
    let seen: Request | undefined;
    let seenBody = '';
    const node = toNodeHandler(async (request) => {
      seen = request;
      seenBody = await request.text();
      return new Response('{"ok":true}', {
        status: 202,
        headers: { 'content-type': 'application/json', 'x-trace': 't-1' },
      });
    });
    const { response, written } = outgoing();
    await node(
      incoming(['{"a":', new TextEncoder().encode('1}')], {
        headers: {
          host: 'api.example.com',
          'content-type': 'application/json',
          'x-multi': ['one', 'two'],
          'x-absent': undefined,
        },
      }),
      response,
    );
    expect(seen?.method).toBe('POST');
    expect(seen?.url).toBe('http://api.example.com/hooks/github?attempt=2');
    expect(seen?.headers.get('content-type')).toBe('application/json');
    expect(seen?.headers.get('x-multi')).toBe('one, two');
    expect(seen?.headers.has('x-absent')).toBe(false);
    expect(seenBody).toBe('{"a":1}');
    expect(written).toEqual({
      statusCode: 202,
      headers: { 'content-type': 'application/json', 'x-trace': 't-1' },
      body: '{"ok":true}',
      ended: 1,
    });
  });

  it('resolves the URL against origin, and sends no body with GET', async () => {
    let seen: Request | undefined;
    const node = toNodeHandler(
      async (request) => {
        seen = request;
        return new Response(null, { status: 405 });
      },
      { origin: 'https://hooks.example.com' },
    );
    const { response, written } = outgoing();
    const message = incoming(['ignored'], { method: 'get', url: '/x' });
    await node(message, response);
    expect(seen?.url).toBe('https://hooks.example.com/x');
    expect(seen?.method).toBe('GET');
    expect(seen?.body).toBeNull();
    expect(message.read).toBe(0);
    expect(written).toMatchObject({ statusCode: 405, body: '', ended: 1 });
    expect(() => toNodeHandler(async () => new Response(), { origin: 'not a url' })).toThrow(
      TypeError,
    );
  });

  it('streams the body, so an oversized one stops being read', async () => {
    const { handler } = await setup({ maxBodyBytes: 10 });
    const node = toNodeHandler(handler);
    const { response, written } = outgoing();
    const message = incoming(['0123456789', 'abcdef', 'more', 'and more']);
    await node(message, response);
    expect(written.statusCode).toBe(413);
    expect(message.read).toBeLessThan(4);
  });

  it('answers 500 when the handler throws', async () => {
    const node = toNodeHandler(async () => {
      throw new Error('boom');
    });
    const { response, written } = outgoing();
    await node(incoming(['{}']), response);
    expect(written.statusCode).toBe(500);
    expect(JSON.parse(written.body ?? '')).toEqual({ ok: false, reason: 'handler-error' });
  });

  it('serves a webhook from a real node:http server', async () => {
    const { createServer } = await import('node:http');
    const { store, handler } = await setup();
    const server = createServer(toNodeHandler(handler));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const { port } = server.address() as { port: number };
      const signed = github();
      const response = await fetch(`http://127.0.0.1:${port}/hooks/github`, {
        method: 'POST',
        headers: signed.headers,
        body,
      });
      expect(response.status).toBe(202);
      expect(await response.json()).toEqual({ ok: true, deliveryId: 'd-1' });
      expect(await inbox(store)).toHaveLength(1);
      const again = await fetch(`http://127.0.0.1:${port}/hooks/github`, {
        method: 'POST',
        headers: signed.headers,
        body,
      });
      expect(again.status).toBe(200);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
