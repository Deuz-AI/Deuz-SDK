/**
 * mcp-v2-server.ts — an in-process MCP server on the v2 SDK
 * (`@modelcontextprotocol/server`, MCP 2026-07-28) for the client tests.
 *
 * `mcp-http-server.ts` is the 2025-11-25 server (v1 SDK); this is its modern
 * twin. It serves through the SDK's own `createMcpHandler` — the fetch-native
 * entry that speaks 2026-07-28 to a negotiating client and falls back to
 * stateless 2025-era serving for everyone else — on a LOW-LEVEL `Server`, so a
 * tool's `inputSchema` reaches the client byte for byte (no Zod round trip).
 *
 * What it gives the 2.3 tests:
 *
 * - `fetch` — the handler as a `fetch`, for `McpHttpTransport.fetch`: no socket,
 *   fully deterministic. `down = true` makes it fail like an unreachable host,
 *   which is how a reconnect test kills and revives "the server".
 * - `methods` — every JSON-RPC method that reached the handler, in order, so a
 *   test can assert what went on the wire (`server/discover`, never `ping`).
 * - tool handlers receive the SDK's request context, so a tool can answer with
 *   `inputRequired(...)` — the 2026-07-28 multi-round-trip results that replace
 *   server→client requests (elicitation, sampling, roots).
 * - `listen()` — the same handler on a real `node:http` port, for the tests that
 *   need real sockets and SSE framing.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import {
  Server,
  createMcpHandler,
  type CallToolResult,
  type InputRequiredResult,
  type McpHttpHandler,
  type ServerContext,
} from '@modelcontextprotocol/server';

export type V2ToolArgs = Record<string, unknown>;

export interface V2ToolSpec {
  name: string;
  description?: string;
  /** Raw JSON Schema, sent verbatim. Default `{ type: 'object', properties: {} }`. */
  inputSchema?: Record<string, unknown>;
  /**
   * A string becomes one text block; an object with an array `content` is sent
   * as-is (that includes an `inputRequired(...)` result); anything else becomes
   * its JSON text.
   */
  handler: (args: V2ToolArgs, ctx: ServerContext) => unknown;
}

export interface V2TestServerOptions {
  tools?: V2ToolSpec[];
  name?: string;
  version?: string;
  /** `createMcpHandler`'s 2025-era posture. Default `'stateless'`. */
  legacy?: 'stateless' | 'reject';
}

export interface V2TestServerHandle {
  /** For `McpHttpTransport.fetch`. Any URL works; the handler ignores the path. */
  fetch: (input: string | URL, init?: RequestInit) => Promise<Response>;
  /** A placeholder endpoint for `fetch`-based connections. */
  url: string;
  /** JSON-RPC methods that reached the handler, in arrival order. */
  methods: string[];
  /** Every `tools/call` served, in order. */
  calls: Array<{ name: string; args: V2ToolArgs }>;
  /** While true, `fetch` rejects like a host that is gone. */
  down: boolean;
  /** Add or replace a tool and publish `tools_list_changed` to open listen streams. */
  addTool(spec: V2ToolSpec): void;
  /**
   * End every open `subscriptions/listen` response stream WITHOUT the final
   * listen result — what a client sees when a proxy or a dying instance cuts
   * the stream. Resolves with how many were cut.
   */
  endListenStreams(): number;
  /** Serve the same handler on 127.0.0.1; resolves with the endpoint URL. */
  listen(): Promise<string>;
  close(): Promise<void>;
}

const EMPTY_INPUT_SCHEMA = { type: 'object', properties: {} };

function toCallToolResult(value: unknown): CallToolResult | InputRequiredResult {
  if (typeof value === 'string') return { content: [{ type: 'text', text: value }] };
  if (
    typeof value === 'object' &&
    value !== null &&
    (Array.isArray((value as { content?: unknown }).content) ||
      (value as { resultType?: unknown }).resultType === 'input_required')
  ) {
    return value as CallToolResult | InputRequiredResult;
  }
  return { content: [{ type: 'text', text: JSON.stringify(value) }] };
}

function methodsOf(body: string): string[] {
  try {
    const parsed: unknown = JSON.parse(body);
    const messages = Array.isArray(parsed) ? parsed : [parsed];
    return messages
      .map((m) => (m as { method?: unknown }).method)
      .filter((m): m is string => typeof m === 'string');
  } catch {
    return [];
  }
}

