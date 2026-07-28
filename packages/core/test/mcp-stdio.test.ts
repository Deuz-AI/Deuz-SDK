/**
 * `@deuz-sdk/core/mcp/stdio` — `createStdioMcpClient` end to end over a REAL
 * child process. Hermetic: the "server" is a ~40-line zero-dependency JSON-RPC
 * responder written to a tmpdir and spawned as `node <file>`, so there is no
 * network and no MCP package to install beyond the optional peer that is already
 * a devDependency here.
 *
 * What this pins: the canonical `ToolSet` shape the loop consumes (names,
 * `parameters` as raw JSON Schema, `outputSchema` carried as metadata only),
 * `extractContent`'s self-heal on `isError`, the clientInfo/capabilities/env
 * option plumbing, and the actionable install error when the optional peer is
 * missing. Every spawned child is closed in `afterEach`.
 */
import { describe, it, expect, beforeAll, afterEach, afterAll, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStdioMcpClient, type McpClient } from '../src/mcp/stdio';

/**
 * A minimal MCP stdio server: newline-delimited JSON-RPC on stdin/stdout (the
 * SDK's framing). It echoes back the client's requested protocolVersion so
 * negotiation always succeeds, and exposes the handshake it observed through
 * tools so the option plumbing is assertable from the test side.
 *
 * Written with string concatenation (no template literals) so it survives being
 * embedded in a TS template literal unescaped.
 */
const SERVER_SOURCE = `
const TOOLS = [
  {
    name: 'echo',
    description: 'Echo a value back.',
    inputSchema: {
      type: 'object',
      properties: { value: { type: 'string', description: 'Text to echo.' } },
      required: ['value'],
      additionalProperties: false,
    },
  },
  {
    name: 'weather',
    description: 'Structured output tool.',
    inputSchema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
    outputSchema: {
      type: 'object',
      properties: { tempC: { type: 'number' } },
      required: ['tempC'],
    },
  },
  { name: 'boom', description: 'Always fails.', inputSchema: { type: 'object', properties: {} } },
  { name: 'handshake', description: 'Reports the observed initialize params.', inputSchema: { type: 'object', properties: {} } },
  { name: 'readEnv', description: 'Reports an env var.', inputSchema: { type: 'object', properties: {} } },
];

let observed = {};

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\\n');
}
function ok(id, result) {
  send({ jsonrpc: '2.0', id: id, result: result });
}
function fail(id, code, message) {
  send({ jsonrpc: '2.0', id: id, error: { code: code, message: message } });
}
function text(id, value) {
  ok(id, { content: [{ type: 'text', text: value }] });
}

function handle(msg) {
  if (msg.id === undefined || msg.id === null) return; // notification
  if (msg.method === 'initialize') {
    observed = msg.params || {};
    return ok(msg.id, {
      protocolVersion: (msg.params && msg.params.protocolVersion) || '2025-06-18',
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: 'deuz-fixture-server', version: '9.9.9' },
    });
  }
  if (msg.method === 'ping') return ok(msg.id, {});
  if (msg.method === 'tools/list') return ok(msg.id, { tools: TOOLS });
  if (msg.method === 'tools/call') {
    const params = msg.params || {};
    const args = params.arguments || {};
    if (params.name === 'echo') return text(msg.id, 'echo:' + args.value);
    if (params.name === 'weather') {
      return ok(msg.id, {
        content: [{ type: 'text', text: '{"tempC":22}' }],
        structuredContent: { tempC: 22 },
      });
    }
    if (params.name === 'boom') {
      return ok(msg.id, { isError: true, content: [{ type: 'text', text: 'tool exploded' }] });
    }
    if (params.name === 'handshake') return text(msg.id, JSON.stringify(observed));
    if (params.name === 'readEnv') {
      return text(msg.id, 'token:' + (process.env.DEUZ_FIXTURE_TOKEN || 'unset'));
    }
    return fail(msg.id, -32602, 'unknown tool ' + params.name);
  }
  fail(msg.id, -32601, 'unknown method ' + msg.method);
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', function (chunk) {
  buffer += chunk;
  let nl;
  while ((nl = buffer.indexOf('\\n')) >= 0) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (line) handle(JSON.parse(line));
  }
});
// Exit as soon as the transport ends stdin, so close() never has to SIGKILL.
process.stdin.on('end', function () {
  process.exit(0);
});
`;

