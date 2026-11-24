/**
 * `@deuz-sdk/core/acp` (2.5) — the Agent Client Protocol. A native agent
 * served with `serveAcpAgent` (mock model, in-memory run store) and a client
 * from `connectAcpAgent` talk over an in-memory transport pair, so every test
 * reads the wire as an editor would. Raw JSON-RPC checks drive the peer with
 * hand-written lines.
 */
import { describe, it, expect } from 'vitest';
import { PassThrough } from 'node:stream';
import {
  ACP_DEUZ_META,
  ACP_ERROR_CODES,
  ACP_PROTOCOL_VERSION,
  connectAcpAgent,
  createAcpPeer,
  createInMemoryAcpSessionStore,
  createInMemoryAcpTransportPair,
  createNdjsonTransport,
  serveAcpAgent,
  type AcpAgentOptions,
  type AcpClientOptions,
  type AcpSessionUpdate,
  type AcpTransport,
} from '../src/acp';
import { serveAcpAgentStdio, nodeStreamsToAcpTransport } from '../src/node/acp-stdio';
import {
  createInMemoryAgentRunStore,
  createInMemoryBudgetStore,
  resumeStreamAgent,
  streamAgent,
} from '../src/agent';
import { createApprovalSigner } from '../src/durable';
import { createMockModel, type MockResponse } from '../src/testing';

const engine = { streamAgent, resumeStreamAgent };
const CWD = '/work/repo';

function writeTool(log: string[]) {
  return {
    description: 'Write a file.',
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    needsApproval: true,
    execute: async (args: { path: string }) => {
      log.push(args.path);
      return { written: args.path };
    },
  };
}

/** An agent served on one end of an in-memory pair, and a client connected to the other. */
async function setup(
  responses: MockResponse[],
  agentOptions: Partial<AcpAgentOptions> = {},
  clientOptions: Partial<AcpClientOptions> = {},
) {
  const [agentSide, clientSide] = createInMemoryAcpTransportPair();
  const errors: unknown[] = [];
  const store = createInMemoryAgentRunStore();
  const model = createMockModel({ responses });
  const server = serveAcpAgent({
    transport: agentSide,
    agent: engine,
    store,
    run: { model, maxSteps: 5 },
    approvalSigner: createApprovalSigner({ secret: 'test-secret' }),
    contextWindow: 100_000,
    onError: (error) => errors.push(error),
    ...agentOptions,
  });
  const client = await connectAcpAgent({ transport: clientSide, ...clientOptions });
  return { server, client, store, errors, model };
}

/** Raw lines on a transport: send text, read parsed JSON. */
function raw(transport: AcpTransport) {
  const writer = transport.writable.getWriter();
  const reader = transport.readable.getReader();
  return {
    send: (text: string) => writer.write(text),
    // Raw JSON-RPC frames: the tests read arbitrary nested fields.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    next: async () => JSON.parse((await reader.read()).value as string) as Record<string, any>,
  };
}