export function startV2TestServer(opts: V2TestServerOptions = {}): V2TestServerHandle {
  const tools = new Map<string, V2ToolSpec>();
  for (const spec of opts.tools ?? []) tools.set(spec.name, spec);
  const calls: Array<{ name: string; args: V2ToolArgs }> = [];
  const methods: string[] = [];

  const handler: McpHttpHandler = createMcpHandler(
    () => {
      const server = new Server(
        { name: opts.name ?? 'deuz-v2-test', version: opts.version ?? '2.0.0' },
        { capabilities: { tools: { listChanged: true } } },
      );
      server.setRequestHandler('tools/list', () => ({
        tools: [...tools.values()].map((spec) => ({
          name: spec.name,
          ...(spec.description !== undefined ? { description: spec.description } : {}),
          inputSchema: (spec.inputSchema ?? EMPTY_INPUT_SCHEMA) as {
            type: 'object';
            [key: string]: unknown;
          },
        })),
      }));
      server.setRequestHandler('tools/call', async (request, ctx) => {
        const { name } = request.params;
        const args = (request.params.arguments ?? {}) as V2ToolArgs;
        const spec = tools.get(name);
        if (!spec) {
          return { isError: true, content: [{ type: 'text', text: `unknown tool ${name}` }] };
        }
        calls.push({ name, args });
        return toCallToolResult(await spec.handler(args, ctx));
      });
      return server;
    },
    { legacy: opts.legacy ?? 'stateless' },
  );

  let httpServer: ReturnType<typeof createServer> | undefined;
  const sockets = new Set<Socket>();
  /** Cut switches for the live listen streams (see `endListenStreams`). */
  const listenCutters = new Set<() => void>();

  /** Re-wrap a listen response so the test can end its body on demand. */
  function cuttable(response: Response): Response {
    const body = response.body;
    if (!body) return response;
    const reader = body.getReader();
    let cut: (() => void) | undefined;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        cut = () => {
          listenCutters.delete(cut!);
          void reader.cancel().catch(() => {});
          try {
            controller.close();
          } catch {
            /* already closed */
          }
        };
        listenCutters.add(cut);
      },
      async pull(controller) {
        try {
          const { done, value } = await reader.read();
          if (done) {
            listenCutters.delete(cut!);
            controller.close();
          } else controller.enqueue(value);
        } catch {
          listenCutters.delete(cut!);
          try {
            controller.close();
          } catch {
            /* cut already */
          }
        }
      },
      cancel() {
        listenCutters.delete(cut!);
        return reader.cancel();
      },
    });
    return new Response(stream, { status: response.status, headers: response.headers });
  }

  const handle: V2TestServerHandle = {
    url: 'http://deuz-v2.test/mcp',
    methods,
    calls,
    down: false,
    async fetch(input, init) {
      if (handle.down) throw new TypeError('fetch failed');
      const request = new Request(input, init);
      const sent = request.method === 'POST' ? methodsOf(await request.clone().text()) : [];
      methods.push(...sent);
      const response = await handler.fetch(request);
      return sent.includes('subscriptions/listen') ? cuttable(response) : response;
    },
    addTool(spec) {
      tools.set(spec.name, spec);
      handler.notify.toolsChanged();
    },
    endListenStreams() {
      const cutters = [...listenCutters];
      for (const cut of cutters) cut();
      return cutters.length;
    },
    async listen() {
      httpServer = createServer((req, res) => void serveNode(req, res));
      httpServer.on('connection', (socket: Socket) => {
        sockets.add(socket);
        socket.on('close', () => sockets.delete(socket));
        socket.on('error', () => {});
      });
      await new Promise<void>((resolve) => httpServer!.listen(0, '127.0.0.1', resolve));
      return `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}/mcp`;
    },
    async close() {
      await handler.close();
      if (httpServer) {
        for (const socket of sockets) socket.destroy();
        await new Promise<void>((resolve) => httpServer!.close(() => resolve()));
        httpServer = undefined;
      }
    },
  };

  /** node:http → Request → the handler → Response → node:http, streaming SSE through. */
  async function serveNode(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers)) {
      if (Array.isArray(value)) for (const v of value) headers.append(key, v);
      else if (value !== undefined) headers.set(key, value);
    }
    const aborter = new AbortController();
    res.on('close', () => {
      if (!res.writableFinished) aborter.abort();
    });
    const method = req.method ?? 'GET';
    try {
      const response = await handle.fetch(`http://127.0.0.1${req.url ?? '/'}`, {
        method,
        headers,
        ...(method === 'GET' || method === 'HEAD' ? {} : { body: Buffer.concat(chunks) }),
        signal: aborter.signal,
      });
      res.writeHead(response.status, Object.fromEntries(response.headers));
      if (response.body) {
        const reader = response.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          res.write(value);
        }
      }
      res.end();
    } catch {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    }
  }

  return handle;
}
