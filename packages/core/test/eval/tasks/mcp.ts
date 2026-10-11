/**
 * MCP hot refresh against the real in-process MCP server
 * (`test/helpers/mcp-http-server.ts`, a loopback listener with the SDK's own
 * transport): a tool added mid-run reaches the model on the next step, its call
 * gets a receipt, and the run's resume binding records the new catalog.
 */
import { createInMemoryAgentRunStore, runAgent } from '../../../src/agent-run';
import { createMcpClient } from '../../../src/mcp/index';
import type { EvalTaskManifest } from '../../../src/testing';
import { startTestMcpServer } from '../../helpers/mcp-http-server';
import { completes, mockPrices, scripted } from '../support';

const MOCK = { provider: 'mock', id: 'mock-model', protocol: 'chat_completions' };

/** Poll until `predicate` holds: the server pushes over SSE, so there is nothing to await. */
async function waitFor(
  predicate: () => boolean,
  label: string,
  signal: AbortSignal,
): Promise<void> {
  while (!predicate()) {
    if (signal.aborted) throw new Error(`gave up waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

export const mcpHotRefresh: EvalTaskManifest = {
  id: 'mcp/hot-refresh',
  version: 1,
  title: 'Use a tool an MCP server added mid-run',
  tags: ['mcp'],
  model: MOCK,
  start: { messages: [{ role: 'user', content: 'Enable reports, then build the weekly report.' }] },
  tools: { allowed: ['enable_reports', 'weekly_report'] },
  budget: { usd: 0.01 },
  timeoutMs: 20_000,
  acceptance: [
    completes,
    {
      name: 'the server ran the new tool once',
      check: (_outcome, context) =>
        JSON.stringify(context.store.serverCalls) === JSON.stringify(['weekly_report']),
    },
    {
      name: 'the resume binding records the refreshed catalog',
      check: (_outcome, context) =>
        JSON.stringify(context.store.boundTools) ===
        JSON.stringify(['ping', 'weekly_report'].sort()),
    },
    {
      name: 'the new tool call has a completed receipt',
      check: (_outcome, context) =>
        (context.store.receipts as string[] | undefined)?.includes('weekly_report:completed') ===
        true,
    },
  ],
  async run(context) {
    const server = await startTestMcpServer({
      tools: [{ name: 'ping', description: 'Health check.', handler: () => 'pong' }],
    });
    const client = await createMcpClient({ transport: { type: 'http', url: server.url } });
    try {
      let refreshed = false;
      const unsubscribe = client.onToolListChanged(() => {
        refreshed = true;
      });
      await server.waitForClientStream();
      const { model } = scripted([
        { toolCalls: [{ toolName: 'enable_reports', args: {} }] },
        { toolCalls: [{ toolName: 'weekly_report', args: {} }] },
        { text: 'Reports are enabled; the weekly report shows 12 closed tickets.' },
      ]);
      const store = createInMemoryAgentRunStore();
      const result = await runAgent({
        model,
        messages: context.messages,
        mcp: [client],
        onCatalogChange: 'accept',
        session: { store, runId: 'mcp', scope: 'eval' },
        tools: {
          enable_reports: {
            description: 'Turn on the reporting tools.',
            parameters: { type: 'object', properties: {} },
            execute: async () => {
              server.addTool({
                name: 'weekly_report',
                description: 'Build the weekly report.',
                handler: () => ({ closed: 12 }),
              });
              // The loop awaits this tool, so the push has landed before the next step.
              await waitFor(() => refreshed, 'tools/list_changed', context.signal);
              return 'enabled';
            },
          },
        },
        signal: context.signal,
        deps: { observer: context.observer, priceProvider: mockPrices },
      });
      unsubscribe();
      const envelope = await store.load('mcp');
      context.store.serverCalls = server.calls.map((call) => call.name);
      context.store.boundTools = Object.keys(
        (JSON.parse(envelope?.binding?.mcp ?? '{}') as { tools?: object }).tools ?? {},
      ).sort();
      context.store.receipts = Object.values(envelope?.toolResults ?? {}).map(
        (receipt) => `${receipt.toolName}:${receipt.stage}`,
      );
      return result;
    } finally {
      await client.close().catch(() => {});
      await server.close();
    }
  },
};
