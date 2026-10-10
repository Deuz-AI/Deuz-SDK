/**
 * mcp-sse-server.ts — an in-process MCP server on the LEGACY HTTP+SSE transport
 * (the v1 SDK's `SSEServerTransport`): `GET /sse` opens the event stream and
 * names a POST endpoint, `POST /messages?sessionId=…` carries the requests.
 *
 * It exists for one question the Streamable HTTP fixtures cannot answer: does
 * `McpHttpTransport.type: 'sse'` — the fallback some hosted servers still
 * expose — keep working on BOTH SDK lines. Real `node:http` sockets and real SSE
 * framing; the catalog mirrors `mcp-http-server.ts`'s `echo` and `add`.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { Server as McpProtocolServer } from '@modelcontextprotocol/sdk/server/index.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

export interface SseTestServerHandle {
  /** The `GET` endpoint a client connects to. */
  url: string;
  /** Sessions opened so far. */
  sessions(): number;
  close(): Promise<void>;
}

const TOOLS = [
  {
    name: 'echo',
    description: 'Echo a value back.',
    inputSchema: {
      type: 'object' as const,
      properties: { value: { type: 'string' } },
      required: ['value'],
    },
  },
  {
    name: 'add',
    description: 'Add two numbers, structured.',
    inputSchema: {
      type: 'object' as const,
      properties: { a: { type: 'number' }, b: { type: 'number' } },
      required: ['a', 'b'],
    },
  },
];

function protocolServer(): McpProtocolServer {
  const server = new McpProtocolServer(
    { name: 'sse-test-server', version: '1.0.0' },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: TOOLS }));
  server.setRequestHandler(CallToolRequestSchema, (request) => {
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;
    if (request.params.name === 'echo') {
      return { content: [{ type: 'text', text: `echo:${String(args.value)}` }] };
    }
    const sum = Number(args.a) + Number(args.b);
    return {
      content: [{ type: 'text', text: JSON.stringify({ sum }) }],
      structuredContent: { sum },
    };
  });
  return server;
}

export async function startSseTestServer(): Promise<SseTestServerHandle> {
  const transports = new Map<string, SSEServerTransport>();
  const servers: McpProtocolServer[] = [];
  const sockets = new Set<Socket>();

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (req.method === 'GET' && url.pathname === '/sse') {
      const transport = new SSEServerTransport('/messages', res);
      transports.set(transport.sessionId, transport);
      transport.onclose = () => transports.delete(transport.sessionId);
      const server = protocolServer();
      servers.push(server);
      await server.connect(transport);
      return;
    }
    if (req.method === 'POST' && url.pathname === '/messages') {
      const transport = transports.get(url.searchParams.get('sessionId') ?? '');
      if (!transport) {
        res.writeHead(404).end('unknown session');
        return;
      }
      await transport.handlePostMessage(req, res);
      return;
    }
    res.writeHead(404).end();
  }

  const http = createServer((req, res) => {
    handle(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });
  http.on('connection', (socket: Socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
  });
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  const { port } = http.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}/sse`,
    sessions: () => servers.length,
    async close() {
      for (const server of servers) await server.close().catch(() => {});
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => http.close(() => resolve()));
    },
  };
}