describe('ACP JSON-RPC peer', () => {
  it('answers malformed input with the JSON-RPC errors and keeps serving', async () => {
    const [a, b] = createInMemoryAcpTransportPair();
    const errors: unknown[] = [];
    createAcpPeer({
      transport: a,
      requests: { echo: (params) => params },
      onError: (e) => errors.push(e),
    });
    const wire = raw(b);
    await wire.send('{not json');
    expect((await wire.next()).error).toEqual({
      code: ACP_ERROR_CODES.parseError,
      message: 'Parse error',
    });
    await wire.send(JSON.stringify({ id: 1, method: 'echo' }));
    expect(await wire.next()).toMatchObject({
      id: 1,
      error: { code: ACP_ERROR_CODES.invalidRequest },
    });
    await wire.send(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'nope' }));
    expect(await wire.next()).toMatchObject({
      id: 2,
      error: { code: ACP_ERROR_CODES.methodNotFound },
    });
    await wire.send(JSON.stringify({ jsonrpc: '2.0', id: 'x', method: 'echo', params: { a: 1 } }));
    expect(await wire.next()).toEqual({ jsonrpc: '2.0', id: 'x', result: { a: 1 } });
  });

  it('cancels a handler on $/cancel_request and answers -32800', async () => {
    const [a, b] = createInMemoryAcpTransportPair();
    createAcpPeer({
      transport: a,
      requests: {
        slow: (_params, { signal }) =>
          new Promise((_, reject) =>
            signal.addEventListener('abort', () => reject(new Error('stopped'))),
          ),
      },
    });
    const caller = createAcpPeer({ transport: b });
    const controller = new AbortController();
    const pending = caller.request('slow', {}, { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AcpError', kind: 'cancelled' });
    // A plain request still answers -32800 when its handler was cancelled by the peer.
    const [c, d] = createInMemoryAcpTransportPair();
    createAcpPeer({
      transport: c,
      requests: {
        slow: (_p, { signal }) =>
          new Promise((_, reject) =>
            signal.addEventListener('abort', () => reject(new Error('x'))),
          ),
      },
    });
    const wire = raw(d);
    await wire.send(JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'slow' }));
    await wire.send(
      JSON.stringify({ jsonrpc: '2.0', method: '$/cancel_request', params: { requestId: 7 } }),
    );
    expect(await wire.next()).toMatchObject({
      id: 7,
      error: { code: ACP_ERROR_CODES.requestCancelled },
    });
  });

  it('drops the late answer to a request it cancelled, but still reports a response to no request', async () => {
    const [a, b] = createInMemoryAcpTransportPair();
    const errors: unknown[] = [];
    const caller = createAcpPeer({
      transport: a,
      requests: { ping: () => 'pong' },
      onError: (e) => errors.push(e),
    });
    const wire = raw(b);
    const controller = new AbortController();
    const pending = caller.request('slow', {}, { signal: controller.signal });
    const sent = await wire.next();
    controller.abort();
    await expect(pending).rejects.toMatchObject({ kind: 'cancelled' });
    expect(await wire.next()).toMatchObject({
      method: '$/cancel_request',
      params: { requestId: sent.id },
    });
    // The spec has the receiver still answer a cancelled request.
    await wire.send(
      JSON.stringify({ jsonrpc: '2.0', id: sent.id, error: { code: -32800, message: 'x' } }),
    );
    await wire.send(JSON.stringify({ jsonrpc: '2.0', id: 999, result: null }));
    await wire.send(JSON.stringify({ jsonrpc: '2.0', id: 'p', method: 'ping' }));
    expect(await wire.next()).toMatchObject({ id: 'p', result: 'pong' });
    expect(errors.map((e) => String((e as Error).message))).toEqual([
      expect.stringContaining('id 999'),
    ]);
  });

  it('frames newline-delimited JSON across chunk boundaries, CRLF and oversized lines', async () => {
    const encoder = new TextEncoder();
    const bytes = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('{"a":'));
        controller.enqueue(encoder.encode('1}\r\n\n{"b":2}\n'));
        controller.enqueue(encoder.encode('x'.repeat(40) + '\n{"c":3}'));
        controller.close();
      },
    });
    const transport = createNdjsonTransport({
      readable: bytes,
      writable: new WritableStream(),
      maxMessageBytes: 16,
    });
    const lines: string[] = [];
    const reader = transport.readable.getReader();
    for (let next = await reader.read(); !next.done; next = await reader.read())
      lines.push(next.value);
    expect(lines[0]).toBe('{"a":1}');
    expect(lines[1]).toBe('{"b":2}');
    expect(lines[2]).not.toMatch(/^x/); // the oversized line is replaced by a marker, never buffered whole
    expect(lines[3]).toBe('{"c":3}');
  });
});

