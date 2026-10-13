/**
 * 19 — An MCP server: Deuz tools and an agent, served over MCP (2.3).
 *
 * `createMcpServer` publishes the tools you already wrote for the loop, and
 * whole agents behind a `{ prompt }` tool, as a Model Context Protocol server.
 * Its `fetch` is a fetch-native Streamable HTTP handler, so here the Deuz MCP
 * client talks straight into it, in this process: no socket, no key. With the
 * official v2 MCP packages installed, the client negotiates MCP 2026-07-28, and
 * a call to a tool marked `needsApproval` asks the client's user first, through
 * an MCP elicitation.
 */
import { tool } from '@deuz-sdk/core';
import { createMcpClient } from '@deuz-sdk/core/mcp';
import type { McpElicitationResult } from '@deuz-sdk/core/mcp';
import { createMcpServer } from '@deuz-sdk/core/mcp/server';
import { createMockModel } from '@deuz-sdk/core/testing';

// --- THE TOOLS (they run on the server) ---------------------------------------
const ORDERS: Record<string, { status: string; totalUsd: number }> = {
  'A-17': { status: 'delivered damaged', totalUsd: 42 },
  'B-2': { status: 'in transit', totalUsd: 18 },
};
const orderId = {
  type: 'object',
  properties: { orderId: { type: 'string' } },
  required: ['orderId'],
  additionalProperties: false,
};

const lookupOrder = tool({
  description: 'Look up an order by its id.',
  parameters: orderId,
  execute: async (args) => {
    const { orderId } = args as { orderId: string };
    console.log(`   [server] lookup_order(${orderId}) runs`);
    const order = ORDERS[orderId];
    if (!order) throw new Error(`There is no order ${orderId}.`);
    return { orderId, ...order };
  },
});

const refundOrder = tool({
  description: 'Refund an order in full.',
  parameters: orderId,
  needsApproval: true, // a person agrees first, wherever the call comes from
  execute: async (args) => {
    const { orderId } = args as { orderId: string };
    console.log(`   [server] refund_order(${orderId}) runs`);
    return { orderId, refundedUsd: ORDERS[orderId]?.totalUsd ?? 0 };
  },
});

// --- THE SERVER -------------------------------------------------------------------
// REAL PROVIDER: the agent's model is scripted, one reply per model call. Replace
// `createMockModel({ ... })` with
//   import { createAnthropic } from '@deuz-sdk/core/anthropic';
//   createAnthropic({ apiKey: process.env.ANTHROPIC_API_KEY })('claude-opus-4-8')
// The tools and the server stay as they are.
const server = createMcpServer({
  name: 'support-desk',
  version: '1.0.0',
  instructions: 'Order support: look orders up, refund them, or ask the support agent.',
  tools: { lookup_order: lookupOrder, refund_order: refundOrder },
  agents: {
    // One MCP tool, one whole `runAgent` on the server: its steps and tools stay here.
    support_agent: {
      description: 'Answers a question about an order, after looking the order up.',
      agent: {
        model: createMockModel({
          responses: [
            { toolCalls: [{ toolName: 'lookup_order', args: { orderId: 'B-2' } }] },
            { text: 'Order B-2 is in transit. It should arrive within two days.' },
          ],
        }),
        instructions: 'You answer questions about orders. Look the order up first.',
        tools: { lookup_order: lookupOrder },
      },
    },
  },
  // Hints the client may show its user: lookup only reads, a refund cannot be undone.
  toolAnnotations: {
    lookup_order: { readOnlyHint: true },
    refund_order: { destructiveHint: true },
  },
});
await server.ready(); // load the MCP SDK and prepare every tool now, not on the first request

// --- THE CLIENT -------------------------------------------------------------------
// The Deuz MCP client, wired into `server.fetch` instead of the network. In
// production, serve `server.fetch` from a route handler and drop `fetch` here:
// the client then dials `url`. A server on stdio (`serveMcpStdio`, see the
// README) is launched by its client instead, with `createStdioMcpClient`.
const userAnswers: McpElicitationResult[] = [
  { action: 'accept', content: { approve: true } }, // the first refund: yes
  { action: 'decline' }, // the second: no
];
const client = await createMcpClient({
  transport: {
    type: 'http',
    url: 'http://support-desk.local/mcp',
    fetch: (input, init) => server.fetch(new Request(input, init)),
  },
  // The client's user answers the server's approval questions (scripted here).
  onElicitationRequest: (request) => {
    console.log(`   [client] the user is asked: ${request.message}`);
    const answer = userAnswers.shift() ?? { action: 'decline' };
    const form = answer.content ? ` ${JSON.stringify(answer.content)}` : '';
    console.log(`   [client] the user answers: ${answer.action}${form}`);
    return answer;
  },
});

/** Call a served tool and print what the client gets back: the value, or the error. */
async function call(name: string, args: unknown): Promise<void> {
  try {
    console.log(`   -> ${JSON.stringify(await client.callTool(name, args))}`);
  } catch (error) {
    console.log(`   -> error: ${(error as Error).message}`);
  }
}

console.log('1) connect: the client negotiates with server.fetch, in this process');
const info = client.serverInfo?.();
console.log(
  `   SDK line ${client.sdk?.()}, MCP ${client.protocolVersion?.()}, ` +
    `server ${info?.name} ${info?.version}`,
);

console.log('\n2) tools/list: what the server publishes, as a ToolSet for your own loop');
for (const [name, served] of Object.entries(await client.listTools())) {
  console.log(`   ${name}: ${served.description}`);
}

console.log('\n3) call a tool; a tool that throws comes back as an error result');
await call('lookup_order', { orderId: 'A-17' });
await call('lookup_order', { orderId: 'Z-9' });

console.log("\n4) a tool with needsApproval: the server asks the client's user first");
await call('refund_order', { orderId: 'A-17' });
await call('refund_order', { orderId: 'B-2' });

console.log('\n5) call the agent: one MCP call runs a whole runAgent on the server');
await call('support_agent', { prompt: 'Where is my order B-2?' });

await client.close();
await server.close();
