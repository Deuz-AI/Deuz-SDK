/**
 * MCP interop (2.3) — every client line against every server line, in-process.
 *
 * Deuz 2.3 is dual-stack on the client (the v1 SDK for 2025-11-25, the v2 SDK
 * for MCP 2026-07-28) and serves on the v2 SDK. This file is the matrix that
 * proves the halves agree with each other AND with the SDKs' own peers:
 *
 * | client \ server            | v1 SDK server (2025-11-25) | Deuz server (v2 SDK) |
 * | -------------------------- | -------------------------- | -------------------- |
 * | Deuz, v1 line              | 2025-11-25                 | 2025-11-25           |
 * | Deuz, v2 line (`'auto'`)   | 2025-11-25 (fallback)      | 2026-07-28           |
 * | Deuz, v2 line `'legacy'`   | 2025-11-25                 | 2025-11-25           |
 * | v1 SDK `Client`            | 2025-11-25                 | 2025-11-25           |
 * | v2 SDK `Client` (`'auto'`) | 2025-11-25 (fallback)      | 2026-07-28           |
 *
 * Negotiation is checked in both directions: a 2026-07-28 client falls back to
 * `initialize` against a server that cannot answer `server/discover`, a
 * 2025-era client is served by the Deuz server's stateless fallback, a pinned
 * revision is refused by a 2025-only server, and a 2026-07-28-only Deuz server
 * refuses 2025-era clients. Every HTTP server here listens on a real port.
 *
 * The stdio half runs a REAL child: the Deuz stdio server entry is bundled with
 * esbuild and launched by the Deuz stdio client on both SDK lines, so
 * `serveMcpStdio` is proven on the process's own stdin/stdout.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Client as V1Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport as V1HttpTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  Client as V2Client,
  StreamableHTTPClientTransport as V2HttpTransport,
} from '@modelcontextprotocol/client';
import { createMcpClient, fingerprintTools } from '../src/mcp/index';
import { createStdioMcpClient, type McpSdkLine } from '../src/mcp/stdio';
import { createMcpServer, type DeuzMcpServer } from '../src/mcp/server';
import type { ToolSet } from '../src/types/tool';
import { startTestMcpServer, type TestMcpServerHandle } from './helpers/mcp-http-server';
import { listenFetch, type FetchListener } from './helpers/mcp-fetch-listener';

type ClientKind = 'deuz-v1' | 'deuz-v2' | 'deuz-v2-legacy' | 'sdk-v1' | 'sdk-v2';
type ServerKind = 'sdk-v1-server' | 'deuz-server';

const CLIENTS: ClientKind[] = ['deuz-v1', 'deuz-v2', 'deuz-v2-legacy', 'sdk-v1', 'sdk-v2'];
const SERVERS: ServerKind[] = ['sdk-v1-server', 'deuz-server'];

const MODERN = '2026-07-28';
const LEGACY = '2025-11-25';

/** The revision each pair must settle on — the table in the header. */
const EXPECTED: Record<ClientKind, Record<ServerKind, string>> = {
  'deuz-v1': { 'sdk-v1-server': LEGACY, 'deuz-server': LEGACY },
  'deuz-v2': { 'sdk-v1-server': LEGACY, 'deuz-server': MODERN },
  'deuz-v2-legacy': { 'sdk-v1-server': LEGACY, 'deuz-server': LEGACY },
  'sdk-v1': { 'sdk-v1-server': LEGACY, 'deuz-server': LEGACY },
  'sdk-v2': { 'sdk-v1-server': LEGACY, 'deuz-server': MODERN },
};

/**
 * The Deuz twin of the v1 test server's default catalog (`echo`, `add`, `boom`),
 * so one set of assertions holds on both sides of the matrix.
 */
function deuzTools(): ToolSet {
  return {
    echo: {
      description: 'Echo a value back.',
      parameters: {
        type: 'object',
        properties: { value: { type: 'string', description: 'Text to echo.' } },
        required: ['value'],
        additionalProperties: false,
      },
      execute: (args) => `echo:${String((args as { value: unknown }).value)}`,
    },
    add: {
      description: 'Add two numbers, structured.',
      parameters: {
        type: 'object',
        properties: { a: { type: 'number' }, b: { type: 'number' } },
        required: ['a', 'b'],
      },
      execute: (args) => {
        const { a, b } = args as { a: number; b: number };
        return { sum: a + b };
      },
    },
    boom: {
      description: 'Always fails.',
      parameters: { type: 'object', properties: {} },
      execute: () => {
        throw new Error('tool exploded');
      },
    },
  };
}

/** One connected client, whatever its line, behind the questions the matrix asks. */
interface InteropSession {
  protocolVersion: string | undefined;
  toolNames(): Promise<string[]>;
  /** `{ value }` for a result (structured content preferred), `{ error }` for an error result. */
  call(name: string, args: Record<string, unknown>): Promise<{ value?: unknown; error?: string }>;
  close(): Promise<void>;
}