describe('serveAcpAgent + connectAcpAgent', () => {
  it('negotiates the version, advertises the Deuz extensions and gates requests before initialize', async () => {
    const [agentSide, clientSide] = createInMemoryAcpTransportPair();
    serveAcpAgent({
      transport: agentSide,
      agent: engine,
      store: createInMemoryAgentRunStore(),
      run: { model: createMockModel({ responses: [] }) },
    });
    const wire = raw(clientSide);
    await wire.send(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'session/new',
        params: { cwd: CWD, mcpServers: [] },
      }),
    );
    expect(await wire.next()).toMatchObject({
      id: 1,
      error: { code: ACP_ERROR_CODES.invalidRequest },
    });
    await wire.send(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'initialize',
        params: { protocolVersion: 99 },
      }),
    );
    const init = await wire.next();
    expect(init.result.protocolVersion).toBe(ACP_PROTOCOL_VERSION);
    expect(init.result.agentCapabilities.loadSession).toBe(false);
    expect(init.result.agentCapabilities._meta).toMatchObject({
      [ACP_DEUZ_META.budget]: true,
      [ACP_DEUZ_META.receipts]: true,
      [ACP_DEUZ_META.signedApprovals]: true,
    });
    await wire.send(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 3,
        method: 'session/prompt',
        params: { sessionId: 'nope', prompt: [{ type: 'text', text: 'hi' }] },
      }),
    );
    expect(await wire.next()).toMatchObject({
      id: 3,
      error: { code: ACP_ERROR_CODES.resourceNotFound, data: { sessionId: 'nope' } },
    });
  });

  it('streams a turn: message chunks, a tool call and its update, then end_turn; the next turn keeps the history', async () => {
    const { client } = await setup(
      [
        { text: 'Looking.', toolCalls: [{ toolName: 'lookup', args: { q: 'x' } }] },
        { text: 'Found it.' },
        { text: 'Again.' },
      ],
      {
        run: {
          model: createMockModel({
            responses: [
              { text: 'Looking.', toolCalls: [{ toolName: 'lookup', args: { q: 'x' } }] },
              { text: 'Found it.' },
              { text: 'Again.' },
            ],
          }),
          maxSteps: 5,
          tools: {
            lookup: {
              description: 'Look up.',
              parameters: { type: 'object' },
              execute: async () => 'result-42',
            },
          },
        },
        toolKinds: { lookup: 'search' },
      },
    );
    const session = await client.newSession({ cwd: CWD });
    const turn = session.prompt('find x');
    const updates: AcpSessionUpdate[] = [];
    for await (const update of turn) updates.push(update);
    const result = await turn.result;
    expect(result.stopReason).toBe('end_turn');
    expect(result.text).toBe('Looking.Found it.');
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]).toMatchObject({
      title: 'lookup',
      kind: 'search',
      status: 'completed',
      rawOutput: 'result-42',
    });
    const kinds = updates.map((u) => u.sessionUpdate);
    expect(kinds.indexOf('tool_call')).toBeLessThan(kinds.lastIndexOf('tool_call_update'));
    expect(kinds).toContain('usage_update');
    expect(result.usage).toMatchObject({ size: 100_000 });
    expect(result.receipts).toEqual([
      { toolCallId: 'call_1', toolName: 'lookup', stage: 'completed' },
    ]);
    const second = await session.prompt('and again').result;
    expect(second.text).toBe('Again.');
  });

  it('turns needsApproval into session/request_permission and binds the verdict to the signed approval', async () => {
    const written: string[] = [];
    const requests: unknown[] = [];
    const { client } = await setup(
      [],
      {
        run: {
          model: createMockModel({
            responses: [
              { toolCalls: [{ toolName: 'write', args: { path: '/work/repo/a.ts' } }] },
              { text: 'done' },
            ],
          }),
          maxSteps: 5,
          tools: { write: writeTool(written) },
        },
      },
      {
        onPermissionRequest: (request) => {
          requests.push(request);
          const allow = request.options.find((option) => option.kind === 'allow_once')!;
          return { outcome: 'selected', optionId: allow.optionId };
        },
      },
    );
    const session = await client.newSession({ cwd: CWD });
    const result = await session.prompt('write a.ts').result;
    expect(written).toEqual(['/work/repo/a.ts']);
    expect(requests).toHaveLength(1);
    const request = requests[0] as {
      options: { kind: string; optionId: string }[];
      toolCall: Record<string, unknown>;
      _meta: Record<string, unknown>;
    };
    expect(request.options.map((o) => o.kind)).toEqual([
      'allow_once',
      'allow_always',
      'reject_once',
      'reject_always',
    ]);
    expect(request.toolCall).toMatchObject({
      title: 'write',
      status: 'pending',
      locations: [{ path: '/work/repo/a.ts' }],
    });
    expect(request._meta[ACP_DEUZ_META.signedApprovals]).toBe(true);
    // The signed token never reaches the client.
    expect(JSON.stringify(request)).not.toContain('v1.');
    expect(result.permissions).toEqual([
      expect.objectContaining({ outcome: 'selected', kind: 'allow_once' }),
    ]);
    expect(result.receipts).toEqual([
      expect.objectContaining({ toolName: 'write', stage: 'completed', approval: 'allowed' }),
    ]);
    expect(result.text).toBe('done');
  });

  it('rejects a call whose answer names an option that was not offered, and remembers "always" answers', async () => {
    const written: string[] = [];
    let asked = 0;
    const { client, errors } = await setup(
      [],
      {
        run: {
          model: createMockModel({
            responses: [
              { toolCalls: [{ toolName: 'write', args: { path: '/a' } }] },
              { text: 'ok' },
              { toolCalls: [{ toolName: 'write', args: { path: '/b' } }] },
              { text: 'ok' },
              { toolCalls: [{ toolName: 'write', args: { path: '/c' } }] },
              { text: 'ok' },
            ],
          }),
          maxSteps: 5,
          tools: { write: writeTool(written) },
        },
      },
      {
        onPermissionRequest: (request) => {
          asked += 1;
          if (asked === 1) return { outcome: 'selected', optionId: 'allow_once' }; // forged: not an offered id
          return {
            outcome: 'selected',
            optionId: request.options.find((o) => o.kind === 'allow_always')!.optionId,
          };
        },
      },
    );
    const session = await client.newSession({ cwd: CWD });
    const first = await session.prompt('a').result;
    expect(written).toEqual([]);
    expect(first.receipts?.[0]).toMatchObject({ approval: 'rejected' });
    expect(first.toolCalls[0]?.status).toBe('failed');
    expect(errors.some((e) => String((e as Error).message).includes('not offered'))).toBe(true);
    await session.prompt('b').result; // answered "always allow"
    const third = await session.prompt('c').result; // no prompt: remembered
    expect(asked).toBe(2);
    expect(written).toEqual(['/b', '/c']);
    expect(third.receipts?.[0]).toMatchObject({ approval: 'remembered-allow' });
  });

  it('cancels a turn waiting on a permission: the request is answered cancelled and the prompt ends cancelled', async () => {
    const written: string[] = [];
    let release!: () => void;
    const asked = new Promise<void>((resolve) => (release = resolve));
    const { client } = await setup(
      [],
      {
        run: {
          model: createMockModel({
            responses: [
              { toolCalls: [{ toolName: 'write', args: { path: '/x' } }] },
              { text: 'after cancel' },
            ],
          }),
          maxSteps: 5,
          tools: { write: writeTool(written) },
        },
      },
      {
        onPermissionRequest: (_request, { signal }) => {
          release();
          return new Promise(() => signal.addEventListener('abort', () => undefined));
        },
      },
    );
    const session = await client.newSession({ cwd: CWD });
    const turn = session.prompt('write x');
    await asked;
    await turn.cancel();
    const result = await turn.result;
    expect(result.stopReason).toBe('cancelled');
    expect(result.permissions).toEqual([expect.objectContaining({ outcome: 'cancelled' })]);
    expect(written).toEqual([]);
    // The history stays valid: the dangling call was closed, so the next turn runs.
    const next = await session.prompt('go on').result;
    expect(next.stopReason).toBe('end_turn');
  });

  it('cancels a prompt whose signal is already aborted, and ends the iterator of a refused second prompt', async () => {
    const { client } = await setup([], {
      run: {
        model: createMockModel({ responses: [{ text: 'ran anyway' }, { text: 'second' }] }),
        maxSteps: 5,
      },
    });
    const session = await client.newSession({ cwd: CWD });
    const aborted = new AbortController();
    aborted.abort();
    const result = await session.prompt('hi', { signal: aborted.signal }).result;
    expect(result.stopReason).toBe('cancelled');
    expect(result.text).toBe('');

    const first = session.prompt('one');
    const busy = session.prompt('two');
    await expect(busy.result).rejects.toThrow(/already running/);
    await expect(
      (async () => {
        for await (const _ of busy) void _;
      })(),
    ).rejects.toThrow(/already running/);
    await first.result;
  });

  it('answers a permission request that crosses the cancel with cancelled, without asking the handler', async () => {
    const [agentSide, clientSide] = createInMemoryAcpTransportPair();
    let cancelled!: () => void;
    const cancelSeen = new Promise<void>((resolve) => (cancelled = resolve));
    const agent: ReturnType<typeof createAcpPeer> = createAcpPeer({
      transport: agentSide,
      requests: {
        initialize: () => ({ protocolVersion: ACP_PROTOCOL_VERSION, agentCapabilities: {} }),
        'session/new': () => ({ sessionId: 's1' }),
        'session/prompt': async () => {
          await cancelSeen;
          const answer = await agent.request<{ outcome: { outcome: string } }>(
            'session/request_permission',
            {
              sessionId: 's1',
              toolCall: { toolCallId: 't1' },
              options: [{ optionId: 'yes', name: 'Allow', kind: 'allow_once' }],
            },
          );
          return { stopReason: answer.outcome.outcome === 'cancelled' ? 'cancelled' : 'end_turn' };
        },
      },
      notifications: { 'session/cancel': () => cancelled() },
    });
    let asked = 0;
    const client = await connectAcpAgent({
      transport: clientSide,
      onPermissionRequest: () => {
        asked++;
        return { outcome: 'selected', optionId: 'yes' };
      },
    });
    const session = await client.newSession({ cwd: CWD });
    const turn = session.prompt('go');
    await turn.cancel();
    const result = await turn.result;
    expect(result.stopReason).toBe('cancelled');
    expect(asked).toBe(0);
    expect(result.permissions).toEqual([expect.objectContaining({ outcome: 'cancelled' })]);
  });

  // Found against the reference client (@agentclientprotocol/sdk 2.9.1): it sends
  // session/cancel while its permission request is pending and answers late.
  it('records a cancelled receipt for a call whose permission was pending at session/cancel, and drops the late answer quietly', async () => {
    const [agentSide, clientSide] = createInMemoryAcpTransportPair();
    const errors: unknown[] = [];
    const written: string[] = [];
    serveAcpAgent({
      transport: agentSide,
      agent: engine,
      store: createInMemoryAgentRunStore(),
      run: {
        model: createMockModel({
          responses: [{ toolCalls: [{ toolName: 'write', args: { path: '/x' } }] }, { text: 'no' }],
        }),
        maxSteps: 5,
        tools: { write: writeTool(written) },
      },
      approvalSigner: createApprovalSigner({ secret: 'test-secret' }),
      contextWindow: 1000,
      onError: (error) => errors.push(error),
    });
    // A plain client peer: on the permission request it cancels the turn and
    // answers only once the agent withdrew the request ($/cancel_request).
    const client: ReturnType<typeof createAcpPeer> = createAcpPeer({
      transport: clientSide,
      requests: {
        'session/request_permission': async (params, { signal }) => {
          await client.notify('session/cancel', {
            sessionId: (params as { sessionId: string }).sessionId,
          });
          await new Promise((resolve) => signal.addEventListener('abort', resolve));
          return { outcome: { outcome: 'cancelled' } };
        },
      },
    });
    await client.request('initialize', { protocolVersion: ACP_PROTOCOL_VERSION });
    const { sessionId } = await client.request<{ sessionId: string }>('session/new', {
      cwd: CWD,
      mcpServers: [],
    });
    const response = await client.request<{ stopReason: string; _meta: Record<string, unknown> }>(
      'session/prompt',
      { sessionId, prompt: [{ type: 'text', text: 'write x' }] },
    );
    expect(response.stopReason).toBe('cancelled');
    expect(written).toEqual([]);
    expect(response._meta[ACP_DEUZ_META.receipts]).toEqual([
      expect.objectContaining({ toolName: 'write', stage: 'not-run', approval: 'cancelled' }),
    ]);
    // The late answer (-32800) to the withdrawn request is not a protocol error.
    await client.request('_io.github.deuz-ai/budget', { sessionId });
    expect(errors.filter((e) => String((e as Error).message).includes('no pending'))).toEqual([]);
  });

  it('charges turns to the persistent budget and reports remaining USD in _meta, usage_update and the footer', async () => {
    const budgetStore = createInMemoryBudgetStore();
    const { client } = await setup([], {
      run: {
        model: createMockModel({ responses: [{ text: 'one' }] }),
        executionEstimate: { tokens: 100, usd: 0.01 },
        maxOutputTokens: 50,
        deps: { priceProvider: { priceUsage: () => 0.01 } },
      },
      budget: { store: budgetStore, scopes: [{ key: 'user:1', limits: { usd: 0.015 } }] },
      budgetFooter: true,
    });
    const session = await client.newSession({ cwd: CWD });
    const first = await session.prompt('hi').result;
    expect(first.budget).toMatchObject({ turnUsd: 0.01, sessionUsd: 0.01 });
    expect(first.budget?.remainingUsd).toBeCloseTo(0.005);
    expect(first.cost).toMatchObject({ amount: 0.01, currency: 'USD', declared: true });
    expect(first.text).toMatch(
      /one\n\n— budget: turn \$0\.0100 · session \$0\.0100 · remaining \$0\.0050/,
    );
    expect((await budgetStore.usage('user:1')).usd).toBeCloseTo(0.01);
    // The second turn does not fit: it ends with a notice, not an error.
    const second = await session.prompt('again').result;
    expect(second.stopReason).toBe('end_turn');
    expect(second.budget?.exhausted).toBe('budget_exceeded');
    expect(second.text).toContain('The budget is exhausted');
  });

  it('loads a stored session on a new connection and replays its conversation', async () => {
    const sessions = createInMemoryAcpSessionStore();
    const store = createInMemoryAgentRunStore();
    const model = createMockModel({ responses: [{ text: 'first answer' }] });
    const common = { agent: engine, store, sessions, run: { model }, contextWindow: 1000 };
    const [a1, c1] = createInMemoryAcpTransportPair();
    serveAcpAgent({ transport: a1, ...common });
    const first = await connectAcpAgent({ transport: c1 });
    expect(first.agent.agentCapabilities?.loadSession).toBe(true);
    const session = await first.newSession({ cwd: CWD });
    await session.prompt('question').result;
    await first.close();

    const [a2, c2] = createInMemoryAcpTransportPair();
    serveAcpAgent({ transport: a2, ...common });
    const second = await connectAcpAgent({ transport: c2 });
    const loaded = await second.loadSession({ sessionId: session.sessionId, cwd: CWD });
    expect(loaded.history).toEqual([
      expect.objectContaining({
        sessionUpdate: 'user_message_chunk',
        content: { type: 'text', text: 'question' },
      }),
      expect.objectContaining({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'first answer' },
      }),
    ]);
    await expect(second.loadSession({ sessionId: 'missing', cwd: CWD })).rejects.toMatchObject({
      rpcCode: ACP_ERROR_CODES.resourceNotFound,
    });
  });

  it('keeps an open session handle working after session/load of the same session on the same connection', async () => {
    const { client } = await setup([{ text: 'answer' }], {
      sessions: createInMemoryAcpSessionStore(),
    });
    const session = await client.newSession({ cwd: CWD });
    await session.prompt('one').result;
    const loaded = await client.loadSession({ sessionId: session.sessionId, cwd: CWD });
    expect(loaded.history.map((update) => update.sessionUpdate)).toEqual([
      'user_message_chunk',
      'agent_message_chunk',
    ]);
    // Before the fix the first handle's state was replaced and its updates were lost.
    expect((await session.prompt('two').result).text).toBe('answer');
    expect((await loaded.prompt('three').result).text).toBe('answer');
  });

  it("gives the run the client's fs as tools when asked", async () => {
    const reads: string[] = [];
    const { client } = await setup(
      [],
      {
        run: {
          model: createMockModel({
            responses: [
              { toolCalls: [{ toolName: 'read_text_file', args: { path: '/work/repo/x.ts' } }] },
              { text: 'read' },
            ],
          }),
          maxSteps: 4,
        },
        clientFsTools: true,
      },
      {
        fs: { readTextFile: (request) => (reads.push(request.path), 'const x = 1;') },
      },
    );
    const session = await client.newSession({ cwd: CWD });
    const result = await session.prompt('read x').result;
    expect(reads).toEqual(['/work/repo/x.ts']);
    expect(result.toolCalls[0]).toMatchObject({
      kind: 'read',
      status: 'completed',
      rawOutput: 'const x = 1;',
    });
  });

  it('requires authenticate before sessions when auth methods are configured', async () => {
    const methods: string[] = [];
    const { client } = await setup([], {
      auth: {
        methods: [{ id: 'token', name: 'Token' }],
        authenticate: (id) => void methods.push(id),
      },
    });
    expect(client.agent.authMethods).toEqual([{ id: 'token', name: 'Token' }]);
    await expect(client.newSession({ cwd: CWD })).rejects.toMatchObject({
      rpcCode: ACP_ERROR_CODES.authRequired,
    });
    await client.authenticate('token');
    await expect(client.newSession({ cwd: CWD })).resolves.toHaveProperty('sessionId');
    expect(methods).toEqual(['token']);
  });

  it('serves over Node stdio streams (serveAcpAgentStdio)', async () => {
    const toAgent = new PassThrough();
    const fromAgent = new PassThrough();
    await serveAcpAgentStdio({
      stdin: toAgent,
      stdout: fromAgent,
      agent: engine,
      store: createInMemoryAgentRunStore(),
      run: { model: createMockModel({ responses: [{ text: 'over stdio' }] }) },
      contextWindow: 1000,
    });
    const client = await connectAcpAgent({
      transport: nodeStreamsToAcpTransport(fromAgent, toAgent, { endOnClose: true }),
    });
    const session = await client.newSession({ cwd: CWD });
    expect((await session.prompt('hi').result).text).toBe('over stdio');
    await client.close();
  });
});
