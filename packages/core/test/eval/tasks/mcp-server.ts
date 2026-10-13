/**
 * A tool served over MCP (2.3, `@deuz-sdk/core/mcp/server`): `createMcpServer`
 * publishes an order lookup, and a native run reaches it through the Deuz MCP
 * client wired straight into `server.fetch`, so no socket opens and nothing
 * depends on timing (mcp-server.mdx, "Quick start"). The served call gets a
 * receipt like any tool call, and the run's resume binding records the
 * server's catalog.
 */
import { createInMemoryAgentRunStore, runAgent } from '../../../src/agent-run';
import { createMcpClient } from '../../../src/mcp/index';
import { createMcpServer } from '../../../src/mcp/server';
import type { EvalTaskManifest } from '../../../src/testing';
import { answerMentions, completes, offline, runWith, type TaskModel } from '../support';

const MOCK = { provider: 'mock', id: 'mock-model', protocol: 'chat_completions' };

/** Run the lookup on `on`'s model against an in-process MCP server. */
export function askServedTool(on: TaskModel): NonNullable<EvalTaskManifest['run']> {
  return async (context) => {
    const served: string[] = [];
    const server = createMcpServer({
      name: 'orders',
      version: '1.0.0',
      tools: {
        order_status: {
          description: 'The shipping status of an order, by its number.',
          parameters: {
            type: 'object',
            properties: { order: { type: 'string' } },
            required: ['order'],
            additionalProperties: false,
          },
          execute: async (args) => {
            const { order } = args as { order: string };
            served.push(order);
            return { order, status: 'shipped', carrier: 'PTT Kargo', eta: '2026-10-14' };
          },
        },
      },
    });
    const client = await createMcpClient({
      transport: {
        type: 'http',
        url: 'http://orders.local/mcp',
        fetch: (input, init) => server.fetch(new Request(input, init)),
      },
    });
    try {
      const runs = createInMemoryAgentRunStore();
      const result = await runAgent({
        ...runWith(on, context),
        messages: context.messages,
        mcp: [client],
        session: { store: runs, runId: 'orders-1', scope: 'eval' },
      });
      const envelope = await runs.load('orders-1');
      context.store.served = served;
      context.store.protocol = client.protocolVersion?.();
      context.store.receipts = Object.values(envelope?.toolResults ?? {}).map(
        (receipt) => `${receipt.toolName}:${receipt.stage}`,
      );
      context.store.bound = Object.keys(
        (JSON.parse(envelope?.binding?.mcp ?? '{}') as { tools?: object }).tools ?? {},
      );
      return result;
    } finally {
      await client.close().catch(() => {});
      await server.close();
    }
  };
}

export const servedOrderLookup: EvalTaskManifest = {
  id: 'mcp-server/order-lookup',
  version: 1,
  title: 'Answer from a tool an in-process MCP server serves',
  tags: ['mcp', 'mcp-server'],
  model: MOCK,
  start: { messages: [{ role: 'user', content: 'Where is my order A-1042?' }] },
  tools: { allowed: ['order_status'] },
  budget: { usd: 0.01 },
  timeoutMs: 20_000,
  acceptance: [
    completes,
    answerMentions('shipped'),
    {
      name: 'the server ran one lookup, for the order the user named',
      check: (_outcome, context) =>
        JSON.stringify(context.store.served) === JSON.stringify(['A-1042']),
    },
    {
      name: "the served call has a completed receipt and the run's binding records the catalog",
      check: (_outcome, context) =>
        JSON.stringify(context.store.receipts) === JSON.stringify(['order_status:completed']) &&
        JSON.stringify(context.store.bound) === JSON.stringify(['order_status']),
    },
    {
      name: 'client and server spoke MCP 2026-07-28',
      check: (_outcome, context) => context.store.protocol === '2026-07-28',
    },
  ],
  run: askServedTool(
    offline([
      { toolCalls: [{ toolName: 'order_status', id: 'o1', args: { order: 'A-1042' } }] },
      { text: 'Order A-1042 has shipped with PTT Kargo; it should arrive on 2026-10-14.' },
    ]),
  ),
};