interface RawCallResult {
  content?: unknown;
  structuredContent?: unknown;
  isError?: boolean;
}

function rawOutcome(result: RawCallResult): { value?: unknown; error?: string } {
  const blocks = Array.isArray(result.content) ? (result.content as Array<{ text?: unknown }>) : [];
  const text = blocks.map((block) => (typeof block.text === 'string' ? block.text : '')).join('\n');
  if (result.isError) return { error: text };
  return { value: result.structuredContent ?? text };
}

async function open(kind: ClientKind, url: string): Promise<InteropSession> {
  if (kind === 'sdk-v1') {
    const client = new V1Client({ name: 'sdk-v1', version: '1.0.0' });
    const transport = new V1HttpTransport(new URL(url));
    await client.connect(transport);
    return {
      protocolVersion: transport.protocolVersion,
      toolNames: async () => (await client.listTools()).tools.map((t) => t.name),
      call: async (name, args) =>
        rawOutcome((await client.callTool({ name, arguments: args })) as RawCallResult),
      close: () => client.close(),
    };
  }
  if (kind === 'sdk-v2') {
    const client = new V2Client(
      { name: 'sdk-v2', version: '1.0.0' },
      { versionNegotiation: { mode: 'auto' } },
    );
    await client.connect(new V2HttpTransport(new URL(url)));
    return {
      protocolVersion: client.getNegotiatedProtocolVersion(),
      toolNames: async () => (await client.listTools()).tools.map((t) => t.name),
      call: async (name, args) =>
        rawOutcome((await client.callTool({ name, arguments: args })) as RawCallResult),
      close: () => client.close(),
    };
  }
  const client = await createMcpClient({
    transport: { type: 'http', url },
    sdk: kind === 'deuz-v1' ? 'v1' : 'v2',
    ...(kind === 'deuz-v2-legacy' ? { versionNegotiation: 'legacy' as const } : {}),
  });
  return {
    protocolVersion: client.protocolVersion?.(),
    toolNames: async () => Object.keys(await client.listTools()),
    call: async (name, args) => {
      try {
        return { value: await client.callTool(name, args) };
      } catch (error) {
        return { error: (error as Error).message };
      }
    },
    close: () => client.close(),
  };
}

// --- HTTP ------------------------------------------------------------------------------

const sessions: InteropSession[] = [];
/** Bare clients a test opened outside the session adapter. */
const closables: Array<{ close(): Promise<void> }> = [];
let v1Server: TestMcpServerHandle;
let deuzServer: DeuzMcpServer;
let deuzListener: FetchListener;
const urls = {} as Record<ServerKind, string>;

beforeAll(async () => {
  v1Server = await startTestMcpServer({ name: 'sdk-v1-server', version: '1.0.0' });
  deuzServer = createMcpServer({ name: 'deuz-server', version: '2.3.0', tools: deuzTools() });
  await deuzServer.ready();
  deuzListener = await listenFetch(deuzServer.fetch);
  urls['sdk-v1-server'] = v1Server.url;
  urls['deuz-server'] = deuzListener.url;
});

afterAll(async () => {
  await deuzServer.close();
  await deuzListener.close();
  await v1Server.close();
});

afterEach(async () => {
  for (const session of sessions.splice(0)) await session.close().catch(() => {});
  for (const client of closables.splice(0)) await client.close().catch(() => {});
});

async function session(kind: ClientKind, server: ServerKind): Promise<InteropSession> {
  const opened = await open(kind, urls[server]);
  sessions.push(opened);
  return opened;
}

describe.each(CLIENTS)('MCP interop over HTTP — %s client', (client) => {
  it.each(SERVERS)(
    'against the %s: negotiates, lists, calls and reports errors',
    async (server) => {
      const s = await session(client, server);

      expect(s.protocolVersion).toBe(EXPECTED[client][server]);
      expect(await s.toolNames()).toEqual(['echo', 'add', 'boom']);
      expect(await s.call('echo', { value: 'interop' })).toEqual({ value: 'echo:interop' });
      expect(await s.call('add', { a: 20, b: 22 })).toEqual({ value: { sum: 42 } });
      expect(await s.call('boom', {})).toEqual({ error: 'tool exploded' });
    },
  );
});

describe('MCP interop — one catalog, one fingerprint', () => {
  // A native run pins the MCP catalog's fingerprint in its resume binding, so a
  // catalog must hash the same whichever client line reads it and whichever
  // server SDK (and protocol era) serves it — installing the v2 SDK between a
  // suspend and its resume must not read as a "catalog changed" rug pull.
  it('fingerprints identically across client lines, eras and server SDKs', async () => {
    const prints = new Set<string>();
    for (const server of SERVERS) {
      for (const options of [
        { sdk: 'v1' as const },
        { sdk: 'v2' as const },
        { sdk: 'v2' as const, versionNegotiation: 'legacy' as const },
      ]) {
        const client = await createMcpClient({
          transport: { type: 'http', url: urls[server] },
          ...options,
        });
        closables.push(client);
        prints.add((await fingerprintTools(await client.listTools())).fingerprint);
      }
    }
    expect(prints.size).toBe(1);
  });
});