let dir: string;
let serverPath: string;
/** Every client we spawn, so afterEach reaps the child processes. */
const spawned: McpClient[] = [];

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'deuz-mcp-'));
  serverPath = join(dir, 'fixture-server.mjs');
  await writeFile(serverPath, SERVER_SOURCE);
  // Warm the optional peer's module graph once. Vitest transforms it on first
  // import (express/hono/zod/ajv/…), which costs seconds and would otherwise be
  // billed to whichever test happens to run first.
  await import('@modelcontextprotocol/sdk/client/index.js');
  await import('@modelcontextprotocol/sdk/client/stdio.js');
}, 60_000);

afterEach(async () => {
  while (spawned.length > 0) {
    await spawned
      .pop()!
      .close()
      .catch(() => {
        /* already gone */
      });
  }
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Connect to the fixture server; the client is auto-closed in afterEach. */
async function connect(
  over: Partial<Parameters<typeof createStdioMcpClient>[0]> = {},
): Promise<McpClient> {
  const client = await createStdioMcpClient({
    command: process.execPath,
    args: [serverPath],
    ...over,
  });
  spawned.push(client);
  return client;
}

describe('createStdioMcpClient — real spawned stdio server', () => {
  it('listTools() returns a canonical ToolSet: JSON Schema parameters, outputSchema as metadata', async () => {
    const client = await connect();
    const tools = await client.listTools();

    expect(Object.keys(tools)).toEqual(['echo', 'weather', 'boom', 'handshake', 'readEnv']);
    expect(tools.echo!.description).toBe('Echo a value back.');
    // The MCP inputSchema IS JSON Schema — it goes straight onto `parameters`.
    expect(tools.echo!.parameters).toEqual({
      type: 'object',
      properties: { value: { type: 'string', description: 'Text to echo.' } },
      required: ['value'],
      additionalProperties: false,
    });
    // outputSchema is metadata only (the SDK validates server-side); never a
    // `parameters` substitute, and absent when the server omits it.
    expect(tools.weather!.outputSchema).toEqual({
      type: 'object',
      properties: { tempC: { type: 'number' } },
      required: ['tempC'],
    });
    expect('outputSchema' in tools.echo!).toBe(false);
    expect(tools.echo!.execute).toBeTypeOf('function');
  });

  it('execute() round-trips through the child: text, structuredContent, and is_error self-heal', async () => {
    const client = await connect();
    const tools = await client.listTools();
    const ctx = { toolCallId: 'call_1', messages: [] };

    expect(await tools.echo!.execute!({ value: 'hi' }, ctx)).toBe('echo:hi');
    // structuredContent wins over the redundant text serialization.
    expect(await tools.weather!.execute!({ city: 'Istanbul' }, ctx)).toEqual({ tempC: 22 });
    // An MCP isError result THROWS so the tool loop records an is_error
    // tool_result the model can recover from — never a silent empty string.
    await expect(tools.boom!.execute!({}, ctx)).rejects.toThrow('tool exploded');
  });

  it('namespaces tool names when combining servers', async () => {
    const client = await connect();
    const tools = await client.listTools('fixture');
    expect(Object.keys(tools)).toEqual([
      'fixture_echo',
      'fixture_weather',
      'fixture_boom',
      'fixture_handshake',
      'fixture_readEnv',
    ]);
    // The namespace is a local alias — the wire call still uses the bare name.
    expect(
      await tools.fixture_echo!.execute!({ value: 'x' }, { toolCallId: 'c', messages: [] }),
    ).toBe('echo:x');
  });

  it('callTool() reaches the server directly and rejects on an unknown tool', async () => {
    const client = await connect();
    expect(await client.callTool('echo', { value: 'direct' })).toBe('echo:direct');
    await expect(client.callTool('nope', {})).rejects.toThrow(/unknown tool nope/);
  });

  it('sends the default clientInfo and NO elicitation capability without a handler', async () => {
    const client = await connect();
    const raw = (await client.callTool('handshake', {})) as string;
    const handshake = JSON.parse(raw) as {
      clientInfo: { name: string; version: string };
      capabilities: Record<string, unknown>;
    };
    expect(handshake.clientInfo).toMatchObject({ name: 'deuz', version: '0.0.0' });
    // Declaring elicitation without a handler would lie to the server.
    expect(handshake.capabilities.elicitation).toBeUndefined();
  });

  it('forwards name/version and declares elicitation when a handler is passed', async () => {
    const client = await connect({
      name: 'deuz-test',
      version: '1.9.0',
      onElicitationRequest: () => ({ action: 'decline' }),
    });
    const handshake = JSON.parse((await client.callTool('handshake', {})) as string) as {
      clientInfo: { name: string; version: string };
      capabilities: { elicitation?: unknown };
    };
    expect(handshake.clientInfo).toMatchObject({ name: 'deuz-test', version: '1.9.0' });
    expect(handshake.capabilities.elicitation).toEqual({ form: {}, url: {} });
  });

  it('forwards env to the child process', async () => {
    const withEnv = await connect({ env: { DEUZ_FIXTURE_TOKEN: 'fixture-token-42' } });
    expect(await withEnv.callTool('readEnv', {})).toBe('token:fixture-token-42');
    const withoutEnv = await connect();
    expect(await withoutEnv.callTool('readEnv', {})).toBe('token:unset');
  });

  it('close() tears the child down; later calls reject instead of hanging', async () => {
    const client = await connect();
    await client.listTools();
    await client.close();
    await expect(client.callTool('echo', { value: 'x' })).rejects.toThrow();
  });

  // NOTE: no "command not found" case here on purpose. cross-spawn routes an
  // unresolvable Windows command through cmd.exe, whose stderr is `inherit`ed
  // into the runner output, and the resulting error text differs per platform
  // ('MCP error -32000: Connection closed' on win32 vs spawn ENOENT on POSIX) —
  // a noisy, platform-dependent assertion about the SDK's transport, not ours.
});

describe('createStdioMcpClient — optional peer missing', () => {
  afterEach(() => {
    vi.doUnmock('@modelcontextprotocol/sdk/client/index.js');
    vi.doUnmock('@modelcontextprotocol/sdk/client/stdio.js');
    vi.resetModules();
  });

  it('raises the actionable install error (InvalidRequestError) when the SDK is absent', async () => {
    const notInstalled = (): never => {
      throw new Error("Cannot find module '@modelcontextprotocol/sdk'");
    };
    // The peer is imported lazily through a variable specifier, so mock both
    // entry points and re-import the module under the mock registry.
    vi.doMock('@modelcontextprotocol/sdk/client/index.js', notInstalled);
    vi.doMock('@modelcontextprotocol/sdk/client/stdio.js', notInstalled);
    vi.resetModules();
    const { createStdioMcpClient: fresh } = await import('../src/mcp/stdio');

    // `loadSdk()` runs before the transport exists, so nothing is ever spawned
    // — a bogus command proves that (and fails loudly if the mock misses).
    const promise = fresh({ command: 'never-spawned' });
    await expect(promise).rejects.toThrow(/npm i @modelcontextprotocol\/sdk/);
    await expect(promise).rejects.toMatchObject({
      name: 'InvalidRequestError',
      code: 'invalid_request',
    });
  });
});