describe('MCP interop — protocol negotiation, both directions', () => {
  it('a client pinned to 2026-07-28 reaches the Deuz server and is refused by the 2025-only one', async () => {
    const pinned = await createMcpClient({
      transport: { type: 'http', url: urls['deuz-server'] },
      sdk: 'v2',
      versionNegotiation: { pin: MODERN },
    });
    closables.push(pinned);
    expect(pinned.protocolVersion?.()).toBe(MODERN);

    await expect(
      createMcpClient({
        transport: { type: 'http', url: urls['sdk-v1-server'] },
        sdk: 'v2',
        versionNegotiation: { pin: MODERN },
      }),
    ).rejects.toThrow();
    const raw = new V2Client(
      { name: 'sdk-v2', version: '1.0.0' },
      { versionNegotiation: { mode: { pin: MODERN } } },
    );
    await expect(
      raw.connect(new V2HttpTransport(new URL(urls['sdk-v1-server']))),
    ).rejects.toThrow();
  });

  it("a 2026-07-28-only Deuz server (legacy: 'reject') refuses every 2025-era client", async () => {
    const strict = createMcpServer({ name: 'strict', legacy: 'reject', tools: deuzTools() });
    const listener = await listenFetch(strict.fetch);
    try {
      for (const kind of ['deuz-v1', 'deuz-v2-legacy', 'sdk-v1'] as const) {
        await expect(open(kind, listener.url), kind).rejects.toThrow();
      }
      const modern = await open('deuz-v2', listener.url);
      sessions.push(modern);
      expect(modern.protocolVersion).toBe(MODERN);
      expect(await modern.call('echo', { value: 'strict' })).toEqual({ value: 'echo:strict' });
    } finally {
      for (const s of sessions.splice(0)) await s.close().catch(() => {});
      await strict.close();
      await listener.close();
    }
  });
});

// --- stdio: a real child process ---------------------------------------------------------

/**
 * The served program: the Deuz stdio entry on the process's own stdin/stdout.
 * Bundled from source with the MCP SDKs left external — they are computed
 * imports by design — so the bundle is written under this package's
 * `node_modules`, where the child resolves them like any installed app.
 */
const STDIO_ENTRY = `
import { createMcpServer } from '../src/mcp/server';
import { serveMcpStdio } from '../src/node/mcp-server';

const server = createMcpServer({
  name: 'deuz-stdio',
  version: '2.3.0',
  tools: {
    echo: {
      parameters: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] },
      execute: (args) => 'echo:' + String(args.value),
    },
    add: {
      parameters: {
        type: 'object',
        properties: { a: { type: 'number' }, b: { type: 'number' } },
        required: ['a', 'b'],
      },
      execute: (args) => ({ sum: args.a + args.b }),
    },
  },
});
await serveMcpStdio(server);
`;

describe('MCP interop over stdio — the Deuz stdio client launches the Deuz stdio server', () => {
  const here = fileURLToPath(new URL('.', import.meta.url));
  const cacheDir = join(here, '..', 'node_modules', '.cache', 'deuz-mcp-interop');
  const bundle = join(cacheDir, `stdio-server-${process.pid}.mjs`);
  const stdioClients: Array<{ close(): Promise<void> }> = [];

  beforeAll(async () => {
    await mkdir(cacheDir, { recursive: true });
    await build({
      stdin: {
        contents: STDIO_ENTRY,
        resolveDir: here,
        sourcefile: 'mcp-interop-stdio-entry.ts',
        loader: 'ts',
      },
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node20',
      outfile: bundle,
      external: ['@modelcontextprotocol/*'],
      logLevel: 'silent',
    });
  }, 60_000);

  afterEach(async () => {
    for (const client of stdioClients.splice(0)) await client.close().catch(() => {});
  });

  afterAll(async () => {
    await rm(bundle, { force: true });
  });

  it.each([
    ['v1', undefined, LEGACY],
    ['v2', undefined, MODERN],
    ['v2', 'legacy', LEGACY],
  ] as Array<[McpSdkLine, 'legacy' | undefined, string]>)(
    'sdk %s (negotiation %s) settles on %s and serves the tools',
    async (sdk, negotiation, expected) => {
      const client = await createStdioMcpClient({
        command: process.execPath,
        args: [bundle],
        sdk,
        ...(negotiation ? { versionNegotiation: negotiation } : {}),
      });
      stdioClients.push(client);

      expect(client.protocolVersion?.()).toBe(expected);
      expect(client.serverInfo?.()).toEqual({ name: 'deuz-stdio', version: '2.3.0' });
      expect(Object.keys(await client.listTools())).toEqual(['echo', 'add']);
      expect(await client.callTool('echo', { value: 'child' })).toBe('echo:child');
      expect(await client.callTool('add', { a: 1, b: 1 })).toEqual({ sum: 2 });
    },
    30_000,
  );
});
